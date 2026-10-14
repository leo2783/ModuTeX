# 儲存庫目錄

| 路徑 | 責任與授權邊界 |
|---|---|
| `apps/frontend` | 正式桌面 renderer；原創範圍 Apache-2.0。 |
| `apps/texpile-editor` | 保留的舊編輯器、測試與素材；維持原授權。 |
| `landing` | 既有 SvelteKit 網站；維持原授權。 |
| `electron` | 主程序、IPC、preload、compiler 與原生服務；完整桌面仍採 AGPL。 |
| `packages/document-core` | 原創來源緩衝、parser 與座標映射；獨立版本。 |
| `packages/frontend-contracts` | 原創平台契約及驗證；獨立版本。 |
| `scripts` | 建置、CI、來源盤點、vendor、打包工具與測試。 |
| `vendor` | 固定第三方版本與 LICENSE／NOTICE。 |
| `docs/user` | 現行使用與開發指南。 |
| `docs/architecture`、`docs/licensing` | 架構與來源證據；歷史提案依日期及狀態辨識。 |
| `release` | 本機產物與驗收紀錄，不納入 Git 原始碼。 |

原未提交的 `editor-legacy`／`site-legacy` 搬移提案已取消。依使用者決定保留 main 的目錄，只整合缺少的工具與文件；詳見[分歧整合](REPOSITORY_RECONCILIATION.md)。正式 renderer 的建置來源仍為 `apps/frontend/dist`。

[開發與打包](../user/DEVELOPMENT.md) · [授權範圍](../../LICENSING.md)
