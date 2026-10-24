// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { watch as watchDirectory } from 'node:fs';
import { readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
	FileEntry,
	FileEvent,
	FileRef,
	FileWatchFailure,
	ReadReceipt,
	SaveAsReceipt,
	SaveAsRequest,
	WorkspaceInfo,
	WriteReceipt,
	WriteRequest
} from '@modutex/frontend-contracts';

interface FixtureWorkspace extends WorkspaceInfo {
	readonly root: string;
}

export interface NativeFilesWatch {
	start(): Promise<void>;
	stop(): void;
}

function revision(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex');
}

function isMissingFile(error: unknown): boolean {
	return typeof error === 'object' && error !== null && 'code' in error &&
		(error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

/** Minimal real-filesystem boundary for mounted App tests; it is not a desktop host. */
export class NativeFilesFixture {
	private sequence = 0;
	private current: FixtureWorkspace | null = null;

	async open(target: string, kind: 'file' | 'folder'): Promise<WorkspaceInfo> {
		const absolute = await realpath(path.resolve(target));
		const info = await stat(absolute);
		let root: string;
		let entryPath: string | null;

		if (kind === 'file') {
			if (!info.isFile()) throw new Error('Expected a file workspace');
			root = path.dirname(absolute);
			entryPath = path.basename(absolute);
		} else {
			if (!info.isDirectory()) throw new Error('Expected a folder workspace');
			root = absolute;
			entryPath = await this.firstTeXFile(root);
		}

		return this.activate(root, entryPath, path.basename(absolute));
	}

	async list(workspaceId: string): Promise<readonly FileEntry[]> {
		const workspace = this.requireCurrent(workspaceId);
		const entries: FileEntry[] = [];
		const visit = async (directory: string, prefix: string): Promise<void> => {
			const children = await readdir(directory, { withFileTypes: true });
			children.sort((left, right) => left.name.localeCompare(right.name));
			for (const child of children) {
				const filePath = prefix ? `${prefix}/${child.name}` : child.name;
				if (child.isDirectory()) {
					entries.push({ path: filePath, kind: 'directory' });
					await visit(path.join(directory, child.name), filePath);
				} else if (child.isFile()) {
					entries.push({ path: filePath, kind: 'file' });
				}
			}
		};

		await visit(workspace.root, '');
		return entries;
	}

	async read(file: FileRef): Promise<ReadReceipt> {
		const workspace = this.requireCurrent(file.workspaceId);
		const bytes = await readFile(this.filePath(workspace, file.path));
		return {
			workspaceId: file.workspaceId,
			path: file.path,
			bytes: Uint8Array.from(bytes),
			revision: revision(bytes)
		};
	}

	async write(request: WriteRequest): Promise<WriteReceipt> {
		const workspace = this.requireCurrent(request.workspaceId);
		const target = this.filePath(workspace, request.path);
		let diskRevision: string | null = null;
		try {
			diskRevision = revision(await readFile(target));
		} catch (error) {
			if (!isMissingFile(error)) throw error;
		}

		if (
			(request.expectedRevision === null && diskRevision !== null) ||
			(request.expectedRevision !== null && diskRevision !== request.expectedRevision)
		) {
			throw new Error('FILE_CONFLICT');
		}

		this.requireCurrent(request.workspaceId);
		await writeFile(target, request.bytes, {
			flag: request.expectedRevision === null ? 'wx' : 'w'
		});
		return {
			workspaceId: request.workspaceId,
			path: request.path,
			revision: revision(request.bytes),
			documentId: request.documentId,
			documentVersion: request.documentVersion
		};
	}

	async saveAs(destination: string, request: SaveAsRequest): Promise<SaveAsReceipt> {
		const target = path.resolve(destination);
		const bytes = Uint8Array.from(request.bytes);
		await writeFile(target, bytes, { flag: 'wx' });
		const entryPath = path.basename(target);
		const workspace = this.activate(await realpath(path.dirname(target)), entryPath, entryPath);
		return {
			workspace,
			write: {
				workspaceId: workspace.id,
				path: entryPath,
				revision: revision(bytes),
				documentId: request.documentId,
				documentVersion: request.documentVersion
			}
		};
	}

	close(workspaceId?: string): void {
		if (workspaceId === undefined || this.current?.id === workspaceId) {
			this.current = null;
		}
	}

	watch(
		workspaceId: string,
		emit: (event: FileEvent) => void,
		onError: (failure: FileWatchFailure) => void
	): NativeFilesWatch {
		const workspace = this.requireCurrent(workspaceId);
		const fixture = this;
		const knownFiles = new Set<string>();
		let active = false;
		let failed = false;
		let watcher: ReturnType<typeof watchDirectory> | null = null;

		const reportFailure = () => {
			if (!active || failed) return;
			failed = true;
			active = false;
			watcher?.close();
			onError('FILE_OPERATION_FAILED');
		};

		const deliver = async (filename: string | Buffer | null): Promise<void> => {
			if (!active || filename === null) return;
			const filePath = (typeof filename === 'string' ? filename : filename.toString())
				.split(path.sep)
				.join('/');
			if (!filePath) return;

			try {
				fixture.requireCurrent(workspaceId);
			} catch {
				return;
			}

			let kind: FileEvent['kind'];
			try {
				const info = await stat(path.join(workspace.root, ...filePath.split('/')));
				if (!info.isFile()) return;
				knownFiles.add(filePath);
				kind = 'changed';
			} catch (error) {
				if (!isMissingFile(error)) {
					reportFailure();
					return;
				}
				if (!knownFiles.has(filePath)) return;
				knownFiles.delete(filePath);
				kind = 'removed';
			}

			if (!active) return;
			try {
				fixture.requireCurrent(workspaceId);
			} catch {
				return;
			}
			emit({ workspaceId, path: filePath, kind });
		};

		return {
			async start() {
				if (active) return;
				fixture.requireCurrent(workspaceId);
				for (const entry of await fixture.list(workspaceId)) {
					if (entry.kind === 'file') knownFiles.add(entry.path);
				}
				fixture.requireCurrent(workspaceId);
				active = true;
				try {
					watcher = watchDirectory(workspace.root, (_eventType, filename) => {
						void deliver(filename);
					});
					watcher.on('error', reportFailure);
				} catch (error) {
					active = false;
					throw error;
				}
			},
			stop() {
				active = false;
				watcher?.close();
				watcher = null;
				knownFiles.clear();
			}
		};
	}

	private async firstTeXFile(root: string): Promise<string | null> {
		const children = await readdir(root, { withFileTypes: true });
		return children
			.filter((child) => child.isFile() && child.name.toLowerCase().endsWith('.tex'))
			.map((child) => child.name)
			.sort((left, right) => left.localeCompare(right))[0] ?? null;
	}

	private activate(root: string, entryPath: string | null, label: string): WorkspaceInfo {
		const workspace: FixtureWorkspace = {
			id: `fixture-workspace-${++this.sequence}`,
			label,
			entryPath,
			root
		};
		this.current = workspace;
		return { id: workspace.id, label: workspace.label, entryPath: workspace.entryPath };
	}

	private requireCurrent(workspaceId: string): FixtureWorkspace {
		if (!this.current || this.current.id !== workspaceId) throw new Error('STALE_WORKSPACE');
		return this.current;
	}

	private filePath(workspace: FixtureWorkspace, filePath: string): string {
		return path.join(workspace.root, ...filePath.split('/'));
	}
}
