export type DiagramType = 'mermaid' | 'drawio';

export interface DiagramMarkerV1 {
	v: 1;
	id: string;
	type: DiagramType;
	source: string;
}

const PREFIX = '% modutex:diagram ';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INCLUDE_GRAPHICS = /(?<!\\)\\includegraphics(?:\s*\[[^\]\r\n]*\])?\s*\{([^{}\r\n]+)\}/g;

export type DiagramMarkerError =
	| 'NOT_MARKER'
	| 'INVALID_JSON'
	| 'INVALID_VERSION'
	| 'INVALID_ID'
	| 'INVALID_TYPE'
	| 'INVALID_SOURCE'
	| 'MISSING_FIGURE'
	| 'FIGURE_MISMATCH';

export type DiagramBlockParseResult =
	{ kind: 'diagram'; marker: DiagramMarkerV1; pdfPath: string; raw: string } | { kind: 'raw'; reason: DiagramMarkerError; raw: string };

function isDiagramType(value: unknown): value is DiagramType {
	return value === 'mermaid' || value === 'drawio';
}

function sourceExtension(type: DiagramType): string {
	return type === 'mermaid' ? '.mmd' : '.drawio';
}

/** Mask comments without changing offsets or newline bytes. */
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

/** Accept only assets/diagrams/<lowercase-slug>-<same-uuid>.<type-extension>. */
export function isSafeDiagramSource(source: string, type: DiagramType, id: string): boolean {
	if (!UUID.test(id) || source !== source.toLowerCase() || source.includes('\\') || source.includes('\0')) return false;
	const parts = source.split('/');
	if (parts.length !== 3 || parts[0] !== 'assets' || parts[1] !== 'diagrams') return false;
	const filename = parts[2];
	const extension = sourceExtension(type);
	if (!filename.endsWith(extension)) return false;
	const stem = filename.slice(0, -extension.length);
	const suffix = `-${id.toLowerCase()}`;
	if (!stem.endsWith(suffix)) return false;
	const slug = stem.slice(0, -suffix.length);
	return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
}

export function diagramPdfPath(marker: DiagramMarkerV1): string {
	return marker.source.replace(/\.(?:mmd|drawio)$/, '.pdf');
}

function parseMarkerJson(json: string): { marker?: DiagramMarkerV1; error?: DiagramMarkerError } {
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		return { error: 'INVALID_JSON' };
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'INVALID_JSON' };
	const record = value as Record<string, unknown>;
	if (Object.keys(record).sort().join(',') !== 'id,source,type,v') return { error: 'INVALID_JSON' };
	if (record.v !== 1) return { error: 'INVALID_VERSION' };
	if (typeof record.id !== 'string' || !UUID.test(record.id)) return { error: 'INVALID_ID' };
	if (!isDiagramType(record.type)) return { error: 'INVALID_TYPE' };
	if (typeof record.source !== 'string' || !isSafeDiagramSource(record.source, record.type, record.id)) {
		return { error: 'INVALID_SOURCE' };
	}
	return { marker: { v: 1, id: record.id, type: record.type, source: record.source } };
}

/** Parse one complete marker + paired figure. Rejected input is returned unchanged as raw. */
export function parseDiagramBlock(raw: string): DiagramBlockParseResult {
	const lineEnd = raw.search(/\r?\n/);
	const firstLine = lineEnd === -1 ? raw : raw.slice(0, lineEnd);
	if (!firstLine.startsWith(PREFIX)) return { kind: 'raw', reason: 'NOT_MARKER', raw };
	const parsed = parseMarkerJson(firstLine.slice(PREFIX.length));
	if (!parsed.marker) return { kind: 'raw', reason: parsed.error!, raw };

	const newlineLength = lineEnd === -1 ? 0 : raw[lineEnd] === '\r' ? 2 : 1;
	const figureSource = lineEnd === -1 ? '' : raw.slice(lineEnd + newlineLength);
	const begin = /^\s*\\begin\{(figure\*?)\}(?:\s*\[[^\]\r\n]*\])?/.exec(figureSource);
	if (!begin) return { kind: 'raw', reason: 'MISSING_FIGURE', raw };
	const end = new RegExp(`\\\\end\\{${begin[1].replace('*', '\\*')}\\}\\s*$`);
	if (!end.test(figureSource)) return { kind: 'raw', reason: 'MISSING_FIGURE', raw };

	const paths = [...maskComments(figureSource).matchAll(INCLUDE_GRAPHICS)].map((match) => match[1]);
	const pdfPath = diagramPdfPath(parsed.marker);
	if (paths.length !== 1 || paths[0] !== pdfPath) return { kind: 'raw', reason: 'FIGURE_MISMATCH', raw };
	return { kind: 'diagram', marker: parsed.marker, pdfPath, raw };
}

/** Stable one-line representation for new or explicitly edited diagram figures. */
export function serializeDiagramMarker(marker: DiagramMarkerV1): string {
	if (marker.v !== 1) throw new Error('Invalid diagram marker version');
	if (!UUID.test(marker.id)) throw new Error('Invalid diagram UUID');
	if (!isDiagramType(marker.type)) throw new Error('Invalid diagram type');
	if (!isSafeDiagramSource(marker.source, marker.type, marker.id)) throw new Error('Invalid diagram source path');
	return `${PREFIX}${JSON.stringify({ v: 1, id: marker.id, type: marker.type, source: marker.source })}`;
}
