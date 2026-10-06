import { describe, expect, it, vi } from 'vitest';
import { hostAction, vendorMessage } from '../src/drawio-message-relay';
import { DRAWIO_SOURCE_LIMIT, DIAGRAM_OUTPUT_LIMIT, validateDrawioMessage } from '../src/drawio-message-bridge';
const nonce = 'a'.repeat(43);
const load = { action: 'load', xml: '<mxGraphModel/>', autosave: 1 };
describe('strict vendor normalization', () => {
	it('normalizes actual vendor load, autosave echo and XML export shapes', () => {
		expect(validateDrawioMessage(vendorMessage({ event: 'load', xml: load.xml }, nonce), nonce).action).toBe('load');
		expect(
			validateDrawioMessage(vendorMessage({ event: 'autosave', xml: load.xml, message: JSON.stringify(load) }, nonce, load), nonce)
		).toMatchObject({ action: 'save', modified: true, xml: load.xml });
		expect(
			validateDrawioMessage(
				vendorMessage({ event: 'export', format: 'xml', xml: load.xml, message: { action: 'export', format: 'xml' } }, nonce, load, {
					action: 'export',
					format: 'xml'
				}),
				nonce
			)
		).toMatchObject({ data: load.xml, xml: load.xml });
	});
	it('rejects unknown fields/actions/nonces/echo and never broadens the original bridge', () => {
		for (const raw of [
			{ event: 'load', xml: load.xml, extra: 1 },
			{ event: 'save', xml: load.xml, action: 'save' },
			{ event: 'init', nonce },
			{ event: 'autosave', xml: load.xml, message: { ...load, evil: true } },
			{ event: 'configure' },
			{ event: 'load' },
			{ event: 'export', format: 'svg', data: '<svg/>' },
			{ event: 'export', format: 'xml', xml: load.xml, message: { action: 'invokeAction' } }
		])
			expect(() => vendorMessage(raw, nonce, load, { action: 'export', format: 'xml' })).toThrow();
	});
	it('accepts exact UTF8 XML bound and rejects multibyte overflow', () => {
		expect(() => hostAction({ action: 'load', nonce, xml: 'a'.repeat(DRAWIO_SOURCE_LIMIT) }, nonce)).not.toThrow();
		expect(() => hostAction({ action: 'load', nonce, xml: '界'.repeat(Math.ceil(DRAWIO_SOURCE_LIMIT / 3)) }, nonce)).toThrow();
	});
	it('only strips nonce from explicit bounded production actions', () => {
		expect(hostAction({ action: 'export', format: 'svg', nonce }, nonce)).toEqual({
			action: 'export',
			format: 'svg',
			asText: true,
			theme: 'light',
			embedImages: false,
			embedFonts: false
		});
		for (const action of [
			{ action: 'export', format: 'pdf', nonce },
			{ action: 'load', xml: 'x', nonce: 'b'.repeat(43) },
			{ action: 'invokeAction', nonce },
			{ action: 'export', format: 'svg', nonce, extra: 1 }
		])
			expect(() => hostAction(action, nonce)).toThrow();
	});
	it('bounds the complete UTF8 envelope including echo and rejects nested accessors without calling them', () => {
		const getter = vi.fn();
		const state = Object.create(null);
		Object.defineProperty(state, 'x', { enumerable: true, get: getter });
		expect(() => vendorMessage({ event: 'load', xml: 'x', bounds: state }, nonce)).toThrow();
		expect(getter).not.toHaveBeenCalled();
		const over = JSON.stringify({ event: 'export', format: 'svg', xml: 'x', data: 'a'.repeat(DIAGRAM_OUTPUT_LIMIT) });
		expect(() => vendorMessage(over, nonce)).toThrow();
		const prefix = JSON.stringify({ event: 'export', format: 'svg', xml: 'x', data: '' });
		const exact = {
			event: 'export',
			format: 'svg',
			xml: 'x',
			data: 'a'.repeat(DIAGRAM_OUTPUT_LIMIT - new TextEncoder().encode(prefix).length)
		};
		// Raw fits exactly but the required nonce also counts: canonical envelope must fail closed.
		expect(() => vendorMessage(exact, nonce)).toThrow();
	});
});
