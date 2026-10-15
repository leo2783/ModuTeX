# 視覺來源交易

> 歷史實作／審查紀錄。下列測試數字與待辦反映早期改寫階段；現行功能、版本及目錄以[實作狀態](FRONTEND_REWRITE_STATUS.md)與[開發指南](../user/DEVELOPMENT.md)為準。

`apps/frontend/src/features/visual-editor/schema.ts` 為新寫的 ProseMirror schema；不 import legacy schema、converter 或 serializer。固定使用 model 1.25.9、state 1.4.4，兩者 upstream LICENSE 為 MIT。完整第三方與產物閉包審查仍待完成，新 workspace 保持 private／UNLICENSED。

## 已實作

- `projectVisual` 只接受同文件／版本的 parser 投影。有 document 環境時顯示正文，preamble 與環境邊界仍留在來源。
- 純文字、純文字標題／格式內容可投影；巢狀未知內容、公式、註解及未知環境保留不可任意改寫的 Raw。
- `visualPatches` 接受真正 ProseMirror transaction，只修改變更 block 的最小文字範圍；保留未動過的 bytes、註解、空白及混合 EOL。
- 新插入的 TeX 特殊字元轉義；來源差異處理 surrogate 邊界與 LF／原始換行座標。
- 每個可編輯 block 保存不可變 UTF-16 → 來源邊界映射；`advanceVisual` 在真實來源 receipt 後重定位 span、更新變更 block 的字元映射，不重新 parser。
- 連續輸入／刪除轉義字元、換行與 Unicode 後可接著編輯；只回讀已知、完整匹配的文字轉義，帶未知參數的 macro 仍為 Raw。
- `sourcePatchTransaction` 經既有 CodeMirror filter、dirty checkpoint、undo stack；保存唯讀、過期版本、外來文件、expected bytes 不符與 CRLF 中間位置皆拒絕。

## 證據與未完成範圍

11 項真正 ProseMirror／CodeMirror state 測試及 1 項 EditorView DOM 測試通過；前端全套 32 項，0 skip，check／build／install policy 通過。DOM 測試使用 jsdom、真正 MutationObserver 與鍵盤事件，不是 Chromium／Electron 驗收。

`view.ts` 已接入 SourceView 的原始碼／視覺／對照模式。視覺輸入直接提交來源交易並更新映射，不逐鍵等待 Worker；來源修改或共用 undo 後，舊投影暫停寫入，只接受同文件／版本回覆。卸載 destroy EditorView，重複 dispose 與晚到 sync 不再修改 DOM。

貼上只接受純文字；一般段落 Enter 插入兩個換行，標題／跨 block Enter 拒絕並提示原始碼模式。結構變更／跨 block 合併／新增節點需獨立指令；已接入以下行內格式子集，但格式新增／移除與跨區段編輯尚未完成。公式、矩陣、表格仍需完整可重編輯驗收。Worker 重投影只夾限舊 selection，精確來源游標映射、IME、Electron 焦點及共用 undo 桌面驗收仍待完成。

## 行內格式映射

已知 textbf／textit／emph／underline 與相鄰文字合併為同一 source block 的真正 ProseMirror marks；標題也可包含格式。巢狀 emph 在 italic 情境移除 em，避免把強調反轉錯顯為持續斜體。格式內含未知 macro／comment 時保留整個包裝為 Raw，不猜測其語意。

純文字沿用既有 boundary mapping；行內格式另用 immutable segments（視覺區間、來源 editable 區間、marks 及 boundary mapping），不複製來源 bytes。普通輸入只修改所在 segment；`advanceVisual` 收到同一來源 receipt 後更新該 segment 及後續座標，不逐鍵重新 parser。完整 wrapper 留在原始來源中，不透過 serializer 重寫。

跨 segment 普通刪除／替換已支援：採真正 step map 的原始座標，按來源區段提交局部 patches，保留各個 TeX wrapper；不以重複文字的共同前後綴猜測選取位置。多步交易先反向映射至原投影。直接 addMark 仍拒絕；格式 toggle、collapsed stored marks 與跨 block 結構指令尚未完成。空格式 wrapper 保留；無 mark 的 collapsed cursor 選左側 visible run，不自動假定正在空 wrapper 內輸入。

九項行內格式測試驗證巢狀／標題格式、連續 Unicode／混合 EOL、跨區段刪除／替換、多步座標、過期交易拒絕、fresh projection 比對、精確 undo 及真正 EditorView／readonly／dispose。前端 66 項通過，check／production 產物測試通過；不是完整格式工具或 Electron／IME／heap 驗收。分段 mapping 仍按字元儲存，大文件成本待量測。

`advanceVisual` 的 next document 必須來自剛完成的同一 CodeMirror 來源交易；檢查 identity／version、長度及插入範圍。它不是外部 IPC receipt 的完整安全驗證器。映射只屬目前視覺投影，不額外建立 visual undo stack。

解析失敗時 `invalidate` 清除視覺來源映射、保留 DOM 內容但禁止寫入；App 清除過期 outline 投影。SourceView 顯示一次「解析中斷，原始碼仍可編輯。」及重新解析入口，失敗期間不顯示持續更新中。重新建立真正 Worker，使用目前 CodeMirror 文件 snapshot，不替換 editor state／選取或 undo。新 Worker 解析當前版本後恢復視覺投影；桌面按鈕／焦點、精確視覺游標與 heap 仍待验收。

目前差異演算法走訪 block 清單並比較變動 block 文字；映射為每個字元邊界配置 offset，變更 block 需複製其映射。未掃描全文來源，但大型單段落與 5 MB GUI p95／heap gate 尚未通過。不能靠等待每次 Worker 全文 parse 才允許下一個字，或將視覺編輯降為唯讀來完成目標。

## 表格來源工具

`tables/source.ts`／`TablePanel.svelte` 為新原創實作，從原始碼／對照模式插入。三種樣式以 base `tabular` 生成，不 import legacy schema／serializer；三線表使用等粗 hline，不冒稱 booktabs。儲存格／caption 為單行文字，特殊 TeX 字元轉義。欄寬權重歸一，p 欄位扣除 tabcolsep／框線寬度；寬度為 linewidth 百分比。先檢查 1–100 行／1–20 列再配置儲存格。

行列增刪產生不可變 proposal，刪除非空內容先確認。caption 隱藏與面板關閉不刪除草稿。插入捕捉文件版本／選取，保存或其他工具期間禁止操作，走共用來源交易及 undo。5 項來源／CodeMirror 測試及真 Tectonic 三種樣式／caption 位置／特殊文字編譯通過；前端全套 38，runtime 5，0 skip。

`parseTable` 只接受本模組生成語法，最終與 emitter 精確比較；EOL 可不同，未知 macro／comment／column spec 拒絕而保留 Raw。`tableAt` 使用同版本 parser span 找到 center／table 包裝；center 在通用 parser 保留 Raw，只有精確辨識的表格可透過工具修改，不將其他 Raw 開放任意交易。七項表格測試涵蓋三種樣式／caption／轉義回讀與範圍替換，前端全套現為 40，0 skip。

原始碼／對照模式可將游標放在新版表格內開啟編輯。`rangeInsertionTarget` 用二分映射轉為 LF 編輯座標，拒絕過期 span／CRLF 中間位置；套用只改表格範圍，保持外圍 BOM／混合 EOL／未知 bytes，精確 undo。面板草稿按文件版本／span 綁定，同一未變更表格關閉重開不重置草稿。沒有 caption 的來源不保存隱藏 caption 文字；目前只在面板草稿保留，不能宣稱完整持久化。

`table_block` atom 只辨識生成器精確語法，由原創 NodeView 產生真正 HTML table／thead／tbody／caption／欄寬；文字用 textContent，不解析 HTML。按「編輯表格」開啟同一 TablePanel，捕捉目前版本／重定位 span，套用共用來源交易／undo。保存、工具開啟或投影過期時禁用；NodeView destroy 移除 listener 與按鈕 registry，舊按鈕不能回呼。一般 ProseMirror 刪除／結構替換仍拒絕，必須透過明確來源工具。

真正 DOM 測試驗證 literal HTML、安全回讀、前方文字變動後 reanchor、來源替換、過期 span 拒絕、唯讀、精確兩次 undo 及重複卸載。前端 41 項全通過，check 0 errors／warnings，build／靜態 detector 通過；不是 Chromium／Electron／IME 驗收。只對變動錨點用 attribute steps，但 ProseMirror leaf 錨點改變仍可能重建 NodeView；不宣稱零重建或大型文件效能完成。

尚未完成：完整表格子集、拖曳欄寬、booktabs preamble 確認、桌面保存重開／焦點／a11y、極窄欄寬與隱藏 caption 持久化。此接線不是整項 F3 完成。

## 大綱定位

`source-editor/outline.ts` 使用當前 parser 投影，列正文可辨識的 section／subsection／subsubsection，跳過註解及 literal 環境；最多讀標題前 160 UTF-16 units，避免切斷 surrogate。標籤保留來源文字，不解讀 HTML。App Files／Outline 切換只顯示一種側欄；來源變更後保留舊大綱但禁止點擊，只有新版本解析可重新啟用。

`sourceNavigationTransaction` 為真正 CodeMirror selection-only transaction，綁定 span identity／version，保留 bytes、checkpoint、dirty、undo。SourceView 每個導航序號只消費一次，不因切模式或關工具重播；新文件不接收舊文件的請求。視覺模式定位目前 ProseMirror block、選取／focus；節點未投影則回原始碼定位。卸載、過期或唯讀不接受導航。

三項來源／狀態測試與真 DOM selection／focus 回歸通過。jsdom 缺 Range 座標 API，因此焦點驗證與既有非焦點 DOM mutation 測試分開；未偽造 rect 或降低拒絕計數。Chromium／Electron focused typing／捲動、長大綱 DOM 效能與 a11y 尚未驗收。

## 編輯器載入邊界

App 僅在文件存在時動態載入 SourceView，await block 以 document identity／重試序號為 key；切文件撤銷舊 block，成功後使用當前來源 props。開檔期間顯示一次載入狀態，失敗保留來源並提供重試。載入完成後切視覺／原始碼仍使用同一 mounted editor，不因輸入逐字重新 import 或重建 undo。

2026-10-07 固定依賴／相同 build 設定量測：initial JS 503.28 → 70.90 KB，editor 延遲 chunk 434.36 KB，PDF chunk 426.16 KB；總程式未移除，500 KB warning 門檻未調整。`npm run test:production --workspace=modutex-frontend` 先建置、再讀真正 manifest／檔案，檢查靜態啟動閉包不含 editor、初始 JS < 100 KiB、editor／CSS 產物存在。這項證據不涵蓋載入失敗重試的桌面操作、實際啟動耗時、IME 或 heap 回收。
