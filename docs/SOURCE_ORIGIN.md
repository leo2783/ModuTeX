# 0.1.0 來源與套件

原始碼基準：[latex/main cf294704936ce1914dc188f703e7a30fcb97d7bd](https://github.com/leo2783/latex/tree/cf294704936ce1914dc188f703e7a30fcb97d7bd)。匯入既有 `ModuTex` 儲存庫的 `feature/version-0.1.0`，保留目標 Git 歷史與 origin，不搬來源 `.git`、本機依賴或使用者未提交的修改。

程式、測試、fixtures、CI／建置設定、vendor、LICENSE／NOTICE 由固定 commit 複製，逐檔 SHA-256 核對。README、安裝說明與 ignore 規則另作整理；新增本文件及已知限制。

## 排除範圍

不搬 `.codex/`、`IMPLEMENTATION_*`、`docs/engineering/`、`docs/security/` 的歷史紀錄、舊 GUI 計畫、舊交接日誌與上游 CONTRIBUTING。授權來源盤點、必要 vendor 文件與可執行安全檢查保留。排除文件沒有被拿來降低測試或檢查門檻。

## 既有套件

路徑：`release/version-0.1.0/modutex-desktop-0.1.0.tgz`，237985752 bytes。

```text
SHA-256 7ac1c061b225fc1975aae6ee0dd97b54dc41998546b168a2b5a903e131165c9c
```

套件保持原位元組；內含 source offer 指向上述原儲存庫 commit，沒有冒充在新 repo 重建。機器可讀逐檔盤點在同目錄 `SOURCE_MANIFEST.json`，包含保留、排除及改寫項目。

既有打包 metadata 的 homepage／source-offer 仍指向舊儲存庫；未來從新 repo 的新 commit 建置時，須一併更新 metadata、來源提供模板與相關測試。不可把新 commit 誤填成舊 repo 的來源。

## 驗證界線

來源 commit 的本地 Windows CI 已通過 20 個指令門檻；High／Critical audit 為 0，Low 1／Moderate 7 尚存。Electron 308 + identity 7、editor 1878、Typst 10 通過；editor 17 個既有條件跳過未算通過。

該次 CI 明確沿用同 commit 的打包證據；不表示 Linux、遠端 Actions、公開 registry 或本套件新一輪 npx GUI 驗收已完成。匯入後的檔案核對與最低檢查結果見 `release/version-0.1.0/TRANSFER_VERIFICATION.json`。
