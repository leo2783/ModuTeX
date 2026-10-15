# Development / 開發與打包

Run commands from the repository root with Node.js **24.19.0** and npm **11.17.0**, as pinned in `package.json`.
請在儲存庫根目錄使用 `package.json` 指定的版本。

The desktop product and active frontend are **0.2.1**. Shared private libraries such as `@modutex/document-core` and `@modutex/frontend-contracts` retain independent **0.1.0** versions. npm build banners show the individual library version; `scripts/set-version.mjs` synchronizes only the desktop and active frontend.
桌面程式與新版前端為 **0.2.1**；共用函式庫採獨立版本，因此建置訊息中的 `document-core@0.1.0` 不代表桌面程式是舊版。

```powershell
npm ci
npm run electron:dev:frontend
```

The new frontend uses Vite on `127.0.0.1:5174`; `npm run electron:dev` starts the earlier editor on 5173.
Stop the existing process with Ctrl+C before switching.
新版前端使用 5174 埠，先前編輯器使用 5173；切換前先 Ctrl+C 停止原程序。

| Command | Purpose / 用途 |
|---|---|
| `npm run electron:frontend` | Build and run the new frontend from local files. / 靜態建置並啟動新版前端。 |
| `npm run frontend:test` | New frontend tests; pretest builds shared packages. / 新前端測試，pretest 先建置共用套件。 |
| `npm run verify:modutex` | Shared build, frontend types/tests, core/contracts and retained host/editor checks. / 共用建置、新前端、核心／契約及保留的 host／編輯器檢查。 |
| `npm run test:ci-policy` | Workflow policy and real frontend failure propagation. / CI 政策與真前端故障傳遞。 |
| `npm run test:frontend-origin` | Rebuild the frontend, then test source boundaries, artifact containment and font notices. / 先重建前端，再驗證來源邊界、產物路徑及字型通知。 |
| `npm run app:build` | Production frontend and Electron build. / 正式前端與 Electron 建置。 |

`npm run verify:frontend-origin` writes a JSON evidence report and intentionally exits with status 1 while independent source/license reviews remain unresolved. It is an investigation tool, not a release approval. Its `not-cleared` verdict does not change the scope documented in `LICENSING.md`.
`verify:frontend-origin` 是證據收集工具；獨立來源／授權審查未結案時會輸出 `not-cleared` 並以狀態 1 結束，不可將其解讀成桌面已脫離 AGPL 或自動授權放行。

For standalone type checking on a clean checkout:

```powershell
npm run build:shared --workspace=modutex-frontend
npm run frontend:check
```

## Windows x64 builds / Windows x64 建置

```powershell
npm run dist:dir -- --win --x64 --publish never
npm exec --no -- electron-builder --win nsis --x64 --prepackaged release/win-unpacked --publish never
```

The payload is `release/win-unpacked/`; the installer is `release/ModuTeX-Setup-0.2.1.exe`.
These commands do not publish to GitHub or npm. Native dependencies may need C++ build tools if no compatible prebuilt binary exists.
產物為未壓縮應用及 `.exe` 安裝程式；指令不發布到 GitHub 或 npm，缺少相容預建原生依賴時可能需要 C++ 建置工具。

The [Windows workflow](../../.github/workflows/modutex-ci.yml) validates the real app, installer and cold offline npx package before staging downloads.
The [PR workflow](../../.github/workflows/test.yml) checks Windows and Linux without publishing.
Windows 工作流程驗證真實應用、安裝程式及冷快取 npx，再整理下載物；PR 工作流程檢查兩個平台而不發布。

Cold npx acceptance separates large-archive preparation (10-minute bound) from application startup (45 seconds). npm 11.17 extracts local tarballs while reading manifests; timing diagnostics distinguish preparation stalls from application failures. Save/reopen, language, PDF and close assertions remain required.
冷快取 npx 驗收分開限制大型壓縮檔準備（10 分鐘）與應用啟動（45 秒）。npm 11.17 讀取本機 `.tgz` manifest 時會完整解壓；timing 紀錄用來區分準備停滯與應用故障，儲存／重開、語言、PDF 與關閉斷言仍須通過。

[Installation / 安裝](INSTALLATION.md) · [Limitations / 限制](KNOWN_LIMITATIONS.md)
