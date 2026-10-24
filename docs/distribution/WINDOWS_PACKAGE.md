# Windows x64 打包與發布

從專案根目錄執行：

| 指令                          | 產物                                        |
| ----------------------------- | ------------------------------------------- |
| npm run tauri:build           | release 主程式，開發驗證使用。              |
| npm run tauri:package         | 線上 NSIS 安裝包。                          |
| npm run tauri:package:offline | 含離線 WebView2 的 NSIS 安裝包。            |
| npm run tauri:bundle          | 對既有 release EXE 打包，不重新編譯主程式。 |

所有打包使用 --no-binary-patching，避免修改已簽署主程式。Rust 僅使用 apps/desktop-tauri/target，不複製建置快取。

CI 檢查 Rust format／Clippy／測試、Svelte 型別與測試、前端建置、Windows 原生 E2E、PE 產品版本與產物雜湊。CD 驗證 tag 對應可信 commit，取同次 CI 產物，簽主程式、打包、檢查解包內容、簽安裝包、產生元件清單與 checksums，最後建立 Draft Release。正式公開前仍需人工核准與完整 G7 驗收。

Code signing policy 與資格條件見 [SIGNPATH_ELIGIBILITY.md](SIGNPATH_ELIGIBILITY.md)。簽章驗收檢查有效信任鏈、核准發布者與時間戳記。

## App 更新

啟動後由 Tauri 官方 updater 背景檢查。使用者選擇下載，再按「安裝更新」。有未存變更時改為「儲存並更新」，儲存取消或失敗就暫停。編譯中顯示等待提示，完成後才開放安裝。

CD 以 TAURI_SIGNING_PRIVATE_KEY 與選用的 TAURI_SIGNING_PRIVATE_KEY_PASSWORD 對最終安裝包簽章，並使用 --app-version 綁定版本。公鑰存於 Tauri 設定，私鑰不進版控。更新簽章與 SignPath 分開處理。

穩定版且有更新金鑰時，Draft Release 包含安裝包、.sig 與 latest.json。預發布版本不產生正式更新資訊。App 從 GitHub Releases 的 latest.json 檢查更新。

## NSIS 安裝生命週期 CI

`installer-lifecycle` 在最終 package gate 後，分別測試同次工作流程的線上與離線安裝包。它核對安裝包及已安裝主程式的 SHA-256 和 PE 版本，不重建產物。

測試只允許乾淨的 GitHub-hosted Windows x64 runner。它拒絕既有 ModuTeX 程序、解除安裝登錄項目、安裝路徑或捷徑。安裝、隔離的 WebView2 profile 與文件 sentinel 都位於新建的 `RUNNER_TEMP` 目錄。測試只關閉自己啟動的程序，解除安裝後核對程式檔案、登錄項目與捷徑已移除，並確認文件 sentinel 保留。

同版本重裝只記為 `sameVersionRepair`，不代表跨版本升級或回退。未提供真實舊安裝包時，收據會將兩者記為 `not-covered`，不會宣稱完整 G7 通過。手動 dispatch 可選擇提供先前 GitHub release 安裝包 URL、穩定版本、SHA-256 與安裝後 executable basename。測試會在同一 scratch 安裝目錄實際安裝舊版、升級、回退，再恢復目前版本並解除安裝。首次 Tauri 版本不需要假造先前 Tauri workflow。

可供日後 Electron 遷移驗收的公開 0.2.1 安裝包為 `https://github.com/leo2783/ModuTeX/releases/download/v0.2.1/ModuTeX-Setup-0.2.1.exe`，SHA-256 為 `f02613312c8567938f1551d24a0f9bb8db231cc8fac2e8951f397b78e9c31340`。dispatch 時須另外提供由該安裝包確認的 executable basename。生命週期腳本會拒絕在 GitHub-hosted Windows runner 以外執行。
