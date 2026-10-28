import { parseSource, type SourceDocument, type SourcePatch } from '../document-core/core.ts';

// TeX-distributed fonts keep the same document usable on Windows without optional OS fonts.
export const BILINGUAL_PREAMBLE = '\\usepackage[UTF8,scheme=plain,fontset=fandol]{ctex}';

/** Explicit migration for existing documents. Existing CJK/font configuration remains authoritative. */
export function planBilingualPatches(source: SourceDocument): readonly SourcePatch[] {
	const parsed = parseSource(source);
	const bodies = parsed.nodes.filter(node => node.kind === 'environment' && node.name === 'document');
	const body = bodies[0];
	if (bodies.length !== 1 || !body?.content || parsed.issues.some(issue => issue.offset < body.span.from)) throw new Error('LANGUAGE_UNSUPPORTED');
	const preamble = parsed.nodes.filter(node => node.span.to <= body.span.from);
	for (const node of preamble) {
		if (node.name === 'documentclass') {
			const command = source.read(node.span.from, node.span.to);
			if (/\{ctex(?:art|rep|book|beamer)\}$/.test(command)) return [];
		}
		if (!['usepackage', 'RequirePackage'].includes(node.name)) continue;
		const command = source.read(node.span.from, node.span.to);
		const match = /^\\(?:usepackage|RequirePackage)\s*(?:\[[^\[\]\\%]*\]\s*)?\{([A-Za-z0-9_.-]+(?:\s*,\s*[A-Za-z0-9_.-]+)*)\}$/.exec(command);
		if (!match) throw new Error('LANGUAGE_UNSUPPORTED');
		const names = match[1]!.split(',').map(value => value.trim());
		if (names.some(name => ['ctex', 'xeCJK', 'luatexja', 'luatexja-fontspec', 'CJK', 'CJKutf8'].includes(name))) return [];
	}
	const at = body.span.from, eol = source.profile.preferredLineEnding;
	const before = at ? source.read(at - 1, at) : '';
	return [{ from: at, to: at, expected: '', insert: (before && !/[\r\n]/.test(before) ? eol : '') + BILINGUAL_PREAMBLE + eol }];
}
