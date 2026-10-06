import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	DIAGRAM_OUTPUT_LIMIT,
	DRAWIO_BRIDGE_ORIGIN,
	DRAWIO_SOURCE_LIMIT,
	attachDrawioMessageBridge,
	type ValidatedDrawioMessage
} from '../src/drawio-message-bridge';

const ORIGIN = DRAWIO_BRIDGE_ORIGIN;
const NONCE = '0123456789abcdef0123456789abcdef';
const SECURITY_LOG = '[security] dropped Draw.io bridge message';

interface Harness {
	target: EventTarget;
	source: MessagePort;
	otherSource: MessagePort;
	received: ValidatedDrawioMessage[];
	dispose: () => void;
}

const channels: MessageChannel[] = [];

function bridge(): Harness {
	const channel = new MessageChannel();
	const otherChannel = new MessageChannel();
	channels.push(channel, otherChannel);
	const target = new EventTarget();
	const received: ValidatedDrawioMessage[] = [];
	const dispose = attachDrawioMessageBridge(target, {
		source: channel.port1,
		origin: ORIGIN,
		nonce: NONCE,
		onMessage: (message) => received.push(message)
	});
	return { target, source: channel.port1, otherSource: otherChannel.port1, received, dispose };
}

function send(
	harness: Harness,
	data: unknown,
	{ source = harness.source, origin = ORIGIN }: { source?: MessagePort; origin?: string } = {}
): void {
	harness.target.dispatchEvent(new MessageEvent('message', { data, origin, source }));
}

afterEach(() => {
	for (const channel of channels.splice(0)) {
		channel.port1.close();
		channel.port2.close();
	}
	vi.restoreAllMocks();
});

describe('Draw.io message bridge', () => {
	it('delivers only the five planned actions from a real message event', () => {
		const harness = bridge();
		const messages = [
			{ event: 'init' },
			{ event: 'load', bounds: { x: 0, y: 0, width: 320, height: 240 } },
			{ event: 'save', xml: '<mxfile />', exit: true },
			{ event: 'export', format: 'svg', data: 'data:image/svg+xml,<svg />' },
			{ event: 'exit', modified: true }
		];

		for (const message of messages) send(harness, JSON.stringify({ ...message, nonce: NONCE }));

		expect(harness.received.map(({ action }) => action)).toEqual(['init', 'load', 'save', 'export', 'exit']);
		expect(harness.received[1]).toMatchObject({ action: 'load', nonce: NONCE });
		expect(harness.received[2]).toMatchObject({ action: 'save', xml: '<mxfile />' });
		expect(harness.received[3]).toMatchObject({ action: 'export', format: 'svg', data: 'data:image/svg+xml,<svg />' });
	});

	it('normalizes official autosave to a dirty save notification without persisting', () => {
		const harness = bridge();
		send(harness, JSON.stringify({ event: 'autosave', xml: '<mxfile />', nonce: NONCE }));
		send(harness, JSON.stringify({ event: 'autosave', xml: '<mxfile />', modified: false, nonce: NONCE }));

		expect(harness.received).toEqual([
			{ action: 'save', nonce: NONCE, xml: '<mxfile />', modified: true },
			{ action: 'save', nonce: NONCE, xml: '<mxfile />', modified: true }
		]);
	});

	it('validates structured-clone message data through the same listener', () => {
		const harness = bridge();
		send(harness, { event: 'save', xml: '<mxfile>😀</mxfile>', nonce: NONCE });

		expect(harness.received).toEqual([{ action: 'save', nonce: NONCE, xml: '<mxfile>😀</mxfile>' }]);
	});

	it('rejects forged source, origin, nonce, action, and unknown schema fields with a data-free log', () => {
		const harness = bridge();
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const privatePath = 'C:/workspace/private/project.tex';
		const payload = { event: 'save', xml: privatePath, nonce: NONCE };

		send(harness, JSON.stringify(payload), { source: harness.otherSource });
		send(harness, JSON.stringify(payload), { origin: 'https://attacker.invalid' });
		send(harness, JSON.stringify({ ...payload, nonce: 'forged-nonce' }));
		send(harness, JSON.stringify({ event: 'openLink', href: 'https://attacker.invalid', nonce: NONCE }));
		send(harness, JSON.stringify({ ...payload, workspacePath: privatePath }));

		expect(harness.received).toEqual([]);
		expect(warn).toHaveBeenCalledTimes(5);
		expect(warn.mock.calls).toEqual(Array.from({ length: 5 }, () => [SECURITY_LOG]));
		expect(warn.mock.calls.flat().join(' ')).not.toContain(privatePath);
	});

	it('rejects malformed JSON, non-record data, host action envelopes, and invalid field types', () => {
		const harness = bridge();
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		for (const data of [
			'{not-json',
			JSON.stringify(['save', NONCE]),
			JSON.stringify({ action: 'save', xml: '<mxfile />', nonce: NONCE }),
			JSON.stringify({ action: 'save', event: 'exit', xml: 'x', nonce: NONCE }),
			{
				event: 'init',
				nonce: NONCE,
				...Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`unknown${index}`, index]))
			},
			JSON.stringify({ event: 'save', xml: 7, nonce: NONCE }),
			JSON.stringify({ event: 'exit', modified: 'yes', nonce: NONCE }),
			JSON.stringify({ event: 'load', bounds: { x: 0, y: 0, width: Number.NaN, height: 1 }, nonce: NONCE })
		]) {
			send(harness, data);
		}

		expect(harness.received).toEqual([]);
		expect(warn).toHaveBeenCalledTimes(8);
	});

	it('requires an allowlisted export format and string data without logging rejected payloads', () => {
		const harness = bridge();
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const secret = 'private-export-payload';
		const invalidExports = [
			{ event: 'export', data: secret, nonce: NONCE },
			{ event: 'export', format: `unsupported-${secret}`, data: 'payload', nonce: NONCE },
			{ event: 'export', format: 'xml', xml: `<mxfile>${secret}</mxfile>`, nonce: NONCE },
			{ event: 'export', format: 'svg', svg: `<svg>${secret}</svg>`, nonce: NONCE },
			{ event: 'export', format: 'svg', data: 7, nonce: NONCE },
			{ event: 'export', format: 'xml', data: 'payload', xml: 7, nonce: NONCE },
			{ event: 'export', format: 'svg', data: 'payload', svg: `<svg>${secret}</svg>`, nonce: NONCE }
		];

		for (const message of invalidExports) send(harness, JSON.stringify(message));

		expect(harness.received).toEqual([]);
		expect(warn.mock.calls).toEqual(Array.from({ length: invalidExports.length }, () => [SECURITY_LOG]));
		expect(warn.mock.calls.flat().join(' ')).not.toContain(secret);
	});

	it('accepts optional export XML only up to the 10 MiB source limit', () => {
		const harness = bridge();
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const xml = 'x'.repeat(DRAWIO_SOURCE_LIMIT);
		const envelope = { event: 'export', format: 'xml', data: 'export-data', nonce: NONCE };

		send(harness, { ...envelope, xml });
		send(harness, { ...envelope, xml: `${xml}x` });

		expect(harness.received).toHaveLength(1);
		expect(harness.received[0]).toMatchObject({ action: 'export', format: 'xml', data: envelope.data });
		expect(harness.received[0].xml).toHaveLength(DRAWIO_SOURCE_LIMIT);
		expect(warn.mock.calls).toEqual([[SECURITY_LOG]]);
	});

	it('enforces the UTF-8 10 MiB XML boundary, including multibyte text', () => {
		const harness = bridge();
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		send(harness, JSON.stringify({ event: 'save', xml: 'x'.repeat(DRAWIO_SOURCE_LIMIT), nonce: NONCE }));
		send(harness, JSON.stringify({ event: 'save', xml: 'x'.repeat(DRAWIO_SOURCE_LIMIT + 1), nonce: NONCE }));
		send(harness, { event: 'save', xml: '界'.repeat(Math.floor(DRAWIO_SOURCE_LIMIT / 3) + 1), nonce: NONCE });

		expect(harness.received).toHaveLength(1);
		expect(harness.received[0].xml).toHaveLength(DRAWIO_SOURCE_LIMIT);
		expect(warn).toHaveBeenCalledTimes(2);
	});

	it('accepts an exact 25 MiB wire message and rejects one byte over', () => {
		const harness = bridge();
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const envelope = { event: 'export', format: 'svg', nonce: NONCE, data: '' };
		const overhead = Buffer.byteLength(JSON.stringify(envelope), 'utf8');
		const data = 'a'.repeat(DIAGRAM_OUTPUT_LIMIT - overhead);
		const exact = JSON.stringify({ ...envelope, data });
		const oversized = JSON.stringify({ ...envelope, data: `${data}a` });

		expect(Buffer.byteLength(exact, 'utf8')).toBe(DIAGRAM_OUTPUT_LIMIT);
		send(harness, exact);
		send(harness, oversized);

		expect(harness.received).toHaveLength(1);
		expect(harness.received[0].data).toHaveLength(data.length);
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it('enforces the 25 MiB serialized-size boundary for structured-clone data', () => {
		const harness = bridge();
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const envelope = { event: 'export', format: 'svg', nonce: NONCE, data: '' };
		const overhead = Buffer.byteLength(JSON.stringify(envelope), 'utf8');
		const data = 'a'.repeat(DIAGRAM_OUTPUT_LIMIT - overhead);
		const exact = { ...envelope, data };
		const oversized = { ...envelope, data: `${data}a` };

		expect(Buffer.byteLength(JSON.stringify(exact), 'utf8')).toBe(DIAGRAM_OUTPUT_LIMIT);
		send(harness, exact);
		send(harness, oversized);

		expect(harness.received).toHaveLength(1);
		expect(harness.received[0].data).toHaveLength(data.length);
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it('rejects wildcard, opaque, and non-origin bridge configuration', () => {
		const harness = bridge();
		const options = {
			source: harness.source,
			nonce: NONCE,
			onMessage: (_message: ValidatedDrawioMessage) => {}
		};

		expect(() => attachDrawioMessageBridge(new EventTarget(), { ...options, origin: '*' })).toThrow('INVALID_DRAWIO_BRIDGE_CONFIG');
		expect(() => attachDrawioMessageBridge(new EventTarget(), { ...options, origin: 'null' })).toThrow('INVALID_DRAWIO_BRIDGE_CONFIG');
		expect(() => attachDrawioMessageBridge(new EventTarget(), { ...options, origin: 'https://attacker.invalid' })).toThrow(
			'INVALID_DRAWIO_BRIDGE_CONFIG'
		);
		expect(() => attachDrawioMessageBridge(new EventTarget(), { ...options, origin: 'drawio://bundle/path' })).toThrow(
			'INVALID_DRAWIO_BRIDGE_CONFIG'
		);
		expect(() => attachDrawioMessageBridge(new EventTarget(), { ...options, origin: ORIGIN, nonce: 'short' })).toThrow(
			'INVALID_DRAWIO_BRIDGE_CONFIG'
		);
	});

	it('removes its real message listener when disposed', () => {
		const harness = bridge();
		send(harness, JSON.stringify({ event: 'init', nonce: NONCE }));
		harness.dispose();
		send(harness, JSON.stringify({ event: 'init', nonce: NONCE }));

		expect(harness.received).toHaveLength(1);
	});
});
