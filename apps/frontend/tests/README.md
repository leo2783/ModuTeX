# Frontend tests

Run commands from the repository root.

```powershell
npm run frontend:check
npm run frontend:test
```

The test runner discovers `.test.ts` files and fails on empty suites or child-process errors. Helpers, performance tools, and production fixtures run separately.

Build the frontend before running production browser tests:

```powershell
npm run frontend:build:tauri
node --test apps/frontend/tests/e2e/document-core-browser.e2e.mjs
node --test apps/frontend/tests/e2e/app-settings-draft-entry-browser.e2e.mjs
```

Windows uses installed Edge. Set `MODUTEX_TEST_BROWSER_CHANNEL` to `chrome` or `msedge` to select a browser.

Native desktop E2E tests live in `tests/scripts`. Build the desktop executable first, then run tests serially:

```powershell
npm run tauri:build
node tests/scripts/tauri-g2-workbench-e2e.mjs
node tests/scripts/tauri-g4-files-e2e.mjs
node tests/scripts/tauri-compile-config-e2e.mjs
node tests/scripts/tauri-native-close-e2e.mjs
node tests/scripts/tauri-multiwindow-e2e.mjs
```

These tests use temporary documents and the actual Tauri executable. Native compiler tests require the bundled Tectonic runtime.
