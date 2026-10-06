import { describe, expect, it } from 'vitest';
import { sanitizeValidatedSVG, sanitizeDrawioLightSVG, SVG_BYTE_LIMIT, DiagramSvgError } from '../src/diagram-svg';

const wrap = (body = '', attributes = '') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 160" ${attributes}>${body}</svg>`;
describe('fail-closed vector SVG validation', () => {
	it('preserves actual retained 31.1.8 vector-copy export metadata, colors and labels', () => {
		// Actual synthetic vendor output, 30163f/e9c13ae0: no producer or label substitution.
		const svg =
			'<svg xmlns="http://www.w3.org/2000/svg" style="background: transparent; background-color: transparent; color-scheme: light;" xmlns:xlink="http://www.w3.org/1999/xlink" version="1.1" width="442px" height="102px" viewBox="0 0 442 102"><defs/><g><g data-cell-id="0"><g data-cell-id="1"><g data-cell-id="a"><g transform="translate(0.5,0.5)"><rect x="0" y="0" width="220" height="100" rx="15" ry="15" fill="#ffffff" stroke="#2458a6" pointer-events="all" style="fill: light-dark(rgb(255, 255, 255), rgb(18, 18, 18)); stroke: light-dark(rgb(36, 88, 166), rgb(125, 170, 237));"/></g><g><g fill="#111111" font-family="Helvetica" text-anchor="middle" data-blockTextHeight="28.799999999999997" font-size="12px" style="fill: light-dark(rgb(17, 17, 17), rgb(223, 223, 223));"><g transform="translate(110,35.6) scale(1)"><text y="12" data-line-font-size="12" x="0"><tspan>中文</tspan></text><text y="26.4" data-line-font-size="12" x="0"><tspan font-weight="bold"><tspan>Vector bold</tspan></tspan></text></g></g></g></g><g data-cell-id="b"><g transform="translate(0.5,0.5)"><rect x="300" y="0" width="140" height="100" fill="#ffffff" stroke="#2458a6" pointer-events="all" style="fill: light-dark(rgb(255, 255, 255), rgb(18, 18, 18)); stroke: light-dark(rgb(36, 88, 166), rgb(125, 170, 237));"/></g><g><g fill="#111111" font-family="Helvetica" text-anchor="middle" font-size="12px" style="fill: light-dark(rgb(17, 17, 17), rgb(223, 223, 223));"><g transform="translate(370,55) scale(1)"><text><tspan>Second</tspan></text></g></g></g></g><g data-cell-id="edge"><g transform="translate(0.5,0.5)"><path d="M 220 50 L 293.63 50" fill="none" stroke="#2458a6" stroke-miterlimit="10" pointer-events="stroke" style="stroke: light-dark(rgb(36, 88, 166), rgb(125, 170, 237));"/><path d="M 298.88 50 L 291.88 53.5 L 293.63 50 L 291.88 46.5 Z" fill="#2458a6" stroke="#2458a6" stroke-miterlimit="10" pointer-events="all" style="fill: light-dark(rgb(36, 88, 166), rgb(125, 170, 237)); stroke: light-dark(rgb(36, 88, 166), rgb(125, 170, 237));"/></g><g><g fill="#111111" font-family="Helvetica" text-anchor="middle" font-size="11px" style="fill: light-dark(rgb(17, 17, 17), rgb(223, 223, 223));"><g transform="translate(260,54.5) scale(1)"><text><tspan>Edge label</tspan></text></g></g></g></g></g></g></g></svg>';
		const result = sanitizeValidatedSVG(svg);
		expect(result).toMatchObject({ widthPx: 442, heightPx: 102 });
		for (const label of ['中文', 'Vector bold', 'Second', 'Edge label']) expect(result.svg).toContain(label);
		expect(result.svg).toContain('light-dark(');
		expect(result.svg).toContain('data-line-font-size="12"');
		expect(result.svg).not.toContain('foreignObject');
	});
	it.each(['dark', 'auto', 'light dark', 'url(https://example.invalid)'])('rejects root color-scheme %s', (value) => {
		expect(() => sanitizeValidatedSVG(wrap('', `style="color-scheme:${value}"`))).toThrow('INVALID_SVG');
	});
	it.each([
		'light-dark(url(https://example.invalid),white)',
		'light-dark(var(--x),white)',
		'light-dark(red,blue,white)',
		'light-dark(light-dark(red,blue),white)',
		'light-dark(rgb(1,2,3),calc(1 + 2))',
		'light-dark(red)'
	])('rejects unsafe adaptive color %s', (fill) => {
		expect(() => sanitizeValidatedSVG(wrap(`<text fill="${fill}">label</text>`, 'style="color-scheme:light"'))).toThrow('INVALID_SVG');
	});
	it.each([
		'<g pointer-events="visiblePainted"/>',
		'<g pointer-events="url(https://example.invalid)"/>',
		'<text data-cell-id="a">label</text>',
		'<path d="M0 0L1 1" data-blockTextHeight="1"/>',
		'<g data-line-font-size="12"/>',
		'<g data-blockTextHeight="NaN"/>',
		'<g data-blockTextHeight="Infinity"/>',
		'<g data-blockTextHeight="-1"/>',
		'<text data-line-font-size="1e999">label</text>',
		'<text data-line-font-size="-1">label</text>',
		'<g data-cell-id="' + 'x'.repeat(129) + '"/>',
		'<g data-other="metadata"/>'
	])('rejects unsupported vendor metadata/enum %s', (body) => {
		expect(() => sanitizeValidatedSVG(wrap(body))).toThrow('INVALID_SVG');
	});
	it('requires explicit root light scheme for adaptive colors and rejects arbitrary root CSS', () => {
		expect(() => sanitizeValidatedSVG(wrap('<text fill="light-dark(red,blue)">label</text>'))).toThrow('INVALID_SVG');
		expect(() => sanitizeValidatedSVG(wrap('', 'style="color-scheme:light;fill:red"'))).toThrow('INVALID_SVG');
	});
	it('preserves vector text, Unicode, paths, local gradients and clips', () => {
		const svg = wrap(
			'<defs><linearGradient id="paint"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/></linearGradient><clipPath id="clip"><rect width="300" height="140"/></clipPath></defs><g clip-path="url(#clip)" transform="translate(5, 5)"><path d="M 0 0 L 300 100 Z" fill="url(#paint)"/><text x="10" y="30" style="font-family:Arial;font-size:18px;fill:#000">向量 &amp; labels<tspan dx="5" font-weight="bold">bold</tspan></text></g>'
		);
		const result = sanitizeValidatedSVG(svg);
		expect(result).toMatchObject({ widthPx: 320, heightPx: 160 });
		expect(result.svg).toContain('向量 &amp; labels');
		expect(result.svg).toContain('<path');
		expect(result.svg).toContain('<tspan');
		expect(result.svg).not.toContain('foreignObject');
		expect(result.svg).toContain('width="320"');
	});
	it.each([
		'<script>alert(1)</script>',
		'<foreignObject><div>important label</div></foreignObject>',
		'<image href="https://example.invalid/pixel"/>',
		'<use href="#shape"/>',
		'<a href="https://example.invalid">link</a>',
		'<style>@import "https://example.invalid";</style>',
		'<animate attributeName="fill"/>',
		'<path d="M0 0L1 1" onclick="alert(1)"/>',
		'<path d="M0 0L1 1" ONLOAD="alert(1)"/>',
		'<g xmlns="http://www.w3.org/1999/xhtml"/>',
		'<g xmlns:a="http://example.invalid" a:value="1"/>',
		'<rect width="10" height="10" fill="url(https://example.invalid)"/>',
		'<rect width="10" height="10" fill="url(data:image/svg+xml,evil)"/>',
		'<text style="font-family:Arial;filter:url(#x)">label</text>',
		'<text style="font-size:calc(1px + 2px)">label</text>',
		'<text style="fill:var(--x)">label</text>',
		'<text style="fill:red!important">label</text>',
		'<text style="fill:red;fill:blue">label</text>',
		'<g style="fill:u\\72l(https://example.invalid)"/>',
		'<g style="/*a*/fill:red"/>',
		'<text><![CDATA[label]]></text>',
		'<!--comment-->',
		'<svg viewBox="0 0 1 1"/>',
		'<rect unknown="preserve-me"/>',
		'<g>visible but misplaced text</g>',
		'<path d="M0 0LNaN 1"/>',
		'<path d="M0 0L1e999 1"/>',
		'<path d="M0 0L1"/>',
		'<path d="M0 0A1 1 0 3 0 1 1"/>',
		'<g transform="translate(1) trailing"/>',
		'<g id="same"/><g id="same"/>',
		'<g clip-path="url(#missing)"/>'
	])('rejects unsupported content without deleting it: %s', (body) => {
		expect(() => sanitizeValidatedSVG(wrap(body))).toThrow(DiagramSvgError);
	});
	it.each([
		'<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///secret">]>',
		'<?xml-stylesheet href="https://example.invalid"?>',
		'<?xml version="1.0"?>',
		'<!ENTITY x "value">'
	])('rejects declarations before XML parsing', (prefix) => {
		expect(() => sanitizeValidatedSVG(prefix + wrap())).toThrow('INVALID_SVG');
	});
	it.each(['&unknown;', '&#0;', '&#xD800;', '&#x110000;', '&amp', '\u0000'])('rejects illegal entities/characters %s', (text) => {
		expect(() => sanitizeValidatedSVG(wrap(`<text>${text}</text>`))).toThrow('INVALID_SVG');
	});
	it.each([
		'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><g></svg>',
		wrap() + wrap(),
		wrap('', 'viewBox="0 0 1 1"'),
		'<svg viewBox="0 0 1 1"/>'
	])('rejects malformed/namespace-less XML', (svg) => {
		expect(() => sanitizeValidatedSVG(svg)).toThrow('INVALID_SVG');
	});
	it.each(['0 0 0 10', '0 0 10 -1', '0 0 8193 1', '0 0 8192 8192', '0 0 NaN 1', '0 0 1e999 1', '1000001 0 1 1', '0 0 1'])(
		'rejects unbounded/invalid viewport %s',
		(viewBox) => {
			expect(() => sanitizeValidatedSVG(wrap().replace('0 0 320 160', viewBox))).toThrow(DiagramSvgError);
		}
	);
	it('accepts exact finite page bounds without scaling', () => {
		expect(sanitizeValidatedSVG(wrap().replace('0 0 320 160', '-1000000 1000000 8192 2048'))).toMatchObject({
			widthPx: 8192,
			heightPx: 2048
		});
	});
	it('accepts only the unused exact retained-vendor xlink declaration', () => {
		expect(sanitizeValidatedSVG(wrap('<text>label</text>', 'xmlns:xlink="http://www.w3.org/1999/xlink"')).svg).toContain('xmlns:xlink');
		expect(() => sanitizeValidatedSVG(wrap('<path d="M0 0L1 1" xlink:href="#x"/>', 'xmlns:xlink="http://www.w3.org/1999/xlink"'))).toThrow(
			'INVALID_SVG'
		);
		expect(() => sanitizeValidatedSVG(wrap('', 'xmlns:xlink="https://example.invalid"'))).toThrow('INVALID_SVG');
	});
	it.each([
		'<defs><clipPath id="a"><g clip-path="url(#a)"/></clipPath></defs>',
		'<defs><clipPath id="a"><g id="child" clip-path="url(#a)"/></clipPath></defs>',
		'<defs><clipPath id="a"><g clip-path="url(#b)"/></clipPath><clipPath id="b"><g clip-path="url(#a)"/></clipPath></defs>',
		'<defs><marker id="a"><path d="M0 0L1 1" marker-end="url(#b)"/></marker><marker id="b"><path d="M0 0L1 1" marker-end="url(#a)"/></marker></defs>',
		'<defs><linearGradient id="a" fill="url(#b)"/><linearGradient id="b" fill="url(#a)"/></defs>',
		'<defs><clipPath id="a"><rect width="1" height="1"/></clipPath></defs><path d="M0 0L1 1" fill="url(#a)"/>',
		'<defs><linearGradient id="a"/></defs><g clip-path="url(#a)"/>'
	])('rejects cyclic/self/ancestor references and wrong target types', (body) => {
		expect(() => sanitizeValidatedSVG(wrap(body))).toThrow('INVALID_SVG');
	});
	it('bounds UTF-8 bytes, not only UTF-16 length', () => {
		expect(() => sanitizeValidatedSVG(wrap(`<text>${'漢'.repeat(Math.floor(SVG_BYTE_LIMIT / 3))}</text>`))).toThrow('SVG_TOO_LARGE');
	});
	it('bounds nodes including text and nesting', () => {
		expect(() => sanitizeValidatedSVG(wrap('<g/>'.repeat(20_000)))).toThrow('SVG_TOO_COMPLEX');
		expect(() => sanitizeValidatedSVG(wrap('<g>'.repeat(64) + '</g>'.repeat(64)))).toThrow('SVG_TOO_COMPLEX');
	});
	it('bounds individual path and total path complexity', () => {
		const d = 'M0 0' + ' L0 0'.repeat(210_000);
		expect(() => sanitizeValidatedSVG(wrap(`<path d="${d}"/>`))).toThrow('SVG_TOO_COMPLEX');
		const smaller = 'M0 0' + ' L0 0'.repeat(180_000);
		expect(() => sanitizeValidatedSVG(wrap(`<path d="${smaller}"/>`.repeat(10)))).toThrow('SVG_TOO_COMPLEX');
	});
});

const adaptiveStyle =
	'<style type="text/css">@supports (color: light-dark(#000, #fff)) { #ge-svg-proof { --ge-adaptive-bg: light-dark(#ffffff, var(--ge-dark-color, #121212)); } }</style>';
const adaptiveRect =
	'<rect x="170" y="90" width="120" height="60" fill="#ffffff" stroke="#000000" pointer-events="all" style="fill: var(--ge-adaptive-bg, #ffffff); stroke: light-dark(rgb(0, 0, 0), rgb(255, 255, 255));"/>';
const adaptiveSvg = (body = adaptiveRect, style = adaptiveStyle) =>
	wrap(style + body, 'id="ge-svg-proof" style="background: transparent; background-color: transparent; color-scheme: light;"');
describe('bounded fixed-light retained Draw.io normalization', () => {
	it('interprets only the observed vendor template without changing explicit paints, labels or geometry', () => {
		const body =
			adaptiveRect +
			'<rect x="7" width="19" height="31" fill="#2458a6" style="fill:light-dark(rgb(36, 88, 166),rgb(125, 170, 237));stroke-width:2"/><text x="10" y="20"><tspan font-weight="bold">中文 Start End</tspan></text>';
		const input = adaptiveSvg(body);
		expect(() => sanitizeValidatedSVG(input)).toThrow('INVALID_SVG');
		const result = sanitizeDrawioLightSVG(input);
		expect(result.svg).not.toMatch(/<style|var\(|light-dark\(/);
		expect(result.svg).toContain('fill: #ffffff; stroke: rgb(0, 0, 0);');
		expect(result.svg).toContain('fill:rgb(36, 88, 166);stroke-width:2');
		expect(result.svg).toContain('x="170" y="90" width="120" height="60"');
		expect(result.svg).toContain('fill="#2458a6"');
		expect(result.svg).toContain('<tspan font-weight="bold">中文 Start End</tspan>');
		expect(sanitizeValidatedSVG(result.svg)).toEqual(result);
	});
	it.each([
		(s: string) => s.replace('#ge-svg-proof {', '#other {'),
		(s: string) => s.replace('#ge-svg-proof {', '#ge-svg-proof, rect {'),
		(s: string) => s.replace('; } }', '; fill: red; } }'),
		(s: string) => s.replace('@supports', '/*comment*/@supports'),
		(s: string) => s.replace('--ge-dark-color', '--other'),
		(s: string) => s.replace('#121212', 'url(https://example.invalid)'),
		(s: string) => s.replace('#121212', 'var(--other)'),
		(s: string) => s.replace('#121212', 'light-dark(red,blue)'),
		(s: string) => s.replace('#121212', 'rgb(999,0,0)'),
		(s: string) => s.replace('</style>', '<g/></style>'),
		(s: string) => s.replace('type="text/css"', 'type="text/css" onload="bad"'),
		(s: string) => s.replace('<style ', '<style xmlns="http://www.w3.org/1999/xhtml" '),
		(s: string) => s.replace('</style>', '</style>' + adaptiveStyle),
		(s: string) => s.replace('<style ', '\n<style '),
		(s: string) => s.replace('color-scheme: light', 'color-scheme: dark'),
		(s: string) => s.replace('color-scheme: light', 'color-scheme: auto'),
		(s: string) => s.replace('color-scheme: light;', ''),
		(s: string) => s.replace('var(--ge-adaptive-bg, #ffffff)', 'var(--ge-adaptive-bg, #000000)'),
		(s: string) => s.replace('var(--ge-adaptive-bg, #ffffff)', 'var(--other, #ffffff)'),
		(s: string) => s.replace('var(--ge-adaptive-bg, #ffffff)', 'var(--ge-adaptive-bg, url(https://example.invalid))'),
		(s: string) => s.replace('fill: var(', 'stroke: var('),
		(s: string) => s.replace('fill: var(--ge-adaptive-bg, #ffffff);', 'fill:#ffffff;'),
		(s: string) => s.replace(adaptiveStyle, ''),
		(s: string) => s.replace('rgb(255, 255, 255)', 'url(https://example.invalid)'),
		(s: string) => s.replace('rgb(255, 255, 255)', 'var(--other)'),
		(s: string) => s.replace('rgb(255, 255, 255)', 'light-dark(red,blue)'),
		(s: string) => s.replace('rgb(255, 255, 255)', 'red,blue')
	])('rejects unknown/ambiguous templates and unsafe light or dark paints %#', (mutate) => {
		expect(() => sanitizeDrawioLightSVG(mutate(adaptiveSvg()))).toThrow('INVALID_SVG');
	});
	it.each([
		'<foreignObject>preserve important label</foreignObject>',
		'<g onclick="bad"/>',
		'<image href="https://example.invalid"/>',
		'<g xmlns="http://www.w3.org/1999/xhtml"/>',
		'<style type="text/css">rect{fill:red}</style>',
		'<rect style="fill:var(--unknown)"/>'
	])('still rejects all unsupported content %s', (body) => {
		expect(() => sanitizeDrawioLightSVG(adaptiveSvg(adaptiveRect + body))).toThrow('INVALID_SVG');
	});
	it('counts original removed style/text nodes, original attribute bytes and depth before normalization', () => {
		expect(() => sanitizeDrawioLightSVG(adaptiveSvg(adaptiveRect + '<g/>'.repeat(19_997)))).toThrow('SVG_TOO_COMPLEX');
		expect(() => sanitizeDrawioLightSVG(adaptiveSvg(adaptiveRect + '<g>'.repeat(64) + '</g>'.repeat(64)))).toThrow('SVG_TOO_COMPLEX');
		expect(() => sanitizeDrawioLightSVG(adaptiveSvg(adaptiveRect + `<g fill="${'x'.repeat(1024 * 1024)}"/>`.repeat(17)))).toThrow(
			'SVG_TOO_COMPLEX'
		);
		expect(() => sanitizeDrawioLightSVG(adaptiveSvg(adaptiveRect + `<path d="${'M0 0 L0 0 '.repeat(120_000)}"/>`))).toThrow(
			'SVG_TOO_COMPLEX'
		);
	});
	it('retains XML/declaration and reference-cycle guards', () => {
		expect(() => sanitizeDrawioLightSVG('<?xml version="1.0"?>' + adaptiveSvg())).toThrow('INVALID_SVG');
		expect(() =>
			sanitizeDrawioLightSVG(adaptiveSvg(adaptiveRect + '<defs><clipPath id="a"><g clip-path="url(#a)"/></clipPath></defs>'))
		).toThrow('INVALID_SVG');
	});
});
