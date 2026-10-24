# 編輯器與功能規格

實作：`apps/frontend/src`、`crates/document-core`。來源模型見 [DOCUMENT_CORE](DOCUMENT_CORE.md)，host 行為見[桌面契約](FRONTEND_CONTRACTS.md)。

## 來源、投影與選取

- 一份 SourceDocument、一條 undo；保留 bytes、BOM、混合 EOL、註解與未知 Raw。可視化操作產生最小 source patch，不重建全文。
- Visual projection 綁 documentId／version，使用 UTF-16 座標；只在真實 transaction receipt 後 advance，不能每個按鍵全量 parse。
- 巢狀未知 wrapper 保持受保護 Raw。sourcePatchTransaction 核對 expected bytes、surrogate／CRLF 邊界與唯讀狀態；parse 失敗保留 DOM／來源並停止過期投影寫入。
- Worker 重建保留 editor state；editor、PDF、MathLive 按需載入。預設可視化與原始碼兩種模式；2026-10-11 已取消 split 模式。
- 插入位置取 active head，保留雙向選取的 anchor／head；支援邊界與新 cell。Files 與 Outline 上下排列。
- Esc 選取／退出，方向鍵移動，Enter 輸入，Alt＋方向鍵調整。拖曳使用 shadow、placeholder、落點線與自動捲動，放開才提交一次 undo；Esc、blur 或版本改變取消。

## 格式與文字

- `textbf`／`textit`／`emph`／`underline` 支援純文字局部套用／取消；Raw、math、comment 與跨 wrapper 選取不做破壞性重寫。
- B／I／U 快捷鍵避開 IME、keyCode 229、repeat 與不適用修飾鍵。插入 title／maketitle、abstract、各層 section；RGB 文字色與安全的 xcolor preamble 更新為同一交易。
- Outline 顯示目前章節，標題最多 160 UTF-16 units 且不拆 surrogate；過期項目不能導向，導向只改 selection。
- CodeMirror 章節／環境折疊使用相符範圍與二分索引，不另存來源或 parse tree；過期時停用，只改 decoration，保留鍵盤操作。

## 公式與矩陣

- 191 個公式模板採分類→模板兩階選擇，含合併 Greek、lim／integral 六種樣式、括號及搜尋；唯讀預覽不接受輸入，關閉需 dispose。
- inline 支援 `$...$`／`\(...\)`，block 支援 `$$...$$`／`\[...\]`。silent setValue 不觸發來源正規化；最多 65536 UTF-16 units。空模板可包含空 group。
- 矩陣 1–10 列／欄、六種括號與 array，支援 surrounding math／scripts；單一矩陣 resize 保留左上資料及周邊內容，縮減非空格需確認，多矩陣不猜測目標。
- amsmath／amssymb 在驗證安全 preamble 後原子加入。MathLive 0.110.0 input-only build 移除八個虛擬鍵盤模組與入口，保留必要 notices、fonts、source maps。
- owner 已授權自有矩陣 parser 與表格程式重用；特定舊程式閱讀授權不擴張到第三方 UI。來源依據見[來源審查](../licensing/SOURCE_REVIEW.md)。

## 表格、程式碼、圖片與 Raw

- 表格 1–100 列、1–20 欄，支援框線／booktabs、全框線、水平線三種樣式、header／caption／linewidth 比例。只接受可精確 round-trip 的 emitter 子集，未知內容保留 Raw。
- session 初次載入使用 null sentinel；同一 session 保留 dirty draft。刪除非空內容需確認；隱藏 caption 只存在草稿。
- 欄寬調整保持相鄰權重總和與正值，pointer owner 固定；鍵盤每次 1%、Shift 每次 5%。取消清理 listener，Apply 才形成 source undo。
- booktabs 套件確認檢查 literal preamble 與當前文件；衝突或超過 5 MiB 時不能只更新半份來源。
- 程式碼支援 145 種語言的延遲 grammar，透過 textContent 顯示、不執行。verbatim／listings 採有限 metadata，套件與來源原子更新；不承諾所有語言皆有 PDF highlighting。超過 100000 UTF-16 units 時以完整純文字呈現。
- 圖片支援 PNG／JPEG，單檔 5 MiB；剪貼簿保留原 bytes，系統 PNG 可用，JPEG 轉換只用於複製。桌面存相鄰資源、browser 用 IndexedDB；UUID 與 graphicx 同交易處理。
- Raw 編輯核對 identity／version／expected bytes；無變更回傳 null，空內容需明確刪除，拒絕 NUL／超過 5 MiB 並保留草稿。

## 文件與輔助頁面

- blank／article／report 模板建立新 ID，首次保存維持 dirty。Help／Release Notes 使用安全文字、按需載入；版本紀錄上限 100 筆／128 KiUTF-16，不代表 updater。
- 繁體中文／English 選單保存偏好，支援 Esc／點擊外部關閉。實際視覺規格見[產品設計](../design/PRODUCT.md)，操作方式見[編輯指南](../user/EDITING.md)。
