# 三頁主代理靜態複審

時間：2026-10-07。範圍：另一位工作者撰寫的 Home、Help、ReleaseNotes；本次未修改三頁。此紀錄不授予 Apache-2.0，也不證明完整非衍生性。

| 檔案 | SHA-256 |
|---|---|
| `apps/frontend/src/pages/Home.svelte` | `0b4c58052e862ad80cb9770da9a0bb3b4c63cd4cef74c4fd4f8b50723d9ea8d2` |
| `apps/frontend/src/pages/Help.svelte` | `45e31cb7afa4f3facb58e4414718986bf0f2e167603a9bd9e9dafb628d0c86e9` |
| `apps/frontend/src/pages/ReleaseNotes.svelte` | `d266debde20a1e33f3e011ac10b5ac281744cb3432b890982f96440d2a2284ac` |

已全文閱讀三頁、templates.ts、release-notes/content.ts：Home 只呼叫提供的開檔／模板／recent callbacks；Help 把授權與安裝文件當 raw 資料，透過受限文字渲染；ReleaseNotes 讀 CHANGELOG／限制文件。兩閱讀頁均未使用 `{@html}`、任意 shell 或 raw IPC。原始碼 import 指向新版功能與明列文件，不直接引用 legacy。

限制與待辦：

- 未執行完整歷史相似性／上游比對，不以無 legacy import 作為非衍生性證明。原創來源清冊仍 pending。
- Help 的 notices 只有部分套件；新建 `apps/frontend/THIRD_PARTY_NOTICES.md` 保留當前 source-map 清冊辨識的 16 個第三方套件全文，尚未接入 Help 或建置分發。MathLive 字型授權文件仍缺漏，需另查上游，不以 MIT 程式碼授權替代字型授權。
- source-map 清冊是當前磁碟建置觀察，不保證與正在修改的原始碼一致；最終建置須重新收集。
- 320px 寬度、桌面實際焦點、雙語正文與鍵盤行為須另依實際行為證據驗收；此靜態審查不代替 GUI 驗收。
