import { describe, it, expect } from 'vitest';
import { buildAnchor, resolveAnchor, resolveAnchorLoose, normalizeForMatch } from '$lib/comments/anchor';

const doc = 'The first paragraph mentions gravity.\nThe second paragraph mentions gravity too.\n';

describe('buildAnchor', () => {
	it('keeps the quote with context either side', () => {
		const at = doc.indexOf('first paragraph');
		const a = buildAnchor(doc, at, at + 'first paragraph'.length);
		expect(a.quote).toBe('first paragraph');
		expect(a.prefix).toBe('The ');
		expect(a.suffix.startsWith(' mentions gravity')).toBe(true);
	});

	it('does not run off either end of the document', () => {
		const a = buildAnchor(doc, 0, 3);
		expect(a.prefix).toBe('');
		const end = buildAnchor(doc, doc.length - 1, doc.length);
		expect(end.suffix).toBe('');
	});
});

describe('resolveAnchor', () => {
	it('reports an untouched document as exact', () => {
		const at = doc.indexOf('gravity');
		const a = buildAnchor(doc, at, at + 7);
		expect(resolveAnchor(doc, a)).toEqual({ from: at, to: at + 7, exact: true });
	});

	it('follows the quote when text is inserted above it', () => {
		const at = doc.indexOf('second paragraph');
		const a = buildAnchor(doc, at, at + 'second paragraph'.length);
		const edited = 'A new opening line.\n' + doc;
		const hit = resolveAnchor(edited, a);
		expect(hit).not.toBeNull();
		expect(hit!.exact).toBe(false);
		expect(edited.slice(hit!.from, hit!.to)).toBe('second paragraph');
		expect(hit!.from).toBe(edited.indexOf('second paragraph'));
	});

	it('picks the right copy of a repeated quote using its context', () => {
		// "gravity" appears twice; the anchor is on the SECOND one
		const second = doc.lastIndexOf('gravity');
		const a = buildAnchor(doc, second, second + 7);
		// push everything down so the remembered offset is wrong for both copies
		const edited = 'Padding.\n'.repeat(4) + doc;
		const hit = resolveAnchor(edited, a);
		expect(hit).not.toBeNull();
		expect(hit!.from).toBe(edited.lastIndexOf('gravity'));
	});

	it('orphans a comment whose text is gone rather than guessing', () => {
		const at = doc.indexOf('gravity');
		const a = buildAnchor(doc, at, at + 7);
		expect(resolveAnchor('An entirely different document.', a)).toBeNull();
	});

	it('refuses a quote too short to identify', () => {
		const a = buildAnchor(doc, 0, 2);
		expect(resolveAnchor(doc, a)).toBeNull();
	});

	it('normalizes both dialects to one canonical form, remembering raw offsets', () => {
		const src = "a \\& b --- c\nwrapped ``quote'' here";
		const { text, map } = normalizeForMatch(src);
		expect(text).toBe('a & b — c wrapped "quote" here');
		expect(map).toHaveLength(text.length);
		// the em dash points back at the first raw hyphen, the collapsed newline at the newline
		expect(src.slice(map[text.indexOf('—')], map[text.indexOf('—')] + 3)).toBe('---');
		expect(src[map[text.indexOf(' wrapped')]]).toBe('\n');
		// rendered dialect converges on the same form
		expect(normalizeForMatch('a & b — c wrapped “quote” here').text).toBe(text);
	});

	it('resolves a source-authored anchor in rendered text across a line wrap', () => {
		const source = 'The theorem holds\nfor every bounded case.\n';
		const rendered = 'The theorem holds for every bounded case.';
		const at = source.indexOf('holds\nfor every');
		const a = buildAnchor(source, at, at + 'holds\nfor every'.length);
		expect(resolveAnchor(rendered, a)).toBeNull(); // raw matching cannot cross the wrap
		const hit = resolveAnchorLoose(rendered, a);
		expect(hit).not.toBeNull();
		expect(rendered.slice(hit!.from, hit!.to)).toBe('holds for every');
	});

	it('resolves a rendered-authored anchor back in the source through escapes', () => {
		const rendered = 'Costs rise — profits & losses follow.';
		const source = 'Costs rise --- profits \\& losses\nfollow.\n';
		const at = rendered.indexOf('— profits & losses');
		const a = buildAnchor(rendered, at, at + '— profits & losses'.length);
		const hit = resolveAnchorLoose(source, a);
		expect(hit).not.toBeNull();
		expect(source.slice(hit!.from, hit!.to)).toBe('--- profits \\& losses');
	});

	it('orphans a quote that repeats past the scan cap instead of ranking the first 500', () => {
		// a comment on \begin, in a document with far more of them than the scan collects. The
		// commented one is near the END, so scoring the truncated hit list would answer with a copy
		// from the top of the file - confidently, and wrongly.
		const body = '\\begin{itemize}\n\\item x\n\\end{itemize}\n'.repeat(600);
		const target = '\\begin{figure}[h]\n\\centering\n';
		const src = body + target + body;
		const at = src.indexOf(target);
		const a = buildAnchor(src, at, at + 6); // just "\begin"
		// the offsets still hold, so the fast path answers without searching
		expect(resolveAnchor(src, a)).toEqual({ from: at, to: at + 6, exact: true });
		// push everything down and it has to search - and must decline
		expect(resolveAnchor('padding\n' + src, a)).toBeNull();
	});
});
