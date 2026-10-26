// SPDX-License-Identifier: Apache-2.0
// Narrow adapter for the host-owned Git commands. Git arguments, executable
// selection, workspace roots, and discard confirmation remain host concerns.
import { invoke, isTauri } from '@tauri-apps/api/core';

const MAX_GIT_PATHS = 4096;
const MAX_PATH_ARGUMENT_BYTES = 512 * 1024;
const MAX_DIFF_BYTES = 32 * 1024 * 1024;
const MAX_SHOW_BYTES = 32 * 1024 * 1024;
const MAX_LOG_BYTES = 8 * 1024 * 1024;
const MAX_COMMAND_BYTES = 1024 * 1024;
const STATUS_CODES = new Set([
	'UNCHANGED',
	'MODIFIED',
	'TYPE_CHANGED',
	'ADDED',
	'DELETED',
	'RENAMED',
	'COPIED',
	'UNMERGED',
	'UNTRACKED'
]);
const AVAILABILITY_REASONS = new Set([
	'NOT_INSTALLED',
	'UNSUPPORTED_PLATFORM',
	'UNSAFE_EXECUTABLE',
	'UNSAFE_ENVIRONMENT'
]);
const OPAQUE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export class GitCommandError extends Error {
	constructor(code, message) {
		super(message);
		this.name = 'GitCommandError';
		this.code = code;
	}
}

function invalidResponse(field) {
	return new GitCommandError('INVALID_GIT_RESPONSE', `Invalid Git ${field} response.`);
}

function invalidRequest(message) {
	return new GitCommandError('INVALID_REQUEST', message);
}

function exactRecord(value, fields, field) {
	try {
		if (
			typeof value !== 'object' ||
			value === null ||
			Array.isArray(value) ||
			![Object.prototype, null].includes(Object.getPrototypeOf(value))
		) {
			throw new Error();
		}
		const descriptors = Object.getOwnPropertyDescriptors(value);
		const keys = Reflect.ownKeys(value);
		if (
			keys.length !== fields.length ||
			keys.some((key) => typeof key !== 'string' || !fields.includes(key)) ||
			fields.some((key) => !descriptors[key] || !('value' in descriptors[key]))
		) {
			throw new Error();
		}
		return value;
	} catch {
		throw invalidResponse(field);
	}
}

function denseArray(value, maximum, field) {
	try {
		if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) {
			throw new Error();
		}
		const descriptors = Object.getOwnPropertyDescriptors(value);
		if (Reflect.ownKeys(value).length !== value.length + 1) throw new Error();
		const result = [];
		for (let index = 0; index < value.length; index++) {
			const descriptor = descriptors[String(index)];
			if (!descriptor || !('value' in descriptor)) throw new Error();
			result.push(descriptor.value);
		}
		return result;
	} catch {
		throw invalidResponse(field);
	}
}

function validRelativePath(path) {
	if (
		typeof path !== 'string' ||
		path.length === 0 ||
		path.length > 32767 ||
		/[\\:\x00-\x1f\x7f]/.test(path) ||
		path.startsWith('/')
	) {
		return false;
	}
	return path.split('/').every(
		(part) =>
			part.length > 0 &&
			part !== '.' &&
			part !== '..' &&
			!/[\u002e\u0020]$/.test(part) &&
			!WINDOWS_RESERVED_NAME.test(part)
	);
}

function responsePath(value) {
	if (!validRelativePath(value)) throw invalidResponse('status path');
	return value;
}

function requestWorkspaceId(value) {
	if (typeof value !== 'string' || !OPAQUE_ID.test(value)) {
		throw invalidRequest('Invalid Git workspace identifier.');
	}
	return value;
}

function requestPaths(paths, allowEmpty) {
	if (!Array.isArray(paths) || Object.getPrototypeOf(paths) !== Array.prototype || paths.length > MAX_GIT_PATHS) {
		throw invalidRequest('Invalid Git path selection.');
	}
	if (!allowEmpty && paths.length === 0) throw invalidRequest('Select at least one changed path.');

	const descriptors = Object.getOwnPropertyDescriptors(paths);
	if (Reflect.ownKeys(paths).length !== paths.length + 1) {
		throw invalidRequest('Invalid Git path selection.');
	}
	const result = [];
	const seen = new Set();
	let totalBytes = 0;
	for (let index = 0; index < paths.length; index++) {
		const descriptor = descriptors[String(index)];
		const path = descriptor && 'value' in descriptor ? descriptor.value : undefined;
		if (!validRelativePath(path)) throw invalidRequest('Git paths must be workspace-relative.');
		if (seen.has(path)) throw invalidRequest('A Git path was selected more than once.');
		seen.add(path);
		totalBytes += new TextEncoder().encode(path).byteLength;
		if (totalBytes > MAX_PATH_ARGUMENT_BYTES) throw invalidRequest('The Git path selection is too large.');
		result.push(path);
	}
	return result;
}

function parseAvailability(value) {
	let status;
	try {
		const descriptor =
			typeof value === 'object' && value !== null
				? Object.getOwnPropertyDescriptor(value, 'status')
				: undefined;
		if (!descriptor || !('value' in descriptor)) throw new Error();
		status = descriptor.value;
	} catch {
		throw invalidResponse('availability');
	}

	if (status === 'available') {
		exactRecord(value, ['status'], 'availability');
		return Object.freeze({ status });
	}
	if (status === 'unavailable') {
		const input = exactRecord(value, ['status', 'reason'], 'availability');
		if (typeof input.reason !== 'string' || !AVAILABILITY_REASONS.has(input.reason)) {
			throw invalidResponse('availability reason');
		}
		return Object.freeze({ status, reason: input.reason });
	}
	throw invalidResponse('availability');
}

function parseStatus(value) {
	const input = exactRecord(value, ['entries'], 'status');
	const entries = denseArray(input.entries, MAX_GIT_PATHS, 'status entries').map((item) => {
		const entry = exactRecord(item, ['index', 'worktree', 'path', 'originalPath'], 'status entry');
		if (
			typeof entry.index !== 'string' ||
			!STATUS_CODES.has(entry.index) ||
			typeof entry.worktree !== 'string' ||
			!STATUS_CODES.has(entry.worktree)
		) {
			throw invalidResponse('status code');
		}
		if (entry.originalPath !== null && !validRelativePath(entry.originalPath)) {
			throw invalidResponse('original status path');
		}
		return Object.freeze({
			index: entry.index,
			worktree: entry.worktree,
			path: responsePath(entry.path),
			originalPath: entry.originalPath
		});
	});
	return Object.freeze({ entries: Object.freeze(entries) });
}

function parseUnit(value) {
	if (value !== null && value !== undefined) throw invalidResponse('empty command');
	return undefined;
}

function parseDiscardResult(value) {
	if (typeof value !== 'boolean') throw invalidResponse('discard');
	return value;
}

function parseUserName(value) {
	if (value === null) return null;
	if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
		throw invalidResponse('Git user name');
	}
	return value;
}

function copyBinaryResponse(value, maximum, field) {
	let bytes;
	if (value instanceof Uint8Array) {
		bytes = value;
	} else if (value instanceof ArrayBuffer) {
		bytes = new Uint8Array(value);
	} else {
		throw invalidResponse(`${field} bytes`);
	}
	if (bytes.byteLength > maximum) {
		throw new GitCommandError('OUTPUT_LIMIT_EXCEEDED', `Git ${field} output exceeded its size limit.`);
	}
	try {
		const copy = new Uint8Array(bytes.byteLength);
		copy.set(bytes);
		return copy;
	} catch {
		throw invalidResponse(`${field} bytes`);
	}
}

function normalizeFailure(value) {
	if (value instanceof GitCommandError) return value;
	try {
		if (typeof value === 'object' && value !== null) {
			const code = Object.getOwnPropertyDescriptor(value, 'code')?.value;
			const message = Object.getOwnPropertyDescriptor(value, 'message')?.value;
			if (
				typeof code === 'string' &&
				/^[A-Z0-9_]{1,64}$/.test(code) &&
				typeof message === 'string' &&
				message.length > 0
			) {
				return new GitCommandError(code, message.slice(0, 4096));
			}
		}
	} catch {
		// An unreadable rejection still becomes a bounded, typed adapter error.
	}
	if (value instanceof Error && value.message) {
		return new GitCommandError('GIT_OPERATION_FAILED', value.message.slice(0, 4096));
	}
	if (typeof value === 'string' && value.length > 0) {
		return new GitCommandError('GIT_OPERATION_FAILED', value.slice(0, 4096));
	}
	return new GitCommandError('GIT_OPERATION_FAILED', 'The Git operation could not be completed.');
}

function call(invokeCommand, command, args, parse) {
	return Promise.resolve()
		.then(() => invokeCommand(command, args))
		.then(parse)
		.catch((error) => {
			throw normalizeFailure(error);
		});
}

function workspaceRequest(workspaceId) {
	return { request: { workspaceId: requestWorkspaceId(workspaceId) } };
}

/**
 * Adapter factory is also the narrow seam used by node:test. The production
 * entry below always supplies Tauri's official invoke API.
 */
export function createTauriGitAdapter(invokeCommand = (command, args) => invoke(command, args)) {
	return Object.freeze({
		availability() {
			return call(invokeCommand, 'frontend_git_availability', undefined, parseAvailability);
		},
		status(workspaceId) {
			return call(invokeCommand, 'frontend_git_status', workspaceRequest(workspaceId), parseStatus);
		},
		diff(workspaceId, staged, paths) {
			if (typeof staged !== 'boolean') throw invalidRequest('Git diff selection must be staged or unstaged.');
			const request = {
				...workspaceRequest(workspaceId).request,
				staged,
				paths: requestPaths(paths, true)
			};
			return call(invokeCommand, 'frontend_git_diff', { request }, (value) =>
				copyBinaryResponse(value, MAX_DIFF_BYTES, 'diff')
			);
		},
		log(workspaceId) {
			return call(invokeCommand, 'frontend_git_log', workspaceRequest(workspaceId), (value) =>
				copyBinaryResponse(value, MAX_LOG_BYTES, 'log')
			);
		},
		show(workspaceId) {
			return call(invokeCommand, 'frontend_git_show', workspaceRequest(workspaceId), (value) =>
				copyBinaryResponse(value, MAX_SHOW_BYTES, 'show')
			);
		},
		init(workspaceId) {
			return call(invokeCommand, 'frontend_git_init', workspaceRequest(workspaceId), parseUnit);
		},
		stage(workspaceId, paths) {
			const request = {
				...workspaceRequest(workspaceId).request,
				paths: requestPaths(paths, true)
			};
			return call(invokeCommand, 'frontend_git_stage', { request }, parseUnit);
		},
		unstage(workspaceId, paths) {
			const request = {
				...workspaceRequest(workspaceId).request,
				paths: requestPaths(paths, true)
			};
			return call(invokeCommand, 'frontend_git_unstage', { request }, parseUnit);
		},
		discard(workspaceId, paths) {
			const request = {
				...workspaceRequest(workspaceId).request,
				paths: requestPaths(paths, false)
			};
			// A false result is the host's explicit user cancellation, not success.
			return call(invokeCommand, 'frontend_git_discard', { request }, parseDiscardResult);
		},
		commit(workspaceId, message) {
			if (typeof message !== 'string' || message.length === 0 || message.length > 32767 || message.includes('\0')) {
				throw invalidRequest('Enter a valid Git commit message.');
			}
			const request = { ...workspaceRequest(workspaceId).request, message };
			return call(invokeCommand, 'frontend_git_commit', { request }, (value) =>
				copyBinaryResponse(value, MAX_COMMAND_BYTES, 'commit')
			);
		},
		userName(workspaceId) {
			return call(invokeCommand, 'frontend_git_user_name', workspaceRequest(workspaceId), parseUserName);
		}
	});
}

/** Return no adapter outside the official Tauri runtime; there is no fake host. */
export function tauriGitAdapter() {
	if (typeof window === 'undefined' || !isTauri()) return null;
	return createTauriGitAdapter((command, args) => invoke(command, args));
}
