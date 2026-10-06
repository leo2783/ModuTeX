import '../../src/app.css';
import { EditorState, NodeSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { schema } from '../../src/lib/schema/schema';
import { DocumentBuffer } from '../../src/lib/workspace/documentBuffer.svelte';
import { MathPackageCoordinator, type MathPackageGateLease, type MathPackageRequester } from '../../src/lib/workspace/math-package-context';
import { PackagePromptController } from '../../src/lib/diagram/package-prompt.svelte';
import {
	VIRTUAL_MATRIX_REQUEST_EVENT,
	configureMathVirtualKeyboard
} from '../../src/lib/editor/extensions/mathlivebridge/virtualKeyboardConfig';
import { editorViewStore, viewMode } from '../../src/lib/stores/editorStore';

const root = document.querySelector<HTMLElement>('#virtual-keyboard-editor')!;
const source =
	'\\documentclass{article}\r\n% keep this source-first preamble\r\n\\begin{document}\r\nBody bytes stay untouched.\r\n\\end{document}\r\n';
const scheduledSaves: Array<{ path: string | null; content: string }> = [];
const documentBuffer = new DocumentBuffer({
	scheduleSave: (path, content) => scheduledSaves.push({ path, content }),
	discardQueuedSave: () => undefined,
	writeNow: () => undefined,
	rebuildVisual: () => undefined,
	isVisualMode: () => true,
	clearPendingAnchor: () => undefined
});
documentBuffer.openTex('/workspace/main.tex', source, '\r\n');

let view: EditorView | null = null;
let packagePrompt: PackagePromptController | null = null;
let pendingGate: Promise<MathPackageGateLease | null> | null = null;
let activePresetCommand = false;

const makeState = (requester?: MathPackageRequester) =>
	EditorState.create({
		schema,
		plugins: [mlarrowHandlers, requester ? createMathlivePlugin(requester) : mathlivePlugin],
		doc: schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, schema.nodes.inline_math.create(null, schema.text('x'))))
	});

function mountEditor(requester?: MathPackageRequester) {
	view?.destroy();
	root.replaceChildren();
	viewMode.set('visual');
	view = new EditorView(root, {
		state: makeState(requester),
		attributes: { class: 'TexpileEditor', spellcheck: 'false' }
	});
	view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, 1)));
	return view;
}

const { createMathlivePlugin, mathlivePlugin, mlarrowHandlers } = await import('../../src/lib/editor/extensions/mathlivebridge/mlplugin');
await configureMathVirtualKeyboard();

function snapshot() {
	const nodes: Array<{ type: string; latex: string; ownedPromptIds: string[] }> = [];
	view?.state.doc.descendants((node) => {
		if (node.type.name === 'inline_math' || node.type.name === 'block_math') {
			nodes.push({
				type: node.type.name,
				latex: node.textContent,
				ownedPromptIds: Array.isArray(node.attrs.ownedPromptIds) ? node.attrs.ownedPromptIds : []
			});
		}
	});
	const field = root.querySelector('math-field') as import('mathlive').MathfieldElement | null;
	return {
		nodes,
		field: field
			? {
					latex: field.getValue('latex'),
					focused: field.hasFocus(),
					connected: field.isConnected,
					readOnly: field.readOnly,
					selection: field.selection.ranges,
					maxMatrixCols: field.maxMatrixCols
				}
			: null,
		source: documentBuffer.texSource,
		docMetaIsNull: documentBuffer.docMeta === null,
		prompt: packagePrompt?.active ?? null,
		scheduledSaves,
		activePresetCommand
	};
}

mountEditor();

const fixture = {
	snapshot,
	requestWithoutRequester() {
		const field = root.querySelector('math-field') as import('mathlive').MathfieldElement | null;
		if (!field) throw new Error('No actual MathLive field was materialized');
		const before = JSON.stringify(view?.state.doc.toJSON());
		field.executeCommand(['dispatchEvent', VIRTUAL_MATRIX_REQUEST_EVENT, 1]);
		return { unchanged: before === JSON.stringify(view?.state.doc.toJSON()), state: snapshot() };
	},
	mountGatedEditor() {
		packagePrompt = new PackagePromptController();
		const coordinator = new MathPackageCoordinator(documentBuffer, packagePrompt, {
			getActivePath: () => documentBuffer.path,
			getKind: () => 'tex',
			getView: () => view,
			getViewMode: () => 'visual',
			afterPackageChange: async () => true
		});
		const requester: MathPackageRequester = {
			ensureAmsmath: (signal, targetIsCurrent) => {
				pendingGate = coordinator.ensureAmsmath(signal, targetIsCurrent);
				return pendingGate;
			}
		};
		mountEditor(requester);
		editorViewStore.set(view);
		return snapshot();
	},
	requestReadonlyMatrix() {
		const field = root.querySelector('math-field') as import('mathlive').MathfieldElement | null;
		if (!field || !view) throw new Error('No actual MathLive editor was mounted');
		const before = {
			doc: JSON.stringify(view.state.doc.toJSON()),
			source: documentBuffer.texSource,
			saveCount: scheduledSaves.length
		};
		field.readOnly = true;
		activePresetCommand = field.executeCommand(['dispatchEvent', VIRTUAL_MATRIX_REQUEST_EVENT, 1]);
		field.readOnly = false;
		return {
			commandAccepted: activePresetCommand,
			unchanged:
				before.doc === JSON.stringify(view.state.doc.toJSON()) &&
				before.source === documentBuffer.texSource &&
				before.saveCount === scheduledSaves.length &&
				packagePrompt?.active === null,
			state: snapshot()
		};
	},
	startGatedRequest() {
		const field = root.querySelector('math-field') as import('mathlive').MathfieldElement | null;
		if (!field) throw new Error('No actual MathLive field was materialized');
		activePresetCommand = field.executeCommand(['dispatchEvent', VIRTUAL_MATRIX_REQUEST_EVENT, 1]);
		return snapshot();
	},
	setReadonly(readOnly: boolean) {
		const field = root.querySelector('math-field') as import('mathlive').MathfieldElement | null;
		if (!field) throw new Error('No actual MathLive field was materialized');
		field.readOnly = readOnly;
	},
	resolveAddChoice() {
		const request = packagePrompt?.active;
		if (!request || !packagePrompt) throw new Error('The amsmath package decision was not requested');
		packagePrompt.resolve(request.id, 'add-and-insert');
	},
	async settleGate() {
		if (!pendingGate) throw new Error('No package gate request is pending');
		await pendingGate;
		return snapshot();
	},
	async dispose() {
		editorViewStore.set(null);
		view?.destroy();
		view = null;
		root.replaceChildren();
	}
};

declare global {
	interface Window {
		__virtualKeyboardMatrix?: typeof fixture;
	}
}
window.__virtualKeyboardMatrix = fixture;
