# Table & PDF Race Conditions and Lifecycle Review

> 歷史實作／審查紀錄。下列測試數字與待辦反映早期改寫階段；現行功能、版本及目錄以[實作狀態](FRONTEND_REWRITE_STATUS.md)與[開發指南](../user/DEVELOPMENT.md)為準。

Date: 2026-10-08
Scope: Architecture and correctness review of `TablePanel.svelte`, `column-resize.ts`, `PdfView.svelte`, `render-queue.ts`, and `App.svelte`
Status: Independent review only; production and test files are read-only.

---

## 1. Executive Summary

This review investigates state synchronization, pointer ownership, and asynchronous concurrency across the Svelte frontend table editing and PDF preview pipelines:
1. **Table Session & Initial Draft Ownership (`TablePanel.svelte`)**: Identification of race conditions and stale draft captures when switching between table editing sessions or modifying `initialDraft` under an unchanged `sessionKey`.
2. **Pointer Capture & Multi-Pointer Edge Cases (`column-resize.ts` & `TablePanel.svelte`)**: Evaluation of pointer release handling, multi-touch/second-pointer conflict resolution, and coordinate tracking integrity.
3. **PDF Lifecycle, Queue Serialization & Remounts (`PdfView.svelte`, `render-queue.ts`, `App.svelte`)**: Analysis of asynchronous worker initialization, queue disposal leaks, keyed remount cancellations, and error callback delivery.

---

## 2. TablePanel & Column Resizing

### 2.1 `sessionKey` & `initialDraft` First-Mount Bug and Session Scoping
- **Evidence**: [`TablePanel.svelte#L27-L28`](file:///C:/Users/qet63/Documents/ModuTex/apps/frontend/src/features/tables/TablePanel.svelte#L27-L28)
  ```svelte
  let loaded = 'insert';
  $effect(() => { if (sessionKey !== loaded) { cancelDrag(); table = initialDraft ?? createTable(); loaded = sessionKey; row = 0; column = 0; error = null; } });
  ```
- **Real Bug / Gap**:
  - `loaded` was initialized to the hardcoded string `'insert'`. When `TablePanel` is first mounted for an insertion where `sessionKey` defaults to `'insert'` ([`TablePanel.svelte#L6`](file:///C:/Users/qet63/Documents/ModuTex/apps/frontend/src/features/tables/TablePanel.svelte#L6)), the `$effect` condition `if (sessionKey !== loaded)` evaluated to `false`. Consequently, when a non-null `initialDraft` was supplied on first mount under the default `'insert'` key, `table` remained initialized to the fallback `createTable()` from line 17 (`let table = $state<TableDraft>(createTable());`), completely discarding the caller's initial draft.
  - **Preservation of Local Dirty Edits within the Same Session**: In Svelte 5 runes, parent re-renders or prop updates (such as locale changes or unrelated state refreshes) must **not** overwrite the user's active, in-progress draft edits while `sessionKey` remains unchanged. The component must strictly scope resets to transitions where `sessionKey !== loaded`, cancel any in-flight drag before switching, and preserve dirty user data during same-session updates.
- **Minimal Production Patch**:
  Use `loaded: string | null = null` as a sentinel so the initial mount effect executes and applies `initialDraft ?? createTable()`, while subsequent re-renders with the same `sessionKey` leave local dirty edits intact:
  ```svelte
  let loaded: string | null = null;
  $effect(() => { if (sessionKey !== loaded) { cancelDrag(); table = initialDraft ?? createTable(); loaded = sessionKey; row = 0; column = 0; error = null; } });
  ```

---

### 2.2 Pointer Capture Cancellation & Second-Pointer Conflict
- **Evidence**:
  - [`column-resize.ts#L18-L24`](file:///C:/Users/qet63/Documents/ModuTex/apps/frontend/src/features/tables/column-resize.ts#L18-L24):
    ```ts
    begin(pointer: number, x: number, width: number, boundary: number, weights: readonly number[]): boolean {
        if (this.current) return false;
        ...
        this.current = { pointer, x, width, boundary, weights: [...weights] }; return true;
    }
    ```
  - [`TablePanel.svelte#L49-L55`](file:///C:/Users/qet63/Documents/ModuTex/apps/frontend/src/features/tables/TablePanel.svelte#L49-L55):
    ```ts
    function startDrag(event: PointerEvent, boundary: number) {
        if (!active || locked || event.button !== 0) return;
        const element = event.currentTarget as HTMLButtonElement;
        if (!drag.begin(event.pointerId, event.clientX, widthTrack.getBoundingClientRect().width, boundary, table.weights)) return;
        try { element.setPointerCapture(event.pointerId); capture = { element, pointer: event.pointerId }; event.preventDefault(); element.focus(); }
        catch { cancelDrag(); }
    }
    ```
  - [`TablePanel.svelte#L21-L24`](file:///C:/Users/qet63/Documents/ModuTex/apps/frontend/src/features/tables/TablePanel.svelte#L21-L24):
    ```ts
    function cancelDrag() {
        drag.cancel(); const previous = capture; capture = null;
        if (previous) { try { if (previous.element.hasPointerCapture(previous.pointer)) previous.element.releasePointerCapture(previous.pointer); } catch {} }
    }
    ```
  - [`TablePanel.svelte#L96`](file:///C:/Users/qet63/Documents/ModuTex/apps/frontend/src/features/tables/TablePanel.svelte#L96):
    ```svelte
    onpointerdown={(event) => startDrag(event, index)} onpointermove={moveDrag} onpointerup={endDrag} onpointercancel={endDrag} onlostpointercapture={endDrag}
    ```
- **Real Bug / Gap**:
  - **Second-Pointer Interception**: When a user touches or clicks a boundary handle (pointer 1), `drag.begin()` captures pointer 1. If a second finger or pointer (pointer 2) touches any boundary handle, `drag.begin(2)` returns `false` (correctly rejected by `ColumnDrag`). However, pointer 2 events still bubble up. In [`TablePanel.svelte#L61`](file:///C:/Users/qet63/Documents/ModuTex/apps/frontend/src/features/tables/TablePanel.svelte#L61):
    ```ts
    function endDrag(event: PointerEvent) { if (drag.end(event.pointerId)) cancelDrag(); }
    ```
    When pointer 2 is released, `drag.end(event.pointerId)` returns `false`, so pointer 1 drag continues without disruption.
  - **Capture Mismatch & `onlostpointercapture` Race**: In line 96, `onlostpointercapture` calls `endDrag(event)`. If `cancelDrag()` is invoked externally (e.g. via `onblur`, `locked = true`, or `onkeydown`), line 23 releases pointer capture:
    ```ts
    previous.element.releasePointerCapture(previous.pointer);
    ```
    Releasing pointer capture synchronously or asynchronously dispatches `lostpointercapture` on `previous.element`. When `endDrag` receives that event, `drag.cancel()` was already called in `cancelDrag()`, and `capture` is already `null`. `drag.end()` returns `false`, which is safe and non-throwing.
  - **Track Width Zero Division**: If `widthTrack.getBoundingClientRect().width` evaluates to `0` (e.g., if the panel is opened while container layout has zero width or within an inert/hidden tab), line 21 of `column-resize.ts` (`if (width <= 0) return false;`) rejects the drag. However, no error is surfaced to the user.

---

## 3. PDF Preview & Render Queue

### 3.1 Asynchronous PDF Task Disposal & Document Loading
- **Evidence**: [`PdfView.svelte#L25-L33`](file:///C:/Users/qet63/Documents/ModuTex/apps/frontend/src/features/pdf/PdfView.svelte#L25-L33), [`#L66-L74`](file:///C:/Users/qet63/Documents/ModuTex/apps/frontend/src/features/pdf/PdfView.svelte#L66-L74), [`#L80-L84`](file:///C:/Users/qet63/Documents/ModuTex/apps/frontend/src/features/pdf/PdfView.svelte#L80-L84)
  ```ts
  onMount(() => {
      let disposed = false;
      let document: PDFDocumentProxy | undefined;
      let loading: PDFDocumentLoadingTask | undefined;
      let destroyPromise: Promise<void> | undefined;
      const destroyLoading = () => {
          if (!loading) return Promise.resolve();
          return (destroyPromise ??= loading.destroy());
      };
      ...
      void import('pdfjs-dist').then(async ({ getDocument, GlobalWorkerOptions }) => {
          if (disposed) return;
          GlobalWorkerOptions.workerSrc = workerUrl;
          loading = getDocument({ data: new Uint8Array(bytes), ... });
          const pdf = await loading.promise;
          if (disposed) { await destroyLoading(); return; }
          document = pdf; count = pdf.numPages; onPageCount(count); schedule?.();
      }).catch(() => { if (!disposed) { busy = false; onError('PDF_LOAD'); } });
      ...
      return () => {
          disposed = true; schedule = undefined; pause = undefined; observer.disconnect(); cancelAnimationFrame(resizeFrame);
          queue.dispose(); void destroyLoading().catch(() => {});
      };
  });
  ```
- **Real Bug / Gap**:
  - **Dynamic Import In-Flight Cancellation**: If the component is unmounted *while* `import('pdfjs-dist')` is resolving over the network or bundle pipeline, `disposed` becomes `true`. The cleanup function in line 82 calls `destroyLoading()`, but at that time `loading` is still `undefined`.
  - When the dynamic import promise eventually resolves:
    ```ts
    if (disposed) return;
    ```
    Execution halts before `getDocument` is invoked, correctly preventing worker initialization.
  - **Document In-Flight During Disposal**: If `loading = getDocument(...)` is called and unmount occurs before `loading.promise` resolves:
    1. Line 82 calls `void destroyLoading().catch(() => {})`, invoking `loading.destroy()`.
    2. In PDF.js, destroying an in-flight loading task causes `loading.promise` to reject with an error (e.g. `RenderingCancelledException` or `Worker was destroyed`).
    3. The rejection is caught by `.catch(() => { if (!disposed) { busy = false; onError('PDF_LOAD'); } })`. Because `disposed` is `true`, `onError('PDF_LOAD')` is suppressed, avoiding spurious error alerts.
  - **Document Proxy Cleanup**: When `document = pdf` has resolved, `loading.destroy()` destroys the underlying worker transport and the document proxy. However, `document.destroy()` is not explicitly called if `loading.destroy()` succeeds. In PDF.js `PDFDocumentLoadingTask.destroy()` delegates to `worker.destroy()`, which tears down pages and documents associated with that transport.

---

### 3.2 Keyed Remount in App.svelte & Canvas Queue Ownership
- **Evidence**: [`App.svelte#L556-L563`](file:///C:/Users/qet63/Documents/ModuTex/apps/frontend/src/App.svelte#L556-L563)
  ```svelte
  {#if pdfBytes}
      {#key pdfBytes}
          <PdfView
              bytes={pdfBytes}
              active={route === 'workbench' && active}
              locale={preferences.language}
              onPageCount={(count) => (pageCount = count)}
              onError={(code) => (errorState = fileErrorDescriptor(new Error(code)))}
          />
      {/key}
  ...
  ```
- **Real Bug / Gap**:
  - **Byte Array Identity Trigger**: Svelte's `{#key pdfBytes}` evaluates reference equality (`===`). Whenever a compilation succeeds or a file is read, `App.svelte` sets `pdfBytes = result.pdf` ([`App.svelte#L390`](file:///C:/Users/qet63/Documents/ModuTex/apps/frontend/src/App.svelte#L390)). Because each compilation yields a fresh `Uint8Array` instance, the key changes, tearing down the previous `PdfView` instance and mounting a new one.
  - **Old Canvas & Task Teardown**: Upon key change, the old `PdfView` runs its unmount cleanup:
    1. Sets `disposed = true`.
    2. Calls `queue.dispose()`, which executes line 32 of `render-queue.ts` (`this.disposed = true; ++this.version; this.pending = null; this.cancel();`).
    3. Line 60 of `PdfView.svelte` passes `() => render?.cancel()` as the queue's cancel callback. If a page render is in progress, `render.cancel()` is invoked, causing `render.promise` to reject with `RenderingCancelledException`.
    4. The `finally` block in [`PdfView.svelte#L56-L59`](file:///C:/Users/qet63/Documents/ModuTex/apps/frontend/src/features/pdf/PdfView.svelte#L56-L59) guarantees `render = undefined` and `page?.cleanup()`.
  - **Queue Cancellation & Error Suppression**:
    In [`render-queue.ts#L24-L26`](file:///C:/Users/qet63/Documents/ModuTex/apps/frontend/src/features/pdf/render-queue.ts#L24-L26):
    ```ts
    const current = () => !this.disposed && item.version === this.version;
    try { await this.draw(item.value, current); }
    catch { if (current()) this.failed(); }
    ```
    When `render?.cancel()` triggers rejection, `current()` returns `false` (because `this.disposed` is `true` and `version` incremented). `this.failed()` is therefore **not** called. This prevents false `PDF_RENDER` error toasts when a new compile cancels an obsolete rendering.

---

### 3.3 ResizeObserver & Fit-Zoom Race Conditions
- **Evidence**: [`PdfView.svelte#L75-L79`](file:///C:/Users/qet63/Documents/ModuTex/apps/frontend/src/features/pdf/PdfView.svelte#L75-L79)
  ```ts
  const observer = new ResizeObserver(() => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => { if (zoom === 'fit') schedule?.(); });
  });
  observer.observe(target);
  ```
- **Real Bug / Gap**:
  - When `zoom === 'fit'`, any change to `target.clientWidth` fires the observer.
  - In line 49, `canvas.style.width = viewport.width + 'px'` alters the canvas size. If the canvas width exceeds container bounds and induces horizontal or vertical scrollbars in `.pdf-scroll`, `target.clientWidth` changes as a side-effect of scrollbar emergence!
  - This can trigger a feedback loop of resize notifications if the scale boundary oscillates across the scrollbar threshold. Throttling via `cancelAnimationFrame` prevents call stack overflows, but rapid layout recalculation can cause visual jitter during fit-to-width rendering on narrow split panes.

---

## 4. Summary of Identified Gaps & Recommended Production Patches

| Component | File & Lines | Identified Issue | Severity | Recommended Fix |
| :--- | :--- | :--- | :--- | :--- |
| `TablePanel.svelte` | [TablePanel.svelte#L27-L28](file:///C:/Users/qet63/Documents/ModuTex/apps/frontend/src/features/tables/TablePanel.svelte#L27-L28) | Default `loaded = 'insert'` skips initialization when `initialDraft` is provided with default `sessionKey = 'insert'`. | Medium | Initialize `loaded` to `null` so initial draft sync runs unconditionally on mount. |
| `column-resize.ts` | [column-resize.ts#L20-L24](file:///C:/Users/qet63/Documents/ModuTex/apps/frontend/src/features/tables/column-resize.ts#L20-L24) | `begin()` rejects with `false` when track width <= 0, causing silent failure if container has zero width during initial mount. | Low | Verify container layout visibility before initializing interaction. |
| `PdfView.svelte` | [PdfView.svelte#L66-L74](file:///C:/Users/qet63/Documents/ModuTex/apps/frontend/src/features/pdf/PdfView.svelte#L66-L74) | If unmounted during PDF.js dynamic import, loading task is skipped, but no cleanup occurs if module import fails. | Low | Ensure unmount token cancels in-flight module loader. |
| `PdfView.svelte` | [PdfView.svelte#L75-L79](file:///C:/Users/qet63/Documents/ModuTex/apps/frontend/src/features/pdf/PdfView.svelte#L75-L79) | Scrollbar appearance under `fit` zoom can trigger layout oscillation. | Low | Use `overflow-y: scroll` or debounce resize requests beyond single rAF. |

---

## 5. Verification & Acceptance Boundaries

- **Static Review Only**: This document records architectural inspection evidence. No production or test files have been modified.
- **Desktop & Native Environment Limitations**:
  - Pointer capture behavior across multi-touch vs. mouse devices requires browser DOM event testing (cannot be fully simulated in headless Node without synthetic `PointerEvent` mocks).
  - WebWorker execution for PDF.js and Canvas 2D hardware acceleration depend on Chromium/Electron runtime acceptance.
