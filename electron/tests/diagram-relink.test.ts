import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DIAGRAM_RELINK_CHANNEL, createDiagramRelinkHandler, registerDiagramRelinkIpc } from '../src/diagram-ipc';

const ID = '123e4567-e89b-42d3-a456-426614174000';
const MMD = `system-flow-${ID}.mmd`;
const DRAWIO = `system-flow-${ID}.drawio`;
const roots: string[] = [];

async function temporaryRoot(prefix = 'modutex-relink-'): Promise<string> {
	// Match the production picker's canonical workspace path, including Windows TEMP aliases.
	const root = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
	roots.push(root);
	return root;
}

async function diagramFile(root: string, name: string, content = 'flowchart LR\nA-->B\n'): Promise<string> {
	const directory = path.join(root, 'assets', 'diagrams');
	await mkdir(directory, { recursive: true });
	const file = path.join(directory, name);
	await writeFile(file, content, 'utf8');
	return file;
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('diagram relink production boundary', () => {
	it('registers one fixed channel and uses the claimed workspace diagram directory as picker default', async () => {
		const root = await temporaryRoot();
		const selected = await diagramFile(root, MMD);
		let registeredChannel = '';
		let registeredHandler: ((event: { sender: { id: number } }, request: unknown) => Promise<unknown>) | undefined;
		let pickerDefault = '';

		registerDiagramRelinkIpc({
			registrar: {
				handle(channel, handler) {
					registeredChannel = channel;
					registeredHandler = handler;
				}
			},
			workspaceForSender: (senderId) => (senderId === 7 ? root : null),
			pickFile: async ({ defaultPath }) => {
				pickerDefault = defaultPath;
				return { canceled: false, filePaths: [selected] };
			}
		});

		expect(registeredChannel).toBe(DIAGRAM_RELINK_CHANNEL);
		expect(registeredHandler).toBeTypeOf('function');
		const result = await registeredHandler!({ sender: { id: 7 } }, { type: 'mermaid' });
		expect(pickerDefault).toBe(path.join(root, 'assets', 'diagrams'));
		expect(result).toMatchObject({
			relativePath: `assets/diagrams/${MMD}`,
			content: 'flowchart LR\nA-->B\n',
			size: Buffer.byteLength('flowchart LR\nA-->B\n')
		});
		expect(JSON.stringify(result)).not.toContain(root);
	});

	it('returns null on cancel without reading or creating a source', async () => {
		const root = await temporaryRoot();
		const handler = createDiagramRelinkHandler({
			workspaceForSender: () => root,
			pickFile: async () => ({ canceled: true, filePaths: [] })
		});

		await expect(handler({ sender: { id: 1 } }, { type: 'mermaid' })).resolves.toBeNull();
	});

	it('reads a matching Draw.io source and constrains the picker filter to that type', async () => {
		const root = await temporaryRoot();
		const selected = await diagramFile(root, DRAWIO, '<mxfile>繁體中文</mxfile>');
		let extensions: readonly string[] = [];
		const handler = createDiagramRelinkHandler({
			workspaceForSender: () => root,
			pickFile: async (options) => {
				extensions = options.extensions;
				return { canceled: false, filePaths: [selected] };
			}
		});

		await expect(handler({ sender: { id: 1 } }, { type: 'drawio' })).resolves.toMatchObject({
			relativePath: `assets/diagrams/${DRAWIO}`,
			content: '<mxfile>繁體中文</mxfile>',
			size: Buffer.byteLength('<mxfile>繁體中文</mxfile>')
		});
		expect(extensions).toEqual(['drawio']);
	});

	it('rejects invalid runtime requests and unclaimed senders before opening the picker', async () => {
		let pickerCalls = 0;
		const handler = createDiagramRelinkHandler({
			workspaceForSender: () => null,
			pickFile: async () => {
				pickerCalls++;
				return { canceled: true, filePaths: [] };
			}
		});

		await expect(handler({ sender: { id: 1 } }, { type: 'mermaid' })).rejects.toThrow('WORKSPACE_NOT_CLAIMED');
		await expect(handler({ sender: { id: 1 } }, { type: 'plantuml' })).rejects.toThrow('INVALID_REQUEST');
		await expect(handler({ sender: { id: 1 } }, { type: 'drawio', root: 'C:/private' })).rejects.toThrow('INVALID_REQUEST');
		expect(pickerCalls).toBe(0);
	});

	it('enforces the selected filename UUID and requested source type', async () => {
		const root = await temporaryRoot();
		for (const [name, type] of [
			['plain.mmd', 'mermaid'],
			[MMD, 'drawio'],
			[DRAWIO, 'mermaid'],
			[`System-${ID}.mmd`, 'mermaid']
		] as const) {
			const selected = await diagramFile(root, name);
			const handler = createDiagramRelinkHandler({
				workspaceForSender: () => root,
				pickFile: async () => ({ canceled: false, filePaths: [selected] })
			});
			await expect(handler({ sender: { id: 1 } }, { type })).rejects.toThrow('INVALID_PATH');
		}

		const otherDirectory = path.join(root, 'other');
		await mkdir(otherDirectory);
		const validNameOutsideDiagramDirectory = path.join(otherDirectory, MMD);
		await writeFile(validNameOutsideDiagramDirectory, 'flowchart LR\nA-->B');
		const handler = createDiagramRelinkHandler({
			workspaceForSender: () => root,
			pickFile: async () => ({ canceled: false, filePaths: [validNameOutsideDiagramDirectory] })
		});
		await expect(handler({ sender: { id: 1 } }, { type: 'mermaid' })).rejects.toThrow('INVALID_PATH');
	});

	it('rejects outside selections, directory junction escapes, and empty sources without disclosing paths', async () => {
		const root = await temporaryRoot();
		const outside = await temporaryRoot('modutex-relink-outside-');
		const outsideFile = await diagramFile(outside, MMD, 'outside');
		const diagramDir = path.join(root, 'assets', 'diagrams');
		await mkdir(path.dirname(diagramDir), { recursive: true });
		await symlink(path.dirname(outsideFile), diagramDir, 'junction');

		for (const selected of [outsideFile, path.join(diagramDir, MMD)]) {
			const handler = createDiagramRelinkHandler({
				workspaceForSender: () => root,
				pickFile: async () => ({ canceled: false, filePaths: [selected] })
			});
			try {
				await handler({ sender: { id: 1 } }, { type: 'mermaid' });
				throw new Error('expected relink rejection');
			} catch (error) {
				expect(error).toBeInstanceOf(Error);
				expect((error as Error).message).toBe('INVALID_PATH');
				expect((error as Error).message).not.toContain(root);
				expect((error as Error).message).not.toContain(outside);
			}
		}

		await rm(diagramDir);
		const empty = await diagramFile(root, MMD, '');
		const emptyHandler = createDiagramRelinkHandler({
			workspaceForSender: () => root,
			pickFile: async () => ({ canceled: false, filePaths: [empty] })
		});
		await expect(emptyHandler({ sender: { id: 1 } }, { type: 'mermaid' })).rejects.toThrow('EMPTY_SOURCE');
	});
});
