// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDrawioSession } from '../../apps/texpile-editor/src/lib/diagram/drawio-session';
import { vendorMessage, RELAY_ORIGIN } from '../src/drawio-message-relay';
afterEach(() => {
	vi.useRealTimers();
	document.body.replaceChildren();
});
describe('host adapter boundary (unit simulation, not runtime proof)', () => {
	it('binds one bootstrap, rejects forged source/origin/nonce, consumes normalized vendor and disposes', async () => {
		const iframe = document.createElement('iframe');
		document.body.append(iframe);
		const onMessage = vi.fn();
		const session = createDrawioSession({ iframe, hostOrigin: `${location.protocol}//${location.host}`, onMessage });
		const post = vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation(() => {});
		const dispatch = (data: unknown, source = iframe.contentWindow, origin = RELAY_ORIGIN) =>
			window.dispatchEvent(new MessageEvent('message', { data, source, origin }));
		dispatch({ type: 'relay-ready' }, window);
		dispatch({ type: 'relay-ready' }, iframe.contentWindow, 'https://evil.invalid');
		expect(post).not.toHaveBeenCalled();
		dispatch({ type: 'relay-ready' });
		const nonce = post.mock.calls[0][0].nonce;
		expect(post.mock.calls[0][1]).toBe(RELAY_ORIGIN);
		expect(iframe.outerHTML).not.toContain(nonce);
		dispatch({ event: 'init', nonce: 'b'.repeat(43) });
		expect(onMessage).not.toHaveBeenCalled();
		const loading = session.load('<mxGraphModel/>');
		dispatch(vendorMessage({ event: 'init' }, nonce));
		expect(post.mock.calls.at(-1)![0]).toMatchObject({ action: 'load', xml: '<mxGraphModel/>', nonce });
		dispatch(vendorMessage({ event: 'load', xml: '<mxGraphModel/>' }, nonce));
		await loading;
		const exporting = session.exportXml();
		dispatch(vendorMessage({ event: 'export', xml: '<mxGraphModel/>', format: 'xml' }, nonce));
		await expect(exporting).resolves.toEqual({ xml: '<mxGraphModel/>' });
		const before = onMessage.mock.calls.length;
		session.dispose();
		dispatch({ event: 'init', nonce });
		expect(onMessage).toHaveBeenCalledTimes(before);
		await expect(session.exportSvg()).rejects.toThrow('SESSION_NOT_READY');
	});
	it('rejects pending requests at deadline and tears down listener', async () => {
		vi.useFakeTimers();
		const iframe = document.createElement('iframe');
		document.body.append(iframe);
		const session = createDrawioSession({ iframe, hostOrigin: `${location.protocol}//${location.host}`, onMessage: () => {} });
		const pending = session.load('x');
		const rejection = expect(pending).rejects.toThrow();
		await vi.advanceTimersByTimeAsync(30000);
		await rejection;
		await expect(session.load('x')).rejects.toThrow('SESSION_NOT_READY');
	});
	it('drops the old session after subsequent frame load and rejects an outstanding request', async () => {
		const iframe = document.createElement('iframe');
		document.body.append(iframe);
		const onMessage = vi.fn();
		const session = createDrawioSession({ iframe, hostOrigin: `${location.protocol}//${location.host}`, onMessage });
		const post = vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation(() => {});
		const dispatch = (data: unknown) =>
			window.dispatchEvent(new MessageEvent('message', { data, source: iframe.contentWindow, origin: RELAY_ORIGIN }));
		dispatch({ type: 'relay-ready' });
		const nonce = post.mock.calls[0][0].nonce;
		dispatch({ event: 'init', nonce });
		iframe.dispatchEvent(new Event('load'));
		const pending = session.exportXml();
		const rejection = expect(pending).rejects.toThrow('SESSION_DISPOSED');
		iframe.dispatchEvent(new Event('load'));
		await rejection;
		const before = onMessage.mock.calls.length;
		dispatch({ event: 'save', xml: 'x', nonce });
		expect(onMessage).toHaveBeenCalledTimes(before);
	});
});
