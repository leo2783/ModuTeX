# 前端實作狀態

新版前端已隨 [0.2.0](https://github.com/leo2783/ModuTeX/releases/tag/v0.2.0) 正式發布，main 對應 `b4278da`。本文提供現行狀態；早期設計與審查文件反映其標示日期，不代表仍有工作者執行或功能尚未交付。

| 範圍 | 現行位置與狀態 |
|---|---|
| 視覺／來源編輯、公式、矩陣、表格、程式碼、圖片與語言選單 | `apps/frontend`；正式 renderer。 |
| 來源緩衝、parser、座標映射 | `packages/document-core`；獨立私有套件 `0.1.0`。 |
| 桌面邊界與驗證 | `packages/frontend-contracts`；獨立私有套件 `0.1.0`。 |
| 主程序與編譯／檔案服務 | `electron`；完整桌面發布物仍維持 AGPL。 |
| 舊編輯器與網站 | `apps/texpile-editor`、`landing`；保留來源、授權及回歸檢查。 |
| 來源／資產證據工具 | `scripts/licensing`；不宣稱獨立授權放行。 |

0.2.0 的 Windows／Linux PR 與 main CI 已通過；真實安裝、開啟／儲存／重開、English、PDF、關閉、解除安裝與冷快取 npx 也有 CI 驗收。[驗收說明](DEV_REVIEW_FIXES.md)描述範圍；[已知限制](../user/KNOWN_LIMITATIONS.md)記錄輸入法與大型文件邊界。

早期未提交的目錄搬移已取消。缺少工具與文件在 `fix/reconcile-frontend-layout` 整合，不回退已發布程式，不更換既有 0.2.0 下載物。

[目錄配置](../reference/REPOSITORY_LAYOUT.md) · [整合決策](../reference/REPOSITORY_RECONCILIATION.md) · [開發指令](../user/DEVELOPMENT.md) · [授權範圍](../../LICENSING.md)
