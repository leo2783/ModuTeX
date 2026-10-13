# Original frontend routing

`src/frontend-development.ts` is a pure URL boundary shared by main and sandbox preload. It imports no Node APIs.

- `MODUTEX_RENDERER=frontend` selects `http://127.0.0.1:5174` only in a nonpackaged app.
- `MODUTEX_RENDERER=frontend-built` selects `app://frontend/index.html` only in a nonpackaged app.
- The matcher requires the exact protocol, host, port and document path, rejects credentials and queries, and accepts only the defined app routes.
- Packaged routing cannot be changed through these environment selections. Main-frame ownership remains the caller's responsibility.

Run the focused boundary tests from the repository root:

```powershell
node node_modules/vitest/vitest.mjs run --config electron/vitest.config.ts electron/tests/frontend-development.test.ts --maxWorkers=1
```
