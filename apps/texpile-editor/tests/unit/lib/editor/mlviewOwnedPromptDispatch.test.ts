// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorState, Plugin } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { ownMathLiveTemplate, pendingOwnedPromptIds, queueOwnedPromptIds } from '$lib/editor/extensions/mathlivebridge/owned-prompt-output';
import { DocumentBuffer, type DocumentBufferDeps } from '$lib/workspace/documentBuffer.svelte';
import { PackagePromptController } from '$lib/diagram/package-prompt.svelte';
import { MathPackageCoordinator, type MathPackageRequester } from '$lib/workspace/math-package-context';

let fakeFields: FakeMathfield[] = [];

class FakeMathfield extends HTMLElement {
	static soundsDirectory: string | null = null;
	selection: { ranges: number[][] } = { ranges: [[0, 0]] };
	readOnly = false;
	mathVirtualKeyboardPolicy = 'manual';
	canUndo = () => false;
	canRedo = () => false;
	focused = false;
	value = '';

	setValue(value: string): void {
		this.value = value;
	}

	getValue(): string {
		return this.value;
	}

	hasFocus(): boolean {
		return this.focused;
	}

	focus(options?: FocusOptions): void {
		this.focused = true;
		super.focus(options);
	}

	blur(): void {
		this.focused = false;
	}

	executeCommand(): void {}
}

customElements.define('owned-prompt-math-field', FakeMathfield);

vi.mock('mathlive', () => ({
	MathfieldElement: new Proxy(FakeMathfield, {
		construct(target, args) {
			const field = Reflect.construct(target, args) as FakeMathfield;
			fakeFields.push(field);
			return field;
		}
	}),
	convertLatexToMarkup: (latex: string) => `<span>${latex}</span>`
}));
vi.mock('mathlive/fonts.css', () => ({}));
vi.mock('$lib/runtime', () => ({ browser: true }));
vi.mock('$lib/editor/extensions/mathlivebridge/virtualKeyboardConfig', () => ({
	configureMathVirtualKeyboard: async () => undefined,
	virtualMatrixLatexForPreset: (preset: unknown) => (preset === 1 ? '\\begin{pmatrix}#? & #?\\\\#? & #?\\end{pmatrix}' : null),
	VIRTUAL_MATRIX_REQUEST_EVENT: 'modutex:virtual-matrix-request'
}));
vi.mock('$lib/editor/extensions/mathlivebridge/mathStatic', () => ({
	renderStaticMath: () => document.createElement('span'),
	setStaticMath: () => undefined,
	cancelStaticMath: () => undefined
}));
vi.mock('$lib/editor/extensions/mathlivebridge/mathViewport', () => ({
	upgradeWhenNear: () => undefined,
	cancelUpgrade: () => undefined
}));
vi.mock('$lib/editor/extensions/mathlivebridge/MathSettings.svelte', () => ({ default: {} }));
vi.mock('svelte', async (original) => ({ ...(await original<Record<string, unknown>>()), mount: () => ({}), unmount: () => undefined }));

const { schema } = await import('$lib/schema/schema');
const { default: MathLiveView, captureMathfieldEditReceipt } = await import('$lib/editor/extensions/mathlivebridge/mlview.svelte');

function createHarness(rejectTransactions: () => boolean = () => false, mathPackageRequester?: MathPackageRequester) {
	const original = schema.nodes.inline_math.create(null, schema.text('x'));
	const paragraph = schema.nodes.paragraph.create(null, original);
	const doc = schema.nodes.doc.create(null, paragraph);
	const transactionFilter = new Plugin({
		filterTransaction: (tr) => !tr.docChanged || !rejectTransactions()
	});
	let mathView: InstanceType<typeof MathLiveView> | undefined;
	const editor = new EditorView(document.createElement('div'), {
		state: EditorState.create({ schema, doc, plugins: [transactionFilter] }),
		nodeViews: {
			inline_math: (node, view, getPos) => {
				mathView = new MathLiveView(node, view, () => getPos() ?? 1, { getState: () => undefined }, false, mathPackageRequester);
				return mathView;
			}
		}
	});
	document.body.appendChild(editor.dom);
	const view = mathView;
	if (!view) throw new Error('ProseMirror did not create the MathLive node view');
	view.selectNode();
	const field = view.mathField as unknown as FakeMathfield;
	if (!field) throw new Error('MathLive node view did not materialize its field');
	return { editor, view, field };
}

function createAmsmathGateHarness() {
	const originalSource = '\\documentclass{article}\n\\begin{document}\nBody.\n\\end{document}\n';
	const scheduled: Array<{ path: string | null; content: string }> = [];
	const deps: DocumentBufferDeps = {
		scheduleSave: (path, content) => scheduled.push({ path, content }),
		discardQueuedSave: () => {},
		writeNow: () => {},
		rebuildVisual: () => {},
		isVisualMode: () => true,
		clearPendingAnchor: () => {}
	};
	const documentBuffer = new DocumentBuffer(deps);
	documentBuffer.openTex('/ws/math.tex', originalSource, '\n');
	const packagePrompt = new PackagePromptController();
	const editorRef: { current: EditorView | null } = { current: null };
	const afterPackageChange = vi.fn(async () => true);
	const coordinator = new MathPackageCoordinator(documentBuffer, packagePrompt, {
		getActivePath: () => '/ws/math.tex',
		getKind: () => 'tex',
		getView: () => editorRef.current,
		getViewMode: () => 'visual',
		afterPackageChange,
		onPackageError: vi.fn()
	});
	const gatePromises: Array<ReturnType<typeof coordinator.ensureAmsmath>> = [];
	const requester: MathPackageRequester = {
		ensureAmsmath: (signal, targetIsCurrent) => {
			const pending = coordinator.ensureAmsmath(signal, targetIsCurrent);
			gatePromises.push(pending);
			return pending;
		}
	};
	const harness = createHarness(() => false, requester);
	editorRef.current = harness.editor;
	return { ...harness, originalSource, documentBuffer, packagePrompt, scheduled, gatePromises, afterPackageChange };
}

function insertPromptValue(field: FakeMathfield): string[] {
	const template = ownMathLiveTemplate('x+#?');
	queueOwnedPromptIds(field, template.promptIds);
	field.setValue(template.latex);
	return template.promptIds;
}

beforeEach(() => {
	fakeFields = [];
	document.body.innerHTML = '';
});

describe('MathLiveView owned prompt dispatch', () => {
	it('keeps prompt ownership pending after a real PM filter rejection and retries atomically', () => {
		let reject = true;
		const { editor, view, field } = createHarness(() => reject);
		const [id] = insertPromptValue(field);

		view.forwardupdate();
		expect(editor.state.doc.nodeAt(1)?.textContent).toBe('x');
		expect(view.updating).toBe(false);
		expect(field.getValue()).toContain(`\\placeholder[${id}]`);
		expect(pendingOwnedPromptIds(field, field.getValue())).toEqual([id]);

		reject = false;
		view.forwardupdate();
		const accepted = editor.state.doc.nodeAt(1);
		expect(accepted?.textContent).toBe(field.getValue());
		expect(accepted?.attrs.ownedPromptIds).toEqual([id]);
		expect(pendingOwnedPromptIds(field, field.getValue())).toEqual([]);
		expect(view.updating).toBe(false);

		view.destroy();
		editor.destroy();
	});

	it('does not consume provenance when dispatch throws and can retry without losing the field value', () => {
		const { editor, view, field } = createHarness();
		const [id] = insertPromptValue(field);
		const dispatch = editor.dispatch.bind(editor);
		editor.dispatch = () => {
			throw new Error('test dispatch failure');
		};

		expect(() => view.forwardupdate()).toThrow('test dispatch failure');
		expect(editor.state.doc.nodeAt(1)?.textContent).toBe('x');
		expect(pendingOwnedPromptIds(field, field.getValue())).toEqual([id]);
		expect(view.updating).toBe(false);

		editor.dispatch = dispatch;
		view.forwardupdate();
		const accepted = editor.state.doc.nodeAt(1);
		expect(accepted?.textContent).toBe(field.getValue());
		expect(accepted?.attrs.ownedPromptIds).toEqual([id]);
		expect(pendingOwnedPromptIds(field, field.getValue())).toEqual([]);

		view.destroy();
		editor.destroy();
	});

	it('invalidates an async receipt when the document replaces the exact original math node', () => {
		const { editor, view, field } = createHarness();
		const receipt = captureMathfieldEditReceipt(field);
		expect(receipt?.isCurrent()).toBe(true);
		const original = editor.state.doc.nodeAt(receipt!.pos)!;
		const replacement = schema.nodes.inline_math.create({ ...original.attrs }, schema.text(original.textContent));
		const replacementDoc = schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, replacement));

		editor.updateState(EditorState.create({ schema, doc: replacementDoc }));

		expect(receipt?.view).toBe(editor);
		expect(receipt?.doc).not.toBe(editor.state.doc);
		expect(receipt?.node).toBe(original);
		expect(editor.state.doc.nodeAt(receipt!.pos)).not.toBe(original);
		expect(receipt?.isCurrent()).toBe(false);

		view.destroy();
		expect(captureMathfieldEditReceipt(field)).toBeNull();
		editor.destroy();
	});

	it('does not request a package or mutate/save source when a readonly MathLive field dispatches a matrix command', () => {
		const { editor, view, field, originalSource, documentBuffer, packagePrompt, scheduled, gatePromises } = createAmsmathGateHarness();
		field.readOnly = true;

		field.dispatchEvent(new CustomEvent('modutex:virtual-matrix-request', { detail: 1 }));

		expect(captureMathfieldEditReceipt(field)).toBeNull();
		expect(gatePromises).toHaveLength(0);
		expect(packagePrompt.active).toBeNull();
		expect(documentBuffer.texSource).toBe(originalSource);
		expect(scheduled).toEqual([]);
		expect(view.updating).toBe(false);
		view.destroy();
		editor.destroy();
	});

	it('does not apply a pending add-package choice if the exact field becomes readonly', async () => {
		const { editor, view, field, originalSource, documentBuffer, packagePrompt, scheduled, gatePromises, afterPackageChange } =
			createAmsmathGateHarness();

		field.dispatchEvent(new CustomEvent('modutex:virtual-matrix-request', { detail: 1 }));
		const request = packagePrompt.active;
		expect(request).toMatchObject({ packageName: 'amsmath', canAdd: true });
		expect(gatePromises).toHaveLength(1);

		field.readOnly = true;
		packagePrompt.resolve(request!.id, 'add-and-insert');

		await expect(gatePromises[0]).resolves.toBeNull();
		expect(packagePrompt.active).toBeNull();
		expect(documentBuffer.texSource).toBe(originalSource);
		expect(scheduled).toEqual([]);
		expect(afterPackageChange).not.toHaveBeenCalled();
		expect(view.updating).toBe(false);
		view.destroy();
		editor.destroy();
	});

	it('invalidates an existing receipt when the ProseMirror view becomes noneditable', () => {
		const { editor, view, field } = createHarness();
		const receipt = captureMathfieldEditReceipt(field);
		expect(receipt?.isCurrent()).toBe(true);

		editor.setProps({ editable: () => false });

		expect(editor.editable).toBe(false);
		expect(receipt?.isCurrent()).toBe(false);
		expect(captureMathfieldEditReceipt(field)).toBeNull();
		view.destroy();
		editor.destroy();
	});
});
