// Original integration code inside the existing AGPL host boundary.
import type { Diagnostic } from '@modutex/frontend-contracts' with { 'resolution-mode': 'import' };

type WorkspacePath =
	| { readonly kind: 'safe'; readonly path: string }
	| { readonly kind: 'unsafe' }
	| { readonly kind: 'invalid' };

const MAX_DIAGNOSTIC_PATH_LENGTH = 4096;

/** Canonicalize a logged path without allowing it to escape the workspace. */
function workspacePath(raw: string): WorkspacePath {
	if (raw.length > MAX_DIAGNOSTIC_PATH_LENGTH) return { kind: 'unsafe' };
	let value = raw;
	const first = value[0];
	const last = value[value.length - 1];
	if (first === '"' || first === "'") {
		if (value.length < 2 || last !== first) return { kind: 'invalid' };
		value = value.slice(1, -1);
	} else if (last === '"' || last === "'") return { kind: 'invalid' };
	if (!value) return { kind: 'invalid' };
	if (/[\u0000-\u001f\u007f]/.test(value)) return { kind: 'unsafe' };

	const separated = value.replaceAll('\\', '/');
	if (separated.startsWith('/') || separated.includes(':')) return { kind: 'unsafe' };
	const segments = separated.split('/');
	if (segments.some((segment) => segment === '..' || /^[A-Za-z]:/.test(segment))) return { kind: 'unsafe' };
	const normalized = segments.filter((segment) => segment !== '' && segment !== '.').join('/');
	if (!normalized) return { kind: 'invalid' };
	// Reject URI-like absolute locations as well as native absolute paths.
	if (/^[A-Za-z][A-Za-z0-9+.-]*:\//.test(normalized)) return { kind: 'unsafe' };
	return { kind: 'safe', path: normalized };
}

/** Only explicit Tectonic file:line[:column] errors; never guess an included file from XeTeX's unqualified l.N lines. */
export function frontendDiagnostics(log: string, entryPath: string): readonly Diagnostic[] {
	const entries: Diagnostic[] = [];
	const entry = workspacePath(entryPath);
	for (const line of log.slice(-256 * 1024).split(/\r?\n/)) {
		const match = /^error: (.+?):([0-9]+)(?::([0-9]+))?: (.+)$/.exec(line);
		if (!match) continue;
		const reportedLine = Number(match[2]);
		if (!Number.isSafeInteger(reportedLine) || reportedLine < 1) continue;
		const message = match[4]!;
		if (!message.trim()) continue;
		const reportedPath = workspacePath(match[1]!);
		if (reportedPath.kind === 'invalid') continue;
		const reportedColumn = match[3] === undefined ? null : Number(match[3]);
		const column = reportedColumn !== null && Number.isSafeInteger(reportedColumn) && reportedColumn > 0
			? reportedColumn : null;
		entries.push(Object.freeze({
			severity: 'error',
			message: message.slice(0, 512),
			// Keep an unsafe-path error visible without giving the renderer a path
			// that could be opened outside this workspace.
			path: entry.kind === 'safe' && reportedPath.kind === 'safe' ? reportedPath.path : null,
			line: reportedLine,
			column
		}));
		if (entries.length === 256) break;
	}
	return Object.freeze(entries);
}
