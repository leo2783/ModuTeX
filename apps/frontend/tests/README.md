# Frontend tests

Run `npm test --workspace=modutex-frontend` from the repository root. The runner discovers all `.test.ts` files recursively and runs test files serially.

| Directory | Coverage |
| --- | --- |
| app | App lifecycle and workspace ownership |
| content | Help, release notes, language and document templates |
| editor | Source/visual editing, formatting, history and folding |
| infrastructure | Test discovery and child-process exit status |
| math | Equations, matrices and visual math editing |
| navigation | Pages, compiler diagnostics and source navigation |
| pdf | PDF loading, rendering and resource lifetime |
| settings | Preferences, validation and restoration |
| tables | Table serialization, editing and pointer sessions |
| workspace | Files, desktop bridges, parser worker and workbench layout |

`helpers` contains support code, not standalone tests. `performance` contains the separate editor benchmark. `production` contains `.mjs` tests run by `npm run test:production --workspace=modutex-frontend`; these require a production build and are not part of the regular `.test.ts` suite.

Discovery does not follow symbolic links. Missing directories, empty suites and failed child tests return a nonzero exit status. Passing client harness tests does not establish native Electron acceptance.

The real-browser workbench test runs separately from the `.test.ts` suite:

```powershell
$env:MODUTEX_TEST_BROWSER_CHANNEL = 'chrome'
node --max-old-space-size=512 --test apps/frontend/tests/app/workbench-browser.test.mjs
```

It uses installed Chrome (`msedge` is also supported), one Vite server, temporary workspace files and the real managed Tectonic runtime prepared by `npm run frontend:test:runtime`. Without a channel, Playwright requires its installed Chromium. Missing browser or runtime resources fail the test.

Coverage includes byte-preserving save/reopen, watcher conflicts, genuine compilation, failure preserving the PDF, cancellation while the start response is pending, retry and teardown without page/console errors. The browser transport calls production file/watch/compiler services; picker selection uses the temporary fixture. This test does not verify the OS picker, Electron preload or native IPC.

For actual built Electron acceptance, run `node --max-old-space-size=512 --test scripts/tests/frontend-electron-smoke.mjs` after frontend/Electron builds and runtime preparation. It directly launches Electron with isolated userData, connects CDP, opens a real recent document, edits/saves bytes, compiles with Tectonic, cancels while preserving PDF bytes/pixels and retries. It also checks route IPC and absence of legacy bridges. OS picker automation is outside this test.

Run the following separately and serially after stopping workers:

```powershell
node --test apps/frontend/tests/app/workbench-ui.test.mjs
node --test scripts/tests/frontend-electron-close.test.mjs
```

The UI test uses real Chrome with GPU disabled to verify mode/icon controls, MathLive rendering, between-block insertion, re-editing, undo and help layout in both themes. The close test requires built frontend/Electron files and verifies save, discard, cancel and save failure using isolated files. It triggers the real Electron window's close path through `window.close()`; it does not click the physical OS title-bar button.
