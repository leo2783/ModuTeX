// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from '$lib/schema/schema';
import { registerDiagramRequester, requestDiagramForView } from '$lib/editor/extensions/blockInsertItems';

const views: EditorView[] = [];

function makeView(doc = schema.topNodeType.createAndFill()!): EditorView {
	const view = new EditorView(document.body.appendChild(document.createElement('div')), {
		state: EditorState.create({ schema, doc })
	});
	views.push(view);
	return view;
}

function imageFigure(): PMNode {
	return schema.nodes.image.create({
		src: 'assets/diagrams/flow-123e4567-e89b-42d3-a456-426614174000.pdf',
		diagramType: 'drawio',
		diagramId: '123e4567-e89b-42d3-a456-426614174000',
		diagramSource: 'assets/diagrams/flow-123e4567-e89b-42d3-a456-426614174000.drawio'
	});
}

afterEach(() => {
	for (const view of views.splice(0)) if (!view.isDestroyed) view.destroy();
	for (const element of [...document.body.children]) element.remove();
});

describe('per-view diagram requester', () => {
	it('routes each request only to the opener registered for that exact EditorView', () => {
		const firstView = makeView();
		const secondView = makeView();
		const first = vi.fn();
		const second = vi.fn();
		registerDiagramRequester(firstView, first);
		registerDiagramRequester(secondView, second);

		expect(requestDiagramForView(firstView, 'drawio', 0, 'after')).toBe(true);
		expect(requestDiagramForView(secondView, 'drawio', 0, 'after')).toBe(true);
		expect(first).toHaveBeenCalledTimes(1);
		expect(first).toHaveBeenCalledWith('drawio', expect.objectContaining({ state: firstView.state, targetPos: 0, placement: 'after' }));
		expect(second).toHaveBeenCalledTimes(1);
		expect(second).toHaveBeenCalledWith('drawio', expect.objectContaining({ state: secondView.state, targetPos: 0, placement: 'after' }));
	});

	it('only removes the callback it registered, so stale cleanup cannot remove its replacement', () => {
		const view = makeView();
		const first = vi.fn();
		const replacement = vi.fn();
		const disposeFirst = registerDiagramRequester(view, first);
		const disposeReplacement = registerDiagramRequester(view, replacement);
		disposeFirst();

		expect(requestDiagramForView(view, 'drawio', 0)).toBe(true);
		expect(first).not.toHaveBeenCalled();
		expect(replacement).toHaveBeenCalledTimes(1);
		disposeReplacement();
		expect(requestDiagramForView(view, 'drawio', 0)).toBe(false);
	});

	it('requires the current exact node identity when reopening an existing figure', () => {
		const existing = imageFigure();
		const view = makeView(schema.topNodeType.create(null, [existing]));
		const callback = vi.fn();
		registerDiagramRequester(view, callback);
		const equalButDifferent = imageFigure();
		expect(equalButDifferent).not.toBe(existing);
		expect(equalButDifferent.eq(existing)).toBe(true);
		expect(requestDiagramForView(view, 'drawio', 0, 'replace', equalButDifferent)).toBe(false);
		expect(callback).not.toHaveBeenCalled();

		const replacement = imageFigure();
		view.updateState(EditorState.create({ schema, doc: schema.topNodeType.create(null, [replacement]) }));
		expect(requestDiagramForView(view, 'drawio', 0, 'replace', existing)).toBe(false);
		expect(callback).not.toHaveBeenCalled();
	});

	it('does not dispatch after the view has been destroyed or detached', () => {
		const view = makeView();
		const callback = vi.fn();
		registerDiagramRequester(view, callback);
		view.dom.remove();
		expect(requestDiagramForView(view, 'drawio', 0)).toBe(false);
		expect(callback).not.toHaveBeenCalled();

		const destroyedView = makeView();
		const destroyedCallback = vi.fn();
		registerDiagramRequester(destroyedView, destroyedCallback);
		destroyedView.destroy();
		views.splice(views.indexOf(destroyedView), 1);
		expect(requestDiagramForView(destroyedView, 'drawio', 0)).toBe(false);
		expect(callback).not.toHaveBeenCalled();
		expect(destroyedCallback).not.toHaveBeenCalled();
	});
});
