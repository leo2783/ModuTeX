import type { DiagramType } from 'modutex-contracts';
import type { ValidatedDrawioMessage } from '../../../../../electron/src/drawio-message-bridge';

export interface DiagramFigureAttrs {
	src: string;
	diagramType?: DiagramType | null;
	diagramId?: string | null;
	diagramSource?: string | null;
	caption?: string;
	label?: string | null;
	widthPercent?: number;
	[key: string]: unknown;
}

export interface ExistingDiagram {
	id: string;
	sourcePath: string;
	caption: string;
	label: string | null;
	widthPercent: number;
}

export interface DiagramMetadata {
	sourcePath: string | null;
	caption: string;
	label: string;
	widthPercent: number;
}

export function isDrawioMetadataDirty(initial: ExistingDiagram | null, current: DiagramMetadata): boolean {
	if (!initial) return true;
	return (
		current.sourcePath !== initial.sourcePath ||
		current.caption !== initial.caption ||
		current.label !== (initial.label ?? '') ||
		current.widthPercent !== initial.widthPercent
	);
}

export type DrawioCloseChoice = 'save' | 'discard' | 'cancel';
export type DrawioCloseDisposition = 'prompt' | 'save' | 'close' | 'stay';

export function drawioCloseDisposition(dirty: boolean, choice?: DrawioCloseChoice): DrawioCloseDisposition {
	if (!dirty) return 'close';
	if (!choice) return 'prompt';
	if (choice === 'save') return 'save';
	if (choice === 'discard') return 'close';
	return 'stay';
}

export type DrawioExportFormat = 'xml' | 'svg';

/** Accept only the strict bridge's validated event and the format requested by the pending export. */
export function drawioExportContent(message: ValidatedDrawioMessage, expectedFormat: DrawioExportFormat): string {
	if (message.action !== 'export' || message.format !== expectedFormat) throw new Error('UNEXPECTED_DRAWIO_EXPORT');
	const value = expectedFormat === 'xml' ? (message.xml ?? message.data) : message.data;
	if (typeof value !== 'string' || value.length === 0) throw new Error('INVALID_DRAWIO_EXPORT');
	return drawioExportData(value, expectedFormat);
}

/** Validates an already bridge-checked Draw.io payload returned by a session export method. */
export function drawioExportData(value: string, expectedFormat: DrawioExportFormat): string {
	if (typeof value !== 'string' || value.length === 0) throw new Error('INVALID_DRAWIO_EXPORT');
	const decoded = decodeExportData(value, expectedFormat);
	const bytes = new TextEncoder().encode(decoded).byteLength;
	if (bytes > (expectedFormat === 'xml' ? 10 * 1024 * 1024 : 25 * 1024 * 1024)) throw new Error('PAYLOAD_TOO_LARGE');
	const body = decoded
		.replace(/^\uFEFF/, '')
		.trimStart()
		.replace(/^<\?xml\s+[^?]*\?>\s*/i, '');
	if (expectedFormat === 'xml' && !/^<(?:mxfile|mxGraphModel)(?:\s|>)/i.test(body)) throw new Error('INVALID_DRAWIO_XML');
	if (expectedFormat === 'svg' && !/^<svg(?:\s[^>]*|\/?)>/i.test(body)) throw new Error('INVALID_SVG');
	return decoded;
}

function decodeExportData(value: string, format: DrawioExportFormat): string {
	if (!value.startsWith('data:')) return value;
	const comma = value.indexOf(',');
	if (comma < 0) throw new Error('INVALID_DRAWIO_EXPORT');
	const header = value.slice(0, comma);
	const payload = value.slice(comma + 1);
	const match = /^data:([^;,]+)(?:;charset=utf-8)?(;base64)?$/i.exec(header);
	const allowedMimeTypes = format === 'svg' ? ['image/svg+xml'] : ['application/xml', 'text/xml'];
	if (!match || !allowedMimeTypes.includes(match[1]!.toLowerCase())) throw new Error('INVALID_DRAWIO_EXPORT');
	try {
		return match[2] ? new TextDecoder().decode(Uint8Array.from(atob(payload), (char) => char.charCodeAt(0))) : decodeURIComponent(payload);
	} catch {
		throw new Error('INVALID_DRAWIO_EXPORT');
	}
}
