import { addLatexPackage, getEditableLatexPreambleEnd } from './packagePatch';

export type PageMarginSide = 'top' | 'right' | 'bottom' | 'left';
export type PageMargins = Record<PageMarginSide, string>;
export type PageMarginsBlockedReason =
	'invalid-preamble' | 'unknown-geometry-settings' | 'geometry-package-options' | 'malformed-managed-settings';

export type PageMarginsInspection =
	{ kind: 'ready'; values: PageMargins; needsGeometryPackage: boolean } | { kind: 'blocked'; reason: PageMarginsBlockedReason };

export type PageMarginsPatch =
	| { kind: 'ready'; source: string; originalPreamble: string; preamble: string; addedGeometryPackage: boolean }
	| { kind: 'needs-package' }
	| { kind: 'blocked'; reason: PageMarginsBlockedReason }
	| { kind: 'invalid-values' };

export const DEFAULT_PAGE_MARGINS: PageMargins = { top: '2.54', right: '2.54', bottom: '2.54', left: '2.54' };

const START_MARKER = '% ModuTeX page margins begin';
const END_MARKER = '% ModuTeX page margins end';
const SIDES: PageMarginSide[] = ['top', 'right', 'bottom', 'left'];
const DECIMAL = '(?:0|[1-9]\\d*)(?:\\.\\d+)?';

interface ManagedBlock {
	start: number;
	end: number;
	text: string;
	values: PageMargins | null;
}

interface Markers {
	block: ManagedBlock | null;
	malformed: boolean;
}

function maskComments(source: string): string {
	const chars = source.split('');
	for (let i = 0; i < chars.length; i++) {
		if (chars[i] !== '%') continue;
		let slashes = 0;
		for (let j = i - 1; j >= 0 && chars[j] === '\\'; j--) slashes++;
		if (slashes % 2 === 1) continue;
		for (let j = i; j < chars.length && chars[j] !== '\n'; j++) chars[j] = ' ';
	}
	return chars.join('');
}

function locateMarkers(source: string): Markers {
	const markerLine = (text: string) => new RegExp(`^${text}[ \\t]*(?:\\r?\\n|$)`, 'gm');
	const starts = [...source.matchAll(markerLine(START_MARKER))];
	const ends = [...source.matchAll(markerLine(END_MARKER))];
	if (!starts.length && !ends.length) return { block: null, malformed: false };
	if (starts.length !== 1 || ends.length !== 1 || starts[0].index === undefined || ends[0].index === undefined) {
		return { block: null, malformed: true };
	}

	const start = starts[0].index;
	const startLineEnd = start + starts[0][0].length;
	if (ends[0].index < startLineEnd) return { block: null, malformed: true };
	const end = ends[0].index + ends[0][0].length;
	const text = source.slice(start, end);
	const eol = source.includes('\r\n') ? '\r\n' : '\n';
	const rule = new RegExp(`^\\\\geometry\\{top=(${DECIMAL})cm,right=(${DECIMAL})cm,bottom=(${DECIMAL})cm,left=(${DECIMAL})cm\\}${eol}$`);
	const body = source.slice(startLineEnd, ends[0].index);
	const match = rule.exec(body);
	const values = match ? { top: match[1], right: match[2], bottom: match[3], left: match[4] } : null;
	return { block: { start, end, text, values }, malformed: false };
}

function removeBlock(source: string, block: ManagedBlock | null): string {
	return block ? source.slice(0, block.start) + source.slice(block.end) : source;
}

function packageDeclarations(source: string, boundary: number): Array<{ name: string; options: string | null; end: number }> {
	const preamble = maskComments(source).slice(0, boundary);
	const pattern = /\\(?:usepackage|RequirePackage)\s*(?:\[([^\]\r\n]*)\]\s*)?\{([^{}]*)\}/g;
	const declarations: Array<{ name: string; options: string | null; end: number }> = [];
	for (const match of preamble.matchAll(pattern)) {
		const options = match[1] ?? null;
		for (const name of match[2].split(',').map((part) => part.trim())) {
			declarations.push({ name, options, end: (match.index ?? 0) + match[0].length });
		}
	}
	return declarations;
}

function inspect(source: string): {
	inspection: PageMarginsInspection;
	block: ManagedBlock | null;
	cleanSource: string;
	geometryEnd: number | null;
} {
	const markers = locateMarkers(source);
	if (markers.malformed) {
		return { inspection: { kind: 'blocked', reason: 'malformed-managed-settings' }, block: null, cleanSource: source, geometryEnd: null };
	}
	let block = markers.block;
	let cleanSource = removeBlock(source, block);
	if (/\\(?:geometry|newgeometry|restoregeometry)\b/.test(maskComments(cleanSource))) {
		return {
			inspection: { kind: 'blocked', reason: 'unknown-geometry-settings' },
			block,
			cleanSource,
			geometryEnd: null
		};
	}
	let boundary: number;
	try {
		boundary = getEditableLatexPreambleEnd(cleanSource);
	} catch {
		return { inspection: { kind: 'blocked', reason: 'invalid-preamble' }, block: null, cleanSource: source, geometryEnd: null };
	}
	// Marker-like comments in the document body are not ModuTeX-owned preamble settings.
	if (block && block.start > boundary) {
		block = null;
		cleanSource = source;
		if (/\\(?:geometry|newgeometry|restoregeometry)\b/.test(maskComments(cleanSource))) {
			return {
				inspection: { kind: 'blocked', reason: 'unknown-geometry-settings' },
				block: null,
				cleanSource,
				geometryEnd: null
			};
		}
		try {
			boundary = getEditableLatexPreambleEnd(cleanSource);
		} catch {
			return { inspection: { kind: 'blocked', reason: 'invalid-preamble' }, block: null, cleanSource: source, geometryEnd: null };
		}
	}
	if (block && !block.values) {
		return {
			inspection: { kind: 'blocked', reason: 'malformed-managed-settings' },
			block: null,
			cleanSource,
			geometryEnd: null
		};
	}
	const packages = packageDeclarations(cleanSource, boundary).filter(({ name }) => name === 'geometry');
	if (packages.length > 1 || (packages.length === 1 && packages[0].options?.trim())) {
		return {
			inspection: { kind: 'blocked', reason: 'geometry-package-options' },
			block,
			cleanSource,
			geometryEnd: packages[0]?.end ?? null
		};
	}
	if (block && packages.length !== 1) {
		return {
			inspection: { kind: 'blocked', reason: 'malformed-managed-settings' },
			block,
			cleanSource,
			geometryEnd: null
		};
	}

	let packagePatch: ReturnType<typeof addLatexPackage>;
	try {
		packagePatch = addLatexPackage(cleanSource, 'geometry');
	} catch {
		return {
			inspection: { kind: 'blocked', reason: 'unknown-geometry-settings' },
			block,
			cleanSource,
			geometryEnd: packages[0]?.end ?? null
		};
	}
	return {
		inspection: {
			kind: 'ready',
			values: block?.values ?? DEFAULT_PAGE_MARGINS,
			needsGeometryPackage: packagePatch.kind === 'insert'
		},
		block,
		cleanSource,
		geometryEnd: packages[0]?.end ?? null
	};
}

export function validatePageMargins(values: Record<PageMarginSide, string>): PageMargins | null {
	const normalized = {} as PageMargins;
	for (const side of SIDES) {
		const value = values[side].trim();
		if (!new RegExp(`^${DECIMAL}$`).test(value)) return null;
		const numeric = Number(value);
		if (!Number.isFinite(numeric) || numeric > 100) return null;
		normalized[side] = String(numeric);
	}
	return normalized;
}

export function inspectPageMargins(source: string): PageMarginsInspection {
	return inspect(source).inspection;
}

export function patchPageMargins(source: string, values: Record<PageMarginSide, string>, addGeometryPackage = false): PageMarginsPatch {
	const normalized = validatePageMargins(values);
	if (!normalized) return { kind: 'invalid-values' };
	const current = inspect(source);
	if (current.inspection.kind === 'blocked') return { kind: 'blocked', reason: current.inspection.reason };
	if (current.inspection.needsGeometryPackage && !addGeometryPackage) return { kind: 'needs-package' };

	let baseSource = current.cleanSource;
	let addedGeometryPackage = false;
	if (current.inspection.needsGeometryPackage) {
		try {
			const packagePatch = addLatexPackage(baseSource, 'geometry');
			if (packagePatch.kind === 'insert') {
				baseSource = packagePatch.result;
				addedGeometryPackage = true;
			}
		} catch {
			return { kind: 'blocked', reason: 'invalid-preamble' };
		}
	}

	let boundary: number;
	try {
		boundary = getEditableLatexPreambleEnd(baseSource);
	} catch {
		return { kind: 'blocked', reason: 'invalid-preamble' };
	}
	const eol = baseSource.includes('\r\n') ? '\r\n' : '\n';
	const rule = `\\geometry{${SIDES.map((side) => `${side}=${normalized[side]}cm`).join(',')}}`;
	const managedText = `${START_MARKER}${eol}${rule}${eol}${END_MARKER}${eol}`;
	let result: string;
	if (current.block) {
		if (current.geometryEnd === null || current.geometryEnd > current.block.start) {
			return { kind: 'blocked', reason: 'malformed-managed-settings' };
		}
		result = source.slice(0, current.block.start) + managedText + source.slice(current.block.end);
	} else {
		const prefix = baseSource.slice(0, boundary);
		const leadingEol = prefix.length > 0 && !prefix.endsWith('\n') ? eol : '';
		result = `${prefix}${leadingEol}${managedText}${baseSource.slice(boundary)}`;
	}

	const finalMarkers = locateMarkers(result);
	if (finalMarkers.malformed || !finalMarkers.block?.values) return { kind: 'blocked', reason: 'malformed-managed-settings' };
	const finalCleanSource = removeBlock(result, finalMarkers.block);
	let finalBoundary: number;
	try {
		finalBoundary = getEditableLatexPreambleEnd(finalCleanSource);
	} catch {
		return { kind: 'blocked', reason: 'invalid-preamble' };
	}
	if (finalMarkers.block.start > finalBoundary) return { kind: 'blocked', reason: 'malformed-managed-settings' };
	let originalBoundary: number;
	try {
		originalBoundary = getEditableLatexPreambleEnd(current.cleanSource) + (current.block?.text.length ?? 0);
	} catch {
		return { kind: 'blocked', reason: 'invalid-preamble' };
	}
	return {
		kind: 'ready',
		source: result,
		originalPreamble: source.slice(0, originalBoundary),
		preamble: result.slice(0, finalBoundary + finalMarkers.block.text.length),
		addedGeometryPackage
	};
}
