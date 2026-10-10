<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { Compartment, EditorState } from '@codemirror/state';
	import { EditorView, lineNumbers, highlightActiveLineGutter, keymap } from '@codemirror/view';
	import type { SourceDocument, SourceProjection, SourceSpan } from '@modutex/document-core';
	import { ParserClient } from '../parser/client.ts';
	import { VisualEditor } from '../visual-editor/view.ts';
	import 'prosemirror-view/style/prosemirror.css';
	import { createSourceState, sourceState, sourcePatches, sourcePatchTransaction, historyTransaction, savedCheckpoint, insertionTarget, insertionTransaction, type InsertionTarget } from './state.ts';
	import MathPanel from '../math/MathPanel.svelte';
	import ToolbarIcon from '../../components/ToolbarIcon.svelte';
	import { equationAt, equationSource, type EquationDraft, type LocatedEquation } from '../math/source.ts';
	import { equationEditTransaction } from '../math/editor.ts';
	import TablePanel from '../tables/TablePanel.svelte';
	import { tableAt, type TableDraft } from '../tables/source.ts';
	import { rangeInsertionTarget, sourceNavigationTransaction } from './state.ts';
	import { diagnosticSourceSpan, type DiagnosticNavigationRequest } from './diagnostics.ts';
	import { foldCode, unfoldAll } from '@codemirror/language';
	import { foldProjection, sourceFolding } from './folding.ts';
	import { formatShortcut, formatTransaction, type TextFormat } from './format.ts';
	import { rawEditTransaction } from './raw.ts';
	import { visualInsertionTransaction } from './state.ts';
	import { booktabsPlan, tableInsertionTransaction, type PackagePlan } from '../tables/preamble.ts';
	import { text, type Language } from '../../i18n/text.ts';
	let { document, label, saving, savedVersion, active = true, fontSize = 14, showLineNumbers = true, wrapLines = false, navigation = null, diagnosticNavigation = null, locale = 'zh-Hant', onChange, onRejected, onVisualRejected, onProjection, onParserFailure }: { document: SourceDocument; label: string;
		active?: boolean; fontSize?: number; showLineNumbers?: boolean; wrapLines?: boolean; locale?: Language;
		navigation?: { readonly span: SourceSpan; readonly sequence: number; readonly sourceOnly?: boolean } | null;
		diagnosticNavigation?: DiagnosticNavigationRequest | null;
		saving: boolean; savedVersion: number | null;
		onProjection: (projection: SourceProjection) => void; onParserFailure: () => void;
		onChange: (source: SourceDocument, dirty: boolean) => void; onRejected: (reason?: 'SOURCE_TOO_LARGE') => void; onVisualRejected: () => void } = $props();
	/** Read at call time so callbacks and markup follow the current per-view locale. */
	const t = (traditionalChinese: string, english: string) => text(locale, traditionalChinese, english);
	type ToolError = 'raw-stale' | 'raw-apply' | 'preamble' | 'table-apply' | 'format' | 'insert-selection' | 'insert-stale' | 'table-pending' | 'table-cursor'
		| 'equation-cursor' | 'equation-stale' | 'equation-apply' | 'table-stale' | 'inline-only' | 'insert' | 'navigation' | 'diagnostic';
	function toolMessage(code: ToolError): string {
		switch (code) {
			case 'raw-stale': return t('內容已變更，請重新選取區段。', 'The content changed. Select the section again.');
			case 'raw-apply': return t('無法套用內容。請確認區段未變更，且文件未超過 5 MiB。', 'Could not apply the change. Make sure the section is unchanged and the document stays within 5 MiB.');
			case 'preamble': return t('無法安全修改前言。請在原始碼加入 \\usepackage{booktabs}，或改選等粗線。', 'Could not safely update the preamble. Add \\usepackage{booktabs} in the source, or choose equal-weight rules.');
			case 'table-apply': return t('無法套用表格。請確認插入位置未變更，且文件未超過 5 MiB。', 'Could not apply the table. Make sure the insertion point is unchanged and the document stays within 5 MiB.');
			case 'format': return t('請選取文字或完整格式區段；原始碼中的未知語法保持不變。', 'Select text or a complete formatted section. Unknown syntax in the source stays unchanged.');
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
			case 'diagnostic': return t('錯誤位置無法對應此文件，請查看編譯記錄。', 'Diagnostic location is unavailable in this document. See the compilation log.');
		}
	}
	let target: HTMLDivElement;
	let visualTarget: HTMLDivElement;
	let visual = $state.raw<VisualEditor | null>(null);
	let mode = $state<'source' | 'visual'>('source');
	let visualStatus = $state<'ready' | 'updating'>('updating');
	let parserFailed = $state(false);
	let retryParser: (() => void) | null = null;
	let editor = $state.raw<EditorView | null>(null);
	const permission = new Compartment();
	const gutter = new Compartment(), wrapping = new Compartment(), labels = new Compartment();
	let tool = $state<'equation' | 'matrix' | 'table' | 'raw' | null>(null);
	let rawSpan: SourceSpan | null = null;
	let rawOriginal = '', rawDraft = $state('');
	let rawInput = $state.raw<HTMLTextAreaElement | null>(null);
	function openRaw(value: string, span: SourceSpan) {
		if (!editor || !active || saving || tool !== null) return;
		try {
			const source = editor.state.field(sourceState).projection.document;
			rangeInsertionTarget(editor.state, span);
			if (source.read(span.from, span.to) !== value) throw new Error('STALE_RAW');
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
	let visualInsertion: { span: SourceSpan; inlineOnly: boolean } | null = null;
	let toolOwner: 'source' | 'visual' = 'source';
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
	function focusInsertedBlock(kind: 'table_block' | 'math_block') {
		if (!editor || mode !== 'visual') return;
		const projection = editor.state.field(sourceState).projection;
		pendingBlock = { documentId: projection.document.documentId, version: projection.document.version, to: projection.toSource(editor.state.selection.main.head), kind };
	}
	let tableDraft = $state.raw<TableDraft | null>(null);
	let tableKey = $state('insert'), editingTable = $state(false), toolError = $state<ToolError | null>(null);
	let equation = $state.raw<LocatedEquation | null>(null);
	let equationKey = $state('insert');
	let handledNavigation = 0;
	let handledDiagnosticNavigation = 0;
	let scheduledDiagnosticNavigation = 0;
	let disposed = false;
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
	function openTool(kind: 'equation' | 'matrix' | 'table') {
		if (!editor || saving || !active || tool !== null) return;
		const useVisual = mode === 'visual';
		const captured = useVisual ? visual?.insertionSelection() ?? null : null;
		if (useVisual && !captured) { toolError = 'insert-selection'; return; }
		try { insertion = captured ? rangeInsertionTarget(editor.state, captured.span) : insertionTarget(editor.state); }
		catch { toolError = 'insert-stale'; return; }
		visualInsertion = captured; toolOwner = useVisual ? 'visual' : 'source';
		toolError = null; editingTable = false; tableKey = 'insert';
		equation = null; equationKey = 'insert';
		tool = kind;
	}
	function editTable() {
		if (!editor || saving || tool !== null) return;
		const projection = editor.state.field(sourceState).projection;
		if (!parsed || parsed.documentId !== projection.document.documentId || parsed.version !== projection.document.version) {
			toolError = 'table-pending'; return;
		}
		const located = tableAt(projection.document, parsed, projection.toSource(editor.state.selection.main.head));
		if (!located) { toolError = 'table-cursor'; return; }
		openTable(located.draft, located.span, 'source');
	}
	function editEquation() {
		if (!editor || saving || !active || tool !== null) return;
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
		try {
			if (equation) {
				const transaction = equationEditTransaction(editor.state, equation, draft);
				if (transaction) editor.dispatch(transaction);
				closeTool();
			} else insert(equationSource(draft.latex, draft.inline).replace(/\r\n|\r/g, '\n'));
		}
		catch { toolError = 'equation-apply'; }
	}
	function openEquation(_draft: EquationDraft, span: SourceSpan) {
		if (!editor || !active || saving || tool !== null || !parsed) return;
		const source = editor.state.field(sourceState).projection.document;
		if (span.documentId !== source.documentId || span.version !== source.version) return;
		const located = equationAt(source, parsed, span.from);
		if (!located || located.span.to !== span.to) return;
		try { insertion = rangeInsertionTarget(editor.state, located.span); equation = located; equationKey = `${span.documentId}:${span.version}:${span.from}:${span.to}`; toolError = null; toolOwner = 'visual'; tool = 'equation'; }
		catch { toolError = 'equation-stale'; }
	}
	function openTable(draft: TableDraft, span: SourceSpan, owner: 'source' | 'visual' = 'visual') {
		if (!editor || saving || !active || tool !== null) return;
		try {
			insertion = rangeInsertionTarget(editor.state, span);
			tableDraft = draft; tableKey = `${span.documentId}:${span.version}:${span.from}:${span.to}`;
			editingTable = true; toolError = null; toolOwner = owner; tool = 'table';
		} catch { toolError = 'table-stale'; }
	}
	function closeTool() { tool = null; insertion = null; visualInsertion = null; pendingPackage = null; if (!active) return; if (mode === 'source') editor?.focus(); else visual?.focus(); }
	function openToolAtBoundary(kind: 'equation' | 'matrix' | 'table', span: SourceSpan) {
		if (!editor || saving || !active || tool !== null) return;
		try {
			insertion = rangeInsertionTarget(editor.state, span);
			visualInsertion = { span, inlineOnly: false };
			toolOwner = 'visual';
			toolError = null;
			editingTable = false;
			tableKey = 'insert';
			equation = null;
			equationKey = 'insert';
			tool = kind;
		} catch { toolError = 'insert-stale'; }
	}
	function insertTextAtBoundary(span: SourceSpan, beforeText: boolean) {
		if (!editor || saving || !active || tool !== null) return;
		try {
			const transaction = visualInsertionTransaction(editor.state, span, beforeText ? '\\par\n\\par\n' : '\\par\n', false);
			if (!transaction.docChanged) throw new Error('INSERTION_REJECTED');
			editor.dispatch(transaction);
			toolError = null;
			const next = editor.state.field(sourceState).projection.document;
			pendingParagraph = { documentId: next.documentId, version: next.version, from: next.read().indexOf('\\par', span.from) };
			visual?.focus();
		} catch { toolError = 'insert-stale'; }
	}
	function insert(source: string) {
		if (!editor || !insertion || saving || !active) return;
		try {
			const transaction = visualInsertion ? visualInsertionTransaction(editor.state, visualInsertion.span, source, visualInsertion.inlineOnly) : insertionTransaction(editor.state, insertion, source);
			if (!transaction.docChanged && editor.state.doc.sliceString(insertion.from, insertion.to) !== source) throw new Error('INSERTION_REJECTED');
			editor.dispatch(transaction); focusInsertedBlock('math_block'); closeTool();
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
			if (navigation.sourceOnly) mode = 'source';
			if (mode === 'source') editor.focus();
			else if (!visual?.navigate(navigation.span)) { mode = 'source'; editor.focus(); }
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
			mode = 'source';
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
						parsed = projection; editor?.dispatch({ effects: foldProjection.of(projection) }); visual?.sync(projection); onProjection(projection);
						if (pendingParagraph && projection.documentId === pendingParagraph.documentId && projection.version === pendingParagraph.version) {
							const from = pendingParagraph.from;
							visual?.view.state.doc.forEach((node) => { if (node.attrs.from === from && node.attrs.name === 'par') visual?.navigate({ documentId: projection.documentId, version: projection.version, from, to: node.attrs.to }, true); });
							pendingParagraph = null;
						}
						if (pendingBlock && projection.documentId === pendingBlock.documentId && projection.version === pendingBlock.version) {
							let selected: SourceSpan | null = null;
							const request = pendingBlock;
							visual?.view.state.doc.forEach((node) => { if (node.type.name === request.kind && node.attrs.to <= request.to) selected = { documentId: projection.documentId, version: projection.version, from: node.attrs.from, to: node.attrs.to }; });
							if (selected) visual?.navigate(selected);
							pendingBlock = null;
						}
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
		const view = new EditorView({
			parent: target,
			state: createSourceState(initial, onRejected, [
					sourceFolding(),
					permission.of(EditorState.readOnly.of(saving || !active)),
					gutter.of(showLineNumbers ? [lineNumbers(), highlightActiveLineGutter()] : []),
					wrapping.of(wrapLines ? EditorView.lineWrapping : []),
					EditorView.domEventHandlers({ keydown: (event) => { const format = formatShortcut(event); if (!format || view.state.readOnly) return false; applyFormat(format); return true; } }),
					keymap.of([{ key: 'Mod-z', run: history('undo') }, { key: 'Mod-Shift-z', run: history('redo') },
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
			rejected: onVisualRejected, status: (status) => { visualStatus = status; }, table: openTable, equation: openEquation, raw: openRaw,
			format: (format) => { applyFormat(format); },
			locale: () => locale,
			insertBlock: (kind, span, beforeText) => {
				if (kind === 'text') insertTextAtBoundary(span, beforeText);
				else openToolAtBoundary(kind, span);
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
<div class="source-view">
	<div class="mode-bar">
		<span class="mode-heading">{t('編輯模式', 'Editing mode')}</span>
		<div class="modes" role="group" aria-label={t('編輯模式', 'Editing mode')}>
			<button aria-pressed={mode === 'source'} onclick={() => { mode = 'source'; editor?.focus(); }} disabled={tool !== null}>{t('原始碼', 'Source')}</button>
			<button aria-pressed={mode === 'visual'} onclick={() => { mode = 'visual'; visual?.focus(); }} disabled={tool !== null}>{t('視覺化', 'Visual')}</button>
		</div>
	</div>
	<div class="insert-bar">
		<div class="tool-group" role="group" aria-label={t('文字格式', 'Text format')}>
			<button class="icon-tool" title={t('粗體', 'Bold')} aria-label={t('粗體', 'Bold')} onclick={() => applyFormat('strong')} disabled={!active || saving || tool !== null || !parsed}><ToolbarIcon kind="bold" /></button>
			<button class="icon-tool" title={t('斜體', 'Italic')} aria-label={t('斜體', 'Italic')} onclick={() => applyFormat('em')} disabled={!active || saving || tool !== null || !parsed}><ToolbarIcon kind="italic" /></button>
			<button class="icon-tool" title={t('底線', 'Underline')} aria-label={t('底線', 'Underline')} onclick={() => applyFormat('underline')} disabled={!active || saving || tool !== null || !parsed}><ToolbarIcon kind="underline" /></button>
		</div>
		<div class="tool-group" role="group" aria-label={t('插入內容', 'Insert')}>
			<button class="icon-tool" title={t('公式', 'Equation')} aria-label={t('公式', 'Equation')} onclick={() => openTool('equation')} disabled={!active || saving || tool !== null}><ToolbarIcon kind="equation" /></button>
			<button class="icon-tool" title={t('矩陣', 'Matrix')} aria-label={t('矩陣', 'Matrix')} onclick={() => openTool('matrix')} disabled={!active || saving || tool !== null}><ToolbarIcon kind="matrix" /></button>
			<button class="icon-tool" title={t('表格', 'Table')} aria-label={t('表格', 'Table')} onclick={() => openTool('table')} disabled={!active || saving || tool !== null}><ToolbarIcon kind="table" /></button>
		</div>
	</div>
	{#if mode !== 'visual'}<div class="table-edit"><button class="text-button" onclick={editEquation} disabled={!active || saving || tool !== null || !parsed}>{t('編輯游標所在公式', 'Edit equation at cursor')}</button><button class="text-button" onclick={editTable} disabled={saving || tool !== null}>{t('編輯游標所在表格', 'Edit table at cursor')}</button><button class="text-button" onclick={() => editor && foldCode(editor)} disabled={!active || saving || tool !== null || !parsed}>{t('折疊目前區段', 'Fold current section')}</button><button class="text-button" onclick={() => editor && unfoldAll(editor)} disabled={!active || tool !== null}>{t('展開全部', 'Unfold all')}</button></div>{/if}
	{#if toolError}<p class="tool-error" role="alert">{toolMessage(toolError)}</p>{/if}
	{#if parserFailed}<div class="parser-error" role="alert"><span>{t('解析中斷，原始碼仍可編輯。', 'Parsing stopped. The source is still editable.')}</span><button class="text-button" onclick={() => retryParser?.()} disabled={saving || tool !== null}>{t('重新解析', 'Parse again')}</button></div>{/if}
	<div hidden={tool !== 'equation' && tool !== 'matrix'}><MathPanel kind={tool === 'matrix' ? 'matrix' : 'equation'} showSource={mode === 'source'} {locale} active={active && (tool === 'equation' || tool === 'matrix')} initialDraft={equation?.draft ?? null} sessionKey={equationKey} editing={equation !== null} onEquation={applyEquation} onInsert={insert} onClose={closeTool} /></div>
	<div hidden={tool !== 'table'}><TablePanel {locale} active={active && tool === 'table'} locked={pendingPackage !== null} initialDraft={tableDraft} sessionKey={tableKey} editing={editingTable} onInsert={insertTable} onClose={closeTool} /></div>
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
			{#if !parserFailed && visualStatus === 'updating'}<p class="visual-status" role="status">{t('正在更新視覺內容…', 'Updating visual content…')}</p>{/if}
			<div bind:this={visualTarget}></div>
		</div>
	</div>
</div>

<style>
	.source {
		flex: 1;
		min-height: 0;
	}
	.source-view { height: 100%; display: flex; flex-direction: column; min-height: 0; }
	.insert-bar { padding: 4px 12px; border-bottom: 1px solid var(--line); display: flex; flex-wrap: wrap; gap: 8px; }
	.tool-group { display: flex; gap: 4px; }
	.tool-group + .tool-group { padding-inline-start: 8px; border-inline-start: 1px solid var(--line); }
	.icon-tool { width: 36px; height: 36px; padding: 7px; display: inline-flex; align-items: center; justify-content: center; background: transparent; border-color: transparent; }
	.table-edit { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 4px 12px; border-bottom: 1px solid var(--line); }
	.parser-error { padding: 4px 12px; border-bottom: 1px solid var(--line); display: flex; flex-wrap: wrap; align-items: center; gap: 8px; color: var(--ink); }
	.mode-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 8px 12px; border-bottom: 1px solid var(--line); background: var(--canvas); }
	.mode-heading { font-size: 13px; font-weight: 600; color: var(--ink); }
	.modes { display: flex; flex-wrap: wrap; gap: 4px; }
	.modes button { min-height: 36px; padding: 6px 12px; white-space: nowrap; }
	.modes [aria-pressed='true'] { background: var(--selection); border-color: var(--accent); color: var(--accent); font-weight: 600; }
	.editor-surfaces { min-height: 0; flex: 1; display: grid; grid-template-columns: minmax(0, 1fr); }
	.visual { min-height: 0; overflow: auto; padding: 24px; }
	.visual-status { margin: 0 0 12px; font-size: 13px; color: var(--muted); }
	.visual :global(.ProseMirror) { min-height: 100%; outline: none; line-height: 1.7; }
	.visual :global(.ProseMirror:focus-visible) { outline: 2px solid var(--accent); outline-offset: 4px; }
	.visual :global(.source-block) { display: block; white-space: pre-wrap; }
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
	.visual :global(.visual-math-content) { overflow-x: auto; margin-block-end: 6px; }
	.visual :global(.visual-math-inline) { display: inline-flex; vertical-align: baseline; align-items: baseline; gap: 4px; margin: 0 2px; max-width: 100%; }
	.visual :global(.visual-math-inline .visual-math-content) { display: inline; margin: 0; overflow-x: visible; }
	.visual :global(.visual-math-inline .text-button) { padding: 2px 4px; min-height: 32px; font-size: 12px; }
	.visual :global(.visual-math math-field) { color: var(--ink); background: var(--surface); border: none; max-width: 100%; --selection-background-color: var(--selection); }
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
