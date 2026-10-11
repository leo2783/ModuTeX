import type { EditorState } from '@codemirror/state';
import {
	projectionIsCurrent,
	type SourceDocument,
	type SourceProjection,
	type SourceSpan,
	type SyntaxNode
} from '@modutex/document-core';
import { insertionTransaction, rangeInsertionTarget, sourceState } from '../source-editor/state.ts';

export interface CodeDraft {
	readonly code: string;
}

export interface LocatedCode {
	readonly draft: CodeDraft;
	readonly span: SourceSpan;
	readonly content: SourceSpan;
	readonly starred?: boolean;
}

/**
 * 安全序列化為 LaTeX 內建 verbatim 環境。
 * 嚴格禁止內嵌 \end{verbatim} 結束標記以防止 TeX 語法逃逸。
 */
export function codeSource(code: string, starred = false): string {
	if (typeof code !== 'string' || code.length > 1048576 || code.includes('\0')) {
		throw new Error('CODE_SOURCE');
	}
	// 內建 verbatim 在語法上無法跳脫 \end{verbatim}，禁止內嵌結束標記
	if (code.includes('\\end{verbatim}') || code.includes('\\end{verbatim*}')) {
		throw new Error('CODE_END_DELIMITER');
	}
	const normalized = code.replace(/\r\n|\r/g, '\n');
	const env = starred ? 'verbatim*' : 'verbatim';
	// LaTeX verbatim 會自動吸收 \begin{verbatim} 緊接的首個換行符；確保結尾換行使 \end{verbatim} 位於新行
	const body = normalized.endsWith('\n')
		? normalized
		: (normalized.length > 0 ? normalized + '\n' : '');
	return `\\begin{${env}}\n${body}\\end{${env}}`;
}

/**
 * 解析 verbatim 節點原始內容，還原為實際程式碼草稿文字。
 */
export function parseVerbatimContent(raw: string): string {
	let text = raw.replace(/\r\n|\r/g, '\n');
	if (text.startsWith('\n')) {
		text = text.slice(1);
	}
	if (text.endsWith('\n')) {
		text = text.slice(0, -1);
	}
	return text;
}

/**
 * 依據游標位移 offset 定位 verbatim 程式碼區塊。
 */
export function codeAt(
	source: SourceDocument,
	projection: SourceProjection,
	offset: number
): LocatedCode | null {
	if (!projectionIsCurrent(source, projection) || !Number.isInteger(offset) || offset < 0 || offset >= source.length) {
		return null;
	}

	function visit(nodes: readonly SyntaxNode[]): LocatedCode | null {
		for (const node of nodes) {
			if (offset < node.span.from || offset > node.span.to) continue;
			if (
				(node.kind === 'raw' || node.kind === 'environment') &&
				node.content &&
				(node.name === 'verbatim' || node.name === 'verbatim*')
			) {
				const raw = source.read(node.content.from, node.content.to);
				return {
					draft: { code: parseVerbatimContent(raw) },
					span: node.span,
					content: node.content,
					starred: node.name === 'verbatim*'
				};
			}
			const childMatch = visit(node.children);
			if (childMatch) return childMatch;
		}
		return null;
	}

	return visit(projection.nodes);
}

/**
 * 驗證並產生現有程式碼區塊的置換文字。
 */
export function codeReplacement(source: SourceDocument, located: LocatedCode, draft: CodeDraft): string {
	const { span, content } = located;
	if (
		span.documentId !== source.documentId ||
		span.version !== source.version ||
		content.documentId !== source.documentId ||
		content.version !== source.version
	) {
		throw new Error('STALE_CODE');
	}
	return codeSource(draft.code, located.starred);
}

/**
 * 建立 CodeMirror 編輯交易，納入共享 SourceState 歷史（支援全域 Undo/Redo）。
 */
export function codeEditTransaction(state: EditorState, located: LocatedCode, draft: CodeDraft) {
	const source = state.field(sourceState).projection.document;
	const replacement = codeReplacement(source, located, draft);
	if (draft.code.replace(/\r\n|\r/g, '\n') === located.draft.code) return null;
	if (replacement === source.read(located.span.from, located.span.to)) {
		return null;
	}
	return insertionTransaction(
		state,
		rangeInsertionTarget(state, located.span),
		replacement.replace(/\r\n|\r/g, '\n')
	);
}
