// Original templates authored for the approved document-workbench specification.
import { SourceDocument } from '@modutex/document-core';

export const templateOptions = Object.freeze([
	Object.freeze({ id: 'blank', title: '空白文件', description: '最小 LaTeX 文件' }),
	Object.freeze({ id: 'article', title: '文章', description: '標題與章節' }),
	Object.freeze({ id: 'report', title: '報告', description: '標題與章' })
] as const);
export type TemplateId = typeof templateOptions[number]['id'];
const sources: Readonly<Record<TemplateId, string>> = Object.freeze({
	blank: '\\documentclass{article}\n\n\\begin{document}\n\\null\n\n\\end{document}\n',
	article: '\\documentclass{article}\n\n\\title{Document title}\n\\author{}\n\\date{}\n\n\\begin{document}\n\\maketitle\n\n\\section{Introduction}\n\n\\end{document}\n',
	report: '\\documentclass{report}\n\n\\title{Report title}\n\\author{}\n\\date{}\n\n\\begin{document}\n\\maketitle\n\n\\chapter{Introduction}\n\n\\end{document}\n'
});
/** Closed identifiers, not arbitrary source paths or inherited object properties. */
export function createDraft(value: unknown): SourceDocument {
	if (typeof value !== 'string' || !templateOptions.some(option => option.id === value)) throw new Error('BAD_TEMPLATE');
	return SourceDocument.open(new TextEncoder().encode(sources[value as TemplateId]));
}
