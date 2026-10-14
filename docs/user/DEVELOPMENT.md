# Development / 開發與打包

Run commands from the repository root with Node.js **24.19.0** and npm **11.17.0**, as pinned in `package.json`.
請在儲存庫根目錄使用 `package.json` 指定的版本。

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
| `npm run app:build` | Production frontend and Electron build. / 正式前端與 Electron 建置。 |

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

The payload is `release/win-unpacked/`; the installer is `release/ModuTeX-Setup-0.2.0.exe`.
These commands do not publish to GitHub or npm. Native dependencies may need C++ build tools if no compatible prebuilt binary exists.
產物為未壓縮應用及 `.exe` 安裝程式；指令不發布到 GitHub 或 npm，缺少相容預建原生依賴時可能需要 C++ 建置工具。

The [Windows workflow](../../.github/workflows/modutex-ci.yml) validates the real app, installer and cold offline npx package before staging downloads.
The [PR workflow](../../.github/workflows/test.yml) checks Windows and Linux without publishing.
Windows 工作流程驗證真實應用、安裝程式及冷快取 npx，再整理下載物；PR 工作流程檢查兩個平台而不發布。

[Installation / 安裝](INSTALLATION.md) · [Limitations / 限制](KNOWN_LIMITATIONS.md)
