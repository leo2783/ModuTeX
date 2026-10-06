<script lang="ts">
	import type { EditorView } from 'prosemirror-view';
	import { editorViewStore } from '$lib/stores/editorStore';
	import { FONT_SIZES, PARAGRAPH_ALIGNMENTS, type ParagraphAlignment } from '$lib/schema/text-formatting';
	import {
		applyParagraphAlignment,
		applyTextFontSize,
		captureTextFormattingReceipt,
		supportsTextFormatting,
		type TextFormattingHost,
		type TextFormattingReceipt
	} from '$lib/editor/utils/textFormattingCommands';
	import { m } from '$lib/paraglide/messages';

	const MIXED = '__mixed__';
	const UNAVAILABLE = '__unavailable__';
	const alignmentLabels: Record<ParagraphAlignment, () => string> = {
		auto: () => m.toolbar_alignment_auto(),
		left: () => m.toolbar_alignment_left(),
		center: () => m.toolbar_alignment_center(),
		right: () => m.toolbar_alignment_right()
	};

	let canFormat = $state(false);
	let fontSizeValue = $state<string>(UNAVAILABLE);
	let alignmentValue = $state<string>(UNAVAILABLE);
	let status = $state('');
	let receipt: TextFormattingReceipt | null = null;
	let receiptView: EditorView | null = null;
	let currentView: EditorView | null = null;

	function hostFor(view: EditorView): TextFormattingHost {
		return {
			get state() {
				return view.state;
			},
			get editable() {
				return view.editable;
			},
			dispatch(transaction) {
				view.dispatch(transaction);
			}
		};
	}

	function sameOrMixed(values: string[], emptyValue = ''): string {
		if (values.length === 0) return emptyValue;
		const first = values[0];
		return values.every((value) => value === first) ? first : MIXED;
	}

	function selectedFontSize(state: EditorView['state']): string {
		const selection = state.selection;
		if (selection.empty) {
			const marks = state.storedMarks ?? selection.$from.marks();
			return marks.find((mark) => mark.type.name === 'font_size')?.attrs.size ?? '';
		}
		const values: string[] = [];
		state.doc.nodesBetween(selection.from, selection.to, (node) => {
			if (!node.isText) return;
			values.push(node.marks.find((mark) => mark.type.name === 'font_size')?.attrs.size ?? '');
		});
		return sameOrMixed(values);
	}

	function selectedAlignment(state: EditorView['state']): string {
		const selection = state.selection;
		if (selection.empty) {
			const from = selection.$from;
			if (from.depth !== 1 || from.parent.type.name !== 'paragraph') return '';
			return from.parent.attrs.alignment ?? 'auto';
		}
		const values: string[] = [];
		state.doc.nodesBetween(selection.from, selection.to, (node, _pos, parent) => {
			if (node.type.name === 'paragraph' && parent === state.doc) values.push(node.attrs.alignment ?? 'auto');
		});
		return sameOrMixed(values);
	}

	$effect(() => {
		const view = $editorViewStore;
		if (view !== currentView) {
			currentView = view;
			receipt = null;
			receiptView = null;
			status = '';
		}
		if (!view) {
			canFormat = false;
			fontSizeValue = UNAVAILABLE;
			alignmentValue = UNAVAILABLE;
			return;
		}
		const host = hostFor(view);
		canFormat = supportsTextFormatting(host, captureTextFormattingReceipt(view.state));
		fontSizeValue = canFormat ? selectedFontSize(view.state) : UNAVAILABLE;
		alignmentValue = canFormat ? selectedAlignment(view.state) : UNAVAILABLE;
	});

	function captureReceipt(): void {
		const view = $editorViewStore;
		if (!view) {
			receipt = null;
			receiptView = null;
			return;
		}
		const host = hostFor(view);
		const nextReceipt = captureTextFormattingReceipt(view.state);
		if (!supportsTextFormatting(host, nextReceipt)) {
			receipt = null;
			receiptView = null;
			return;
		}
		receipt = nextReceipt;
		receiptView = view;
		status = '';
	}

	function keepEditorSelection(event: PointerEvent | MouseEvent): void {
		// Let the native select open, but keep the toolbar's global mousedown guard from
		// preventing its focus/default behavior.
		event.stopPropagation();
	}

	function applyChoice(apply: (host: TextFormattingHost, target: TextFormattingReceipt) => boolean): void {
		const view = $editorViewStore;
		const target = receipt;
		if (!view || view !== receiptView || !target || !apply(hostFor(view), target)) {
			status = m.toolbar_formatting_stale();
			receipt = null;
			receiptView = null;
			return;
		}
		status = '';
		view.focus();
	}

	function selectFontSize(event: Event): void {
		const value = (event.currentTarget as HTMLSelectElement).value;
		if (value === MIXED || value === UNAVAILABLE) return;
		applyChoice((host, target) => applyTextFontSize(host, target, value || null));
	}

	function selectAlignment(event: Event): void {
		const value = (event.currentTarget as HTMLSelectElement).value;
		if (!PARAGRAPH_ALIGNMENTS.some((option) => option === value)) return;
		applyChoice((host, target) => applyParagraphAlignment(host, target, value));
	}
</script>

<div class="flex items-center gap-2" role="group" aria-label={m.toolbar_text_formatting_aria()}>
	<label class="flex items-center gap-1 text-xs">
		<span class="text-surface-500">{m.toolbar_text_size_label()}</span>
		<select
			class="select select-sm max-w-32"
			aria-label={m.toolbar_text_size_aria()}
			value={fontSizeValue}
			disabled={!canFormat}
			title={canFormat ? m.toolbar_text_size_aria() : m.toolbar_formatting_unavailable_hint()}
			onfocus={captureReceipt}
			onpointerdown={(event) => {
				keepEditorSelection(event);
				captureReceipt();
			}}
			onmousedown={keepEditorSelection}
			onchange={selectFontSize}
		>
			{#if !canFormat}
				<option value={UNAVAILABLE} disabled>{m.toolbar_formatting_unavailable()}</option>
			{:else if fontSizeValue === MIXED}
				<option value={MIXED} disabled>{m.toolbar_formatting_mixed()}</option>
			{/if}
			<option value="">{m.toolbar_text_size_default()}</option>
			{#each FONT_SIZES as size (size)}
				<option value={size}>{`\\${size}`}</option>
			{/each}
		</select>
	</label>
	<label class="flex items-center gap-1 text-xs">
		<span class="text-surface-500">{m.toolbar_alignment_label()}</span>
		<select
			class="select select-sm max-w-32"
			aria-label={m.toolbar_alignment_aria()}
			value={alignmentValue}
			disabled={!canFormat}
			title={canFormat ? m.toolbar_alignment_aria() : m.toolbar_formatting_unavailable_hint()}
			onfocus={captureReceipt}
			onpointerdown={(event) => {
				keepEditorSelection(event);
				captureReceipt();
			}}
			onmousedown={keepEditorSelection}
			onchange={selectAlignment}
		>
			{#if !canFormat}
				<option value={UNAVAILABLE} disabled>{m.toolbar_formatting_unavailable()}</option>
			{:else if alignmentValue === MIXED}
				<option value={MIXED} disabled>{m.toolbar_formatting_mixed()}</option>
			{/if}
			{#each PARAGRAPH_ALIGNMENTS as alignment (alignment)}
				<option value={alignment}>{alignmentLabels[alignment]()}</option>
			{/each}
		</select>
	</label>
	<span class="sr-only" role="status" aria-live="polite">{status}</span>
</div>
