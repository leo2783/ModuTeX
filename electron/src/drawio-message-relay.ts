import { validateDrawioMessage, DIAGRAM_OUTPUT_LIMIT, DRAWIO_SOURCE_LIMIT } from './drawio-message-bridge';

export const RELAY_ORIGIN = 'drawio://bundle';
export const EDITOR_ORIGIN = 'drawio://editor';
export const RELAY_URL = `${RELAY_ORIGIN}/relay.html`;
export const EDITOR_URL = `${EDITOR_ORIGIN}/index.html?embed=1&proto=json&offline=1&local=1&noSaveBtn=1&noExitBtn=1&configure=1`;
export const SESSION_DEADLINE = 30000;
type RecordValue = Record<string, unknown>;

export function record(value: unknown, allowed?: readonly string[]): RecordValue {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_MESSAGE');
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) throw new Error('INVALID_MESSAGE');
	const keys = Reflect.ownKeys(value);
	if (keys.length > 32) throw new Error('INVALID_MESSAGE');
	const result: RecordValue = Object.create(null);
	for (const key of keys) {
		if (typeof key !== 'string' || (allowed && !allowed.includes(key))) throw new Error('INVALID_MESSAGE');
		const d = Object.getOwnPropertyDescriptor(value, key);
		if (!d?.enumerable || !('value' in d)) throw new Error('INVALID_MESSAGE');
		result[key] = d.value;
	}
	return result;
}
export function boundedText(value: unknown, limit: number): asserts value is string {
	if (typeof value !== 'string' || value.length > limit || new TextEncoder().encode(value).length > limit)
		throw new Error('PAYLOAD_TOO_LARGE');
}
export function parsed(value: unknown): RecordValue {
	if (typeof value === 'string') {
		boundedText(value, DIAGRAM_OUTPUT_LIMIT);
		value = JSON.parse(value);
	}
	return record(value);
}
function jsonBytes(value: unknown, depth = 0, budget = DIAGRAM_OUTPUT_LIMIT): number {
	if (depth > 3) throw new Error('INVALID_MESSAGE');
	let count = 0;
	if (typeof value === 'string') {
		count = 2;
		for (let i = 0; i < value.length; i++) {
			const code = value.charCodeAt(i);
			if (code === 34 || code === 92 || [8, 9, 10, 12, 13].includes(code)) count += 2;
			else if (code < 32) count += 6;
			else if (
				code >= 0xd800 &&
				code <= 0xdbff &&
				i + 1 < value.length &&
				value.charCodeAt(i + 1) >= 0xdc00 &&
				value.charCodeAt(i + 1) <= 0xdfff
			) {
				count += 4;
				i++;
			} else if (code >= 0xd800 && code <= 0xdfff) count += 6;
			else count += code <= 127 ? 1 : code <= 2047 ? 2 : 3;
			if (count > budget) throw new Error('PAYLOAD_TOO_LARGE');
		}
	} else if (value === null) count = 4;
	else if (typeof value === 'boolean') count = value ? 4 : 5;
	else if (typeof value === 'number' && Number.isFinite(value)) count = String(value).length;
	else {
		const safe = record(value);
		count = 2;
		let first = true;
		for (const key of Object.keys(safe)) {
			count += (first ? 0 : 1) + jsonBytes(key, depth + 1, budget - count) + 1;
			count += jsonBytes(safe[key], depth + 1, budget - count);
			first = false;
		}
	}
	if (count > budget) throw new Error('PAYLOAD_TOO_LARGE');
	return count;
}
export function hostAction(value: unknown, nonce: string): RecordValue {
	const r = record(value, ['action', 'nonce', 'xml', 'format']);
	if (r.nonce !== nonce) throw new Error('INVALID_NONCE');
	if (r.action === 'load' && Object.keys(r).length === 3) {
		boundedText(r.xml, DRAWIO_SOURCE_LIMIT);
		boundedText(JSON.stringify(r), DIAGRAM_OUTPUT_LIMIT);
		return { action: 'load', xml: r.xml, autosave: 1 };
	}
	if (r.action === 'export' && Object.keys(r).length === 3 && (r.format === 'xml' || r.format === 'svg')) {
		return r.format === 'svg'
			? { action: 'export', format: 'svg', asText: true, theme: 'light', embedImages: false, embedFonts: false }
			: { action: 'export', format: 'xml' };
	}
	throw new Error('INVALID_ACTION');
}

export function vendorMessage(raw: unknown, nonce: string, loadRequest?: RecordValue, exportRequest?: RecordValue): RecordValue {
	const r = parsed(raw);
	// Bound the entire original envelope, including the vendor request echo.
	jsonBytes(r);
	// Validate echo separately, never pass arbitrary nested data to the trusted bridge.
	if (Object.hasOwn(r, 'message')) {
		const expected = r.event === 'autosave' ? loadRequest : r.event === 'export' ? exportRequest : undefined;
		if (!expected) throw new Error('INVALID_MESSAGE');
		const echo = typeof r.message === 'string' ? parsed(r.message) : record(r.message);
		if (Object.keys(echo).length !== Object.keys(expected).length || Object.keys(echo).some((k) => echo[k] !== expected[k]))
			throw new Error('INVALID_MESSAGE');
		delete r.message;
	}
	if (r.event === 'load') {
		boundedText(r.xml, DRAWIO_SOURCE_LIMIT);
		delete r.xml;
	}
	if (r.event === 'export' && r.format !== 'xml' && r.format !== 'svg') throw new Error('INVALID_MESSAGE');
	if (r.event === 'export') boundedText(r.xml, DRAWIO_SOURCE_LIMIT);
	if (r.event === 'export' && r.format === 'xml' && !Object.hasOwn(r, 'data')) {
		boundedText(r.xml, DRAWIO_SOURCE_LIMIT);
		r.data = r.xml;
	}
	if (Object.hasOwn(r, 'nonce')) throw new Error('INVALID_MESSAGE');
	r.nonce = nonce;
	validateDrawioMessage(r, nonce);
	return r;
}

export function startDrawioRelay(hostOrigins: readonly string[]): () => void {
	const parent = window.parent;
	let hostOrigin: string | undefined;
	let nonce: string | undefined;
	let inner: HTMLIFrameElement | undefined;
	let stopped = false;
	let initialized = false;
	let loadRequest: RecordValue | undefined;
	let exportRequest: RecordValue | undefined;
	let loads = 0;
	const startup = setTimeout(() => stop(), SESSION_DEADLINE);
	const stop = () => {
		clearTimeout(startup);
		stopped = true;
		nonce = undefined;
		loadRequest = undefined;
		exportRequest = undefined;
		window.removeEventListener('message', listener);
		window.removeEventListener('pagehide', stop);
		inner?.remove();
	};
	const listener = (event: MessageEvent<unknown>) => {
		if (stopped) return;
		try {
			if (event.source === parent && (hostOrigin ? event.origin === hostOrigin : hostOrigins.includes(event.origin))) {
				if (!nonce) {
					const r = record(event.data, ['type', 'nonce']);
					if (r.type !== 'bootstrap' || Object.keys(r).length !== 2 || typeof r.nonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(r.nonce))
						return;
					nonce = r.nonce;
					hostOrigin = event.origin;
					inner = document.createElement('iframe');
					inner.setAttribute('sandbox', 'allow-scripts allow-same-origin');
					inner.style.cssText = 'width:100%;height:100%;border:0';
					inner.addEventListener('load', () => {
						if (++loads > 1) stop();
					});
					inner.src = EDITOR_URL;
					document.body.append(inner);
					return;
				}
				const raw = record(event.data);
				if (raw.type === 'dispose' && Object.keys(raw).length === 2 && raw.nonce === nonce) {
					stop();
					return;
				}
				if (!initialized) return;
				const action = hostAction(raw, nonce);
				if (action.action === 'load') loadRequest = action;
				else exportRequest = action;
				inner?.contentWindow?.postMessage(JSON.stringify(action), EDITOR_ORIGIN);
			} else if (inner && event.source === inner.contentWindow && event.origin === EDITOR_ORIGIN && nonce) {
				const r = parsed(event.data);
				if (r.event === 'configure' && Object.keys(r).length === 1 && !initialized) {
					inner.contentWindow?.postMessage(JSON.stringify({ action: 'configure', config: {} }), EDITOR_ORIGIN);
					return;
				}
				if (r.event === 'init') {
					if (initialized) return;
					if (Object.keys(r).length !== 1) return;
					initialized = true;
					clearTimeout(startup);
				}
				if (!initialized) return;
				const canonical = vendorMessage(event.data, nonce, loadRequest, exportRequest);
				if (hostOrigin) parent.postMessage(canonical, hostOrigin);
			}
		} catch {
			console.warn('[security] dropped Draw.io relay message');
		}
	};
	window.addEventListener('message', listener);
	window.addEventListener('pagehide', stop, { once: true });
	for (const origin of hostOrigins) parent.postMessage({ type: 'relay-ready' }, origin);
	return stop;
}
