import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { TextSelection } from 'prosemirror-state';
import { SourceDocument, parseSource } from '../../src/features/document-core/core.ts';
import { VisualEditor } from '../../src/features/visual-editor/view.ts';
import { createSourceState, sourcePatchTransaction, sourceState, historyTransaction } from '../../src/features/source-editor/state.ts';
const { JSDOM } = createRequire(import.meta.url)('jsdom');

test('Enter closes and reopens format wrappers around a real line break, retains typing marks and exact undo', () => {
 const dom = new JSDOM('<!doctype html><body><div id="editor"></div></body>', {pretendToBeVisual:true});
 const previous = new Map<string, PropertyDescriptor | undefined>();
 for (const key of ['window', 'document', 'navigator', 'MutationObserver', 'Node', 'HTMLElement', 'getComputedStyle']) {
  previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, {configurable:true,writable:true,value:key === 'getComputedStyle' ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key]});
 }
 try {
  for (const paragraphMarker of ['', '\\par']) for (const [opening, closing] of [['', ''], ['\\textbf{\\textit{\\underline{', '}}}'], ['\\textcolor[HTML]{B42318}{\\textbf{', '}}']]) {
   const prefix = '\\begin{document}\r\n' + paragraphMarker, suffix = (paragraphMarker.endsWith('{') ? '}' : '') + '\r\n\\end{document}\r\n';
   const original = SourceDocument.open(new TextEncoder().encode('\ufeff' + prefix + opening + '你知道嗎' + closing + suffix));
   let state = createSourceState(original), readonly = false;
   const view = new VisualEditor(dom.window.document.getElementById('editor')!, 'main.tex', {
    source: () => state.field(sourceState).projection.document,
    apply: (identity, patches) => { state = sourcePatchTransaction(state, identity, patches).state; return state.field(sourceState).projection.document; },
    readOnly: () => readonly, history: () => false, status: () => {}, rejected: () => assert.fail('Valid Enter was rejected')
   });
   try {
    view.sync(parseSource(original));
    let end = -1;
    view.view.state.doc.descendants((node, offset) => { if (node.isText && node.text!.includes('你知道嗎')) end = offset + node.text!.indexOf('你知道嗎') + 4; });
    assert(end >= 0);
    view.view.dispatch(view.view.state.tr.setSelection(TextSelection.create(view.view.state.doc, end)));
    const press = (composing = false) => view.view.dom.dispatchEvent(new dom.window.KeyboardEvent('keydown', {key:'Enter', bubbles:true, cancelable:true, isComposing:composing}));
    press(true); assert.deepEqual(state.field(sourceState).projection.document.toBytes(), original.toBytes());
    readonly = true; press(); readonly = false;
    assert.deepEqual(state.field(sourceState).projection.document.toBytes(), original.toBytes());
    press();
    const broken = state.field(sourceState).projection.document;
    assert.equal(broken.read(), prefix + opening + '你知道嗎' + closing + '\\\\' + opening + closing + suffix);
    const input = new dom.window.InputEvent('beforeinput', {inputType:'insertText', data:'第二', bubbles:true, cancelable:true});
    view.view.dom.dispatchEvent(input);
    assert.equal(input.defaultPrevented, true, 'typing during parser acknowledgement is retained');
    view.view.dispatch(view.view.state.tr.insertText('行'));
    assert.equal(state.field(sourceState).projection.document, broken, 'queued input does not patch stale spans');
    view.sync(parseSource(broken));
    view.view.dom.blur();
    assert.equal(state.field(sourceState).projection.document.read(), prefix + opening + '你知道嗎' + closing + '\\\\' + opening + '第二行' + closing + suffix);
    state = historyTransaction(state, 'undo')!.state;
    state = historyTransaction(state, 'undo')!.state;
    assert.deepEqual(state.field(sourceState).projection.document.toBytes(), original.toBytes());
   } finally { view.dispose(); }
  }
 } finally {
  dom.window.close();
  for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis,key,descriptor); else Reflect.deleteProperty(globalThis,key); }
 }
});
