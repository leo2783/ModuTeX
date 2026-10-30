// SPDX-License-Identifier: Apache-2.0

export const TERMINAL_EVENT = 'frontend://terminal/event';

export const TERMINAL_LIMITS = Object.freeze({
	maxOutputChunkBytes: 1024 * 1024,
	maxOutputQueueBytes: 2 * 1024 * 1024,
	maxOutputQueueEvents: 256,
	maxEarlyBytes: 1024 * 1024,
	maxEarlyEvents: 128,
	maxEarlySessions: 16,
	maxInputChunkBytes: 16 * 1024,
	maxInputQueueBytes: 1024 * 1024
});

const opaqueIdentifier = /^[A-Za-z0-9_-]{1,128}$/;
const stableCode = /^[A-Z][A-Z0-9_]{0,63}$/;
const unsafeControls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export class TerminalSessionError extends Error {
	constructor(code, detail = '') {
		const safeCode = typeof code === 'string' && stableCode.test(code)
			? code
			: 'TERMINAL_OPERATION_FAILED';
		const safeDetail = sanitizeDetail(detail);
		super(safeDetail || safeCode);
		this.name = 'TerminalSessionError';
		this.code = safeCode;
		this.detail = safeDetail;
	}
}

function sanitizeDetail(value) {
	return typeof value === 'string'
		? value.replace(unsafeControls, ' ').slice(0, 2048)
		: '';
}

function contractFailure(code, field, reason) {
	return new TerminalSessionError(code, `${field}: ${reason}`);
}

function exactRecord(value, fields, code, field) {
	try {
		if (
			typeof value !== 'object' ||
			value === null ||
			Array.isArray(value) ||
			![Object.prototype, null].includes(Object.getPrototypeOf(value))
		) {
			throw contractFailure(code, field, 'expected a plain record');
		}
		const descriptors = Object.getOwnPropertyDescriptors(value);
		const keys = Reflect.ownKeys(value);
		if (
			keys.length !== fields.length ||
			keys.some((key) => typeof key !== 'string' || !fields.includes(key)) ||
			fields.some((key) => !descriptors[key] || !('value' in descriptors[key]))
		) {
			throw contractFailure(code, field, 'expected exact data fields');
		}
		const result = Object.create(null);
		for (const key of fields) result[key] = descriptors[key].value;
		return result;
	} catch (error) {
		if (error instanceof TerminalSessionError) throw error;
		throw contractFailure(code, field, 'unreadable record');
	}
}

function denseArray(value, maximum, code, field) {
	try {
		if (
			!Array.isArray(value) ||
			Object.getPrototypeOf(value) !== Array.prototype ||
			value.length > maximum
		) {
			throw contractFailure(code, field, 'invalid array length or type');
		}
		const descriptors = Object.getOwnPropertyDescriptors(value);
		if (Reflect.ownKeys(value).length !== value.length + 1) {
			throw contractFailure(code, field, 'sparse or augmented array');
		}
		const result = [];
		for (let index = 0; index < value.length; index++) {
			const descriptor = descriptors[String(index)];
			if (!descriptor || !('value' in descriptor)) {
				throw contractFailure(code, field, 'missing data element or accessor');
			}
			result.push(descriptor.value);
		}
		return result;
	} catch (error) {
		if (error instanceof TerminalSessionError) throw error;
		throw contractFailure(code, field, 'unreadable array');
	}
}

function ownDataField(value, name, code, field) {
	try {
		if (typeof value !== 'object' || value === null || Array.isArray(value)) {
			throw contractFailure(code, field, 'expected a data record');
		}
		const descriptor = Object.getOwnPropertyDescriptor(value, name);
		if (!descriptor || !('value' in descriptor)) {
			throw contractFailure(code, field, 'expected a data field');
		}
		return descriptor.value;
	} catch (error) {
		if (error instanceof TerminalSessionError) throw error;
		throw contractFailure(code, field, 'unreadable data field');
	}
}

function opaqueId(value, code, field) {
	if (typeof value !== 'string' || !opaqueIdentifier.test(value)) {
		throw contractFailure(code, field, 'invalid opaque identifier');
	}
	return value;
}

function boundedText(value, maximum, code, field, allowEmpty = false) {
	if (
		typeof value !== 'string' ||
		value.length > maximum ||
		(!allowEmpty && value.length === 0)
	) {
		throw contractFailure(code, field, 'invalid text length or type');
	}
	return value;
}

function safeInteger(value, minimum, maximum, code, field) {
	if (
		typeof value !== 'number' ||
		!Number.isSafeInteger(value) ||
		value < minimum ||
		value > maximum
	) {
		throw contractFailure(code, field, 'expected a bounded integer');
	}
	return value;
}

function parseTerminalSize(value, code, field) {
	const input = exactRecord(value, ['cols', 'rows'], code, field);
	return Object.freeze({
		cols: safeInteger(input.cols, 1, 65535, code, `${field}.cols`),
		rows: safeInteger(input.rows, 1, 65535, code, `${field}.rows`)
	});
}

function parseAvailability(value) {
	const code = 'INVALID_TERMINAL_AVAILABILITY';
	const input = exactRecord(
		value,
		['available', 'reason', 'detail'],
		code,
		'availability'
	);
	if (typeof input.available !== 'boolean') {
		throw contractFailure(code, 'available', 'expected a boolean');
	}
	const reason = input.reason === null
		? null
		: boundedText(input.reason, 128, code, 'reason');
	const detail = input.detail === null
		? null
		: boundedText(input.detail, 2048, code, 'detail', true);
	return Object.freeze({ available: input.available, reason, detail });
}

function parseSessionReceipt(value, expectedWorkspaceId) {
	const code = 'INVALID_TERMINAL_RECEIPT';
	const input = exactRecord(
		value,
		['sessionId', 'workspaceId', 'generation', 'size'],
		code,
		'receipt'
	);
	const sessionId = opaqueId(input.sessionId, code, 'sessionId');
	const workspaceId = opaqueId(input.workspaceId, code, 'workspaceId');
	if (workspaceId !== expectedWorkspaceId) {
		throw new TerminalSessionError(
			'STALE_WORKSPACE',
			'terminal receipt belongs to another workspace'
		);
	}
	return Object.freeze({
		sessionId,
		workspaceId,
		generation: safeInteger(input.generation, 0, Number.MAX_SAFE_INTEGER, code, 'generation'),
		size: parseTerminalSize(input.size, code, 'size')
	});
}

function parseOutputBytes(value) {
	const code = 'INVALID_TERMINAL_EVENT';
	const bytes = denseArray(
		value,
		TERMINAL_LIMITS.maxOutputChunkBytes,
		code,
		'payload.bytes'
	);
	const output = new Uint8Array(bytes.length);
	for (let index = 0; index < bytes.length; index++) {
		output[index] = safeInteger(bytes[index], 0, 255, code, `payload.bytes[${index}]`);
	}
	return output;
}

function parseWireEvent(value) {
	const code = 'INVALID_TERMINAL_EVENT';
	const input = exactRecord(
		value,
		['ownerId', 'workspaceId', 'sessionId', 'generation', 'sequence', 'payload'],
		code,
		'event'
	);
	const payloadType = ownDataField(input.payload, 'type', code, 'payload.type');
	let payload;
	if (payloadType === 'data') {
		const data = exactRecord(
			input.payload,
			['type', 'bytes', 'text'],
			code,
			'payload'
		);
		payload = Object.freeze({
			type: 'data',
			bytes: parseOutputBytes(data.bytes),
			text: boundedText(
				data.text,
				TERMINAL_LIMITS.maxOutputChunkBytes * 2,
				code,
				'payload.text',
				true
			)
		});
	} else if (payloadType === 'exit') {
		const exit = exactRecord(
			input.payload,
			['type', 'exitCode', 'reason'],
			code,
			'payload'
		);
		payload = Object.freeze({
			type: 'exit',
			exitCode: exit.exitCode === null
				? null
				: safeInteger(exit.exitCode, 0, 0xffffffff, code, 'payload.exitCode'),
			reason: boundedText(exit.reason, 256, code, 'payload.reason')
		});
	} else {
		throw contractFailure(code, 'payload.type', 'unknown terminal event');
	}
	return Object.freeze({
		ownerId: opaqueId(input.ownerId, code, 'ownerId'),
		workspaceId: opaqueId(input.workspaceId, code, 'workspaceId'),
		sessionId: opaqueId(input.sessionId, code, 'sessionId'),
		generation: safeInteger(input.generation, 0, Number.MAX_SAFE_INTEGER, code, 'generation'),
		sequence: safeInteger(input.sequence, 0, Number.MAX_SAFE_INTEGER, code, 'sequence'),
		payload
	});
}

function normalizeCommandError(value, fallbackCode = 'TERMINAL_OPERATION_FAILED') {
	if (value instanceof TerminalSessionError) return value;

	let rawCode = '';
	let detail = '';
	try {
		if (typeof value === 'string') {
			detail = value;
		} else if (value instanceof Error) {
			detail = value.message;
		} else if (typeof value === 'object' && value !== null) {
			const code = Object.getOwnPropertyDescriptor(value, 'code');
			const message = Object.getOwnPropertyDescriptor(value, 'detail');
			const errorMessage = Object.getOwnPropertyDescriptor(value, 'message');
			if (code && 'value' in code && typeof code.value === 'string') rawCode = code.value;
			if (message && 'value' in message && typeof message.value === 'string') detail = message.value;
			else if (errorMessage && 'value' in errorMessage && typeof errorMessage.value === 'string') detail = errorMessage.value;
		}
	} catch {
		// The native error is untrusted input too; use only the stable fallback.
	}

	if (!rawCode && detail) {
		const prefix = /^([A-Za-z][A-Za-z0-9_]{0,63})(?::|\s|$)/.exec(detail);
		if (prefix) rawCode = prefix[1];
	}
	const code = rawCode
		.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
		.replace(/[^A-Za-z0-9_]/g, '_')
		.toUpperCase();
	const stable = stableCode.test(code) ? code : fallbackCode;
	const normalized = [
		'WORKSPACE_CLOSED',
		'WORKSPACE_UNAVAILABLE',
		'OWNER_REVOKED',
		'STALE_WORKSPACE'
	].includes(stable)
		? 'STALE_WORKSPACE'
		: stable;
	return new TerminalSessionError(normalized, detail);
}

function safeCleanupCandidate(value, workspaceId) {
	try {
		if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
		const returnedWorkspace = Object.getOwnPropertyDescriptor(value, 'workspaceId');
		const returnedSession = Object.getOwnPropertyDescriptor(value, 'sessionId');
		if (
			!returnedWorkspace ||
			!('value' in returnedWorkspace) ||
			returnedWorkspace.value !== workspaceId ||
			!returnedSession ||
			!('value' in returnedSession) ||
			typeof returnedSession.value !== 'string' ||
			!opaqueIdentifier.test(returnedSession.value)
		) {
			return null;
		}
		return returnedSession.value;
	} catch {
		return null;
	}
}

function notify(callbacks, name, ...args) {
	try {
		return callbacks[name]?.(...args);
	} catch {
		return undefined;
	}
}

export function createTerminalController(options) {
	if (!options || typeof options !== 'object') {
		throw new TypeError('A terminal owner and admitted workspace are required');
	}
	const ownerId = opaqueId(options.ownerId, 'INVALID_TERMINAL_OWNER', 'ownerId');
	const workspaceId = opaqueId(options.workspaceId, 'STALE_WORKSPACE', 'workspaceId');
	const invokeCommand = options.invokeCommand;
	const listenEvent = options.listenEvent;
	const callbacks = options.callbacks ?? {};
	const signal = options.signal;
	if (typeof invokeCommand !== 'function' || typeof listenEvent !== 'function') {
		throw new TypeError('Terminal commands and the terminal event listener are required');
	}
	if (signal?.aborted) {
		throw new TerminalSessionError('STALE_WORKSPACE', 'workspace is no longer active');
	}

	let phase = 'idle';
	let availabilityResult = null;
	let listenerPromise = null;
	let listenerStop = null;
	let listenerStopCalled = false;
	let startTask = null;
	let closeTask = null;
	let closeConfirmed = false;
	let closeRequested = false;
	let failure = null;
	let failureReported = false;
	let binding = null;
	let exitReceived = false;
	let lastSequence = null;
	let killTask = null;
	let killConfirmed = false;
	let inputQueue = [];
	let inputQueueBytes = 0;
	let inputPump = null;
	let pendingResize = null;
	let resizePump = null;
	let earlyEvents = new Map();
	let earlyEventCount = 0;
	let earlyBytes = 0;
	let outputQueue = [];
	let outputQueueBytes = 0;
	let outputPump = null;

	function checkOpen() {
		if (signal?.aborted) {
			throw new TerminalSessionError('STALE_WORKSPACE', 'workspace is no longer active');
		}
		if (closeRequested) {
			throw new TerminalSessionError('STALE_WORKSPACE', 'terminal session is closing');
		}
	}

	function stopListenerOnce(stop) {
		if (typeof stop !== 'function' || listenerStopCalled) return;
		listenerStopCalled = true;
		try {
			stop();
		} catch {
			// The subscription is no longer used, even if its native removal failed.
		}
	}

	async function detachListener() {
		if (listenerStop) {
			const stop = listenerStop;
			listenerStop = null;
			stopListenerOnce(stop);
			return;
		}
		if (listenerPromise) {
			try {
				stopListenerOnce(await listenerPromise);
			} catch {
				// A failed listener registration has no resource to remove.
			}
		}
	}

	function clearEarlyEvents() {
		earlyEvents.clear();
		earlyEventCount = 0;
		earlyBytes = 0;
	}

	function clearOutputQueue() {
		outputQueue = [];
		outputQueueBytes = 0;
	}

	function clearInputQueue() {
		inputQueue = [];
		inputQueueBytes = 0;
	}

	function reportCleanupFailure(error) {
		notify(callbacks, 'onCleanupFailure', normalizeCommandError(error, 'CLEANUP_UNPROVEN'));
	}

	async function requestKill() {
		if (!binding || exitReceived || killConfirmed) return;
		if (!killTask) {
			const task = Promise.resolve()
				.then(() => invokeCommand('frontend_terminal_kill', {
					request: { sessionId: binding.sessionId }
				}))
				.then(() => {
					killConfirmed = true;
				});
			killTask = task;
		}
		const task = killTask;
		try {
			await task;
		} catch (error) {
			if (killTask === task) killTask = null;
			throw normalizeCommandError(error, 'CLEANUP_UNPROVEN');
		}
	}

	function fail(error) {
		if (failure || closeRequested) return;
		failure = normalizeCommandError(error, 'TERMINAL_OPERATION_FAILED');
		phase = 'failed';
		clearEarlyEvents();
		clearOutputQueue();
		clearInputQueue();
		pendingResize = null;
		void detachListener();
		if (!failureReported) {
			failureReported = true;
			notify(callbacks, 'onFailure', failure);
		}
		if (binding && !exitReceived) {
			void requestKill().catch(reportCleanupFailure);
		}
	}

	async function drainOutputQueue() {
		if (outputPump || closeRequested || failure) return;
		outputPump = (async () => {
			while (outputQueue.length && !closeRequested && !failure) {
				const item = outputQueue.shift();
				outputQueueBytes = Math.max(0, outputQueueBytes - item.byteLength);
				try {
					if (item.type === 'data') {
						await callbacks.onOutput?.(item.bytes);
					} else {
						await callbacks.onExit?.({
							exitCode: item.exitCode,
							reason: item.reason
						});
					}
				} catch (error) {
					fail(new TerminalSessionError(
						'OUTPUT_CONSUMER_FAILED',
						error instanceof Error ? error.message : 'terminal output could not be displayed'
					));
				}
			}
		})().finally(() => {
			outputPump = null;
			if (outputQueue.length && !closeRequested && !failure) {
				void drainOutputQueue();
			}
		});
		await outputPump;
	}

	function enqueueOutput(item) {
		if (
			outputQueue.length >= TERMINAL_LIMITS.maxOutputQueueEvents ||
			outputQueueBytes + item.byteLength > TERMINAL_LIMITS.maxOutputQueueBytes
		) {
			fail(new TerminalSessionError(
				'OUTPUT_BACKPRESSURE',
				'terminal output exceeded the renderer queue limit'
			));
			return;
		}
		outputQueue.push(item);
		outputQueueBytes += item.byteLength;
		void drainOutputQueue();
	}

	function processBoundEvent(event) {
		if (failure || closeRequested || !binding) return;
		if (event.sessionId !== binding.sessionId) return;
		if (event.generation !== binding.generation) {
			fail(new TerminalSessionError(
				'STALE_GENERATION',
				'terminal event belongs to an outdated session generation'
			));
			return;
		}
		if (exitReceived) {
			fail(new TerminalSessionError(
				'EVENT_AFTER_EXIT',
				'terminal sent an event after process exit'
			));
			return;
		}
		if (lastSequence !== null) {
			if (event.sequence <= lastSequence) {
				fail(new TerminalSessionError(
					'EVENT_SEQUENCE_REPLAY',
					'terminal event sequence was repeated or reordered'
				));
				return;
			}
			if (event.sequence !== lastSequence + 1) {
				fail(new TerminalSessionError(
					'EVENT_SEQUENCE_GAP',
					'terminal output sequence has a gap'
				));
				return;
			}
		}
		lastSequence = event.sequence;
		if (event.payload.type === 'data') {
			enqueueOutput({
				type: 'data',
				bytes: event.payload.bytes,
				byteLength: event.payload.bytes.byteLength
			});
			return;
		}
		exitReceived = true;
		phase = 'exited';
		void detachListener();
		enqueueOutput({
			type: 'exit',
			exitCode: event.payload.exitCode,
			reason: event.payload.reason,
			byteLength: 0
		});
	}

	function enqueueEarlyEvent(event) {
		let group = earlyEvents.get(event.sessionId);
		if (!group) {
			if (earlyEvents.size >= TERMINAL_LIMITS.maxEarlySessions) {
				fail(new TerminalSessionError(
					'OUTPUT_BACKPRESSURE',
					'too many terminal sessions arrived before spawn completed'
				));
				return;
			}
			group = [];
			earlyEvents.set(event.sessionId, group);
		}
		const byteLength = event.payload.type === 'data'
			? event.payload.bytes.byteLength
			: 0;
		if (
			earlyEventCount >= TERMINAL_LIMITS.maxEarlyEvents ||
			earlyBytes + byteLength > TERMINAL_LIMITS.maxEarlyBytes
		) {
			fail(new TerminalSessionError(
				'OUTPUT_BACKPRESSURE',
				'early terminal output exceeded the renderer queue limit'
			));
			return;
		}
		group.push(event);
		earlyEventCount++;
		earlyBytes += byteLength;
	}

	function onWireEvent(value) {
		if (closeRequested || failure) return;
		let event;
		try {
			event = parseWireEvent(value);
		} catch (error) {
			fail(error);
			return;
		}
		if (event.ownerId !== ownerId) {
			fail(new TerminalSessionError(
				'OWNER_MISMATCH',
				'terminal event was delivered for another window owner'
			));
			return;
		}
		// The listener is window-scoped, but may observe sessions in other workspaces.
		// They are never delivered to this controller.
		if (event.workspaceId !== workspaceId) return;
		if (binding) {
			processBoundEvent(event);
		} else if (phase === 'spawning') {
			enqueueEarlyEvent(event);
		}
	}

	async function attachListener() {
		if (listenerPromise) {
			throw new TerminalSessionError('BUSY', 'terminal listener already exists');
		}
		listenerPromise = Promise.resolve().then(() =>
			listenEvent(TERMINAL_EVENT, onWireEvent)
		);
		const stop = await listenerPromise;
		if (typeof stop !== 'function') {
			throw new TerminalSessionError(
				'INVALID_TERMINAL_LISTENER',
				'terminal event listener did not return an unsubscribe function'
			);
		}
		if (closeRequested || failure) stopListenerOnce(stop);
		else listenerStop = stop;
	}

	async function pumpInputQueue() {
		if (inputPump || closeRequested || failure) return;
		inputPump = (async () => {
			while (inputQueue.length && phase === 'active' && !closeRequested && !failure) {
				const chunk = inputQueue.shift();
				try {
					await invokeCommand('frontend_terminal_input', {
						request: {
							sessionId: binding.sessionId,
							data: chunk.data
						}
					});
				} catch (error) {
					if (!closeRequested) fail(normalizeCommandError(error));
					break;
				} finally {
					inputQueueBytes = Math.max(0, inputQueueBytes - chunk.byteLength);
				}
			}
		})().finally(() => {
			inputPump = null;
			if (inputQueue.length && phase === 'active' && !closeRequested && !failure) {
				void pumpInputQueue();
			}
		});
		await inputPump;
	}

	function splitUtf8Input(value, availableBytes) {
		if (value.length === 0 || value.length > availableBytes) return null;
		const encoder = new TextEncoder();
		const chunks = [];
		let current = '';
		let currentBytes = 0;
		let totalBytes = 0;
		for (const character of value) {
			const byteLength = encoder.encode(character).byteLength;
			if (totalBytes + byteLength > availableBytes) return null;
			if (currentBytes + byteLength > TERMINAL_LIMITS.maxInputChunkBytes) {
				chunks.push({ data: current, byteLength: currentBytes });
				current = '';
				currentBytes = 0;
			}
			current += character;
			currentBytes += byteLength;
			totalBytes += byteLength;
		}
		if (current) chunks.push({ data: current, byteLength: currentBytes });
		return { chunks, totalBytes };
	}

	async function drainResizeQueue() {
		if (resizePump || phase !== 'active' || closeRequested || failure) return;
		resizePump = (async () => {
			while (pendingResize && phase === 'active' && !closeRequested && !failure) {
				const size = pendingResize;
				pendingResize = null;
				try {
					const result = await invokeCommand('frontend_terminal_resize', {
						request: {
							sessionId: binding.sessionId,
							cols: size.cols,
							rows: size.rows
						}
					});
					parseTerminalSize(result, 'INVALID_TERMINAL_SIZE', 'resize');
				} catch (error) {
					if (!closeRequested) fail(normalizeCommandError(error, 'INVALID_TERMINAL_SIZE'));
					break;
				}
			}
		})().finally(() => {
			resizePump = null;
			if (pendingResize && phase === 'active' && !closeRequested && !failure) {
				void drainResizeQueue();
			}
		});
		await resizePump;
	}

	async function availability() {
		checkOpen();
		let result;
		try {
			result = await invokeCommand('frontend_terminal_availability');
		} catch (error) {
			throw normalizeCommandError(error);
		}
		checkOpen();
		availabilityResult = parseAvailability(result);
		return availabilityResult;
	}

	function start(cols, rows) {
		checkOpen();
		if (startTask) {
			throw new TerminalSessionError('BUSY', 'terminal session can only be spawned once');
		}
		if (!availabilityResult) {
			throw new TerminalSessionError(
				'AVAILABILITY_REQUIRED',
				'check terminal availability before spawning'
			);
		}
		if (!availabilityResult.available) {
			throw new TerminalSessionError(
				'TERMINAL_UNAVAILABLE',
				availabilityResult.detail || availabilityResult.reason || 'terminal shell is unavailable'
			);
		}
		const size = parseTerminalSize(
			{ cols, rows },
			'INVALID_TERMINAL_SIZE',
			'spawn.size'
		);
		phase = 'spawning';
		const task = (async () => {
			let rawReceipt;
			try {
				await attachListener();
				checkOpen();
				rawReceipt = await invokeCommand('frontend_terminal_spawn', {
					request: {
						workspaceId,
						cols: size.cols,
						rows: size.rows
					}
				});
			} catch (error) {
				const normalized = normalizeCommandError(error);
				if (!closeRequested && !failure) fail(normalized);
				throw normalized;
			}

			try {
				binding = parseSessionReceipt(rawReceipt, workspaceId);
			} catch (error) {
				const normalized = normalizeCommandError(error, 'INVALID_TERMINAL_RECEIPT');
				const candidate = safeCleanupCandidate(rawReceipt, workspaceId);
				if (candidate) {
					try {
						await invokeCommand('frontend_terminal_kill', {
							request: { sessionId: candidate }
						});
					} catch (cleanupError) {
						reportCleanupFailure(cleanupError);
					}
				}
				if (!closeRequested && !failure) fail(normalized);
				throw normalized;
			}

			if (closeRequested) return binding;
			if (failure) {
				try {
					await requestKill();
				} catch (error) {
					reportCleanupFailure(error);
				}
				throw failure;
			}

			phase = 'active';
			const early = earlyEvents.get(binding.sessionId) ?? [];
			clearEarlyEvents();
			for (const event of early) {
				if (failure || closeRequested) break;
				processBoundEvent(event);
			}
			if (failure) {
				try {
					await requestKill();
				} catch (error) {
					reportCleanupFailure(error);
				}
				throw failure;
			}
			return binding;
		})();
		startTask = task;
		return task;
	}

	function send(data) {
		if (
			typeof data !== 'string' ||
			data.length === 0 ||
			phase !== 'active' ||
			closeRequested ||
			failure ||
			exitReceived
		) {
			return false;
		}
		const availableBytes = TERMINAL_LIMITS.maxInputQueueBytes - inputQueueBytes;
		const split = splitUtf8Input(data, availableBytes);
		if (!split || split.totalBytes === 0) {
			notify(callbacks, 'onBackpressure');
			return false;
		}
		inputQueue.push(...split.chunks);
		inputQueueBytes += split.totalBytes;
		void pumpInputQueue();
		return true;
	}

	function resize(cols, rows) {
		if (phase !== 'active' || closeRequested || failure || exitReceived) return false;
		try {
			pendingResize = parseTerminalSize(
				{ cols, rows },
				'INVALID_TERMINAL_SIZE',
				'resize'
			);
		} catch (error) {
			fail(error);
			return false;
		}
		void drainResizeQueue();
		return true;
	}

	async function close() {
		if (closeConfirmed) return;
		closeRequested = true;
		phase = 'closing';
		clearEarlyEvents();
		clearOutputQueue();
		clearInputQueue();
		pendingResize = null;
		signal?.removeEventListener('abort', onAbort);
		if (closeTask) return closeTask;

		const task = (async () => {
			await detachListener();
			if (startTask) {
				try {
					await startTask;
				} catch {
					// Spawn failures are already reported; still release all local resources.
				}
			}
			await detachListener();
			if (binding && !exitReceived) await requestKill();
			closeConfirmed = true;
			phase = 'closed';
		})();
		closeTask = task;
		try {
			await task;
		} catch (error) {
			if (closeTask === task) closeTask = null;
			const normalized = normalizeCommandError(error, 'CLEANUP_UNPROVEN');
			reportCleanupFailure(normalized);
			throw normalized;
		}
	}

	function onAbort() {
		void close().catch(() => {});
	}

	signal?.addEventListener('abort', onAbort, { once: true });
	if (signal?.aborted) onAbort();

	return Object.freeze({ availability, start, send, resize, close });
}
