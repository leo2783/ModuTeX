/**
 * App-owned MathLive prompt provenance.
 *
 * MathLive's `#?` template marker serializes as `\placeholder{}`, which is not TeX. New prompts
 * therefore receive explicit, unique IDs. Only IDs copied into a ProseMirror math node's attrs may
 * have their prompt wrapper converted to a TeX group by the LaTeX serializer; imported or otherwise
 * unknown placeholder commands remain untouched.
 */

export interface OwnedPromptTemplate {
	latex: string;
	promptIds: string[];
}

const pendingPromptIds = new WeakMap<object, Set<string>>();
const PROMPT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const PLACEHOLDER_COMMAND = '\\placeholder';
let fallbackSequence = 0;

function newPromptId(index: number): string {
	const uuid = globalThis.crypto?.randomUUID?.();
	const random =
		uuid?.replaceAll('-', '') ?? `${Date.now().toString(36)}${(++fallbackSequence).toString(36)}${Math.random().toString(36).slice(2)}`;
	return `modutex-${random}-${index.toString(36)}`;
}

/** Create a MathLive template whose empty `#?` cells have traceable, per-insertion IDs. */
export function ownMathLiveTemplate(latexTemplate: string): OwnedPromptTemplate {
	const promptIds: string[] = [];
	const latex = latexTemplate.replace(/#\?/g, () => {
		const id = newPromptId(promptIds.length);
		promptIds.push(id);
		return `\\placeholder[${id}]{}`;
	});
	return { latex, promptIds };
}

/** Mark IDs before MathLive's synchronous input event so text and provenance can share one PM step. */
export function queueOwnedPromptIds(field: object, promptIds: readonly string[]): void {
	const current = pendingPromptIds.get(field) ?? new Set<string>();
	for (const id of promptIds) {
		if (PROMPT_ID.test(id)) current.add(id);
	}
	if (current.size > 0) pendingPromptIds.set(field, current);
}

/** Peek queued IDs present as complete prompt commands; consumption waits for PM dispatch acceptance. */
export function pendingOwnedPromptIds(field: object, latex: string): string[] {
	const queued = pendingPromptIds.get(field);
	if (!queued) return [];
	const claimed: string[] = [];
	for (const id of queued) {
		if (containsOwnedPrompt(latex, id)) {
			claimed.push(id);
		}
	}
	return claimed;
}

/** Consume only after the matching text+attrs transaction is visible in the PM document. */
export function consumeOwnedPromptIds(field: object, promptIds: readonly string[]): void {
	const queued = pendingPromptIds.get(field);
	if (!queued) return;
	for (const id of promptIds) queued.delete(id);
	if (queued.size === 0) pendingPromptIds.delete(field);
}

/** Drop IDs when an insertion is rejected or throws, so a later unrelated input cannot claim them. */
export function clearQueuedOwnedPromptIds(field: object, promptIds: readonly string[]): void {
	const queued = pendingPromptIds.get(field);
	if (!queued) return;
	for (const id of promptIds) queued.delete(id);
	if (queued.size === 0) pendingPromptIds.delete(field);
}

/**
 * Replace only complete prompt commands whose exact IDs are carried by the math node's provenance
 * attrs. Their content remains grouped to preserve TeX binding. The scanner is iterative so deeply
 * nested foreign prompts cannot exhaust the JavaScript call stack.
 */
export function stripOwnedPromptCommands(latex: string, ownedPromptIds: readonly string[] | null | undefined): string {
	const attrs = Array.isArray(ownedPromptIds) ? ownedPromptIds : [];
	const owned = new Set(attrs.filter((id): id is string => typeof id === 'string' && PROMPT_ID.test(id)));
	if (owned.size === 0) return latex;
	return stripOwnedCommands(latex, owned);
}

interface StripFrame {
	source: string;
	cursor: number;
	index: number;
	output: string;
	closingGroup: string;
	resumeAt: number;
}

function stripOwnedCommands(latex: string, owned: ReadonlySet<string>): string {
	const stack: StripFrame[] = [{ source: latex, cursor: 0, index: 0, output: '', closingGroup: '', resumeAt: 0 }];
	let result = '';
	while (stack.length > 0) {
		const frame = stack[stack.length - 1];
		if (frame.index >= frame.source.length) {
			const completed = frame.output + frame.source.slice(frame.cursor) + frame.closingGroup;
			stack.pop();
			if (stack.length > 0) {
				const parent = stack[stack.length - 1];
				parent.output += completed;
				parent.cursor = frame.resumeAt;
				parent.index = frame.resumeAt;
			} else {
				result = completed;
			}
			continue;
		}

		if (frame.source[frame.index] === '%') {
			frame.index = skipComment(frame.source, frame.index);
			continue;
		}
		if (frame.source[frame.index] !== '\\') {
			frame.index++;
			continue;
		}

		const commandAt = frame.index++;
		const nameStart = frame.index;
		if (isControlWordChar(frame.source[frame.index] ?? '')) {
			while (frame.index < frame.source.length && isControlWordChar(frame.source[frame.index])) frame.index++;
		} else {
			frame.index++;
			continue;
		}
		if (frame.source.slice(nameStart, frame.index) !== PLACEHOLDER_COMMAND.slice(1)) continue;

		const idOpen = frame.index;
		if (frame.source[idOpen] !== '[') continue;
		const idEnd = frame.source.indexOf(']', idOpen + 1);
		if (idEnd < 0) {
			frame.output += frame.source.slice(frame.cursor);
			frame.cursor = frame.source.length;
			frame.index = frame.source.length;
			continue;
		}
		const id = frame.source.slice(idOpen + 1, idEnd);
		const bodyOpen = idEnd + 1;
		if (frame.source[bodyOpen] !== '{') {
			frame.output += frame.source.slice(frame.cursor);
			frame.cursor = frame.source.length;
			frame.index = frame.source.length;
			continue;
		}
		const bodyClose = matchingBrace(frame.source, bodyOpen);
		if (bodyClose < 0) {
			frame.output += frame.source.slice(frame.cursor);
			frame.cursor = frame.source.length;
			frame.index = frame.source.length;
			continue;
		}

		if (owned.has(id)) {
			// Keep a TeX group around content so control words and superscript/subscript arguments
			// cannot run into adjacent source or change precedence.
			frame.output += frame.source.slice(frame.cursor, commandAt) + '{';
		} else {
			frame.output += frame.source.slice(frame.cursor, bodyOpen + 1);
		}
		frame.cursor = bodyClose + 1;
		frame.index = bodyClose + 1;
		stack.push({
			source: frame.source.slice(bodyOpen + 1, bodyClose),
			cursor: 0,
			index: 0,
			output: '',
			closingGroup: '}',
			resumeAt: bodyClose + 1
		});
	}
	return result;
}

function containsOwnedPrompt(latex: string, id: string): boolean {
	let index = 0;
	while (index < latex.length) {
		if (latex[index] === '%') {
			index = skipComment(latex, index);
			continue;
		}
		if (latex[index] !== '\\') {
			index++;
			continue;
		}

		index++;
		const nameStart = index;
		if (isControlWordChar(latex[index] ?? '')) {
			while (index < latex.length && isControlWordChar(latex[index])) index++;
		} else {
			index++;
			continue;
		}
		if (latex.slice(nameStart, index) !== PLACEHOLDER_COMMAND.slice(1) || latex[index] !== '[') continue;
		const idEnd = latex.indexOf(']', index + 1);
		if (idEnd < 0) continue;
		const bodyOpen = idEnd + 1;
		if (latex.slice(index + 1, idEnd) === id && latex[bodyOpen] === '{' && matchingBrace(latex, bodyOpen) >= 0) return true;
	}
	return false;
}

function isControlWordChar(char: string): boolean {
	return /[A-Za-z@]/.test(char);
}

function skipComment(source: string, start: number): number {
	let index = start + 1;
	while (index < source.length && source[index] !== '\n' && source[index] !== '\r') index++;
	return index;
}

function matchingBrace(source: string, opening: number): number {
	let depth = 0;
	for (let index = opening; index < source.length; index++) {
		const char = source[index];
		if (char === '%') {
			let slashCount = 0;
			for (let previous = index - 1; previous >= 0 && source[previous] === '\\'; previous--) slashCount++;
			if (slashCount % 2 === 0) {
				while (index < source.length && source[index] !== '\n' && source[index] !== '\r') index++;
				continue;
			}
		}
		if (char !== '{' && char !== '}') continue;
		let slashCount = 0;
		for (let previous = index - 1; previous >= 0 && source[previous] === '\\'; previous--) slashCount++;
		if (slashCount % 2 === 1) continue;
		if (char === '{') depth++;
		else if (--depth === 0) return index;
	}
	return -1;
}
