# 新前端與 Electron

新版工作台使用現有 Electron main／preload，未搬入 legacy renderer 元件。host 仍保留 AGPL 邊界；不能因新 UI 原創而將整體桌面版標為 Apache-2.0。

## 開發啟動

使用專案固定的 Node 24.19.0／npm 11.17.0，在儲存庫根目錄執行：

```powershell
npm run electron:dev:frontend
```

入口會建置真正的 Electron host，等待新版 Vite 的 5174 埠，再開啟桌面視窗。使用原生視窗框架，避免尚未接入自訂 titlebar 時失去關閉／最小化控制。開發設定隔離至 `modutex-frontend-development`；原 `electron:dev` 與正式版路由不變，packaged app 不接受此環境切換。

## 非打包建置前端啟動

在需要測試非打包之完整前端靜態建置時執行：

```powershell
npm run electron:frontend
```

此指令會編譯 `modutex-frontend` 與 Electron 主程序，並透過 `MODUTEX_RENDERER=frontend-built` 載入 `app://frontend/index.html`。若 `apps/frontend/dist/index.html` 遺失，主程序會立即拋出明確錯誤阻止啟動（無 fallback）。該模式共用既有之 protocol serving 與 CSP/MIME 邊界，並透過專用之 `matchesFrontendHostURL` 與 Drawio Context Matcher 確保在路由切換（如 `#/workbench`）後能正確取得靜態資源並正常執行原生 IPC。

## 驗收邊界

2026-10-10：Electron 型別檢查／建置、前端檢查／建置通過，正式 host／Drawio guard 25 項通過。真 Chrome 工作台流程 7 項通過，包含原始 bytes 儲存、watch 衝突、真 Tectonic 成功／失敗／取消／重試及 PDF 保留，零 page／console error；[執行方式與邊界](../../apps/frontend/tests/README.md)。

原生 Electron 驗收已通過：直接啟動真執行檔並連接 CDP，載入建置版、透過正式最近文件／preload／IPC 開檔、逐 byte 儲存、真 Tectonic 編譯、非空 PDF 渲染、取消保留 PDF 並重試成功；換頁後 IPC 有效，legacy bridge 未暴露，零 page／console error，正常關閉且無隔離程序殘留。Playwright `_electron.launch` 的逾時仍是測試啟動路徑的限制，未據此投機修改 main。

重跑方式（先完成前端／Electron 建置與 `npm run frontend:test:runtime` 的 runtime 快取準備）：

```powershell
node --max-old-space-size=512 --test scripts/tests/frontend-electron-smoke.mjs
```

測試僅建立 temp 文件／最近紀錄與隔離 userData，使用既有 Tectonic 快取副本與 `--disable-gpu`。未替換 IPC 或編譯結果，不覆蓋 OS picker 自動操作。當前進度以[主路徑清單](MAINPATH_HANDOFF_2026-10-10.md)為準；下列較早紀錄不是本輪完成證據。

- 現階段：原創來源核心、可編輯 CodeMirror 與保真 undo／redo、真實 PDF.js 翻頁／輸入頁碼／縮放；已接入既有 TeX 的磁碟儲存與 Ctrl+S。
- 已接線：native picker、每個 main frame 的工作區、原始 bytes／檔案清單／revision 保存、compile start／result／cancel；不暴露 legacy 任意檔案／shell API。
- 安全邊界：relative path、junction 拒絕、根目錄 dev／inode 綁定、讀取前後身份／大小／時間檢查；host／renderer TeX 統一 5 MiB、PDF 32 MB、目錄最多 4096 entries／16 層。
- 已接線：[另存新檔](FRONTEND_SAVE_AS.md)、新檔排他建立與原生 picker；尚待完整 write race 審查、新文件／模板、watch、首次下載／完全離線及 Electron 端到端。邊界見 [競態清單](FRONTEND_IO_CONCURRENCY.md)。
- 原始碼／視覺／對照模式已接入真正 CodeMirror／ProseMirror；尚待完成：桌面游標／IME／開檔驗收、視覺結構／表格／公式節點、設定與版本頁面、production renderer 選擇及打包。

Electron 視窗啟動不等於 F4 驗收通過。不能以重新編碼舊 host 的文字 read API 冒充原始 bytes，也不能以靜態 PDF 或假 IPC 回覆替代編譯。

2026-10-07 最新驗證：9 項真實檔案系統測試、3 項開發路由測試通過；Electron／frontend build 成功。工作區被同路徑的新目錄替換後，list／read 均拒絕。這不是敵對檔案系統 race 的完整審查。

## 真引擎驗證

Windows x64、固定 Node／npm，在儲存庫根目錄執行 `npm run frontend:test:runtime`。測試建立受檢查的 `.verification-artifacts/frontend-runtime-2026-10-07`，使用實際 bundled Tectonic 與官方固定資源來源；缺少資源時可能下載，首次 format setup 有有限五分鐘預算。此次使用隔離的既有資源快取副本，3 項測試通過，0 skip。未用 mock engine／PDF，未修改原設定。

`FrontendCompiler` 限每個 owner 一筆 run／單次結果領取；工作區或 renderer 撤銷、保存與取消會中止該 owner。新版前端跨視窗編譯／保存雙向互斥：重疊／巢狀 root 保護由初次 revision 讀取前開始，待 engine 清理及 PDF bytes capture 後釋放，取消不提前解除。結果匹配 workspace／entry／document version／revision，前端另拒絕過期文件或預覽。真 Tectonic 4 項與 filesystem 21 項測試通過；不涵蓋外部程式／legacy API／敵對 path replacement，亦不是 GUI 驗收。失敗保留現有 PDF；system TeX 仍未接入。
