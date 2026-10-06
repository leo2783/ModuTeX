import { isSafeDiagramSource } from '$lib/diagram/marker';

interface DiagramImageAttrs {
	src?: unknown;
	diagramType?: unknown;
	diagramId?: unknown;
	diagramSource?: unknown;
}

export interface ImageDisplaySource {
	path: string;
	diagramPreview: boolean;
}

/** Use the persisted SVG only for a fully paired Draw.io image; the node's PDF src stays untouched. */
export function imageDisplaySource(attrs: DiagramImageAttrs): ImageDisplaySource {
	const src = typeof attrs.src === 'string' ? attrs.src : '';
	const { diagramId, diagramSource } = attrs;
	if (
		attrs.diagramType !== 'drawio' ||
		typeof diagramId !== 'string' ||
		typeof diagramSource !== 'string' ||
		!isSafeDiagramSource(diagramSource, 'drawio', diagramId)
	) {
		return { path: src, diagramPreview: false };
	}

	const stem = diagramSource.slice(0, -'.drawio'.length);
	if (src !== `${stem}.pdf`) return { path: src, diagramPreview: false };
	return { path: `${stem}.svg`, diagramPreview: true };
}

/** Give a refreshed SVG a distinct URL without changing non-network/blob source semantics. */
export function revisionedPreviewUrl(url: string, revision: number): string {
	if (!url || /^(?:data|blob):/i.test(url)) return url;
	const hashAt = url.indexOf('#');
	const beforeHash = hashAt < 0 ? url : url.slice(0, hashAt);
	const hash = hashAt < 0 ? '' : url.slice(hashAt);
	const separator = beforeHash.includes('?') ? '&' : '?';
	return `${beforeHash}${separator}__diagram_preview=${revision}${hash}`;
}
