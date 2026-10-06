export const DRAWIO_ACTIONS = ['init', 'load', 'save', 'export', 'exit'] as const;
export const DRAWIO_BRIDGE_ORIGIN = 'drawio://bundle';
export const DRAWIO_SOURCE_LIMIT = 10 * 1024 * 1024;
export const DIAGRAM_OUTPUT_LIMIT = 25 * 1024 * 1024;

const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const MAX_RECORD_FIELDS = 32;
const FORMATS = new Set(['xml', 'svg', 'xmlsvg', 'png', 'xmlpng', 'jpg', 'webp', 'html', 'html2', 'json', 'pdf']);
const ENVELOPE_FIELDS = ['event', 'nonce'] as const;
const STATE_FIELDS = [
	'bounds',
	'modelBounds',
	'scale',
	'translate',
	'pageVisible',
	'currentPage',
	'page',
	'containerSize',
	'checksum'
] as const;

export type DrawioAction = (typeof DRAWIO_ACTIONS)[number];

export interface ValidatedDrawioMessage {
	action: DrawioAction;
	nonce: string;
	xml?: string;
	data?: string;
	format?: string;
	modified?: boolean;
}

export interface DrawioMessageBridgeOptions {
	source: MessageEventSource;
	origin: string;
	nonce: string;
	onMessage: (message: ValidatedDrawioMessage) => void;
}

type PlainRecord = Record<string, unknown>;

function fail(code: 'INVALID_MESSAGE' | 'INVALID_ACTION' | 'INVALID_NONCE' | 'PAYLOAD_TOO_LARGE'): never {
	throw new Error(code);
}

function utf8ByteLength(value: string, limit: number): number {
	if (value.length > limit) return limit + 1;
	let bytes = 0;
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code <= 0x7f) bytes++;
		else if (code <= 0x7ff) bytes += 2;
		else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
			const next = value.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				bytes += 4;
				index++;
			} else bytes += 3;
		} else bytes += 3;
		if (bytes > limit) return bytes;
	}
	return bytes;
}

function jsonStringByteLength(value: string, limit: number): number {
	let bytes = 2;
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) {
			bytes += 2;
		} else if (code <= 0x1f) {
			bytes += 6;
		} else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
			const next = value.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				bytes += 4;
				index++;
			} else bytes += 6;
		} else if (code >= 0xd800 && code <= 0xdfff) {
			bytes += 6;
		} else if (code <= 0x7f) bytes++;
		else if (code <= 0x7ff) bytes += 2;
		else bytes += 3;
		if (bytes > limit) return bytes;
	}
	return bytes;
}

function plainRecord(value: unknown): PlainRecord {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('INVALID_MESSAGE');
	try {
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) return fail('INVALID_MESSAGE');
		const keys = Reflect.ownKeys(value);
		if (keys.length > MAX_RECORD_FIELDS) return fail('INVALID_MESSAGE');
		if (keys.some((key) => typeof key !== 'string')) return fail('INVALID_MESSAGE');
		const result: PlainRecord = Object.create(null) as PlainRecord;
		for (const key of keys as string[]) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor?.enumerable || !('value' in descriptor)) return fail('INVALID_MESSAGE');
			result[key] = descriptor.value;
		}
		return result;
	} catch {
		return fail('INVALID_MESSAGE');
	}
}

function objectJsonByteLength(record: PlainRecord, limit: number, depth: number): number {
	if (depth > 2) return fail('INVALID_MESSAGE');
	let bytes = 2;
	const entries = Object.entries(record);
	for (let index = 0; index < entries.length; index++) {
		const [key, value] = entries[index];
		bytes += jsonStringByteLength(key, limit);
		bytes += 1;
		if (typeof value === 'string') bytes += jsonStringByteLength(value, limit);
		else if (typeof value === 'boolean') bytes += value ? 4 : 5;
		else if (typeof value === 'number' && Number.isFinite(value)) bytes += String(value).length;
		else if (value === null) bytes += 4;
		else if (value && typeof value === 'object') bytes += objectJsonByteLength(plainRecord(value), limit, depth + 1);
		else return fail('INVALID_MESSAGE');
		if (index < entries.length - 1) bytes++;
		if (bytes > limit) return bytes;
	}
	return bytes;
}

function canonicalEvent(value: unknown): DrawioAction | undefined {
	if (typeof value !== 'string') return undefined;
	if (value === 'autosave') return 'save';
	return (DRAWIO_ACTIONS as readonly string[]).includes(value) ? (value as DrawioAction) : undefined;
}

function allowedFields(action: DrawioAction): Set<string> {
	const common = [...ENVELOPE_FIELDS];
	if (action === 'init') return new Set(common);
	if (action === 'load') return new Set([...common, ...STATE_FIELDS]);
	if (action === 'save') return new Set([...common, ...STATE_FIELDS, 'xml', 'exit', 'modified']);
	if (action === 'export') return new Set([...common, ...STATE_FIELDS, 'xml', 'data', 'format', 'filename']);
	return new Set([...common, 'modified']);
}

function hasOnlyFields(record: PlainRecord, allowed: Set<string>): void {
	for (const key of Object.keys(record)) {
		if (!allowed.has(key)) return fail('INVALID_MESSAGE');
	}
}

function assertBoundedString(value: unknown, limit: number): asserts value is string {
	if (typeof value !== 'string') return fail('INVALID_MESSAGE');
	if (utf8ByteLength(value, limit) > limit) return fail('PAYLOAD_TOO_LARGE');
}

function numericRecord(value: unknown, fields: readonly string[], nonNegative: readonly string[] = []): void {
	const record = plainRecord(value);
	if (Object.keys(record).length !== fields.length || fields.some((field) => !Object.hasOwn(record, field))) {
		return fail('INVALID_MESSAGE');
	}
	for (const field of fields) {
		const item = record[field];
		if (typeof item !== 'number' || !Number.isFinite(item) || Math.abs(item) > 100_000_000) return fail('INVALID_MESSAGE');
		if (nonNegative.includes(field) && item < 0) return fail('INVALID_MESSAGE');
	}
}

function validateState(record: PlainRecord): void {
	if (Object.hasOwn(record, 'bounds')) numericRecord(record.bounds, ['x', 'y', 'width', 'height'], ['width', 'height']);
	if (Object.hasOwn(record, 'modelBounds')) numericRecord(record.modelBounds, ['x', 'y', 'width', 'height'], ['width', 'height']);
	if (Object.hasOwn(record, 'page')) numericRecord(record.page, ['x', 'y', 'width', 'height'], ['width', 'height']);
	if (Object.hasOwn(record, 'translate')) numericRecord(record.translate, ['x', 'y']);
	if (Object.hasOwn(record, 'containerSize')) {
		numericRecord(
			record.containerSize,
			['width', 'height', 'offsetWidth', 'offsetHeight'],
			['width', 'height', 'offsetWidth', 'offsetHeight']
		);
	}
	if (Object.hasOwn(record, 'scale')) {
		if (typeof record.scale !== 'number' || !Number.isFinite(record.scale) || record.scale <= 0 || record.scale > 1000) {
			return fail('INVALID_MESSAGE');
		}
	}
	if (Object.hasOwn(record, 'currentPage')) {
		if (!Number.isInteger(record.currentPage) || (record.currentPage as number) < 0 || (record.currentPage as number) > 1_000_000) {
			return fail('INVALID_MESSAGE');
		}
	}
	if (Object.hasOwn(record, 'pageVisible') && typeof record.pageVisible !== 'boolean') return fail('INVALID_MESSAGE');
	if (Object.hasOwn(record, 'checksum')) assertBoundedString(record.checksum, 256);
}

function messageAction(record: PlainRecord): { action: DrawioAction; autosave: boolean } {
	const action = canonicalEvent(record.event);
	if (!action) return fail('INVALID_ACTION');
	return { action, autosave: record.event === 'autosave' };
}

export function validateDrawioMessage(raw: unknown, expectedNonce: string): ValidatedDrawioMessage {
	if (!NONCE_PATTERN.test(expectedNonce)) return fail('INVALID_NONCE');
	let value = raw;
	let rawMessageSize: number | undefined;
	if (typeof raw === 'string') {
		rawMessageSize = utf8ByteLength(raw, DIAGRAM_OUTPUT_LIMIT);
		if (rawMessageSize > DIAGRAM_OUTPUT_LIMIT) return fail('PAYLOAD_TOO_LARGE');
		try {
			value = JSON.parse(raw) as unknown;
		} catch {
			return fail('INVALID_MESSAGE');
		}
	}

	const record = plainRecord(value);
	const { action, autosave } = messageAction(record);
	hasOnlyFields(record, allowedFields(action));
	if (record.nonce !== expectedNonce) return fail('INVALID_NONCE');

	if (Object.hasOwn(record, 'xml')) assertBoundedString(record.xml, DRAWIO_SOURCE_LIMIT);
	if (Object.hasOwn(record, 'data')) assertBoundedString(record.data, DIAGRAM_OUTPUT_LIMIT);
	if (Object.hasOwn(record, 'format') && (typeof record.format !== 'string' || !FORMATS.has(record.format))) {
		return fail('INVALID_MESSAGE');
	}
	if (Object.hasOwn(record, 'filename')) {
		assertBoundedString(record.filename, 256);
		if (!record.filename || /[\\/\0]/.test(record.filename)) return fail('INVALID_MESSAGE');
	}
	if (Object.hasOwn(record, 'modified') && typeof record.modified !== 'boolean') return fail('INVALID_MESSAGE');
	if (Object.hasOwn(record, 'exit') && typeof record.exit !== 'boolean') return fail('INVALID_MESSAGE');
	validateState(record);

	if (rawMessageSize === undefined && objectJsonByteLength(record, DIAGRAM_OUTPUT_LIMIT, 0) > DIAGRAM_OUTPUT_LIMIT) {
		return fail('PAYLOAD_TOO_LARGE');
	}
	if (action === 'save' && !Object.hasOwn(record, 'xml')) return fail('INVALID_MESSAGE');
	if (action === 'export' && (!Object.hasOwn(record, 'format') || !Object.hasOwn(record, 'data'))) return fail('INVALID_MESSAGE');
	if (action === 'exit' && typeof record.modified !== 'boolean') return fail('INVALID_MESSAGE');

	return {
		action,
		nonce: expectedNonce,
		...(typeof record.xml === 'string' ? { xml: record.xml } : {}),
		...(typeof record.data === 'string' ? { data: record.data } : {}),
		...(typeof record.format === 'string' ? { format: record.format } : {}),
		...(autosave ? { modified: true } : typeof record.modified === 'boolean' ? { modified: record.modified } : {})
	};
}

function validateBridgeOptions(options: DrawioMessageBridgeOptions): void {
	if (
		!options.source ||
		options.origin !== DRAWIO_BRIDGE_ORIGIN ||
		!NONCE_PATTERN.test(options.nonce) ||
		typeof options.onMessage !== 'function'
	) {
		throw new Error('INVALID_DRAWIO_BRIDGE_CONFIG');
	}
}

export function attachDrawioMessageBridge(target: EventTarget, options: DrawioMessageBridgeOptions): () => void {
	validateBridgeOptions(options);
	const listener: EventListener = (event) => {
		const messageEvent = event as MessageEvent<unknown>;
		if (messageEvent.source !== options.source || messageEvent.origin !== options.origin) {
			console.warn('[security] dropped Draw.io bridge message');
			return;
		}
		let message: ValidatedDrawioMessage;
		try {
			message = validateDrawioMessage(messageEvent.data, options.nonce);
		} catch {
			console.warn('[security] dropped Draw.io bridge message');
			return;
		}
		options.onMessage(message);
	};
	target.addEventListener('message', listener);
	return () => target.removeEventListener('message', listener);
}
