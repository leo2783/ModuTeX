import { DOMParser, XMLSerializer } from '@xmldom/xmldom';

export const SVG_BYTE_LIMIT = 25 * 1024 * 1024;
export const SVG_NODE_LIMIT = 20_000;
export const SVG_DEPTH_LIMIT = 64;
const SVG_NS = 'http://www.w3.org/2000/svg';
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';
const XLINK_NS = 'http://www.w3.org/1999/xlink';
const NUMBER = '[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?';
const NUMBER_RE = new RegExp(`^${NUMBER}$`);
const NUMBERS_RE = new RegExp(NUMBER, 'g');
const ID_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;
const LOCAL_REF_RE = /^url\(#([A-Za-z_][A-Za-z0-9_.-]{0,127})\)$/;

export type DiagramSvgErrorCode = 'INVALID_SVG' | 'SVG_TOO_LARGE' | 'SVG_TOO_COMPLEX' | 'INVALID_VIEWPORT';
export class DiagramSvgError extends Error {
	constructor(readonly code: DiagramSvgErrorCode) {
		super(code);
		this.name = 'DiagramSvgError';
	}
}
export interface ValidatedDiagramSvg {
	svg: string;
	widthPx: number;
	heightPx: number;
}
function invalid(): never {
	throw new DiagramSvgError('INVALID_SVG');
}
function finiteNumber(value: string, bound = 1_000_000): number {
	if (!NUMBER_RE.test(value)) invalid();
	const n = Number(value);
	if (!Number.isFinite(n) || Math.abs(n) > bound) invalid();
	return n;
}
function numberList(value: string): number[] {
	if (!value.trim() || /[^\d.eE+,\s-]/.test(value)) invalid();
	const parts = value.trim().split(/[\s,]+/);
	return parts.map((v) => finiteNumber(v));
}
function length(value: string): void {
	const match = new RegExp(`^(${NUMBER})(px|em|%)?$`).exec(value);
	if (!match) invalid();
	finiteNumber(match[1]);
}
const COLORS = new Set(
	'none transparent currentColor black white red green blue yellow orange purple pink gray grey silver navy teal olive maroon aqua fuchsia lime'.split(
		' '
	)
);
function color(value: string, adaptive = true): void {
	if (adaptive && value.startsWith('light-dark(')) {
		// Exactly two existing colors: nested functions other than rgb/rgba are forbidden.
		const atom = '(rgb(?:a)?\\([^()]*\\)|[^(),]+)';
		const pair = new RegExp(`^light-dark\\(\\s*${atom}\\s*,\\s*${atom}\\s*\\)$`).exec(value);
		if (!pair) invalid();
		color(pair[1].trim(), false);
		color(pair[2].trim(), false);
		return;
	}
	if (COLORS.has(value) || /^#(?:[a-fA-F0-9]{3,4}|[a-fA-F0-9]{6}|[a-fA-F0-9]{8})$/.test(value)) return;
	const rgb = /^(rgb|rgba)\(([^()]*)\)$/.exec(value);
	if (!rgb) invalid();
	const parts = rgb[2].split(',').map((v) => v.trim());
	if (parts.length !== (rgb[1] === 'rgb' ? 3 : 4)) invalid();
	parts.forEach((v, i) => {
		const percent = v.endsWith('%');
		const n = finiteNumber(percent ? v.slice(0, -1) : v);
		if (n < 0 || n > (percent ? 100 : i === 3 ? 1 : 255)) invalid();
	});
}
function transform(value: string): void {
	const expression = /\s*(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^()]*)\)\s*/g;
	let end = 0;
	for (const match of value.matchAll(expression)) {
		if (match.index !== end) invalid();
		const values = numberList(match[2]);
		const counts: Record<string, readonly number[]> = {
			matrix: [6],
			translate: [1, 2],
			scale: [1, 2],
			rotate: [1, 3],
			skewX: [1],
			skewY: [1]
		};
		if (!counts[match[1]].includes(values.length)) invalid();
		end = match.index + match[0].length;
	}
	if (!end || end !== value.length) invalid();
}
function pathData(value: string): void {
	if (!value.trim() || /[^MmLlHhVvCcSsQqTtAaZz\d.eE+,\s-]/.test(value)) invalid();
	const tokens = value.match(new RegExp(`[MmLlHhVvCcSsQqTtAaZz]|${NUMBER}`, 'g')) ?? [];
	// Reject lexically unconsumed punctuation and malformed numbers, not just unsafe characters.
	if (value.replace(new RegExp(`[MmLlHhVvCcSsQqTtAaZz]|${NUMBER}`, 'g'), '').replace(/[\s,]/g, '') !== '') invalid();
	if (!/^[Mm]$/.test(tokens[0] ?? '')) invalid();
	const sizes: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
	let i = 0;
	while (i < tokens.length) {
		const command = tokens[i++].toUpperCase();
		if (!(command in sizes)) invalid();
		const size = sizes[command];
		let count = 0;
		while (i < tokens.length && !/^[A-Za-z]$/.test(tokens[i])) {
			if (size === 0) invalid();
			const n = finiteNumber(tokens[i++]);
			if (command === 'A' && (count % size === 3 || count % size === 4) && n !== 0 && n !== 1) invalid();
			count++;
		}
		if ((size !== 0 && (count === 0 || count % size !== 0)) || (size === 0 && count !== 0)) invalid();
	}
}
const TAG_ATTRS: Record<string, readonly string[]> = {
	svg: ['viewBox', 'width', 'height', 'preserveAspectRatio', 'version'],
	g: ['data-cell-id', 'data-blockTextHeight'],
	defs: [],
	title: [],
	desc: [],
	path: ['d', 'pathLength'],
	rect: ['x', 'y', 'width', 'height', 'rx', 'ry'],
	circle: ['cx', 'cy', 'r'],
	ellipse: ['cx', 'cy', 'rx', 'ry'],
	line: ['x1', 'y1', 'x2', 'y2'],
	polyline: ['points'],
	polygon: ['points'],
	text: ['x', 'y', 'dx', 'dy', 'rotate', 'textLength', 'lengthAdjust', 'data-line-font-size'],
	tspan: ['x', 'y', 'dx', 'dy', 'rotate', 'textLength', 'lengthAdjust', 'data-line-font-size'],
	clipPath: ['clipPathUnits'],
	linearGradient: ['x1', 'y1', 'x2', 'y2', 'gradientUnits', 'gradientTransform', 'spreadMethod'],
	radialGradient: ['cx', 'cy', 'r', 'fx', 'fy', 'fr', 'gradientUnits', 'gradientTransform', 'spreadMethod'],
	stop: ['offset', 'stop-color', 'stop-opacity'],
	marker: ['markerWidth', 'markerHeight', 'refX', 'refY', 'orient', 'markerUnits', 'viewBox', 'preserveAspectRatio']
};
const COMMON = new Set([
	'id',
	'style',
	'transform',
	'fill',
	'stroke',
	'fill-opacity',
	'stroke-opacity',
	'opacity',
	'stroke-width',
	'stroke-linecap',
	'stroke-linejoin',
	'stroke-miterlimit',
	'stroke-dasharray',
	'stroke-dashoffset',
	'fill-rule',
	'clip-rule',
	'clip-path',
	'marker-start',
	'marker-mid',
	'marker-end',
	'font-family',
	'font-size',
	'font-weight',
	'font-style',
	'text-anchor',
	'dominant-baseline',
	'alignment-baseline',
	'text-decoration',
	'letter-spacing',
	'word-spacing',
	'white-space',
	'visibility',
	'display',
	'vector-effect',
	'shape-rendering',
	'paint-order',
	'color',
	'pointer-events'
]);
const ENUMS: Record<string, readonly string[]> = {
	'pointer-events': ['none', 'all', 'stroke'],
	'fill-rule': ['nonzero', 'evenodd'],
	'clip-rule': ['nonzero', 'evenodd'],
	'stroke-linecap': ['butt', 'round', 'square'],
	'stroke-linejoin': ['miter', 'round', 'bevel'],
	'font-style': ['normal', 'italic', 'oblique'],
	'text-anchor': ['start', 'middle', 'end'],
	'dominant-baseline': ['auto', 'alphabetic', 'middle', 'central', 'hanging', 'text-before-edge', 'text-after-edge'],
	'alignment-baseline': ['auto', 'baseline', 'alphabetic', 'middle', 'central', 'hanging', 'text-before-edge', 'text-after-edge'],
	'text-decoration': ['none', 'underline', 'line-through', 'overline', 'underline line-through'],
	'white-space': ['normal', 'pre', 'pre-wrap'],
	visibility: ['visible', 'hidden'],
	display: ['inline', 'none'],
	'vector-effect': ['none', 'non-scaling-stroke'],
	'shape-rendering': ['auto', 'crispEdges', 'geometricPrecision'],
	'paint-order': ['normal', 'stroke fill', 'fill stroke'],
	gradientUnits: ['objectBoundingBox', 'userSpaceOnUse'],
	clipPathUnits: ['objectBoundingBox', 'userSpaceOnUse'],
	spreadMethod: ['pad', 'reflect', 'repeat'],
	markerUnits: ['strokeWidth', 'userSpaceOnUse'],
	lengthAdjust: ['spacing', 'spacingAndGlyphs']
};
interface LocalReference {
	id: string;
	property: string;
}
function property(name: string, value: string, refs: LocalReference[]): void {
	if (ENUMS[name]) {
		if (!ENUMS[name].includes(value)) invalid();
		return;
	}
	if (['fill', 'stroke', 'clip-path', 'marker-start', 'marker-mid', 'marker-end'].includes(name)) {
		const ref = LOCAL_REF_RE.exec(value);
		if (ref) {
			refs.push({ id: ref[1], property: name });
			return;
		}
		if (name === 'fill' || name === 'stroke') color(value);
		else if (value !== 'none') invalid();
		return;
	}
	if (name === 'color' || name === 'stop-color') {
		color(value);
		return;
	}
	if (name === 'font-family') {
		if (!/^[A-Za-z0-9 _,-]{1,200}$/.test(value)) invalid();
		return;
	}
	if (name === 'font-weight') {
		if (!/^(normal|bold|[1-9]00)$/.test(value)) invalid();
		return;
	}
	if (name === 'transform' || name === 'gradientTransform') {
		transform(value);
		return;
	}
	if (name === 'preserveAspectRatio') {
		if (!/^(none|x(Min|Mid|Max)Y(Min|Mid|Max)( (meet|slice))?)$/.test(value)) invalid();
		return;
	}
	if (name === 'version') {
		if (value !== '1.1' && value !== '2.0') invalid();
		return;
	}
	if (name === 'orient') {
		if (value !== 'auto' && value !== 'auto-start-reverse') finiteNumber(value);
		return;
	}
	if (name === 'stroke-dasharray') {
		if (value !== 'none') numberList(value);
		return;
	}
	if (name.endsWith('opacity') || name === 'offset') {
		const percent = value.endsWith('%');
		const n = finiteNumber(percent ? value.slice(0, -1) : value);
		if (n < 0 || n > (percent ? 100 : 1)) invalid();
		return;
	}
	if (['x', 'y', 'dx', 'dy', 'rotate'].includes(name)) {
		if (value.includes(',') || /\s/.test(value)) numberList(value);
		else length(value);
		return;
	}
	length(value);
}
function inlineStyle(value: string, refs: LocalReference[]): void {
	const seen = new Set<string>();
	for (const declaration of value.split(';')) {
		if (!declaration.trim()) continue;
		const match = /^\s*([a-z-]+)\s*:\s*([^:;]+?)\s*$/.exec(declaration);
		if (!match || !COMMON.has(match[1]) || ['id', 'style', 'transform'].includes(match[1]) || seen.has(match[1])) invalid();
		seen.add(match[1]);
		property(match[1], match[2], refs);
	}
}

function rootBackground(value: string): void {
	const seen = new Set<string>();
	for (const declaration of value.split(';')) {
		if (!declaration.trim()) continue;
		const match = /^\s*(background|background-color|color-scheme)\s*:\s*([^:;]+?)\s*$/.exec(declaration);
		if (!match || seen.has(match[1])) invalid();
		seen.add(match[1]);
		if (match[1] === 'color-scheme') {
			if (match[2] !== 'light') invalid();
		} else color(match[2], false);
	}
}

function parseSvgRoot(input: string): Element {
	if (typeof input !== 'string' || !input) invalid();
	if (input.length > SVG_BYTE_LIMIT || Buffer.byteLength(input, 'utf8') > SVG_BYTE_LIMIT) throw new DiagramSvgError('SVG_TOO_LARGE');
	// xmldom is an XML parser, not a security policy. Forbid declarations and invalid XML
	// characters before parsing; only the five predefined/numeric XML entities remain legal.
	if (/<!|<\?|[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(input)) invalid();
	for (const match of input.matchAll(/&([^;]*);?/g)) {
		if (!/^&(amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);$/.test(match[0])) invalid();
		if (match[1].startsWith('#')) {
			const cp = match[1][1] === 'x' ? parseInt(match[1].slice(2), 16) : Number(match[1].slice(1));
			if (!(
				cp === 9 ||
				cp === 10 ||
				cp === 13 ||
				(cp >= 32 && cp <= 0xd7ff) ||
				(cp >= 0xe000 && cp <= 0xfffd) ||
				(cp >= 0x10000 && cp <= 0x10ffff)
			))
				invalid();
		}
	}
	let doc: Document;
	try {
		doc = new DOMParser({ errorHandler: { warning: invalid, error: invalid, fatalError: invalid } }).parseFromString(
			input,
			'image/svg+xml'
		);
	} catch {
		invalid();
	}
	const root = doc.documentElement;
	if (!root || root.nodeName !== 'svg' || root.namespaceURI !== SVG_NS) invalid();
	for (let n = doc.firstChild; n; n = n.nextSibling) if (n !== root && !(n.nodeType === 3 && !n.nodeValue?.trim())) invalid();
	return root;
}

/** Validation is fail-closed: unsupported content is rejected, never stripped or rasterized. */
export function sanitizeValidatedSVG(input: string): ValidatedDiagramSvg {
	const root = parseSvgRoot(input);
	const viewBox = numberList(root.getAttribute('viewBox') ?? '');
	if (viewBox.length !== 4) throw new DiagramSvgError('INVALID_VIEWPORT');
	const [x, y, widthPx, heightPx] = viewBox;
	if (
		Math.abs(x) > 1_000_000 ||
		Math.abs(y) > 1_000_000 ||
		widthPx < 1 ||
		heightPx < 1 ||
		widthPx > 8192 ||
		heightPx > 8192 ||
		widthPx * heightPx > 16_777_216
	)
		throw new DiagramSvgError('INVALID_VIEWPORT');
	const stack: { node: Node; depth: number; owner: string }[] = [{ node: root, depth: 1, owner: '' }];
	const ids = new Map<string, string>();
	const references: LocalReference[] = [];
	const graph = new Map<string, Set<string>>();
	const edge = (from: string, to: string) => {
		if (!graph.has(from)) graph.set(from, new Set());
		graph.get(from)!.add(to);
	};
	let count = 0,
		attributeBytes = 0,
		pathBytes = 0;
	while (stack.length) {
		const { node, depth, owner: parentOwner } = stack.pop()!;
		if (++count > SVG_NODE_LIMIT || depth > SVG_DEPTH_LIMIT) throw new DiagramSvgError('SVG_TOO_COMPLEX');
		if (node.nodeType === 3) {
			if (node.nodeValue?.trim() && !['text', 'tspan', 'title', 'desc'].includes(node.parentNode?.nodeName ?? '')) invalid();
			continue;
		}
		if (node.nodeType !== 1) invalid();
		const element = node as Element;
		const tag = element.nodeName;
		if (element.namespaceURI !== SVG_NS || !Object.hasOwn(TAG_ATTRS, tag) || (tag === 'svg' && element !== root)) invalid();
		const refs: LocalReference[] = [];
		let owner = parentOwner;
		const ownId = element.getAttribute('id');
		if (ownId) {
			if (!ID_RE.test(ownId) || ids.has(ownId)) invalid();
			ids.set(ownId, tag);
			edge(parentOwner, ownId);
			owner = ownId;
		}
		for (let i = 0; i < element.attributes.length; i++) {
			const a = element.attributes.item(i)!;
			attributeBytes += Buffer.byteLength(a.value, 'utf8');
			if (attributeBytes > 16 * 1024 * 1024) throw new DiagramSvgError('SVG_TOO_COMPLEX');
			if (a.name === 'xmlns' && a.namespaceURI === XMLNS_NS && a.value === SVG_NS && element === root) continue;
			// Retained Graph.createSvgNode declares this constant even without links.
			// Declaration alone grants no xlink attribute: every namespaced href still fails.
			if (a.name === 'xmlns:xlink' && a.namespaceURI === XMLNS_NS && a.value === XLINK_NS && element === root) continue;
			if (a.namespaceURI || a.name.includes(':') || (!COMMON.has(a.name) && !TAG_ATTRS[tag].includes(a.name))) invalid();
			if (
				['style', 'fill', 'stroke', 'color', 'stop-color'].includes(a.name) &&
				a.value.includes('light-dark(') &&
				!/(?:^|;)\s*color-scheme\s*:\s*light\s*(?:;|$)/.test(root.getAttribute('style') ?? '')
			)
				invalid();
			if (a.name === 'id') {
				if (!ID_RE.test(a.value)) invalid();
			} else if (a.name === 'style') {
				if (element === root && /(?:^|;)\s*(?:background(?:-color)?|color-scheme)\s*:/.test(a.value)) rootBackground(a.value);
				else inlineStyle(a.value, refs);
			} else if (a.name === 'data-cell-id') {
				if (!a.value || a.value.length > 128 || Buffer.byteLength(a.value, 'utf8') > 256 || /[\u0000-\u001f\u007f]/.test(a.value))
					invalid();
			} else if (a.name === 'data-blockTextHeight' || a.name === 'data-line-font-size') {
				if (finiteNumber(a.value) < 0) invalid();
			} else if (a.name === 'd') {
				const bytes = Buffer.byteLength(a.value, 'utf8');
				pathBytes += bytes;
				if (bytes > 1024 * 1024 || pathBytes > 8 * 1024 * 1024) throw new DiagramSvgError('SVG_TOO_COMPLEX');
				pathData(a.value);
			} else if (a.name === 'points') {
				if (numberList(a.value).length % 2 !== 0) invalid();
			} else if (a.name === 'viewBox') {
				const numbers = numberList(a.value);
				if (numbers.length !== 4 || numbers[2] <= 0 || numbers[3] <= 0) invalid();
			} else property(a.name, a.value, refs);
		}
		for (const ref of refs) {
			references.push(ref);
			edge(owner, ref.id);
		}
		for (let child = node.lastChild; child; child = child.previousSibling) stack.push({ node: child, depth: depth + 1, owner });
	}
	for (const ref of references) {
		const allowed =
			ref.property === 'clip-path' ? ['clipPath'] : ref.property.startsWith('marker-') ? ['marker'] : ['linearGradient', 'radialGradient'];
		if (!allowed.includes(ids.get(ref.id) ?? '')) invalid();
	}
	// Containment edges plus dependency edges catch references from a resource's child
	// back to its own ancestor as well as indirect cycles. Iterative DFS avoids JS recursion.
	const colors = new Map<string, number>();
	for (const start of graph.keys()) {
		if (colors.get(start) === 2) continue;
		const visits = [{ id: start, exit: false }];
		while (visits.length) {
			const visit = visits.pop()!;
			if (visit.exit) {
				colors.set(visit.id, 2);
				continue;
			}
			if (colors.get(visit.id) === 1) invalid();
			if (colors.get(visit.id) === 2) continue;
			colors.set(visit.id, 1);
			visits.push({ id: visit.id, exit: true });
			for (const next of graph.get(visit.id) ?? []) visits.push({ id: next, exit: false });
		}
	}
	// Root sizing is canonicalized from the already-validated viewBox, never from renderer CSS.
	root.setAttribute('width', String(widthPx));
	root.setAttribute('height', String(heightPx));
	const svg = new XMLSerializer().serializeToString(root, false, undefined, { requireWellFormed: true });
	if (Buffer.byteLength(svg, 'utf8') > SVG_BYTE_LIMIT) throw new DiagramSvgError('SVG_TOO_LARGE');
	return { svg, widthPx, heightPx };
}

/** Fixed-light interpretation of the one retained Graph.addAdaptiveColors template.
 * No CSS is evaluated; all remaining content must pass the unchanged strict policy. */
export function sanitizeDrawioLightSVG(input: string): ValidatedDiagramSvg {
	const root = parseSvgRoot(input);
	const nodes: Element[] = [];
	const stack = [{ node: root as Node, depth: 1 }];
	let count = 0,
		attributeBytes = 0,
		pathBytes = 0;
	let template: Element | undefined;
	while (stack.length) {
		const { node, depth } = stack.pop()!;
		if (++count > SVG_NODE_LIMIT || depth > SVG_DEPTH_LIMIT) throw new DiagramSvgError('SVG_TOO_COMPLEX');
		if (node.nodeType === 3) {
			if (node.nodeValue?.trim() && !['text', 'tspan', 'title', 'desc', 'style'].includes(node.parentNode?.nodeName ?? '')) invalid();
			continue;
		}
		if (node.nodeType !== 1) invalid();
		const element = node as Element;
		const tag = element.nodeName;
		if (element.namespaceURI !== SVG_NS || (tag === 'svg' && element !== root)) invalid();
		if (tag === 'style') {
			// Actual vendor inserts this before every existing root child, including whitespace.
			if (
				template ||
				element !== root.firstChild ||
				element.parentNode !== root ||
				element.attributes.length !== 1 ||
				element.getAttribute('type') !== 'text/css'
			)
				invalid();
			template = element;
		} else if (!Object.hasOwn(TAG_ATTRS, tag)) invalid();
		for (let i = 0; i < element.attributes.length; i++) {
			const a = element.attributes.item(i)!;
			attributeBytes += Buffer.byteLength(a.value, 'utf8');
			if (attributeBytes > 16 * 1024 * 1024) throw new DiagramSvgError('SVG_TOO_COMPLEX');
			if (
				element === root &&
				a.namespaceURI === XMLNS_NS &&
				((a.name === 'xmlns' && a.value === SVG_NS) || (a.name === 'xmlns:xlink' && a.value === XLINK_NS))
			)
				continue;
			if (
				a.namespaceURI ||
				a.name.includes(':') ||
				(tag === 'style' ? a.name !== 'type' : !COMMON.has(a.name) && !TAG_ATTRS[tag].includes(a.name))
			)
				invalid();
			if (a.name === 'd') {
				const bytes = Buffer.byteLength(a.value, 'utf8');
				pathBytes += bytes;
				if (bytes > 1024 * 1024 || pathBytes > 8 * 1024 * 1024) throw new DiagramSvgError('SVG_TOO_COMPLEX');
			}
		}
		if (tag !== 'style') nodes.push(element);
		for (let child = node.lastChild; child; child = child.previousSibling) stack.push({ node: child, depth: depth + 1 });
	}
	const atom = '(rgb(?:a)?\\([^()]*\\)|[^(),;{}]+)';
	const pair = new RegExp(`^light-dark\\(\\s*${atom}\\s*,\\s*${atom}\\s*\\)$`);
	let light: string | undefined;
	let uses = 0;
	if (template) {
		const id = root.getAttribute('id') ?? '';
		if (!/^ge-svg-[A-Za-z0-9_-]+$/.test(id) || !ID_RE.test(id)) invalid();
		let css = '';
		for (let child = template.firstChild; child; child = child.nextSibling) {
			if (child.nodeType !== 3) invalid();
			css += child.nodeValue ?? '';
		}
		const prefix = `@supports (color: light-dark(#000, #fff)) { #${id} { --ge-adaptive-bg: `;
		if (!css.startsWith(prefix) || !css.endsWith('; } }')) invalid();
		const adaptive = css.slice(prefix.length, -5);
		const match = new RegExp(`^light-dark\\(${atom}, var\\(--ge-dark-color, ${atom}\\)\\)$`).exec(adaptive);
		if (!match) invalid();
		color(match[1], false);
		color(match[2], false);
		light = match[1];
	}
	const resolvePaint = (name: string, value: string): string => {
		if (value.startsWith('var(')) {
			if (!light || !['fill', 'background', 'background-color'].includes(name)) invalid();
			const match = new RegExp(`^var\\(--ge-adaptive-bg, ${atom}\\)$`).exec(value);
			if (!match) invalid();
			color(match[1], false);
			if (match[1] !== light) invalid();
			uses++;
			return light;
		}
		if (value.startsWith('light-dark(')) {
			const match = pair.exec(value);
			if (!match) invalid();
			color(match[1].trim(), false);
			color(match[2].trim(), false);
			return match[1].trim();
		}
		return value;
	};
	const rootStyle = root.getAttribute('style') ?? '';
	const adaptivePresent =
		Boolean(template) ||
		nodes.some((el) =>
			Array.from({ length: el.attributes.length }, (_, i) => el.attributes.item(i)!).some(
				(a) =>
					['style', 'fill', 'stroke', 'color', 'stop-color'].includes(a.name) &&
					(a.value.includes('light-dark(') || a.value.includes('var('))
			)
		);
	if (adaptivePresent && !/(?:^|;)\s*color-scheme\s*:\s*light\s*(?:;|$)/.test(rootStyle)) invalid();
	for (const element of nodes) {
		for (let i = 0; i < element.attributes.length; i++) {
			const a = element.attributes.item(i)!;
			if (a.name === 'style') {
				// Preserve all non-paint declarations byte-for-byte; strict validation follows.
				const rewritten = a.value
					.split(';')
					.map((declaration) => {
						const match = /^(\s*([a-z-]+)\s*:\s*)([^:;]*?)(\s*)$/.exec(declaration);
						if (!match || !['fill', 'stroke', 'color', 'stop-color', 'background', 'background-color'].includes(match[2]))
							return declaration;
						return match[1] + resolvePaint(match[2], match[3]) + match[4];
					})
					.join(';');
				element.setAttribute(a.name, rewritten);
			} else if (['fill', 'stroke', 'color', 'stop-color'].includes(a.name)) element.setAttribute(a.name, resolvePaint(a.name, a.value));
		}
	}
	if (template) {
		if (!uses) invalid();
		root.removeChild(template);
	}
	return sanitizeValidatedSVG(new XMLSerializer().serializeToString(root, false, undefined, { requireWellFormed: true }));
}
