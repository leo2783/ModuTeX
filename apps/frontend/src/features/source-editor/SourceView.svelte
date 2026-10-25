<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
	import { invoke, isTauri } from '@tauri-apps/api/core';
	import type { ImageContext } from '../images/store.ts';
	import { clipboardImage } from '../images/view.ts';
	import { Compartment, EditorState } from '@codemirror/state';
	import { EditorView, lineNumbers, highlightActiveLineGutter, keymap } from '@codemirror/view';
	import type { EditorProjection, SourceDocument, SourceProjection, SourceSpan, SourcePatch } from '../document-core/core.ts';
	import { ParserClient } from '../parser/client.ts';
	import { VisualEditor } from '../visual-editor/view.ts';
	import 'prosemirror-view/style/prosemirror.css';
	import { createSourceState, sourceState, sourcePatches, sourcePatchTransaction, historyTransaction, savedCheckpoint, insertionTarget, insertionTransaction, type InsertionTarget } from './state.ts';
	import { cellMoveTransaction } from './cell-move.ts';
	import MathPanel from '../math/MathPanel.svelte';
	import ToolbarIcon from '../../components/ToolbarIcon.svelte';
	import CodePanel from '../code/CodePanel.svelte';
	import { codeAt, codeEditTransaction, type LocatedCode, type CodeDraft } from '../code/source.ts';
	import { equationAt, equationSource, matrixSource, type EquationDraft, type LocatedEquation } from '../math/source.ts';
	import { equationEditTransaction } from '../math/editor.ts';
	import TablePanel from '../tables/TablePanel.svelte';
	import { tableAt, type TableDraft } from '../tables/source.ts';
	import { rangeInsertionTarget, sourceNavigationTransaction } from './state.ts';
	import { diagnosticSourceSpan, type DiagnosticNavigationRequest } from './diagnostics.ts';
	import { foldCode, unfoldAll } from '@codemirror/language';
	import { foldProjection, sourceFolding } from './folding.ts';
	import { formatShortcut, formatTransaction, colorTransaction, type TextFormat } from './format.ts';
	import { rawEditTransaction } from './raw.ts';
	import { visualInsertionTransaction, paragraphInsertionTransaction } from './state.ts';
	import { booktabsPlan, tableInsertionTransaction, withPackage, type PackagePlan } from '../tables/preamble.ts';
	import { text, type Language } from '../../i18n/text.ts';
	let { document, label, saving, savedVersion, active = true, fontSize = 14, showLineNumbers = true, wrapLines = false, navigation = null, diagnosticNavigation = null, locale = 'zh-Hant', imageContext = null, formatWorkspaceId = null, viewMode = 'visual', onViewModeChange, onChange, onRejected, onVisualRejected, onProjection, onParserFailure }: { document: SourceDocument; label: string;
		imageContext?: ((writing: boolean) => Promise<ImageContext>) | null;
		formatWorkspaceId?: string | null;
		viewMode?: 'source' | 'visual'; onViewModeChange?: (mode: 'source' | 'visual') => void;
		active?: boolean; fontSize?: number; showLineNumbers?: boolean; wrapLines?: boolean; locale?: Language;
		navigation?: { readonly span: SourceSpan; readonly sequence: number; readonly sourceOnly?: boolean } | null;
		diagnosticNavigation?: DiagnosticNavigationRequest | null;
		saving: boolean; savedVersion: number | null;
		onProjection: (projection: SourceProjection) => void; onParserFailure: () => void;
		onChange: (source: SourceDocument, dirty: boolean) => void; onRejected: (reason?: 'SOURCE_TOO_LARGE') => void; onVisualRejected: () => void } = $props();
	/** Read at call time so callbacks and markup follow the current per-view locale. */
	const t = (traditionalChinese: string, english: string) => text(locale, traditionalChinese, english);
	type ToolError = 'raw-stale' | 'raw-apply' | 'preamble' | 'table-apply' | 'format' | 'insert-selection' | 'insert-stale' | 'table-pending' | 'table-cursor'
		| 'equation-cursor' | 'equation-stale' | 'equation-apply' | 'table-stale' | 'inline-only' | 'insert' | 'navigation' | 'diagnostic' | 'image';
	function toolMessage(code: ToolError): string {
		switch (code) {
			case 'raw-stale': return t('內容已變更，請重新選取區段。', 'The content changed. Select the section again.');
			case 'raw-apply': return t('無法套用內容。請確認區段未變更，且文件未超過 5 MiB。', 'Could not apply the change. Make sure the section is unchanged and the document stays within 5 MiB.');
			case 'preamble': return t('無法安全修改前言。請在原始碼加入 \\usepackage{booktabs}，或改選等粗線。', 'Could not safely update the preamble. Add \\usepackage{booktabs} in the source, or choose equal-weight rules.');
			case 'table-apply': return t('無法套用表格。請確認插入位置未變更，且文件未超過 5 MiB。', 'Could not apply the table. Make sure the insertion point is unchanged and the document stays within 5 MiB.');
			case 'format': return t('請將游標放在文字儲存格中，或選取要格式化的文字。', 'Place the cursor in a text cell or select text to format.');
			case 'insert-selection': return t('請將游標放在文字中，或選取同一段文字；未知語法請在原始碼修改。', 'Place the cursor in text or select text within one paragraph. Edit unknown syntax in the source.');
			case 'insert-stale': return t('內容已變更，請重新選取插入位置。', 'The content changed. Select the insertion point again.');
			case 'table-pending': return t('表格資訊尚未更新。請稍後再試。', 'Table information is still updating. Try again shortly.');
			case 'table-cursor': return t('請將游標放在可編輯的表格內；其他格式可在原始碼修改。', 'Place the cursor inside an editable table. Edit other formats in the source.');
			case 'equation-cursor': return t('請將游標放在公式內；未支援的環境可在原始碼修改。', 'Place the cursor inside an equation. Edit unsupported environments in the source.');
			case 'equation-stale': return t('公式內容已變更。請重新選取。', 'The equation changed. Select it again.');
			case 'equation-apply': return t('公式內容已變更。請關閉工具後重新選取。', 'The equation changed. Close the tool and select it again.');
			case 'table-stale': return t('表格內容已變更。請重新選取。', 'The table changed. Select it again.');
			case 'inline-only': return t('標題或格式文字內請選行內公式；表格與獨立公式請插入正文。', 'Use an inline equation inside headings or formatted text. Insert tables and display equations in body text.');
			case 'insert': return t('無法插入。請確認位置未變更，且文件未超過 5 MiB。', 'Could not insert. Make sure the position is unchanged and the document stays within 5 MiB.');
			case 'navigation': return t('章節位置已變更。請等待大綱更新後再選取。', 'The section moved. Wait for the outline to update, then select it again.');
			case 'image': return t('圖片未插入。請確認文件已儲存，並選用 5 MiB 以下的 PNG／JPEG 圖片。', 'Image was not inserted. Save the document and use a PNG/JPEG image under 5 MiB.');
			case 'diagnostic': return t('錯誤位置無法對應此文件，請查看編譯記錄。', 'Diagnostic location is unavailable in this document. See the compilation log.');
		}
	}
	let target: HTMLDivElement;
	let visualTarget: HTMLDivElement;
	let cellToolbarTarget: HTMLDivElement;
	let visual = $state.raw<VisualEditor | null>(null);
	let mode = $state<'source' | 'visual'>(untrack(() => viewMode));
	$effect(() => {
		const next = viewMode;
		const changed = untrack(() => {
			if (mode === next) return false;
			mode = next;
			return true;
		});
		if (changed && next === 'visual') untrack(() => syncVisualProjection());
	});
	function setMode(next: 'source' | 'visual') {
		if (mode === next) return;
		mode = next;
		if (next === 'visual') syncVisualProjection();
		onViewModeChange?.(next);
	}
	let visualStatus = $state<'ready' | 'updating'>('updating');
	let parserFailed = $state(false);
	let retryParser: (() => void) | null = null;
	let editor = $state.raw<EditorView | null>(null);
	const permission = new Compartment();
	const gutter = new Compartment(), wrapping = new Compartment(), labels = new Compartment();
	let tool = $state<'equation' | 'matrix' | 'table' | 'raw' | 'code' | 'image' | null>(null);
	let codePanelHost = $state.raw<HTMLDivElement | null>(null);
	let imageInput: HTMLInputElement;
	let imageSequence = 0;
	async function insertImage(file: Blob) {
		if (!editor || !imageContext || !active || saving || tool !== null) return;
		const owner = editor.state.field(sourceState).projection.document;
		const captured = mode === 'visual' ? visual?.toolInsertionSelection() : null;
		const point = captured?.span ?? { ...insertionTarget(editor.state) };
		const ticket = ++imageSequence;
		tool = 'image'; toolError = null;
		try {
			const { storeImage, imageSource } = await import('../images/store.ts');
			const context = await imageContext(true);
			if (ticket !== imageSequence || tool !== 'image' || !editor || editor.state.field(sourceState).projection.document !== owner || !active) return;
			const path = await storeImage(context, file);
			if (ticket !== imageSequence || tool !== 'image' || !editor || editor.state.field(sourceState).projection.document !== owner || !active) return;
			const transaction = visualInsertionTransaction(editor.state, point, imageSource(path), captured?.inlineOnly ?? false);
			editor.dispatch(withPackage(editor.state, transaction, 'graphicx'));
		} catch { if (ticket === imageSequence) toolError = 'image'; }
		finally { if (ticket === imageSequence) { if (tool === 'image') tool = null; if (imageInput) imageInput.value = ''; visual?.refresh(); } }
	}
	async function loadImage(path: string) {
		if (!imageContext) throw new Error('IMAGE_UNAVAILABLE');
		const { readImage } = await import('../images/store.ts'); return readImage(await imageContext(false), path);
	}
	let codeDraft = $state.raw<LocatedCode | null>(null), codeKey = $state('insert');
	function openCode(span?: SourceSpan) {
		if (!editor || !active || saving) return;
		if (tool !== null) closeTool();
		try {
			const captured = !span && mode === 'visual' ? visual?.toolInsertionSelection() : null;
			const boundary = span ?? captured?.span;
			if (mode === 'visual' && !boundary) throw new Error('INSERTION_RANGE');
			insertion = boundary ? rangeInsertionTarget(editor.state, boundary) : insertionTarget(editor.state);
			visualInsertion = captured ?? (boundary ? { span: boundary, inlineOnly: false } : null);
			codeDraft = null; codeKey = `insert:${++draftSequence}`;
			toolOwner = mode === 'visual' ? 'visual' : 'source'; toolError = null; tool = 'code';
		} catch { toolError = 'insert-stale'; }
	}
	function applyCode(draft: CodeDraft) {
		if (!editor || !active || saving || !codeDraft) return;
		try { const transaction = codeEditTransaction(editor.state, codeDraft, draft); if (transaction) editor.dispatch(draft.language && draft.language !== 'text' ? withPackage(editor.state, transaction, 'listings') : transaction); closeTool(); }
		catch { toolError = 'raw-apply'; }
	}
	let rawSpan: SourceSpan | null = null;
	let rawOriginal = '', rawDraft = $state('');
	let rawInput = $state.raw<HTMLTextAreaElement | null>(null);
	function openRaw(value: string, span: SourceSpan) {
		if (!editor || !active || saving) return;
		if (tool !== null) closeTool();
		try {
			const source = editor.state.field(sourceState).projection.document;
			rangeInsertionTarget(editor.state, span);
			if (source.read(span.from, span.to) !== value) throw new Error('STALE_RAW');
			const located = parsed ? codeAt(source, parsed, span.from) : null;
			if (located?.span.from === span.from && located.span.to === span.to) {
				codeDraft = located; codeKey = `edit:${++draftSequence}`; insertion = rangeInsertionTarget(editor.state, span);
				visualInsertion = { span, inlineOnly: false }; toolOwner = 'visual'; toolError = null; tool = 'code'; return;
			}
			rawSpan = span; rawOriginal = value; rawDraft = value; toolError = null; toolOwner = 'visual'; tool = 'raw';
		} catch { toolError = 'raw-stale'; }
	}
	function applyRaw() {
		if (!editor || !active || saving || tool !== 'raw' || !rawSpan) return;
		try {
			const transaction = rawEditTransaction(editor.state, rawSpan, rawOriginal, rawDraft);
			if (transaction) editor.dispatch(transaction);
			closeTool();
		} catch { toolError = 'raw-apply'; }
	}
	$effect(() => { if (active && tool === 'raw') rawInput?.focus(); });
	let insertion: InsertionTarget | null = null;
	let visualInsertion: { span: SourceSpan; inlineOnly: boolean; atCaret?: boolean } | null = null;
	let toolOwner: 'source' | 'visual' = 'source';
	let mathPanelHost = $state.raw<HTMLDivElement | null>(null), tablePanelHost = $state.raw<HTMLDivElement | null>(null);
	let pendingPackage = $state.raw<{ source: string; plan: PackagePlan } | null>(null);
	function insertTable(source: string, booktabs = false) {
		if (!editor || !insertion || !active || saving || tool !== 'table') return;
		try {
			if (booktabs) {
				if (!parsed) throw new Error('PREAMBLE_UNSUPPORTED');
				const plan = booktabsPlan(editor.state.field(sourceState).projection.document, parsed);
				if (plan) { pendingPackage = { source, plan }; toolError = null; return; }
			}
			commitTable(source);
		} catch { toolError = 'preamble'; }
	}
	function commitTable(source: string, plan?: PackagePlan) {
		if (!editor || !insertion || !active || saving || tool !== 'table') return;
		try {
			const transaction = tableInsertionTransaction(editor.state, insertion, source, plan, visualInsertion);
			if (!transaction.docChanged && (plan || editor.state.doc.sliceString(insertion.from, insertion.to) !== source)) throw new Error('INSERTION_REJECTED');
			editor.dispatch(transaction); focusInsertedBlock('table_block'); closeTool();
		} catch { toolError = 'table-apply'; }
	}
	let parsed = $state.raw<SourceProjection | null>(null);
	let pendingParagraph: { documentId: string; version: number; from: number } | null = null;
	let pendingBlock: { documentId: string; version: number; to: number; kind: 'table_block' | 'math_block' } | null = null;
	function syncVisualProjection() {
		const view = editor, currentVisual = visual, projection = parsed;
		if (mode !== 'visual' || !view || !currentVisual || !projection) return;
		const current = view.state.field(sourceState).projection.document;
		if (projection.documentId !== current.documentId || projection.version !== current.version) return;
		currentVisual.sync(projection);
		if (pendingParagraph) {
			if (projection.documentId === pendingParagraph.documentId && projection.version === pendingParagraph.version) {
				const from = pendingParagraph.from;
				currentVisual.view.state.doc.forEach((node) => {
					if (node.attrs.from === from && node.attrs.name === 'par') currentVisual.navigate({ documentId: projection.documentId, version: projection.version, from, to: node.attrs.to }, true);
				});
				pendingParagraph = null;
			} else if (projection.documentId !== pendingParagraph.documentId || projection.version > pendingParagraph.version) {
				pendingParagraph = null;
			}
		}
		if (pendingBlock) {
			if (projection.documentId === pendingBlock.documentId && projection.version === pendingBlock.version) {
				let selected: SourceSpan | null = null;
				const request = pendingBlock;
				currentVisual.view.state.doc.forEach((node) => {
					if (node.type.name === request.kind && node.attrs.to <= request.to) selected = { documentId: projection.documentId, version: projection.version, from: node.attrs.from, to: node.attrs.to };
				});
				if (selected) currentVisual.navigate(selected);
				pendingBlock = null;
			} else if (projection.documentId !== pendingBlock.documentId || projection.version > pendingBlock.version) {
				pendingBlock = null;
			}
		}
	}
	function focusInsertedBlock(kind: 'table_block' | 'math_block') {
		if (!editor || mode !== 'visual') return;
		const projection = editor.state.field(sourceState).projection;
		pendingBlock = { documentId: projection.document.documentId, version: projection.document.version, to: projection.toSource(editor.state.selection.main.head), kind };
	}
	let tableDraft = $state.raw<TableDraft | null>(null);
	let tableKey = $state('insert'), editingTable = $state(false), toolError = $state<ToolError | null>(null);
	let equation = $state.raw<LocatedEquation | null>(null);
	let equationKey = $state('insert');
	let insertInline = $state(false);
	let insertMatrix = $state(false);
	let mathMenu = $state.raw<HTMLDetailsElement | null>(null);
	let colorMenu = $state.raw<HTMLDetailsElement | null>(null);
	function applyColor(hex: string) {
		if (!editor || !parsed || !active || saving || tool !== null) return;
		if (colorMenu) colorMenu.open = false;
		try {
			const span = mode === 'visual' ? visual?.formatSelection() : undefined;
			if (mode === 'visual' && (!span || span.from === span.to)) throw new Error('FORMAT_RANGE');
			editor.dispatch(colorTransaction(editor.state, parsed, hex, span ?? undefined));
			toolError = null;
		} catch { toolError = 'format'; }
	}
	let draftSequence = 0;
	let handledNavigation = 0;
	let handledDiagnosticNavigation = 0;
	let scheduledDiagnosticNavigation = 0;
	let disposed = false;
	const FORMAT_SOURCE_MAX_BYTES = 5 * 1024 * 1024;
	let sourceFormatting = $state(false);
	let sourceFormatMessage = $state<string | null>(null);
	let sourceFormatSequence = 0;
	function boundedUtf8Length(value: string, maximum: number): number | null {
		let bytes = 0;
		for (let index = 0; index < value.length; index++) {
			const code = value.charCodeAt(index);
			if (code <= 0x7f) bytes++;
			else if (code <= 0x7ff) bytes += 2;
			else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
				const next = value.charCodeAt(index + 1);
				if (next >= 0xdc00 && next <= 0xdfff) { bytes += 4; index++; }
				else bytes += 3;
			} else bytes += 3;
			if (bytes > maximum) return null;
		}
		return bytes;
	}
	function splitsSourceBoundary(value: string, offset: number): boolean {
		if (offset <= 0 || offset >= value.length) return false;
		const previous = value.charCodeAt(offset - 1), current = value.charCodeAt(offset);
		return (previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff) ||
			(previous === 0x0d && current === 0x0a);
	}
	function minimalSourcePatch(before: string, after: string): SourcePatch | null {
		if (before === after) return null;
		const commonLength = Math.min(before.length, after.length);
		let prefix = 0;
		while (prefix < commonLength && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix++;
		if (splitsSourceBoundary(before, prefix) || splitsSourceBoundary(after, prefix)) prefix--;
		let suffix = 0;
		while (
			suffix < before.length - prefix && suffix < after.length - prefix &&
			before.charCodeAt(before.length - suffix - 1) === after.charCodeAt(after.length - suffix - 1)
		) suffix++;
		while (suffix > 0 &&
			(splitsSourceBoundary(before, before.length - suffix) || splitsSourceBoundary(after, after.length - suffix))) suffix--;
		const to = before.length - suffix, afterTo = after.length - suffix;
		return { from: prefix, to, insert: after.slice(prefix, afterTo), expected: before.slice(prefix, to) };
	}
	function sourceFormatFailure(error: unknown): string {
		const detail = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
		if (detail.includes('LATEXINDENT_NOT_FOUND')) {
			return t('找不到 latexindent.exe。請安裝 TeX Live 或 MiKTeX，並將 latexindent.exe 加入 PATH。', 'latexindent.exe was not found. Install TeX Live or MiKTeX and add latexindent.exe to PATH.');
		}
		if (detail.includes('SOURCE_FORMAT_LIMIT')) {
			return t('文件超過 5 MiB，未變更原始碼。', 'Source exceeds 5 MiB. The source was not changed.');
		}
		if (detail.includes('SOURCE_FORMAT_BUSY')) {
			return t('格式化工具正在使用中，請稍後再試。', 'The formatter is busy. Try again shortly.');
		}
		return t('格式化失敗，原始碼未變更。', 'Formatting failed. The source was not changed.');
	}
	async function formatSource() {
		const view = editor;
		const workspaceId = formatWorkspaceId;
		if (!view || !workspaceId || !isTauri() || mode !== 'source' || !active || saving ||
			tool !== null || view.state.readOnly || sourceFormatting) return;
		const source = view.state.field(sourceState).projection.document;
		const sourceText = source.read();
		const documentId = source.documentId;
		const documentVersion = source.version;
		const selection = view.state.selection.ranges.map((range) => [range.anchor, range.head] as const);
		if (!Number.isSafeInteger(documentVersion) || documentVersion < 0 ||
			boundedUtf8Length(sourceText, FORMAT_SOURCE_MAX_BYTES) === null) {
			sourceFormatMessage = t('文件超過 5 MiB，未變更原始碼。', 'Source exceeds 5 MiB. The source was not changed.');
			return;
		}
		const sequence = ++sourceFormatSequence;
		sourceFormatting = true;
		sourceFormatMessage = null;
		try {
			const receipt = await invoke<unknown>('frontend_format_latex', {
				request: { workspaceId, text: sourceText, documentId, documentVersion }
			});
			if (disposed || sequence !== sourceFormatSequence) return;
			if (typeof receipt !== 'object' || receipt === null || Array.isArray(receipt)) {
				throw new Error('INVALID_FORMAT_RECEIPT');
			}
			const result = receipt as Record<string, unknown>;
			if (result.documentId !== documentId || result.documentVersion !== documentVersion ||
				typeof result.formatted !== 'string' ||
				boundedUtf8Length(result.formatted, FORMAT_SOURCE_MAX_BYTES) === null) {
				throw new Error('INVALID_FORMAT_RECEIPT');
			}
			const formatted = result.formatted.replace(/\r\n|\r|\n/g, source.profile.preferredLineEnding);
			if (boundedUtf8Length(formatted, FORMAT_SOURCE_MAX_BYTES) === null) {
				throw new Error('SOURCE_FORMAT_LIMIT');
			}
			const current = view.state.field(sourceState).projection.document;
			const currentSelection = view.state.selection.ranges;
			const selectionMatches = currentSelection.length === selection.length &&
				currentSelection.every((range, index) =>
					range.anchor === selection[index]?.[0] && range.head === selection[index]?.[1]);
			if (editor !== view || document.documentId !== documentId || document.version !== documentVersion ||
				current.documentId !== documentId || current.version !== documentVersion ||
				formatWorkspaceId !== workspaceId ||
				!selectionMatches || mode !== 'source' || !active || saving || tool !== null ||
				view.state.readOnly || !isTauri()) {
				sourceFormatMessage = t('內容或選取位置已變更，格式化結果未套用。', 'The source or selection changed. The formatting result was not applied.');
				return;
			}
			const patch = minimalSourcePatch(sourceText, formatted);
			if (patch) {
				const transaction = sourcePatchTransaction(view.state, { documentId, version: documentVersion }, [{
					...patch
				}]);
				view.dispatch(transaction);
			}
		} catch (error) {
			if (!disposed && sequence === sourceFormatSequence && editor === view) {
				sourceFormatMessage = sourceFormatFailure(error);
			}
		} finally {
			if (!disposed && sequence === sourceFormatSequence) sourceFormatting = false;
		}
	}
	interface CurrentMcpEditor {
		readonly view: EditorView;
		readonly projection: EditorProjection;
		readonly source: SourceDocument;
	}
	function currentMcpEditor(
		documentId: string,
		documentVersion: number,
		editable = false
	): CurrentMcpEditor | null {
		const view = editor;
		if (!view || disposed || view !== editor) return null;
		try {
			const projection = view.state.field(sourceState).projection;
			const current = projection.document;
			if (document.documentId !== current.documentId || document.version !== current.version) return null;
			if (current.documentId !== documentId || current.version !== documentVersion) return null;
			if (editable && (!active || saving || tool !== null || view.state.readOnly)) return null;
			return { view, projection, source: current };
		} catch {
			return null;
		}
	}
	function sourceOffsetAtEditorPosition(
		projection: EditorProjection,
		position: number,
		sourceLength: number
	): number | null {
		try {
			const offset = projection.toSource(position);
			return Number.isSafeInteger(offset) && offset >= 0 && offset <= sourceLength
				? offset
				: null;
		} catch {
			return null;
		}
	}
	function sourceLineColumn(sourceText: string, offset: number): { readonly line: number; readonly column: number } | null {
		if (!Number.isSafeInteger(offset) || offset < 0 || offset > sourceText.length) return null;
		let line = 1;
		let column = 1;
		for (let index = 0; index < offset;) {
			const code = sourceText.charCodeAt(index);
			if (code === 0x0d) {
				index += index + 1 < offset && sourceText.charCodeAt(index + 1) === 0x0a ? 2 : 1;
				line++;
				column = 1;
			} else if (code === 0x0a) {
				index++;
				line++;
				column = 1;
			} else {
				index++;
				column++;
			}
		}
		return Object.freeze({ line, column });
	}
	export function getEditorSelection(
		documentId: string,
		documentVersion: number
	): {
		readonly documentId: string;
		readonly documentVersion: number;
		readonly cursor: { readonly line: number; readonly column: number };
		readonly selection: {
			readonly start: { readonly line: number; readonly column: number };
			readonly end: { readonly line: number; readonly column: number };
		} | null;
	} | null {
		const current = currentMcpEditor(documentId, documentVersion);
		if (!current) return null;
		try {
			const sourceText = current.source.read();
			const selected = current.view.state.selection.main;
			const cursorOffset = sourceOffsetAtEditorPosition(current.projection, selected.head, sourceText.length);
			const cursor = cursorOffset === null ? null : sourceLineColumn(sourceText, cursorOffset);
			if (!cursor) return null;
			let selection: {
				readonly start: { readonly line: number; readonly column: number };
				readonly end: { readonly line: number; readonly column: number };
			} | null = null;
			if (!selected.empty) {
				const anchor = sourceOffsetAtEditorPosition(current.projection, selected.anchor, sourceText.length);
				const head = sourceOffsetAtEditorPosition(current.projection, selected.head, sourceText.length);
				if (anchor === null || head === null) return null;
				const start = sourceLineColumn(sourceText, Math.min(anchor, head));
				const end = sourceLineColumn(sourceText, Math.max(anchor, head));
				if (!start || !end) return null;
				selection = Object.freeze({ start, end });
			}
			if (editor !== current.view || disposed) return null;
			return Object.freeze({
				documentId,
				documentVersion,
				cursor,
				selection
			});
		} catch {
			return null;
		}
	}
	export function applySourcePatches(
		identity: { readonly documentId: string; readonly version: number },
		patches: readonly SourcePatch[]
	): boolean {
		if (!editor || disposed || saving || tool !== null) return false;
		try {
			const current = editor.state.field(sourceState).projection.document;
			if (current.documentId !== identity.documentId || current.version !== identity.version) return false;
			editor.dispatch(sourcePatchTransaction(editor.state, identity, patches, false, true));
			return true;
		} catch {
			return false;
		}
	}
	function completeDiagnosticNavigation(sequence: number) {
		handledDiagnosticNavigation = Math.max(handledDiagnosticNavigation, sequence);
	}
	function diagnosticDocumentMatches(view: EditorView, request: DiagnosticNavigationRequest): boolean {
		if (document.documentId !== request.documentId || document.version !== request.documentVersion) return false;
		try {
			const current = view.state.field(sourceState).projection.document;
			return current.documentId === request.documentId && current.version === request.documentVersion;
		} catch { return false; }
	}
	function focusAfterDiagnostic(view: EditorView, request: DiagnosticNavigationRequest) {
		const selection = view.state.selection.main;
		const ownerDocument = view.dom.ownerDocument;
		const originatingActiveElement = ownerDocument.activeElement;
		scheduledDiagnosticNavigation = request.sequence;
		void tick().then(() => {
			if (disposed || editor !== view || scheduledDiagnosticNavigation !== request.sequence) return;
			if (diagnosticNavigation?.sequence !== request.sequence) {
				scheduledDiagnosticNavigation = 0;
				return;
			}
			if (!active || saving || tool !== null || view.state.readOnly) {
				scheduledDiagnosticNavigation = 0;
				return;
			}
			if (!diagnosticDocumentMatches(view, request)) {
				scheduledDiagnosticNavigation = 0;
				completeDiagnosticNavigation(request.sequence);
				return;
			}
			if (mode !== 'source') {
				scheduledDiagnosticNavigation = 0;
				completeDiagnosticNavigation(request.sequence);
				return;
			}
			const currentSelection = view.state.selection.main;
			if (currentSelection.anchor !== selection.anchor || currentSelection.head !== selection.head) {
				scheduledDiagnosticNavigation = 0;
				completeDiagnosticNavigation(request.sequence);
				return;
			}
			const activeElement = ownerDocument.activeElement;
			if (activeElement !== originatingActiveElement && activeElement !== null &&
				activeElement !== ownerDocument.body && activeElement.isConnected &&
				!view.dom.contains(activeElement) && !view.hasFocus) {
				scheduledDiagnosticNavigation = 0;
				completeDiagnosticNavigation(request.sequence);
				return;
			}
			try {
				view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: 'nearest' }) });
				view.focus();
			} catch { toolError = 'diagnostic'; }
			completeDiagnosticNavigation(request.sequence);
			if (scheduledDiagnosticNavigation === request.sequence) scheduledDiagnosticNavigation = 0;
		}).catch(() => {
			if (scheduledDiagnosticNavigation === request.sequence) scheduledDiagnosticNavigation = 0;
		});
	}
	function applyFormat(format: TextFormat) {
		if (!editor || !parsed || !active || saving || tool !== null) return;
		try {
			const useVisual = mode === 'visual';
			const visualSelection = useVisual ? visual?.view.state.selection : null;
			if (visualSelection?.empty) {
				if (!visual?.toggleFormat(format)) throw new Error('FORMAT_RANGE');
				toolError = null;
				visual.focus();
				return;
			}
			const span = useVisual ? visual?.formatSelection() ?? null : undefined;
			if (span === null || span && span.from === span.to) throw new Error('FORMAT_RANGE');
			editor.dispatch(formatTransaction(editor.state, parsed, format, span));
			toolError = null; if (!useVisual) editor.focus(); else visual?.focus();
		} catch { toolError = 'format'; }
	}
	function applyStructure(kind: string) {
		if (!editor || !active || saving || tool !== null || mode !== 'visual') return;
		const selected = visual?.textStructureSelection();
		if (!selected) { toolError = 'format'; return; }
		const { span, content } = selected;
		const value = kind === 'abstract' ? '\\begin{abstract}\n' + content + '\n\\end{abstract}'
			: kind === 'title' ? '\\title{' + content + '}\n\\maketitle'
			: kind === 'paragraph' ? content : '\\' + kind + '{' + content + '}';
		try {
			const source = editor.state.field(sourceState).projection.document;
			editor.dispatch(sourcePatchTransaction(editor.state, span, [{ from: span.from, to: span.to, insert: '\n' + value + '\n\n', expected: source.read(span.from, span.to) }]));
			toolError = null;
		} catch { toolError = 'format'; }
	}
	function openTool(kind: 'equation' | 'matrix' | 'table') {
		if (!editor || saving || !active) return;
		if (mathMenu) mathMenu.open = false;
		insertInline = false;
		if (tool !== null) closeTool();
		const useVisual = mode === 'visual';
		if (useVisual) {
			const captured = visual?.toolInsertionSelection();
			if (captured) openToolAtBoundary(kind, captured.span, captured.inlineOnly, captured.atCaret); else toolError = 'insert-selection';
			return;
		}
		const captured = useVisual ? visual?.insertionSelection() ?? null : null;
		if (useVisual && !captured) { toolError = 'insert-selection'; return; }
		try { insertion = captured ? rangeInsertionTarget(editor.state, captured.span) : insertionTarget(editor.state); }
		catch { toolError = 'insert-stale'; return; }
		visualInsertion = captured; toolOwner = useVisual ? 'visual' : 'source';
		toolError = null; editingTable = false; tableKey = 'insert';
		equation = null; equationKey = `insert:${++draftSequence}`;
		tool = kind;
	}
	function editTable() {
		if (!editor || saving) return;
		if (tool !== null) closeTool();
		const projection = editor.state.field(sourceState).projection;
		if (!parsed || parsed.documentId !== projection.document.documentId || parsed.version !== projection.document.version) {
			toolError = 'table-pending'; return;
		}
		const located = tableAt(projection.document, parsed, projection.toSource(editor.state.selection.main.head));
		if (!located) { toolError = 'table-cursor'; return; }
		openTable(located.draft, located.span, 'source');
	}
	function editEquation() {
		if (!editor || saving || !active) return;
		if (tool !== null) closeTool();
		const source = editor.state.field(sourceState).projection;
		const located = parsed && equationAt(source.document, parsed, source.toSource(editor.state.selection.main.head));
		if (!located) { toolError = 'equation-cursor'; return; }
		try {
			insertion = rangeInsertionTarget(editor.state, located.span); equation = located;
			equationKey = `${located.span.documentId}:${located.span.version}:${located.span.from}:${located.span.to}`;
			toolError = null; toolOwner = 'source'; tool = 'equation';
		} catch { toolError = 'equation-stale'; }
	}
	function applyEquation(draft: EquationDraft) {
		if (!editor || !active || saving) return;
		insertInline = draft.inline;
		try {
			if (equation) {
				const transaction = equationEditTransaction(editor.state, equation, draft);
				if (transaction) editor.dispatch(withPackage(editor.state, transaction, ['amsmath', 'amssymb']));
				closeTool();
			} else insert(equationSource(draft.latex, draft.inline).replace(/\r\n|\r/g, '\n'));
		}
		catch { toolError = 'equation-apply'; }
	}
	function openInlineEquation() {
		if (!editor || saving || !active || tool !== null) return;
		insertMatrix = false;
		if (mathMenu) mathMenu.open = false;
		try {
			const captured = mode === 'visual' ? visual?.toolInsertionSelection(true) : null;
			if (mode === 'visual' && !captured) { toolError = 'insert-selection'; return; }
			insertion = captured ? rangeInsertionTarget(editor.state, captured.span) : insertionTarget(editor.state);
			visualInsertion = captured ? { ...captured, inlineOnly: true } : null;
			toolOwner = mode === 'visual' ? 'visual' : 'source';
			insertInline = true; equation = null; equationKey = `insert:${++draftSequence}`;
			toolError = null; tool = 'equation';
		} catch { toolError = 'insert-stale'; }
	}
	function openEquation(_draft: EquationDraft, span: SourceSpan) {
		if (!editor || !active || saving || !parsed) return;
		if (tool !== null) closeTool();
		const source = editor.state.field(sourceState).projection.document;
		if (span.documentId !== source.documentId || span.version !== source.version) return;
		const located = equationAt(source, parsed, span.from);
		if (!located || located.span.to !== span.to) return;
		try { insertion = rangeInsertionTarget(editor.state, located.span); equation = located; equationKey = `${span.documentId}:${span.version}:${span.from}:${span.to}`; toolError = null; toolOwner = 'visual'; tool = 'equation'; }
		catch { toolError = 'equation-stale'; }
	}
	function openTable(draft: TableDraft, span: SourceSpan, owner: 'source' | 'visual' = 'visual') {
		if (!editor || saving || !active) return;
		if (tool !== null) closeTool();
		try {
			insertion = rangeInsertionTarget(editor.state, span);
			tableDraft = draft; tableKey = `${span.documentId}:${span.version}:${span.from}:${span.to}`;
			editingTable = true; toolError = null; toolOwner = owner; tool = 'table';
		} catch { toolError = 'table-stale'; }
	}
	function closeTool() { if (tool === 'image') imageSequence++; visual?.closeEquation(); tool = null; insertion = null; visualInsertion = null; equation = null; pendingPackage = null; toolError = null; visual?.refresh(); if (!active) return; if (mode === 'source') editor?.focus(); else visual?.focus(); }
	$effect(() => {
		if (!active || mode !== 'visual' || tool !== 'equation' || !visual) return;
		const span = equation?.span ?? visualInsertion?.span;
		if (!span) return;
		const current = visual;
		if (!current.startEquation(equation?.draft ?? { latex: insertMatrix ? matrixSource({ rows: 3, columns: 3, cells: Array(9).fill('\\placeholder{}') }, 'parentheses') : '', inline: insertInline }, span, applyEquation, closeTool, visualInsertion?.atCaret ?? false)) toolError = 'equation-stale';
		return () => current.closeEquation();
	});
	$effect(() => {
		if (!active || mode !== 'visual' || !visual || (tool !== 'matrix' && tool !== 'table' && tool !== 'code')) return;
		const panel = tool === 'matrix' ? mathPanelHost : tool === 'code' ? codePanelHost : tablePanelHost;
		const span = equation?.span ?? visualInsertion?.span ?? (insertion ? { documentId: insertion.documentId, version: insertion.version, from: insertion.from, to: insertion.to } : null);
		if (!panel || !span) return;
		const current = visual;
		if (!current.startCellPanel(span, panel, visualInsertion?.atCaret ?? false)) toolError = 'insert-stale';
		return () => current.closeEquation();
	});
	function openToolAtBoundary(kind: 'equation' | 'matrix' | 'table', span: SourceSpan, inlineOnly = false, atCaret = false) {
		if (!editor || saving || !active) return;
		insertInline = false;
		if (tool !== null) closeTool();
		insertMatrix = kind === 'matrix';
		try {
			insertion = rangeInsertionTarget(editor.state, span);
			visualInsertion = { span, inlineOnly, atCaret };
			toolOwner = 'visual';
			toolError = null;
			editingTable = false;
			tableKey = `insert:${++draftSequence}`;
			equation = null;
			equationKey = `insert:${draftSequence}`;
			tool = kind === 'matrix' ? 'equation' : kind;
		} catch { toolError = 'insert-stale'; }
	}
	function insertTextAtBoundary(span: SourceSpan, beforeText: boolean) {
		if (!editor || saving || !active) return;
		if (tool !== null) closeTool();
		try {
			const { transaction, paragraph } = paragraphInsertionTransaction(editor.state, span, beforeText);
			editor.dispatch(transaction);
			toolError = null;
			pendingParagraph = paragraph;
			visual?.focus();
		} catch { toolError = 'insert-stale'; }
	}
	function handleCellAction(action: 'delete' | 'move-up' | 'move-down', span: SourceSpan, adjacent?: SourceSpan) {
		if (!editor || !active || saving) return;
		if (tool !== null) closeTool();
		const current = editor.state.field(sourceState).projection.document;
		if (span.documentId !== current.documentId || span.version !== current.version) {
			toolError = 'insert-stale';
			return;
		}
		if (adjacent && (adjacent.documentId !== current.documentId || adjacent.version !== current.version)) {
			toolError = 'insert-stale';
			return;
		}
		if (action === 'delete') {
			const content = current.read(span.from, span.to);
			const isNonEmpty = content.trim().length > 0 && content.trim() !== '\\par';
			if (isNonEmpty && !window.confirm(t('確定要刪除此區塊嗎？', 'Delete this cell?'))) {
				return false;
			}
			const deleteFrom = span.from, deleteTo = span.to;
			const patch: SourcePatch = {
				from: deleteFrom,
				to: deleteTo,
				insert: '',
				expected: current.read(deleteFrom, deleteTo)
			};
			try {
				const transaction = sourcePatchTransaction(editor.state, { documentId: current.documentId, version: current.version }, [patch]);
				editor.dispatch(transaction);
				toolError = null;
				visual?.focus();
				return true;
			} catch {
				toolError = 'insert-stale';
				return false;
			}
		}
		if (action === 'move-up' || action === 'move-down') {
			if (!adjacent) return;
			const [first, second] = span.from < adjacent.from ? [span, adjacent] : [adjacent, span];
			if (first.to > second.from) {
				toolError = 'insert-stale';
				return;
			}
			try {
				const transaction = cellMoveTransaction(editor.state, [first, second], span.from === first.from ? 0 : 1, span.from === first.from ? 2 : 0);
				if (transaction) editor.dispatch(transaction);
				toolError = null;
				visual?.focus();
			} catch {
				toolError = 'insert-stale';
			}
		}
	}
	function insert(source: string) {
		if (!editor || !insertion || saving || !active) return;
		try {
			let transaction = visualInsertion ? visualInsertionTransaction(editor.state, visualInsertion.span, source, visualInsertion.inlineOnly) : insertionTransaction(editor.state, insertion, source);
			if (tool === 'equation' || tool === 'matrix') transaction = withPackage(editor.state, transaction, ['amsmath', 'amssymb']);
			if (tool === 'code' && source.startsWith('\\begin{lstlisting}')) transaction = withPackage(editor.state, transaction, 'listings');
			if (!transaction.docChanged && editor.state.doc.sliceString(insertion.from, insertion.to) !== source) throw new Error('INSERTION_REJECTED');
			editor.dispatch(transaction); if (tool !== 'code' && !insertInline) focusInsertedBlock('math_block'); closeTool();
		} catch (error) { toolError = error instanceof Error && error.message === 'INSERTION_INLINE_ONLY' ? 'inline-only' : 'insert'; }
	}
	$effect(() => { editor?.dispatch({ effects: permission.reconfigure(EditorState.readOnly.of(saving || tool !== null || !active)) }); });
	$effect(() => { editor?.dispatch({ effects: gutter.reconfigure(showLineNumbers ? [lineNumbers(), highlightActiveLineGutter()] : []) }); });
	$effect(() => { editor?.dispatch({ effects: wrapping.reconfigure(wrapLines ? EditorView.lineWrapping : []) }); });
	// Label-only refresh: no document, selection, history or engine rebuild on label/locale changes.
	$effect(() => { editor?.dispatch({ effects: labels.reconfigure(EditorView.contentAttributes.of({ 'aria-label': label, tabindex: '0' })) }); });
	$effect(() => { if (visual) visual.setLabel(label); });
	$effect(() => { saving; tool; active; locale; visual?.refresh(); });
	$effect(() => { fontSize; if (active && mode !== 'visual') editor?.requestMeasure(); });
	$effect(() => { if (editor && savedVersion !== null) editor.dispatch({ effects: savedCheckpoint.of(savedVersion) }); });
	$effect(() => {
		if (!editor || !navigation || navigation.sequence === handledNavigation || saving || tool !== null || !active) return;
		handledNavigation = navigation.sequence;
		try {
			editor.dispatch(sourceNavigationTransaction(editor.state, navigation.span));
			if (navigation.sourceOnly) setMode('source');
			if (mode === 'source') editor.focus();
			else if (!visual?.navigate(navigation.span)) { setMode('source'); editor.focus(); }
		} catch { toolError = 'navigation'; }
	});
	$effect(() => {
		const request = diagnosticNavigation, view = editor;
		if (!request || !view || disposed || !Number.isSafeInteger(request.sequence) || request.sequence < 1 ||
			request.sequence <= handledDiagnosticNavigation) return;
		if (scheduledDiagnosticNavigation === request.sequence) return;
		if (scheduledDiagnosticNavigation !== 0) scheduledDiagnosticNavigation = 0;
		if (saving || tool !== null || !active || view.state.readOnly) return;
		if (!diagnosticDocumentMatches(view, request)) {
			completeDiagnosticNavigation(request.sequence);
			return;
		}
		const span = diagnosticSourceSpan(view.state, request.location);
		if (!span) {
			completeDiagnosticNavigation(request.sequence);
			toolError = 'diagnostic';
			return;
		}
		try {
			const target = rangeInsertionTarget(view.state, span);
			view.dispatch(view.state.update({
				selection: { anchor: target.from, head: target.to },
				scrollIntoView: true,
				userEvent: 'select.diagnostic'
			}));
			setMode('source');
			toolError = null;
			focusAfterDiagnostic(view, request);
		} catch {
			completeDiagnosticNavigation(request.sequence);
			toolError = 'diagnostic';
		}
	});
	onMount(() => {
		disposed = false;
		const initial = document;
		const failParser = () => { parserFailed = true; parsed = null; editor?.dispatch({ effects: foldProjection.of(null) }); visual?.invalidate(); onParserFailure(); };
		const startParser = (source: SourceDocument) => {
			parserFailed = false;
			try {
				return new ParserClient(new Worker(new URL('../parser/parser.worker.ts', import.meta.url), { type: 'module' }),
					source, (projection) => {
						const current = editor?.state.field(sourceState).projection.document ?? initial;
						if (projection.documentId !== current.documentId || projection.version !== current.version) return;
						parsed = projection;
						editor?.dispatch({ effects: foldProjection.of(projection) });
						onProjection(projection);
						syncVisualProjection();
					}, failParser);
			} catch { failParser(); return null; }
		};
		let parser = startParser(initial);
		const history = (direction: 'undo' | 'redo') => (editor: EditorView) => {
			if (editor.state.readOnly) return true;
			const transaction = historyTransaction(editor.state, direction);
			if (!transaction) return false;
			editor.dispatch(transaction);
			return true;
		};
		const documentEdge = (end: boolean, extend = false) => (editor: EditorView) => {
			const head = end ? editor.state.doc.length : 0;
			editor.dispatch({ selection: { anchor: extend ? editor.state.selection.main.anchor : head, head }, scrollIntoView: true });
			return true;
		};
		const view = new EditorView({
			parent: target,
			state: createSourceState(initial, onRejected, [
					sourceFolding(),
					permission.of(EditorState.readOnly.of(saving || !active)),
					gutter.of(showLineNumbers ? [lineNumbers(), highlightActiveLineGutter()] : []),
					wrapping.of(wrapLines ? EditorView.lineWrapping : []),
					EditorView.domEventHandlers({ keydown: (event) => { const format = formatShortcut(event); if (!format || view.state.readOnly) return false; applyFormat(format); return true; }, paste: event => { if (view.state.readOnly || !imageContext) return false; try { const image = clipboardImage(event); if (image) { void insertImage(image); return true; } } catch { toolError = 'image'; return true; } return false; } }),
					keymap.of([{ key: 'Mod-z', run: history('undo') }, { key: 'Mod-Shift-z', run: history('redo') },
						{ key: 'Mod-End', run: documentEdge(true) }, { key: 'Mod-Home', run: documentEdge(false) },
						{ key: 'Mod-Shift-End', run: documentEdge(true, true) }, { key: 'Mod-Shift-Home', run: documentEdge(false, true) },
						{ key: 'Mod-y', run: history('redo') }]),
					EditorView.updateListener.of((update) => {
						for (const transaction of update.transactions) {
							if (!transaction.docChanged) continue;
							parser?.update(transaction.startState.field(sourceState).projection.document,
								transaction.state.field(sourceState).projection.document, transaction.annotation(sourcePatches) ?? null);
						}
						if (!update.docChanged && !update.transactions.some((transaction) => transaction.effects.some((effect) => effect.is(savedCheckpoint)))) return;
						const data = update.state.field(sourceState);
						visual?.refresh();
						onChange(data.projection.document, data.dirty);
					}),
					labels.of(EditorView.contentAttributes.of({ 'aria-label': label, tabindex: '0' })),
					EditorView.theme({
						'&': { height: '100%', color: 'var(--ink)', backgroundColor: 'var(--surface)' },
						'.cm-scroller': { overflow: 'auto', fontFamily: 'Consolas, monospace', fontSize: 'var(--source-font-size, 14px)' },
						'.cm-content': { padding: '16px 0' },
						'.cm-line': { padding: '0 16px', lineHeight: '1.7' },
						'.cm-gutters': { backgroundColor: 'var(--canvas)', color: 'var(--muted)', border: 'none' },
						'.cm-activeLineGutter': { backgroundColor: 'var(--selection)' },
						'&.cm-focused': { outline: '2px solid var(--accent)', outlineOffset: '-2px' }
					})
				])
		});
		editor = view;
		visual = new VisualEditor(visualTarget, label, {
			source: () => view.state.field(sourceState).projection.document,
			apply: (identity, patches) => { view.dispatch(sourcePatchTransaction(view.state, identity, patches)); return view.state.field(sourceState).projection.document; },
			applyValidated: (identity, patches, validateNextSource) => {
				const transaction = sourcePatchTransaction(view.state, identity, patches);
				validateNextSource(transaction.state.field(sourceState).projection.document);
				view.dispatch(transaction);
				return view.state.field(sourceState).projection.document;
			},
			history: (direction) => history(direction)(view), readOnly: () => saving || tool !== null || !active,
			image: loadImage, pasteImage: insertImage, rejected: onVisualRejected, status: (status) => { visualStatus = status; }, table: openTable, equation: openEquation, raw: openRaw,
			cellToolbar: (toolbar) => cellToolbarTarget?.replaceChildren(...(toolbar ? [toolbar] : [])),
			format: (format) => { applyFormat(format); },
			locale: () => locale,
			insertBlock: (kind, span, beforeText) => {
				if (kind === 'code') { openCode(span); return; }
				if (kind === 'text') insertTextAtBoundary(span, beforeText);
				else openToolAtBoundary(kind, span);
			},
			cellAction: (action, span, adjacent) => {
				return handleCellAction(action, span, adjacent);
			},
			cellReorder: (cells, index, boundary) => {
				if (!active || saving || tool !== null) return false;
				try { const transaction = cellMoveTransaction(view.state, cells, index, boundary); if (!transaction) return false; view.dispatch(transaction); return true; }
				catch { toolError = 'insert-stale'; return false; }
			},
			cellDone: () => { if (tool !== null) closeTool(); },
			cellCancel: (span, original) => {
				if (!active || saving || tool !== null) return;
				try {
					const current = view.state.field(sourceState).projection.document;
					view.dispatch(sourcePatchTransaction(view.state, span, [{ from: span.from, to: span.to, insert: original, expected: current.read(span.from, span.to) }]));
				} catch { toolError = 'insert-stale'; }
			}
		});
		retryParser = () => {
			parser?.dispose();
			parser = startParser(view.state.field(sourceState).projection.document);
		};
		return () => { disposed = true; retryParser = null; parser?.dispose(); visual?.dispose(); visual = null; editor = null; view.destroy(); };
	});
</script>

<svelte:window onkeydown={(event) => { if (active && tool && event.key === 'Escape') { event.preventDefault(); closeTool(); } }} />
<div class="source-view" style:--abstract-label={'"' + t('摘要', 'Abstract') + '"'}>
	<div class="insert-bar">
		<div class="modes" role="group" aria-label={t('編輯模式', 'Editing mode')}>
			<button class="icon-tool" title={t('視覺化', 'Visual')} aria-label={t('視覺化', 'Visual')} aria-pressed={mode === 'visual'} onclick={() => { if (tool !== null) closeTool(); setMode('visual'); visual?.focus(); }}><ToolbarIcon kind="visual" /></button>
			<button class="icon-tool" title={t('原始碼', 'Source')} aria-label={t('原始碼', 'Source')} aria-pressed={mode === 'source'} onclick={() => { if (tool !== null) closeTool(); setMode('source'); editor?.focus(); }}><ToolbarIcon kind="source" /></button>
		</div>
		{#if mode === 'source' && formatWorkspaceId && isTauri()}
			<button class="text-button" title={t('格式化 LaTeX', 'Format LaTeX')} aria-label={t('格式化 LaTeX', 'Format LaTeX')} onclick={() => void formatSource()} disabled={!active || saving || tool !== null || sourceFormatting}>{sourceFormatting ? t('格式化中', 'Formatting') : t('格式化 LaTeX', 'Format LaTeX')}</button>
		{/if}
		<div class="tool-group" role="group" aria-label={t('文字格式', 'Text format')}>
			<details class="math-menu structure-menu">
				<summary aria-label={t('文字層級', 'Text structure')} title={t('文字層級', 'Text structure')}>{t('文字層級', 'Text structure')}<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="m2 4 3 3 3-3" fill="none" stroke="currentColor" /></svg></summary>
				<div class="math-menu-items structure-options">
					{#each [['paragraph', '正文', 'Paragraph'], ['title', '論文題目', 'Paper title'], ['abstract', '摘要', 'Abstract'], ['section', '一級標題', 'Heading 1'], ['subsection', '二級標題', 'Heading 2'], ['subsubsection', '三級標題', 'Heading 3']] as const as entry}
						<button data-structure={entry[0]} disabled={!active || saving || tool !== null || !parsed || mode !== 'visual'} onclick={event => { applyStructure(entry[0]); event.currentTarget.closest('details')!.open = false; }}><span class="structure-mark">{entry[0] === 'section' ? 'H1' : entry[0] === 'subsection' ? 'H2' : entry[0] === 'subsubsection' ? 'H3' : 'T'}</span>{t(entry[1], entry[2])}</button>
					{/each}
				</div>
			</details>
			<button class="icon-tool" title={t('粗體', 'Bold')} aria-label={t('粗體', 'Bold')} onclick={() => applyFormat('strong')} disabled={!active || saving || tool !== null || !parsed}><ToolbarIcon kind="bold" /></button>
			<button class="icon-tool" title={t('斜體', 'Italic')} aria-label={t('斜體', 'Italic')} onclick={() => applyFormat('em')} disabled={!active || saving || tool !== null || !parsed}><ToolbarIcon kind="italic" /></button>
			<button class="icon-tool" title={t('底線', 'Underline')} aria-label={t('底線', 'Underline')} onclick={() => applyFormat('underline')} disabled={!active || saving || tool !== null || !parsed}><ToolbarIcon kind="underline" /></button>
			<details class="math-menu" bind:this={colorMenu}>
				<summary title={t('文字顏色', 'Text color')} aria-label={t('文字顏色', 'Text color')}><ToolbarIcon kind="color" /></summary>
				<div class="math-menu-items color-options">
					{#each [{ hex: 'B42318', zh: '紅色', en: 'Red' }, { hex: '166534', zh: '綠色', en: 'Green' }, { hex: '1D4ED8', zh: '藍色', en: 'Blue' }, { hex: '7E22CE', zh: '紫色', en: 'Purple' }, { hex: '92400E', zh: '棕色', en: 'Brown' }] as color}
						<button onclick={() => applyColor(color.hex)} disabled={!active || saving || tool !== null}><span class="color-swatch" style:background={'#' + color.hex}></span>{t(color.zh, color.en)}</button>
					{/each}
					<label>{t('自訂顏色', 'Custom color')}<input type="color" aria-label={t('自訂文字顏色', 'Custom text color')} onchange={event => applyColor(event.currentTarget.value.slice(1))} disabled={!active || saving || tool !== null} /></label>
				</div>
			</details>
		</div>
		<div class="tool-group" role="group" aria-label={t('插入內容', 'Insert')}>
			<details class="math-menu" bind:this={mathMenu}>
				<summary title={t('數學', 'Math')} aria-label={t('數學', 'Math')}><ToolbarIcon kind="equation" /><svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="m2 4 3 3 3-3" fill="none" stroke="currentColor" /></svg></summary>
				<div class="math-menu-items">
					<button onclick={openInlineEquation} disabled={!active || saving || tool !== null}>{t('行內公式', 'Inline equation')}</button>
					<button onclick={() => openTool('equation')} disabled={!active || saving || tool !== null}>{t('公式儲存格', 'Equation cell')}</button>
					<button onclick={() => openTool('matrix')} disabled={!active || saving || tool !== null}>{t('矩陣', 'Matrix')}</button>
				</div>
			</details>
			<button class="icon-tool" title={t('表格', 'Table')} aria-label={t('表格', 'Table')} onclick={() => openTool('table')} disabled={!active || saving || tool !== null}><ToolbarIcon kind="table" /></button>
			<input type="file" accept="image/png,image/jpeg" bind:this={imageInput} hidden aria-label={t('選擇圖片', 'Choose image')} onchange={event => { const file = event.currentTarget.files?.[0]; if (file) void insertImage(file); }} />
			<button class="icon-tool" title={t('圖片', 'Image')} aria-label={t('圖片', 'Image')} onclick={() => imageInput.click()} disabled={!active || saving || tool !== null || !imageContext}><ToolbarIcon kind="image" /></button>
			<button class="icon-tool" title={t('程式碼區塊', 'Code block')} aria-label={t('程式碼區塊', 'Code block')} onclick={() => openCode()} disabled={!active || saving || tool !== null}><ToolbarIcon kind="code" /></button>
		</div>
	</div>
	{#if sourceFormatMessage}<p class="tool-error" role="alert">{sourceFormatMessage}</p>{/if}
	{#if mode !== 'visual'}<div class="table-edit"><button class="text-button" onclick={editEquation} disabled={!active || saving || tool !== null || !parsed}>{t('編輯游標所在公式', 'Edit equation at cursor')}</button><button class="text-button" onclick={editTable} disabled={saving || tool !== null}>{t('編輯游標所在表格', 'Edit table at cursor')}</button><button class="text-button" onclick={() => editor && foldCode(editor)} disabled={!active || saving || tool !== null || !parsed}>{t('折疊目前區段', 'Fold current section')}</button><button class="text-button" onclick={() => editor && unfoldAll(editor)} disabled={!active || tool !== null}>{t('展開全部', 'Unfold all')}</button></div>{/if}
	{#if toolError}<p class="tool-error" role="alert">{toolMessage(toolError)}</p>{/if}
	<div class="cell-actions-bar" bind:this={cellToolbarTarget} hidden={mode !== 'visual'}></div>
	{#if parserFailed}<div class="parser-error" role="alert"><span>{t('解析中斷，原始碼仍可編輯。', 'Parsing stopped. The source is still editable.')}</span><button class="text-button" onclick={() => retryParser?.()} disabled={saving || tool !== null}>{t('重新解析', 'Parse again')}</button></div>{/if}
	<div bind:this={mathPanelHost} hidden={tool !== 'matrix' && !(tool === 'equation' && mode === 'source')}><MathPanel kind={tool === 'matrix' ? 'matrix' : 'equation'} showSource={mode === 'source'} {locale} active={active && (tool === 'matrix' || tool === 'equation' && mode === 'source')} initialDraft={equation?.draft ?? (insertInline ? { latex: '', inline: true } : null)} sessionKey={equationKey} editing={equation !== null} onEquation={applyEquation} onInsert={insert} onClose={closeTool} /></div>
	<div bind:this={tablePanelHost} hidden={tool !== 'table'}><TablePanel {locale} active={active && tool === 'table'} locked={pendingPackage !== null} initialDraft={tableDraft} sessionKey={tableKey} editing={editingTable} onInsert={insertTable} onClose={closeTool} /></div>
	<div bind:this={codePanelHost} hidden={tool !== 'code'}><CodePanel {locale} active={active && tool === 'code'} initialDraft={codeDraft?.draft ?? null} sessionKey={codeKey} editing={codeDraft !== null} onInsert={insert} onApply={applyCode} onClose={closeTool} /></div>
	{#if pendingPackage}<section class="package-preview" aria-labelledby="package-heading">
		<h2 id="package-heading">{t('新增 Booktabs 套件', 'Add the Booktabs package')}</h2><p>{t('表格需要以下前言設定。確認後會與表格一起套用，可一次復原。', 'This table needs the preamble setting below. Confirming applies it together with the table, and one undo reverts both.')}</p>
		<pre>{pendingPackage.plan.insert.trim()}</pre>
		<div class="raw-actions"><button onclick={() => { pendingPackage = null; toolError = null; }}>{t('返回表格', 'Back to table')}</button><button onclick={() => { if (pendingPackage) commitTable(pendingPackage.source, pendingPackage.plan); }} disabled={!active || saving}>{t('加入套件並套用表格', 'Add package and apply table')}</button></div>
	</section>{/if}
	{#if tool === 'raw'}<section class="raw-panel" aria-labelledby="raw-title">
		<div class="raw-heading"><h2 id="raw-title">Raw LaTeX</h2><button class="text-button" onclick={closeTool}>{t('關閉', 'Close')}</button></div>
		<label for="raw-source">{t('區段原始碼', 'Section source')}</label><textarea id="raw-source" bind:this={rawInput} bind:value={rawDraft} rows="8" spellcheck="false" disabled={!active || saving}></textarea>
		<div class="raw-actions"><button onclick={closeTool}>{t('取消', 'Cancel')}</button><button onclick={applyRaw} disabled={!active || saving}>{t('套用', 'Apply')}</button></div>
	</section>{/if}
	<div class="editor-surfaces">
		<div class="source" bind:this={target} hidden={mode === 'visual'}></div>
		<div class="visual" hidden={mode === 'source'} aria-busy={!parserFailed && visualStatus === 'updating'}>
			<div bind:this={visualTarget}></div>
		</div>
	</div>
</div>

<style>
	.visual :global(.visual-image) { margin: 16px 0; }
	.visual :global(.visual-image-content) { display: block; width: 100%; padding: 0; border: 0; background: transparent; }
	.visual :global(.visual-image-content img) { display: block; max-width: 80%; max-height: 480px; height: auto; margin: auto; }
	.visual :global(.visual-table-content) { display: block; width: 100%; padding: 0; border: 0; background: transparent; color: inherit; font: inherit; text-align: inherit; cursor: pointer; }
	.visual :global(.visual-table-content:focus-visible) { outline: 2px solid var(--accent); outline-offset: 4px; }
	.visual :global(.catalog-search) { position: sticky; top: 0; z-index: 1; box-sizing: border-box; width: 100%; min-height: 34px; padding: 6px 10px; border: 1px solid var(--line); border-radius: 4px; background: var(--surface); color: var(--ink); font: inherit; }
	.visual :global(.inline-equation-catalog-grid .catalog-item-btn) { width: 132px; }
	.visual :global(.inline-equation-catalog-grid .catalog-item-btn.wide-template) { width: 100%; }
	.visual :global(.inline-equation-draft.is-inline .inline-equation-catalog) { width: min(480px, 70vw); }
	.visual :global(.catalog-tab), .visual :global(.catalog-item-btn) { display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 4px; width: 96px; min-height: 76px; }
	.visual :global(.catalog-preview) { display: flex; align-items: center; justify-content: center; min-height: 32px; pointer-events: none; }
	.visual :global(.catalog-preview math-field) { font-size: 21px; border: 0; padding: 0; background: transparent; pointer-events: none; min-width: 0; }
	.visual :global(.catalog-label) { font-size: 12px; line-height: 1.3; }
	.visual :global(.code-content) { font: 14px/1.6 Consolas, monospace; white-space: pre; overflow-x: auto; background: var(--canvas); padding: 12px; border: 1px solid var(--line); }
	.visual :global(.inline-equation-catalog) { flex-direction: column; gap: 6px; width: min(480px, 100%); max-height: 30vh; overflow: auto; padding: 8px; box-sizing: border-box; background: var(--surface); border: 1px solid var(--line); margin-top: 8px; }
	.visual :global(.inline-equation-catalog-nav), .visual :global(.inline-equation-catalog-grid) { display: flex; flex-wrap: wrap; gap: 4px; }
	.visual :global(.catalog-tab), .visual :global(.catalog-item-btn) { min-height: 32px; font-size: 14px; padding: 5px 8px; } .visual :global(.catalog-back) { align-self: flex-start; padding: 4px 8px; border: 0; background: transparent; color: var(--accent); }
	.visual :global(.catalog-tab.active) { background: var(--selection); }
	.visual :global(.catalog-item-btn) { min-width: 40px; padding: 5px 8px; }
	.visual :global(.confirm-action) { color: #15803d; }
	.visual :global(.cancel-action) { color: #b91c1c; }
	:global([data-theme='dark']) .visual :global(.confirm-action) { color: #4ade80; }
	:global([data-theme='dark']) .visual :global(.cancel-action) { color: #f87171; }
	.math-menu { position: relative; }
	.math-menu summary { display: flex; align-items: center; gap: 3px; cursor: pointer; list-style: none; padding: 5px; min-height: 32px; box-sizing: border-box; }
	.math-menu summary::-webkit-details-marker { display: none; }
	.math-menu summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
	.math-menu-items { position: absolute; z-index: 30; top: 100%; left: 0; padding: 4px; min-width: 150px; background: var(--surface); border: 1px solid var(--line); box-shadow: 0 4px 12px #0002; }
	.math-menu-items button { display: block; width: 100%; text-align: start; white-space: nowrap; border: 0; background: transparent; padding: 7px 10px; }
	.math-menu-items button:hover { background: var(--selection); }
	.color-options button, .color-options label { display: flex; align-items: center; gap: 8px; }
	.color-options label { padding: 7px 10px; white-space: nowrap; }
	.color-swatch { display: inline-block; width: 14px; height: 14px; border: 1px solid var(--line); }
	.source {
		flex: 1;
		min-height: 0;
	}
	.source-view { height: 100%; display: flex; flex-direction: column; min-height: 0; }
	.insert-bar { height: 40px; min-height: 40px; flex: none; padding: 1px 12px; border-bottom: 1px solid var(--line); display: flex; align-items: center; flex-wrap: nowrap; gap: 8px; overflow-x: auto; overflow-y: hidden; scrollbar-width: thin; }
	.insert-bar:has(.math-menu[open]) { overflow: visible; }
	.insert-bar > * { flex: none; }
	.tool-group { display: flex; flex: none; align-items: center; gap: 4px; white-space: nowrap; }
	.tool-group { padding-inline-start: 8px; border-inline-start: 1px solid var(--line); }
	.structure-menu summary { gap: 12px; padding: 5px 8px; } .structure-options button { display: flex; align-items: center; gap: 12px; min-height: 36px; } .structure-mark { color: var(--muted); width: 24px; font-size: 12px; font-weight: 600; }
	.visual :global(.source-block[data-source-role='abstract']) { max-width: 70ch; margin-inline: auto; padding-block: 8px; }
	.visual :global(.source-block[data-source-role='abstract']::before) { content: var(--abstract-label); display: block; text-align: center; font-weight: 600; margin-bottom: 8px; }
	.visual :global(.source-block[data-structure='title']) { text-align: center; font-size: 28px; }
	.icon-tool { width: 36px; min-width: 36px; height: 36px; min-height: 36px; padding: 7px; display: inline-flex; align-items: center; justify-content: center; background: transparent; border-color: transparent; }
	.table-edit { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 4px 12px; border-bottom: 1px solid var(--line); }
	.parser-error { padding: 4px 12px; border-bottom: 1px solid var(--line); display: flex; flex-wrap: wrap; align-items: center; gap: 8px; color: var(--ink); }
	.modes { display: flex; flex: none; flex-wrap: nowrap; gap: 4px; }
	.modes [aria-pressed='true'] { background: var(--selection); border-color: var(--accent); color: var(--accent); font-weight: 600; }
	.editor-surfaces { min-height: 0; flex: 1; display: grid; grid-template-columns: minmax(0, 1fr); }
	.visual { min-height: 0; overflow: auto; padding: 24px; }
	.visual :global(.ProseMirror) { position: relative; min-height: 100%; outline: none; font-size: 16px; line-height: 1.7; }
	.visual :global(.source-block) { display: block; white-space: pre-wrap; overflow-wrap: anywhere; }
	.visual :global(.raw-latex) { font: 13px/1.6 Consolas, monospace; padding: 8px; border: 1px solid var(--line); background: var(--canvas); white-space: pre-wrap; overflow-wrap: anywhere; }
	.tool-error { margin: 4px 12px; color: var(--ink); }
	.raw-panel { padding: 12px; border-bottom: 1px solid var(--line); overflow: auto; max-height: 60%; }
	.raw-heading, .raw-actions { display: flex; align-items: center; gap: 8px; justify-content: flex-end; }
	.raw-heading h2 { margin: 0 auto 8px 0; font-size: 16px; }
	.raw-panel label { display: block; margin-block: 8px; }
	.raw-panel textarea { display: block; width: 100%; box-sizing: border-box; font: 14px/1.6 Consolas, monospace; margin-block-end: 12px; }
	.package-preview { padding: 12px 16px; border-bottom: 1px solid var(--line); overflow: auto; }
	.package-preview h2 { font-size: 16px; margin: 0; }
	.package-preview pre { white-space: pre-wrap; overflow-wrap: anywhere; font: 14px/1.6 Consolas, monospace; }
	.visual :global(.visual-math) { margin: 16px 0; }
	.visual :global(.visual-math-content) { display: block; width: 100%; overflow-x: auto; margin-block-end: 6px; padding: 0; border: 0; background: transparent; color: inherit; text-align: start; }
	.visual :global(.visual-math-content:hover:not(:disabled)) { background: transparent; }
	.visual :global(.visual-math:not(.visual-math-inline) .visual-math-content) { text-align: center; }
	.visual :global(.visual-math-inline) { display: inline-flex; vertical-align: baseline; align-items: baseline; gap: 4px; margin: 0 2px; max-width: 100%; }
	.visual :global(.visual-math-inline .visual-math-content) { display: inline; width: auto; margin: 0; overflow-x: visible; }
	.visual :global(.visual-math-inline .text-button) { padding: 2px 4px; min-height: 32px; font-size: 12px; }
	.visual :global(.visual-math math-field) { font-size: 22px; color: var(--ink); background: var(--surface); border: none; max-width: 100%; --selection-background-color: var(--selection); }
	.visual :global(.visual-math-inline math-field) { font-size: 1.125em; }
	.visual :global(.visual-table) { margin: 24px 0; overflow-x: auto; }
	.visual :global(.visual-table table) { margin: 0 auto 8px; border-collapse: collapse; table-layout: fixed; border-top: 1px solid var(--ink); border-bottom: 1px solid var(--ink); font-variant-numeric: tabular-nums; }
	.visual :global(.visual-table th), .visual :global(.visual-table td) { padding: 6px 8px; text-align: left; overflow-wrap: anywhere; }
	.visual :global(.visual-table thead) { border-bottom: 1px solid var(--ink); }
	.visual :global(.visual-table table.booktabs) { border-block: 2px solid var(--ink); }
	.visual :global(.visual-table .horizontal tr) { border-bottom: 1px solid var(--line); }
	.visual :global(.visual-table .full th), .visual :global(.visual-table .full td) { border: 1px solid var(--line); }
	.visual :global(.visual-table caption) { padding: 8px 0; text-align: left; }
	.visual :global(.visual-block-inserter) {
		margin: 6px 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		position: relative;
		user-select: none;
	}
	.visual :global(.visual-block-inserter-line) {
		width: 100%;
		height: 1px;
		background: var(--line);
		position: absolute;
		top: 50%;
		left: 0;
		z-index: 0;
	}
	.visual :global(.visual-block-inserter-actions) {
		position: relative;
		z-index: 1;
		display: flex;
		align-items: center;
		gap: 4px;
	}
	.visual :global(.inserter-trigger) {
		width: 24px;
		height: 24px;
		border-radius: 50%;
		padding: 0;
		font-size: 15px;
		line-height: 22px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		background: var(--surface);
		border: 1px solid var(--line);
		color: var(--muted);
		cursor: pointer;
	}
	.visual :global(.inserter-trigger:hover),
	.visual :global(.visual-block-inserter.open .inserter-trigger),
	.visual :global(.visual-block-inserter:focus-within .inserter-trigger) {
		color: var(--accent);
		border-color: var(--accent);
		background: var(--selection);
	}
	.visual :global(.inserter-menu) {
		display: none;
		gap: 4px;
		background: var(--surface);
		padding: 2px 6px;
		border-radius: 4px;
		border: 1px solid var(--line);
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
	}
	.visual :global(.visual-block-inserter.open .inserter-menu),
	.visual :global(.visual-block-inserter:hover .inserter-menu),
	.visual :global(.visual-block-inserter:focus-within .inserter-menu) {
		display: flex;
	}
	.visual :global(.inserter-btn) {
		font-size: 12px;
		padding: 2px 8px;
		min-height: 26px;
		background: var(--canvas);
		border: 1px solid var(--line);
		border-radius: 3px;
		color: var(--ink);
		cursor: pointer;
		white-space: nowrap;
	}
	.visual :global(.inserter-btn:hover:not(:disabled)) {
		background: var(--selection);
		border-color: var(--accent);
		color: var(--accent);
	}
	.visual :global(.inserter-btn:focus-visible),
	.visual :global(.inserter-trigger:focus-visible) {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}
	.visual :global(.inserter-btn:disabled),
	.visual :global(.inserter-trigger:disabled) {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
