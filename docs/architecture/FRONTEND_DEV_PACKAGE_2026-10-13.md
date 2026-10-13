# 新版前端 dev 下載包

使用者指定 Git dev 分支＋下載 tgz 後用 npx 啟動。本次版本是 `0.2.0-dev.0`，Windows x64；不發布 npm registry，也不產出正式版安裝程式。

| 項目 | 行為與驗證 |
| --- | --- |
| 來源整合 | origin/dev 1351c29 整合 refactor/frontend 93140c8，使用隔離工作區，不帶入主工作區未提交的舊目錄搬遷 |
| 正式載入 | app:build 建置 apps/frontend；Electron packaged 模式固定 app://frontend/index.html，使用 resources/app-dist，禁止 legacy bundle origin |
| 權限 | 使用既有 modutexFiles 窄範圍 IPC；不暴露 legacy bridge，不開發伺服器 |
| 設定 | prerelease dev 版本使用 modutex-desktop-dev，與穩定版分開 |
| 授權 | 完整桌面包保留 AGPL，原創前端及兩個共享套件保留 Apache-2.0；包內提供 LICENSE、NOTICE、第三方 notices 與精確來源提交 |
| 完整性 | stage 驗證乾淨來源提交、PE／vendor／asar／原生依賴、檔案 inventory；tarball 另有 SHA-256 並解開重驗 |
| 真實執行 | frontend-packaged-smoke.mjs 驗證 EXE 及離線 npx：正式 origin、IPC、檔案儲存重開、英文設定、Tectonic PDF／canvas、關閉 |

EXE 與下載資料夾的離線 npx 真實驗證已通過。npx 首次展開約 226 MB 套件需要數分鐘，測試將套件準備與 45 秒 App 啟動檢查分開。完整前端回歸為 345／348；兩個版本頁預期修正後，包含檔案監看案例的 11 項針對性重測通過。整套仍有 Windows 檔案監看時序不穩定的紀錄，不宣稱完整回歸全綠，也不當作穩定版驗收。

既有 dev CI 整體驗證通過：Electron 400 項＋身分 7 項、舊編輯器 1,878 項（既有 17 skipped）、Typst 10 項；下載包／CI／安全門檻 31 項與 production 3 項通過。檔案密集測試固定兩個工作者，不放寬 timeout；Vitest 升級後共用既有 Windows WASM helper，圖片測試精確選取 NodeView，避免誤選游標輔助圖。

前端型別檢查為 0 errors、2 個既有 layout reactivity warnings。依賴修正與剩餘通報見 [依賴更新](../security/DEV_PACKAGE_DEPENDENCIES_2026-10-13.md)。最終 npx、inventory、audit、signature 與來源 SHA 收據隨本次 release 證據保存。

GitHub 乾淨 CI 曾在 Electron 型別檢查找不到兩個共享套件；已將共享建置納入 Electron dev／prod 指令、整體驗證與兩平台 workflow。移除本機兩個 generated dist 後重建通過，驗證 runner 4 項與 CI 政策 10 項通過。

執行方式見 [安裝說明](../user/INSTALLATION.md)。首次缺少快取的 TeX 編譯需要網路；啟動包不需要 Vite。檔案是未簽章開發版，Windows x64 以外平台未列入驗證。
