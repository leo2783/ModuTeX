# 0.2.0 直接下載安裝包：發布缺項（2026-10-13）

後續使用者選擇 Git dev＋npx tgz，進度另見 [dev 下載包](FRONTEND_DEV_PACKAGE_2026-10-13.md)；下列內容保留直接安裝程式的盤點範圍。

這是工作區發布盤點，不是發布授權或已產生安裝包的宣告。使用者詢問直接提供安裝檔所需申請事項；本次沒有申請帳號、購買憑證、修改版本或對外發布。

| 項目 | 實際觀察 | 發布前處理 |
|---|---|---|
| 正式 renderer | electron-builder.yml 仍複製 apps/editor-legacy/dist；frontendDevelopment／frontendBuilt 都排除 packaged 模式 | 將新版 frontend 正式納入打包與 packaged URL／preload 允許範圍，驗證不是只有開發模式可用 |
| 版本 | 根 package.json 為 0.1.0 | 選定發布提交並同步 0.2.0 版本、更新記錄與 tag |
| 安裝包 | 本次僅建置 renderer 與 Electron 程式，未建立或安裝 0.2.0 安裝包 | 驗證全新 Windows 使用者的安裝、啟動、存取、圖片、中文輸入、編譯、關閉、升級與解除安裝 |
| 授權 | 原創前端 Apache；現有桌面 host 與舊版 AGPL，第三方各自授權 | 安裝包附完整 LICENSE／NOTICE，下載頁連結對應版本來源與範圍說明 |
| 編譯首用 | Tectonic 冷快取仍可能下載套件與 format | 在全新環境測試進度、失敗、取消及重試；說明首次需要網路 |
| 下載完整性 | 尚未建立本次 release assets | 產出安裝包 SHA-256、對應原始碼及 release notes；不可將未生成檔案說成可下載 |

直接發布 Windows EXE／MSI 不要求走 Microsoft Store。GitHub Releases 可附二進位檔案。簽章建議供正式對外版本使用；新簽章仍可能遇到 SmartScreen 聲譽提示，不保證零警告。MSIX 則另有有效簽章要求。

Microsoft Artifact Signing Public Trust 個人僅限美國／加拿大，目前不包含台灣。台灣個人若需正式簽章，應先確認供應商的地區與個人身分資格，再申請程式碼簽章憑證；不預先建議購買不適用的 Azure 服務。未簽章 EXE 可供測試，但 Windows 安全功能可能提示或阻擋。

官方資料：[Windows 發布路徑](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/publish-first-app)、[GitHub Releases](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository)、[Artifact Signing 資格](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart)、[SmartScreen](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)。

可延後項目須在功能清單誠實揭露，例如 Mermaid／Draw.io／自訂 TeX 引擎等尚未確認的新前端整合。docs/user/KNOWN_LIMITATIONS.md 有舊版內容，0.2.0 前需按實際功能更新；不把該文件中的每一項都當成新前端已驗證能力。

完整前端回歸最後一次為 346／348 通過，兩個 Windows 真實檔案監看案例等待逾時；即使單獨重測通過，也不宣稱完整套件全數通過。正式發布前需釐清此類通知或測試時序不穩定。此次 GUI 20 項、生產 3 項、核心 122 項、引擎 41 項與真實編譯 21 項皆通過。
