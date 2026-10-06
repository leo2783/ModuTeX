import { describe, expect, it } from 'vitest';
import { drawioCloseDisposition, drawioExportContent, isDrawioMetadataDirty } from '$lib/diagram/events';
import { validateDrawioMessage } from '../../../../../../electron/src/drawio-message-bridge';

const NONCE = '0123456789abcdef0123456789abcdef';
const EXISTING = {
	id: '123e4567-e89b-42d3-a456-426614174000',
	sourcePath: 'assets/diagrams/system-flow-123e4567-e89b-42d3-a456-426614174000.drawio',
	caption: 'System overview',
	label: 'fig:system',
	widthPercent: 80
};

describe('Draw.io renderer contracts', () => {
	it('maps dirty close choices to exactly save, discard, or stay', () => {
		expect(drawioCloseDisposition(false)).toBe('close');
		expect(drawioCloseDisposition(true)).toBe('prompt');
		expect(drawioCloseDisposition(true, 'save')).toBe('save');
		expect(drawioCloseDisposition(true, 'discard')).toBe('close');
		expect(drawioCloseDisposition(true, 'cancel')).toBe('stay');
	});

	it('marks only changed metadata or relinked source as dirty for existing diagrams', () => {
		expect(isDrawioMetadataDirty(EXISTING, { ...EXISTING, label: EXISTING.label ?? '' })).toBe(false);
		expect(isDrawioMetadataDirty(EXISTING, { ...EXISTING, caption: 'Changed' })).toBe(true);
		expect(isDrawioMetadataDirty(EXISTING, { ...EXISTING, sourcePath: 'assets/diagrams/other.drawio' })).toBe(true);
		expect(isDrawioMetadataDirty(null, { sourcePath: null, caption: '', label: '', widthPercent: 100 })).toBe(true);
	});

	it('uses the production bridge validator and rejects format mismatches', () => {
		const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
		const validated = validateDrawioMessage({ event: 'export', nonce: NONCE, format: 'svg', data: svg }, NONCE);
		expect(drawioExportContent(validated, 'svg')).toBe(svg);
		expect(() => drawioExportContent(validated, 'xml')).toThrow('UNEXPECTED_DRAWIO_EXPORT');
		expect(() => validateDrawioMessage({ action: 'export', nonce: NONCE, format: 'svg', data: svg }, NONCE)).toThrow('INVALID_ACTION');
	});

	it('decodes only the requested canonical XML or SVG export payload', () => {
		const xml = '<mxfile><diagram id="page"/></mxfile>';
		const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
		const xmlMessage = validateDrawioMessage({ event: 'export', nonce: NONCE, format: 'xml', data: xml }, NONCE);
		const svgMessage = validateDrawioMessage(
			{ event: 'export', nonce: NONCE, format: 'svg', data: `data:image/svg+xml,${encodeURIComponent(svg)}` },
			NONCE
		);
		const base64SvgMessage = validateDrawioMessage(
			{ event: 'export', nonce: NONCE, format: 'svg', data: `data:image/svg+xml;base64,${btoa(svg)}` },
			NONCE
		);
		expect(drawioExportContent(xmlMessage, 'xml')).toBe(xml);
		expect(drawioExportContent(svgMessage, 'svg')).toBe(svg);
		expect(drawioExportContent(base64SvgMessage, 'svg')).toBe(svg);
		expect(() =>
			drawioExportContent(
				validateDrawioMessage({ event: 'export', nonce: NONCE, format: 'svg', data: `data:text/html,${encodeURIComponent(svg)}` }, NONCE),
				'svg'
			)
		).toThrow('INVALID_DRAWIO_EXPORT');
		expect(() => drawioExportContent({ ...xmlMessage, format: 'svg' }, 'svg')).toThrow('INVALID_SVG');
	});
});
