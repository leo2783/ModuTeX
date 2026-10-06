export type LatexPackagePatch =
	| { kind: 'already-present'; packageName: string; result: string }
	| { kind: 'insert'; packageName: string; offset: number; text: string; result: string };

const PACKAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function lineEndingOf(source: string): '\r\n' | '\n' {
	return source.includes('\r\n') ? '\r\n' : '\n';
}

/** Mask comments with spaces so every source offset remains stable. */
function maskComments(source: string): string {
	const chars = source.split('');
	for (let i = 0; i < chars.length; i++) {
		if (chars[i] !== '%') continue;
		let slashes = 0;
		for (let j = i - 1; j >= 0 && chars[j] === '\\'; j--) slashes++;
		if (slashes % 2 === 1) continue;
		for (let j = i; j < chars.length && chars[j] !== '\n'; j++) chars[j] = ' ';
	}
	return chars.join('');
}

interface PackageDeclaration {
	end: number;
	packages: string[];
}

interface LiteralPreamble {
	safe: boolean;
	begin: number;
	declarations: PackageDeclaration[];
}

/** Return the active document boundary only when this file has a literal, safely editable preamble. */
export function getEditableLatexPreambleEnd(source: string): number {
	const preamble = literalPreamble(maskComments(source));
	if (!preamble.safe || preamble.begin === -1) {
		throw new Error('Cannot edit an unrecognized or unsafe LaTeX preamble');
	}
	return preamble.begin;
}

/** Not a TeX interpreter: recognize only literal declarations and deferred macro definitions.
 * Unknown execution, conditionals, catcode/alias changes and malformed groups fail closed. */
function literalPreamble(masked: string): LiteralPreamble {
	const result: LiteralPreamble = { safe: true, begin: -1, declarations: [] };
	let cursor = masked.charCodeAt(0) === 0xfeff ? 1 : 0;
	const spaces = () => {
		while (/\s/.test(masked[cursor] ?? '') && cursor < masked.length) cursor++;
	};
	const command = (): string | null => {
		if (masked[cursor] !== '\\') return null;
		const match = /^\\([A-Za-z]+)(?![A-Za-z@])/.exec(masked.slice(cursor));
		if (!match) return null;
		cursor += match[0].length;
		return match[1];
	};
	const group = (): string | null => {
		spaces();
		if (masked[cursor] !== '{') return null;
		const start = ++cursor;
		let depth = 1;
		while (cursor < masked.length) {
			const char = masked[cursor++];
			if (char === '\\') {
				// Escaped braces and control symbols do not alter group nesting.
				if (/[A-Za-z]/.test(masked[cursor] ?? '')) while (/[A-Za-z]/.test(masked[cursor] ?? '') && cursor < masked.length) cursor++;
				else if (cursor < masked.length) cursor++;
			} else if (char === '{') {
				if (++depth > 64) return null;
			} else if (char === '}' && --depth === 0) return masked.slice(start, cursor - 1);
		}
		return null;
	};
	const option = (): string | null => {
		spaces();
		if (masked[cursor] !== '[') return '';
		const end = masked.indexOf(']', cursor + 1);
		if (end < 0) return null;
		const value = masked.slice(cursor + 1, end);
		if (/[\\{}[\r\n]/.test(value)) return null;
		cursor = end + 1;
		return value;
	};
	const definitions = new Set(['newcommand', 'renewcommand', 'providecommand', 'DeclareRobustCommand']);
	const protectedCommands = new Set([
		'begin',
		'end',
		'document',
		'enddocument',
		'documentclass',
		'usepackage',
		'RequirePackage',
		'def',
		'gdef',
		...definitions
	]);
	while (cursor < masked.length) {
		spaces();
		if (cursor === masked.length) break;
		const at = cursor;
		const name = command();
		if (!name) {
			result.safe = false;
			break;
		}
		if (name === 'begin') {
			if (group() !== 'document') result.safe = false;
			else result.begin = at;
			break;
		}
		if (name === 'documentclass' || name === 'usepackage' || name === 'RequirePackage') {
			const opts = option();
			const value = opts === null ? null : group();
			const names = value?.split(',').map((part) => part.trim()) ?? [];
			if (!names.length || names.some((part) => !PACKAGE_NAME.test(part)) || (name === 'documentclass' && names.length !== 1)) {
				result.safe = false;
				break;
			}
			if (name !== 'documentclass') result.declarations.push({ end: cursor, packages: names });
			continue;
		}
		if (definitions.has(name) || name === 'def' || name === 'gdef') {
			if (definitions.has(name) && masked[cursor] === '*') cursor++;
			spaces();
			let target: string | null;
			if (definitions.has(name) && masked[cursor] === '{') {
				const value = group();
				target = value === null ? null : (/^\\([A-Za-z]+)$/.exec(value.trim())?.[1] ?? null);
			} else target = command();
			if (!target || protectedCommands.has(target) || target.startsWith('if')) {
				result.safe = false;
				break;
			}
			if (definitions.has(name)) {
				const args = option();
				if (args === null || (args !== '' && !/^[0-9]$/.test(args))) {
					result.safe = false;
					break;
				}
				spaces();
				if (masked[cursor] === '[' && (args === '' || args === '0' || option() === null)) {
					result.safe = false;
					break;
				}
			} else {
				spaces();
				while (masked[cursor] === '#' && /^[1-9]$/.test(masked[cursor + 1] ?? '')) {
					cursor += 2;
					spaces();
				}
			}
			if (group() === null) {
				result.safe = false;
				break;
			}
			continue;
		}
		// Includes all if*/else/fi/newif, macro calls, input, csname, let and catcode changes.
		result.safe = false;
		break;
	}
	return result;
}

export function hasLatexPackage(source: string, packageName: string): boolean {
	const preamble = literalPreamble(maskComments(source));
	return preamble.safe && preamble.declarations.some((declaration) => declaration.packages.includes(packageName));
}

/** Return one insertion splice; no existing preamble byte is regenerated or reordered. */
export function addLatexPackage(source: string, packageName: string): LatexPackagePatch {
	if (!PACKAGE_NAME.test(packageName)) throw new Error('Invalid LaTeX package name');
	const masked = maskComments(source);
	const preamble = literalPreamble(masked);
	if (!preamble.safe) throw new Error('Cannot insert a package into an unrecognized or unsafe LaTeX preamble');
	const declarations = preamble.declarations;
	if (declarations.some((declaration) => declaration.packages.includes(packageName))) {
		return { kind: 'already-present', packageName, result: source };
	}

	const begin = preamble.begin;
	if (begin === -1) throw new Error('Cannot insert a package without an active \\begin{document}');
	const eol = lineEndingOf(source);
	const last = declarations.at(-1);
	let offset: number;
	let text: string;

	if (last) {
		const newline = source.indexOf('\n', last.end);
		if (newline !== -1 && newline < begin && !masked.slice(last.end, newline).trim()) {
			offset = newline + 1;
			text = `\\usepackage{${packageName}}${eol}`;
		} else {
			offset = begin;
			text = `${eol}\\usepackage{${packageName}}${eol}`;
		}
	} else {
		offset = begin;
		const needsLeadingEol = offset > 0 && source[offset - 1] !== '\n';
		text = `${needsLeadingEol ? eol : ''}\\usepackage{${packageName}}${eol}`;
	}

	return { kind: 'insert', packageName, offset, text, result: source.slice(0, offset) + text + source.slice(offset) };
}
