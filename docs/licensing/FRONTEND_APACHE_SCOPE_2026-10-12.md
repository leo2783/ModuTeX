# 原創前端 Apache-2.0 授權範圍

日期：2026-10-12。專案權利人明確要求將來源核心、前端契約、新寫 UI／圖片／編輯功能及自有矩陣程式採 Apache-2.0。本文件記錄實際授權決定；不把此決定描述為獨立來源審查核准。

| 範圍 | 許可 |
|---|---|
| apps/frontend 的原創 source、tests、build scripts | Apache-2.0，包含原創 UI、圖片、編輯及權利人自有 matrix.ts |
| packages/document-core 的原創 source、tests、build scripts | Apache-2.0 |
| packages/frontend-contracts 的原創 source、tests、build scripts | Apache-2.0 |
| 第三方依賴、字型、素材、匯入授權文件、生成第三方 runtime | 保留各自授權，不由套件宣告改標 |
| Electron、legacy editor/site、既有 AGPL 桌面發布物 | 維持既有授權 |

每個原創套件附有 Apache-2.0 LICENSE 全文及 NOTICE。Manifest 和 lockfile 的三個 workspace license 欄位同步更新；private 設定保持，授權決定不代表要求發布 npm 套件。前端 Vite 產物附帶 LICENSE、NOTICE 與 THIRD_PARTY_NOTICES.md。

MathLive input-only runtime 是 MIT 上游的修改版本，字型另受 OFL 條款約束。CodeMirror、ProseMirror、Svelte 及 PDF.js 也保留自己的授權。第三方 notices 不得移除。生成的 bundle 應按 constituent licenses 解讀，不能把整個 bundle 中所有位元組一律宣告為自有 Apache 程式碼。

根 LICENSE 與既有發布版本不變。獨立前端原創模組採 Apache-2.0，不等於整個 Electron 桌面組合作品脫離 AGPL；來源與第三方閉包的未解項目仍記錄在 frontend-origin.json 與既有審查文件。2026-10-07 及可分離審查文件反映各自當時狀態，最新授權決定以本文件與套件 LICENSE 為準。

驗證採用正式生產建置、完整 notices 比對、manifest／lockfile／LICENSE 位元組核對，以及中英文授權說明 SSR 測試。套件授權全文來源為既有 LICENSES/Apache-2.0.txt；應用方式依據 [Apache 官方說明](https://www.apache.org/legal/apply-license)。
