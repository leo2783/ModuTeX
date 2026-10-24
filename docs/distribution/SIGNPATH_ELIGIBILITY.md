# Code signing policy

ModuTeX 僅申請簽署自行建置的桌面程式與 NSIS 安裝包。Tectonic 與 Microsoft WebView2 保留上游位元及簽章，簽章設定採確切檔名，不使用第三方執行檔萬用匹配。

## 發布條件

| 項目         | 驗收方式                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------ |
| 原始碼與授權 | 自有 Tauri／Svelte 程式採 Apache-2.0；第三方保留原有 LICENSE／NOTICE。                           |
| 產品資訊     | EXE 與安裝包 ProductName 為 ModuTeX，ProductVersion／FileVersion 與發布 tag 一致。               |
| 可追溯建置   | GitHub hosted runner 從鎖定 commit 與 lockfile 建置；記錄 workflow run、artifact ID 與 SHA-256。 |
| 兩階段簽署   | 簽主程式後以 --no-binary-patching 打包，再簽安裝包；解包後主程式雜湊必須相同。                   |
| 簽章驗收     | Windows 信任鏈有效、發布者符合核准值、具時間戳記，第三方簽章保持原樣。                           |
| 公開下載     | 下載頁描述功能，提供與申請形式相同的 EXE／安裝包，連結本 Code signing policy。                   |
| 安裝生命週期 | 乾淨 Windows VM 驗證安裝、升級、解除安裝與回復，保留使用者文件。                                 |
| 人員與核准   | 維護者指定 Authors、Reviewers、Approvers，GitHub 與 SignPath 全員啟用 MFA，每次簽署須人工核准。  |

## 設定

匯入 [.signpath/artifact-configurations](../../.signpath/artifact-configurations/) 的兩份 XML，slug 分別為 modutex-exe-zip、modutex-installer-zip，version 參數取自驗證後 tag。GitHub upload-artifact 已產生 ZIP，輸入應為原始 EXE，避免再包一層 ZIP。

GitHub release 環境需設定 SIGNPATH_API_TOKEN secret，以及 SIGNPATH_ORGANIZATION_ID、SIGNPATH_PROJECT_SLUG、SIGNPATH_SIGNING_POLICY_SLUG、SIGNPATH_EXPECTED_PUBLISHER variables。發布者取核准憑證 Subject，不能猜填專案名稱。保護環境需配置指定核准人；僅在 YAML 命名 environment 不會啟用人工核准。

## 申請資料

申請前補齊具名角色、正式下載頁、隱私政策與第三方網路行為說明。核准後在首頁及發布頁列示 SignPath.io 提供簽署服務、SignPath Foundation 提供憑證，並列出實際角色成員。帳號申請由專案擁有者處理。

## 目前證據

兩份簽章 XML 已通過官方 XSD。CI／CD 已納入 Tauri 工作流程；本機已驗證原生編輯、檔案操作、Git、終端機及元件清單。正式發布前仍需驗收同一 EXE 的安裝包、乾淨 VM 生命週期與 GitHub 環境保護。

官方依據：[Foundation 條件](https://signpath.org/terms)、[GitHub 建置來源](https://docs.signpath.io/trusted-build-systems/github)、[Artifact configuration](https://docs.signpath.io/artifact-configuration/syntax)。
