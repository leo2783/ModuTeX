# 原始碼折疊

> 歷史實作／審查紀錄。下列測試數字與待辦反映早期改寫階段；現行功能、版本及目錄以[實作狀態](FRONTEND_REWRITE_STATUS.md)與[開發指南](../user/DEVELOPMENT.md)為準。

- 使用真正 CodeMirror folding service／gutter／commands；範圍來自新版 parser，不使用舊 editor glue 或另掃全文。
- 目前支援 section／subsection／subsubsection（含星號）的層級區段，以及 parser 已匹配的多行環境；unknown／unclosed 不猜測。註解與 literal body 不產生內部章節。
- CRLF／CR／LF 透過來源座標映射，不修改原始 bytes。折疊／展開僅改 decorations，不加入來源 undo。
- 解析完成時建立排序座標索引，查詢用 binary search；不保留第二份來源或 parser tree。來源修改即停用舊索引；晚到／外來回覆不能蓋掉新索引。
- 既有折疊 decorations 由 CodeMirror 隨編輯映射；尚未取得新解析前不提供新的折疊範圍。不是語意 parser 的增量子樹實作。
- 原始碼／對照工具列有「折疊目前區段」「展開全部」；gutter 可操作，折疊 placeholder 是具名稱的真正按鈕，卸載後拒絕晚到點擊。
- CodeMirror 預設鍵盤：Ctrl+Shift+[／] 折疊／展開；Ctrl+Alt+[／] 全部折疊／展開。macOS 個別區段使用 Cmd+Alt+[／]。
- 五項回歸涵蓋層級／環境／混合 EOL、Unicode unknown、過期解析、bytes／checkpoint／undo，以及真 EditorView commands／placeholder／重複 destroy。jsdom 不取代 Electron geometry／IME／縮放與 heap 驗收。
- 授權線索見 [採用紀錄](../licensing/FRONTEND_FOLDING_DEPENDENCIES.md)，完整閉包與 notice 審查尚未完成。
