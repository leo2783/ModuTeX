import { describe, expect, it } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { history, redo, undo } from 'prosemirror-history';
import { schema } from '$lib/schema/schema';
import {
	clearQueuedOwnedPromptIds,
	consumeOwnedPromptIds,
	ownMathLiveTemplate,
	pendingOwnedPromptIds,
	queueOwnedPromptIds,
	stripOwnedPromptCommands
} from '$lib/editor/extensions/mathlivebridge/owned-prompt-output';

describe('owned MathLive prompt output', () => {
	it('gives each template cell a distinct explicit prompt id', () => {
		const template = ownMathLiveTemplate('\\begin{pmatrix}#?&#?\\end{pmatrix}');

		expect(template.promptIds).toHaveLength(2);
		expect(new Set(template.promptIds).size).toBe(2);
		expect(template.latex).toBe(
			`\\begin{pmatrix}\\placeholder[${template.promptIds[0]}]{}&\\placeholder[${template.promptIds[1]}]{}\\end{pmatrix}`
		);
	});

	it('claims only complete, exact prompt commands, not comments or lookalike control words', () => {
		const field = {};
		const [id] = ownMathLiveTemplate('#?').promptIds;
		queueOwnedPromptIds(field, [id]);

		expect(pendingOwnedPromptIds(field, `% \\placeholder[${id}]{}\n\\placeholderLike[${id}]{} \\\\placeholder[${id}]{} `)).toEqual([]);
		expect(pendingOwnedPromptIds(field, `\\placeholder[${id}]{}`)).toEqual([id]);
		expect(pendingOwnedPromptIds(field, `\\placeholder[${id}]{}`)).toEqual([id]);
		consumeOwnedPromptIds(field, [id]);
		expect(pendingOwnedPromptIds(field, `\\placeholder[${id}]{}`)).toEqual([]);
	});

	it('removes only an owned command and keeps its entered content', () => {
		const [id] = ownMathLiveTemplate('#?').promptIds;

		expect(stripOwnedPromptCommands(`x+\\placeholder[${id}]{a+1}`, [id])).toBe('x+{a+1}');
		expect(stripOwnedPromptCommands(`\\alpha\\placeholder[${id}]{}x`, [id])).toBe('\\alpha{}x');
		expect(stripOwnedPromptCommands(`x^\\placeholder[${id}]{a+b}`, [id])).toBe('x^{a+b}');
	});

	it('preserves unknown prompts, partial ids, escaped commands, and prompt-like names', () => {
		const [id] = ownMathLiveTemplate('#?').promptIds;
		const source = `\\placeholder{} \\placeholder[${id}-other]{} \\\\placeholder[${id}]{} \\placeholderLike[${id}]{} `;

		expect(stripOwnedPromptCommands(source, [id])).toBe(source);
		expect(stripOwnedPromptCommands(`\\placeholder[${id}]{} `, [])).toBe(`\\placeholder[${id}]{} `);
	});

	it('preserves deeply nested foreign prompts without recursive traversal', () => {
		const foreign = `${'\\placeholder[foreign]{'.repeat(240)}value${'}'.repeat(240)}`;
		const [id] = ownMathLiveTemplate('#?').promptIds;

		expect(stripOwnedPromptCommands(foreign, [id])).toBe(foreign);
	});

	it('fails closed for malformed runtime provenance attrs', () => {
		expect(stripOwnedPromptCommands('\\placeholder[owned]{}', 'owned' as unknown as string[])).toBe('\\placeholder[owned]{}');
	});

	it('parses nested groups, escaped braces, and comments without stripping comment text', () => {
		const [id] = ownMathLiveTemplate('#?').promptIds;
		const source = `\\placeholder[${id}]{\\text{a \\{b\\}}% } is comment text\n+c}`;

		expect(stripOwnedPromptCommands(source, [id])).toBe('{\\text{a \\{b\\}}% } is comment text\n+c}');
	});

	it('preserves malformed owned commands byte-for-byte', () => {
		const [id] = ownMathLiveTemplate('#?').promptIds;
		const malformed = `\\placeholder[${id}]{unclosed \\placeholder[${id}]{}`;

		expect(stripOwnedPromptCommands(malformed, [id])).toBe(malformed);
	});

	it('clears queued provenance when an insertion is rejected', () => {
		const field = {};
		const [id] = ownMathLiveTemplate('#?').promptIds;
		queueOwnedPromptIds(field, [id]);
		clearQueuedOwnedPromptIds(field, [id]);

		expect(pendingOwnedPromptIds(field, `\\placeholder[${id}]{} `)).toEqual([]);
	});

	it('undo and redo preserve the prompt text and provenance as one PM node change', () => {
		const id = 'modutex-history-prompt';
		const initial = EditorState.create({
			schema,
			doc: schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, schema.text('x'))),
			plugins: [history()]
		});
		const prompt = schema.nodes.inline_math.create({ ownedPromptIds: [id] }, schema.text(`\\placeholder[${id}]{}`));
		const inserted = initial.apply(initial.tr.replaceWith(1, 2, prompt));

		let undone = inserted;
		expect(undo(inserted, (tr) => (undone = inserted.apply(tr)))).toBe(true);
		expect(undone.doc.textContent).toBe('x');

		let redone = undone;
		expect(redo(undone, (tr) => (redone = undone.apply(tr)))).toBe(true);
		const redonePrompt = redone.doc.nodeAt(1);
		expect(redonePrompt?.textContent).toBe(`\\placeholder[${id}]{}`);
		expect(redonePrompt?.attrs.ownedPromptIds).toEqual([id]);
	});
});
