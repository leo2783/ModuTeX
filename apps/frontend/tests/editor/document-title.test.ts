import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { SourceDocument, parseSource } from '../../src/features/document-core/core.ts';
import { VisualEditor } from '../../src/features/visual-editor/view.ts';
import { createSourceState, sourcePatchTransaction, sourceState, historyTransaction } from '../../src/features/source-editor/state.ts';
import { DATE_VALUES } from '../../src/features/compile/document-date.ts';
const { JSDOM } = createRequire(import.meta.url)('jsdom');

test('automatic numeric dates render as dates without exposing their TeX commands', () => {
 const dom = new JSDOM('<!doctype html><body><div id="editor"></div></body>', {pretendToBeVisual:true});
 const previous = new Map<string, PropertyDescriptor | undefined>();
 for (const key of ['window','document','navigator','MutationObserver','Node','HTMLElement','getComputedStyle']) {
  previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));
  Object.defineProperty(globalThis,key,{configurable:true,writable:true,value:key === 'getComputedStyle' ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key]});
 }
 try {
  for (const mode of ['iso','slash','day-first'] as const) {
   const source = SourceDocument.open(new TextEncoder().encode(`\\documentclass{article}\n\\title{Title}\n\\date{${DATE_VALUES[mode]}}\n\\begin{document}\n\\maketitle\nBody.\n\\end{document}`));
   const target = dom.window.document.getElementById('editor')!;
   const view = new VisualEditor(target,'main.tex',{source:()=>source,apply:()=>source,history:()=>false,readOnly:()=>false,rejected:()=>assert.fail('Unexpected edit'),status:()=>{}});
   try {
    view.sync(parseSource(source));
    assert.match(target.querySelector('.document-date')!.textContent!,mode === 'iso' ? /^\d{4}-\d{2}-\d{2}$/ : mode === 'slash' ? /^\d{4}\/\d{2}\/\d{2}$/ : /^\d{2}\/\d{2}\/\d{4}$/);
    assert(!target.textContent!.includes('\\number'));
   } finally { view.dispose(); }
  }
 } finally {
  dom.window.close();
  for (const [key,descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis,key,descriptor); else Reflect.deleteProperty(globalThis,key); }
 }
});

test('preamble title renders at maketitle without exposing a raw command or changing source bytes', { timeout: 5000 }, () => {
  const dom = new JSDOM('<!doctype html><body><div id="editor"></div></body>', { pretendToBeVisual: true });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const key of ['window', 'document', 'navigator', 'MutationObserver', 'Node', 'HTMLElement', 'getComputedStyle']) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === 'getComputedStyle' ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key] });
  }
  const text = '\uFEFF\\documentclass{article}\r\n\\title{A workspace for ideas}\r\n\\author{ModuTeX}\r\n\\date{}\r\n\\begin{document}\r\n\\maketitle\r\nBody text.\r\n\\end{document}\r\n';
  const original = SourceDocument.open(new TextEncoder().encode(text));
  let state = createSourceState(original);
  const target = dom.window.document.getElementById('editor');
  const view = new VisualEditor(target, 'main.tex', {
    source: () => state.field(sourceState).projection.document,
    apply: (identity, patches) => { state = sourcePatchTransaction(state, identity, patches).state; return state.field(sourceState).projection.document; },
    history: direction => { const transaction = historyTransaction(state, direction); if (!transaction) return false; state = transaction.state; view.refresh(); return true; },
    readOnly: () => false,
    rejected: () => assert.fail('valid title/body source edit was rejected'),
    status: () => {},
    raw: () => {}
  });
  try {
    view.sync(parseSource(original));
    const heading = [...target.querySelectorAll('h1, [role="heading"][aria-level="1"]')].find((element: Element) => element.textContent === 'A workspace for ideas');
    assert(heading, 'the document title must be a visible heading');
    assert(target.textContent.includes('ModuTeX'), 'the explicit author must remain visible');
    assert(!target.textContent.includes('\\maketitle'), 'supported maketitle must not appear as a raw-code card');
    assert(!target.textContent.includes('\\author') && !target.textContent.includes('\\date'), 'plain author and empty date must not become raw-code cards');
    assert.deepEqual(state.field(sourceState).projection.document.toBytes(), original.toBytes(), 'rendering must preserve BOM, CRLF and all original bytes');
    let bodyPosition = -1;
    view.view.state.doc.descendants((node, position) => { if (node.isText && node.text?.includes('Body text.')) bodyPosition = position + node.text.indexOf('Body text.'); });
    assert(bodyPosition >= 0, 'body text remains editable');
    view.view.dispatch(view.view.state.tr.insertText('Updated ', bodyPosition));
    assert(state.field(sourceState).projection.document.read().includes('Updated Body text.'));
    assert.equal(target.querySelector('h1')?.textContent, 'A workspace for ideas');
    const undo = historyTransaction(state, 'undo');
    assert(undo, 'body editing retains the shared source undo history');
    state = undo.state;
    view.refresh();
    assert.deepEqual(state.field(sourceState).projection.document.toBytes(), original.toBytes());
    view.sync(parseSource(state.field(sourceState).projection.document));
    let titlePosition = -1;
    view.view.state.doc.descendants((node, position) => { if (node.isText && node.text?.includes('A workspace for ideas')) titlePosition = position + node.text.indexOf('A workspace for ideas'); });
    assert(titlePosition >= 0);
    view.view.dispatch(view.view.state.tr.insertText('My ', titlePosition));
    assert(state.field(sourceState).projection.document.read().includes('\\title{My A workspace for ideas}'));
    bodyPosition = -1;
    view.view.state.doc.descendants((node, position) => { if (node.isText && node.text?.includes('Body text.')) bodyPosition = position + node.text.indexOf('Body text.'); });
    assert(bodyPosition >= 0);
    view.view.dispatch(view.view.state.tr.insertText('Still ', bodyPosition));
    assert(state.field(sourceState).projection.document.read().includes('Still Body text.'));
    state = historyTransaction(state, 'undo')!.state;
    state = historyTransaction(state, 'undo')!.state;
    view.refresh();
    assert.deepEqual(state.field(sourceState).projection.document.toBytes(), original.toBytes());
  } finally {
    view.dispose();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
    dom.window.close();
  }
});
