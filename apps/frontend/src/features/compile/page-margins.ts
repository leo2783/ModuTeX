import type { LineEnding, SourcePatch } from '../document-core/core.ts';

export interface PageMarginsCm {
	readonly top: number;
	readonly bottom: number;
	readonly left: number;
	readonly right: number;
}

export interface PageMarginsReading {
	readonly margins: PageMarginsCm;
	readonly explicit: boolean;
	readonly explicitSides: Readonly<Record<keyof PageMarginsCm, boolean>>;
}

interface OptionBlock {
	readonly from: number;
	readonly to: number;
	readonly command: string;
	readonly after: number;
}

interface Group {
	readonly from: number;
	readonly to: number;
	readonly end: number;
}

interface GeometrySource {
	readonly blocks: readonly OptionBlock[];
	readonly geometryPackage: { readonly brace: number; readonly options: OptionBlock | null } | null;
	readonly documentClassLineEnd: number;
	readonly geometryCommand: boolean;
}

const DEFAULT_MARGINS: PageMarginsCm = Object.freeze({ top: 2, bottom: 2, left: 2, right: 2 });
const SIDE_KEYS = new Set(['top', 'bottom', 'left', 'right']);
const MARGIN_KEYS = new Set(['margin', 'hmargin', 'vmargin', 'top', 'bottom', 'left', 'right']);
const MAX_SOURCE_CHARS = 5 * 1024 * 1024;
const UNSUPPORTED_LAYOUT_KEYS = new Set([
	'total', 'scale', 'hscale', 'vscale', 'text', 'textwidth', 'textheight', 'width', 'height',
	'layout', 'layoutwidth', 'layoutheight', 'marginratio', 'hmarginratio', 'vmarginratio', 'centering',
	'inner', 'outer', 'twoside', 'bindingoffset', 'asymmetric', 'reset', 'pass', 'ignoreall'
]);

function unsupported(): never {
	throw new Error('GEOMETRY_UNSUPPORTED');
}

function maskComments(source: string): string {
	const chars = source.split('');
	let slashCount = 0;
	for (let index = 0; index < chars.length; index++) {
		const char = chars[index]!;
		if (char === '%' && slashCount % 2 === 0) {
			while (index < chars.length && chars[index] !== '\n' && chars[index] !== '\r') {
				chars[index] = ' ';
				index++;
			}
			if (index < chars.length) {
				if (chars[index] === '\r' && chars[index + 1] === '\n') index++;
				slashCount = 0;
			}
			continue;
		}
		slashCount = char === '\\' ? slashCount + 1 : 0;
	}
	return chars.join('');
}

function isLetter(char: string | undefined): boolean {
	return char !== undefined && /[A-Za-z@]/.test(char);
}

function controlWord(source: string, index: number, end: number): { readonly name: string; readonly end: number } | null {
	if (source[index] !== '\\' || index + 1 >= end || !isLetter(source[index + 1])) return null;
	let next = index + 2;
	while (next < end && isLetter(source[next])) next++;
	return { name: source.slice(index + 1, next), end: next };
}

function skipSpace(source: string, index: number, end: number): number {
	while (index < end && /\s/.test(source[index]!)) index++;
	return index;
}

function readDelimited(source: string, index: number, end: number, open: string, close: string): Group | null {
	if (source[index] !== open) return null;
	let depth = 0;
	let braces = 0;
	for (let cursor = index; cursor < end; cursor++) {
		const char = source[cursor]!;
		if (char === '\\') { cursor++; continue; }
		if (char === '{') { braces++; continue; }
		if (char === '}' && braces > 0) { braces--; continue; }
		if (braces > 0) continue;
		if (char === open) depth++;
		else if (char === close && --depth === 0) return { from: index + 1, to: cursor, end: cursor + 1 };
	}
	return null;
}

function readBraceGroup(source: string, index: number, end: number): Group | null {
	if (source[index] !== '{') return null;
	let depth = 0;
	for (let cursor = index; cursor < end; cursor++) {
		const char = source[cursor]!;
		if (char === '\\') { cursor++; continue; }
		if (char === '{') depth++;
		else if (char === '}' && --depth === 0) return { from: index + 1, to: cursor, end: cursor + 1 };
	}
	return null;
}

function commandPosition(source: string, name: string, start: number, end: number): number {
	for (let index = start; index < end;) {
		if (source[index] !== '\\') { index++; continue; }
		const word = controlWord(source, index, end);
		if (word) {
			if (word.name === name) return index;
			index = word.end;
		} else index += Math.min(2, end - index);
	}
	return -1;
}

function documentBeginPosition(source: string): number {
	for (let index = 0; index < source.length;) {
		if (source[index] !== '\\') { index++; continue; }
		const word = controlWord(source, index, source.length);
		if (!word) { index += Math.min(2, source.length - index); continue; }
		if (word.name === 'begin') {
			const open = skipSpace(source, word.end, source.length);
			const group = readBraceGroup(source, open, source.length);
			if (group && source.slice(group.from, group.to).trim() === 'document') return index;
			index = group?.end ?? word.end;
		} else index = word.end;
	}
	return -1;
}

function optionSegments(source: string, from: number, to: number): { readonly from: number; readonly to: number }[] {
	const segments: { from: number; to: number }[] = [];
	let braces = 0;
	let brackets = 0;
	let start = from;
	for (let index = from; index < to; index++) {
		const char = source[index]!;
		if (char === '\\') { index++; continue; }
		if (char === '{') braces++;
		else if (char === '}' && braces > 0) braces--;
		else if (braces === 0 && char === '[') brackets++;
		else if (braces === 0 && char === ']' && brackets > 0) brackets--;
		else if (char === ',' && braces === 0 && brackets === 0) {
			segments.push({ from: start, to: index });
			start = index + 1;
		}
	}
	if (braces !== 0 || brackets !== 0) unsupported();
	segments.push({ from: start, to });
	return segments;
}

function findTopLevelEquals(value: string): number {
	let braces = 0;
	for (let index = 0; index < value.length; index++) {
		const char = value[index]!;
		if (char === '\\') { index++; continue; }
		if (char === '{') braces++;
		else if (char === '}' && braces > 0) braces--;
		else if (char === '=' && braces === 0) return index;
	}
	return -1;
}

function packageNames(value: string): string[] {
	if (value.includes('\\')) unsupported();
	return value.split(',').map((name) => name.trim().toLowerCase()).filter(Boolean);
}

function lineEnd(source: string, offset: number): number {
	for (let index = offset; index < source.length; index++) {
		if (source[index] === '\n') return index + 1;
		if (source[index] === '\r') return index + (source[index + 1] === '\n' ? 2 : 1);
	}
	return source.length;
}

function collectGeometry(source: string, masked: string): GeometrySource {
	if (source.length > MAX_SOURCE_CHARS) throw new Error('SOURCE_TOO_LARGE');
	const begin = documentBeginPosition(masked);
	if (begin < 0) unsupported();
	const end = begin;
	const documentClass = commandPosition(masked, 'documentclass', 0, end);
	if (documentClass < 0) unsupported();
	const classWord = controlWord(masked, documentClass, end)!;
	let classCursor = skipSpace(masked, classWord.end, end);
	const classOptions = readDelimited(masked, classCursor, end, '[', ']');
	if (classOptions) classCursor = skipSpace(masked, classOptions.end, end);
	const classGroup = readBraceGroup(masked, classCursor, end);
	if (!classGroup) unsupported();
	const blocks: OptionBlock[] = [];
	let geometryPackage: GeometrySource['geometryPackage'] = null;
	let geometryCommand = false;
	for (let index = 0; index < end;) {
		if (masked[index] !== '\\') { index++; continue; }
		const word = controlWord(masked, index, end);
		if (!word) { index += Math.min(2, end - index); continue; }
		if (word.name === 'restoregeometry' || word.name === 'loadgeometry') unsupported();
		let cursor = skipSpace(masked, word.end, end);
		if (word.name === 'usepackage' || word.name === 'RequirePackage') {
			const options = readDelimited(masked, cursor, end, '[', ']');
			if (masked[cursor] === '[' && !options) unsupported();
			if (options) cursor = skipSpace(masked, options.end, end);
			const group = readBraceGroup(masked, cursor, end);
			if (!group) unsupported();
			const names = packageNames(masked.slice(group.from, group.to));
			if (names.includes('geometry')) {
				if (names.length !== 1 || geometryPackage) unsupported();
				geometryPackage = { brace: cursor, options: options ? { from: options.from, to: options.to, command: word.name, after: group.end } : null };
				if (options) blocks.push({ from: options.from, to: options.to, command: word.name, after: group.end });
			}
			index = group.end;
			continue;
		} else if (word.name === 'PassOptionsToPackage') {
			const first = readBraceGroup(masked, cursor, end);
			if (!first) unsupported();
			const packageOpen = skipSpace(masked, first.end, end);
			const second = readBraceGroup(masked, packageOpen, end);
			if (!second) unsupported();
			const names = packageNames(masked.slice(second.from, second.to));
			if (names.includes('geometry')) {
				if (names.length !== 1) unsupported();
				if (geometryPackage) unsupported();
				blocks.push({ from: first.from, to: first.to, command: word.name, after: second.end });
				index = second.end;
				continue;
			}
		} else if (word.name === 'geometry' || word.name === 'newgeometry') {
			const group = readBraceGroup(masked, cursor, end);
			if (!group) unsupported();
			geometryCommand = true;
			blocks.push({ from: group.from, to: group.to, command: word.name, after: group.end });
			index = group.end;
			continue;
		}
		index = word.end;
	}
	return {
		blocks: blocks.sort((a, b) => a.from - b.from),
		geometryPackage,
		documentClassLineEnd: lineEnd(source, classGroup.end),
		geometryCommand
	};
}

function dimensionCm(value: string): number {
	let dimension = value.trim();
	if (dimension.startsWith('{') && dimension.endsWith('}')) dimension = dimension.slice(1, -1).trim();
	const match = /^\s*([+]?(?:\d+(?:\.\d*)?|\.\d+))\s*(cm|mm|in|pt|bp|pc)\s*$/i.exec(dimension);
	if (!match) unsupported();
	const magnitude = Number(match[1]);
	const unit = match[2]!.toLowerCase();
	const factor = unit === 'cm' ? 1 : unit === 'mm' ? 0.1 : unit === 'in' ? 2.54
		: unit === 'pt' ? 2.54 / 72.27 : unit === 'bp' ? 2.54 / 72 : 12 * 2.54 / 72.27;
	const cm = magnitude * factor;
	if (!Number.isFinite(cm) || cm <= 0 || cm > 50) unsupported();
	return cm;
}

function readOptionBlock(source: string, block: OptionBlock, margins: { top: number; bottom: number; left: number; right: number }, known: Set<string>) {
	for (const entry of optionSegments(source, block.from, block.to).map((segment) => source.slice(segment.from, segment.to))) {
		const clean = entry.trim();
		if (!clean) continue;
		if (clean.includes('\\')) unsupported();
		const equal = findTopLevelEquals(clean);
		if (equal < 0) {
			if (clean.includes('\\') || UNSUPPORTED_LAYOUT_KEYS.has(clean.toLowerCase())) unsupported();
			continue;
		}
		const key = clean.slice(0, equal).trim().toLowerCase();
		const value = clean.slice(equal + 1).trim();
		if (value.includes('\\') || value.includes('%')) unsupported();
		if (UNSUPPORTED_LAYOUT_KEYS.has(key)) unsupported();
		if (key === 'margin') {
			const cm = dimensionCm(value);
			margins.top = cm; margins.bottom = cm; margins.left = cm; margins.right = cm;
			for (const side of SIDE_KEYS) known.add(side);
		} else if (key === 'hmargin' || key === 'vmargin') {
			const cm = dimensionCm(value);
			const sides = key === 'hmargin' ? ['left', 'right'] : ['top', 'bottom'];
			for (const side of sides) { margins[side as keyof typeof margins] = cm; known.add(side); }
		} else if (SIDE_KEYS.has(key)) {
			margins[key as keyof typeof margins] = dimensionCm(value);
			known.add(key);
		}
	}
}

function formattedCm(value: number): string {
	if (!Number.isFinite(value) || value <= 0 || value > 50) throw new Error('INVALID_PAGE_MARGIN');
	return String(Number(value.toFixed(4)));
}

function marginOptions(margins: PageMarginsCm): string {
	return `top=${formattedCm(margins.top)}cm,bottom=${formattedCm(margins.bottom)}cm,left=${formattedCm(margins.left)}cm,right=${formattedCm(margins.right)}cm`;
}

export function readPageMargins(source: string): PageMarginsReading {
	if (source.length > MAX_SOURCE_CHARS) throw new Error('SOURCE_TOO_LARGE');
	const masked = maskComments(source);
	const geometry = collectGeometry(source, masked);
	const margins = { ...DEFAULT_MARGINS };
	const known = new Set<string>();
	for (const block of geometry.blocks) readOptionBlock(masked, block, margins, known);
	const explicitSides = Object.freeze({
		top: known.has('top'), bottom: known.has('bottom'), left: known.has('left'), right: known.has('right')
	});
	return Object.freeze({ margins: Object.freeze(margins), explicit: known.size === 4, explicitSides });
}

function updatedOptionBlock(source: string, masked: string, block: OptionBlock, appendMargins: boolean, options: string): string {
	const segments = optionSegments(masked, block.from, block.to);
	const retained = segments.filter((segment) => {
		const entry = masked.slice(segment.from, segment.to).trim();
		const equal = findTopLevelEquals(entry);
		const key = equal < 0 ? '' : entry.slice(0, equal).trim().toLowerCase();
		return !MARGIN_KEYS.has(key);
	});
	let value = retained.map((segment) => source.slice(segment.from, segment.to)).join(',');
	if (appendMargins) {
		const retainedText = retained.map((segment) => masked.slice(segment.from, segment.to).trim()).filter(Boolean).join(',');
		const separator = retainedText.length === 0 || value.trimEnd().endsWith(',') ? '' : ',';
		value += `${separator}${options}`;
	}
	return value;
}

export function planPageMarginPatches(source: string, margins: PageMarginsCm, lineEnding?: LineEnding): readonly SourcePatch[] {
	if (source.length > MAX_SOURCE_CHARS) throw new Error('SOURCE_TOO_LARGE');
	const masked = maskComments(source);
	const geometry = collectGeometry(source, masked);
	const inspected = { ...DEFAULT_MARGINS };
	const known = new Set<string>();
	for (const block of geometry.blocks) readOptionBlock(masked, block, inspected, known);
	const options = marginOptions(margins);
	const last = geometry.blocks.at(-1);
	if (last) {
		const patches: SourcePatch[] = [];
		for (const block of geometry.blocks) {
			const insert = updatedOptionBlock(source, masked, block, block === last, options);
			const original = source.slice(block.from, block.to);
			if (insert !== original) patches.push({ from: block.from, to: block.to, insert, expected: original });
		}
		if (!geometry.geometryPackage && last.command === 'PassOptionsToPackage' && !geometry.geometryCommand) {
			const newline = lineEnding ?? source.match(/\r\n|\n|\r/)?.[0] ?? '\n';
			patches.push({ from: last.after, to: last.after, insert: `${newline}\\usepackage{geometry}`, expected: '' });
		}
		return Object.freeze(patches.sort((a, b) => a.from - b.from));
	}
	if (geometry.geometryPackage) {
		const at = geometry.geometryPackage.brace;
		return Object.freeze([{ from: at, to: at, insert: `[${options}]`, expected: '' }]);
	}
	if (geometry.geometryCommand) {
		const newline = lineEnding ?? source.match(/\r\n|\n|\r/)?.[0] ?? '\n';
		return Object.freeze([{ from: geometry.documentClassLineEnd, to: geometry.documentClassLineEnd,
			insert: `\\usepackage[${options}]{geometry}${newline}`, expected: '' }]);
	}
	const newline = lineEnding ?? source.match(/\r\n|\n|\r/)?.[0] ?? '\n';
	return Object.freeze([{ from: geometry.documentClassLineEnd, to: geometry.documentClassLineEnd,
		insert: `\\usepackage[${options}]{geometry}${newline}`, expected: '' }]);
}
