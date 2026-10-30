# 開發與打包

在儲存庫根目錄執行。使用 Node.js 24.22.1、npm 11.19.1、Rust 1.97.1 MSVC 與 wasm-bindgen-cli 0.2.126。

```powershell
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.126 --locked
npm ci
npm run build
npm run tauri
```

`npm run tauri` 啟動已建置的執行檔。修改程式後先重新建置。

| 命令                            | 用途                                 |
| ------------------------------- | ------------------------------------ |
| `npm run frontend:check`        | Svelte 與 TypeScript 檢查            |
| `npm run frontend:test`         | 前端功能測試                         |
| `npm run frontend:build:tauri`  | 建置 Rust WASM 與 Tauri 前端         |
| `npm run tauri:build`           | 建置前端與 Rust 桌面程式             |
| `npm run tauri:package`         | 建置標準 Windows 安裝包              |
| `npm run tauri:package:offline` | 建置含離線 WebView2 安裝資源的安裝包 |

桌面、前端、共用契約及 Rust 核心使用 0.3.0。版本更新使用 `npm run set-version -- 0.3.0`。

[CI](../../.github/workflows/tauri-ci.yml) 按 Markdown、前端、Rust、安全、原生 E2E 與打包驗證拆分。[發布流程](../../.github/workflows/tauri-release.yml) 使用 CI 驗證過的執行檔處理簽章與更新產物。

未簽署發布設置 `force_unsigned_candidate=true`，安裝包驗證省略選填的 `OurSignerSubject`，避免空值在子 PowerShell 程序變成缺少參數。簽署發布仍必須提供並驗證發行者名稱。

一般 push 與既有 PR 新增提交時，只要本次變更全為 `.md`，便僅執行 Markdown 格式檢查；同時修改程式、工作流程或圖片等其他檔案時，執行完整 CI。新開或重開 PR 以整個 PR 差異判斷。無法取得比較歷史、新分支、標籤、手動驗證與發布流程一律執行完整 CI。Markdown 檢查涵蓋 Git 追蹤的文件，排除既有歷史／第三方授權聲明及自動產生的 notices。

Rust 測試前執行 `node tests/scripts/prepare-tectonic-test-bundle.mjs`，從固定來源取得測試資源。暫時性連線中斷、逾時及指定 HTTP 錯誤最多嘗試三次，共用原有 240 秒期限；區段、長度或 SHA-256 不符立即失敗。回歸測試使用 `node --test tests/scripts/tectonic-test-bundle.test.mjs`。

原生編譯驗證執行 `node tests/scripts/tauri-compile-config-e2e.mjs`；設置 `MODUTEX_TEST_PERIODIC_WATCH=1` 可包含實際 60 秒監看週期。圖片案例透過視覺編輯器的 `Control+End` 定位文件末尾，避免換行後插圖拆開定位文字，並驗證原段落、圖片存檔與 PDF 像素。

CDP 程序歸屬同時檢查父程序 PID 與建立時間，排除 Windows 重用 PID 造成的過期父子關係。啟動診斷與監聽埠驗證共用此規則。

線上與離線 NSIS 安裝包共用 `apps/desktop-tauri/windows/installer-hooks.nsh`。解除安裝先確認主程式已停止，再於約 10 秒內重試移除被暫時鎖定的主程式；持續鎖定會回傳失敗，保留解除安裝資訊。打包 CI 使用實際 NSIS 驗證原始殘留問題、短暫鎖定成功及持續鎖定失敗；本機可設置 `MODUTEX_TEST_MAKENSIS` 為 `makensis.exe` 路徑後，執行 `node --test tests/scripts/distribution/nsis-uninstall.test.mjs`。既有完整安裝／修復／解除安裝與文件保留驗收仍須通過。

完整工作台瀏覽器回歸使用 `node --test --test-concurrency=1 apps/frontend/tests/app/*.test.mjs`。混合文章矩陣保留 24 種情境，透過真實滑鼠拖選標題並確認完整選取後操作格式工具列，避免 `Home`／`End` 隨版面位置選到部分文字。
