# Raw LaTeX 重編輯

> 歷史實作／審查紀錄。下列測試數字與待辦反映早期改寫階段；現行功能、版本及目錄以[實作狀態](FRONTEND_REWRITE_STATUS.md)與[開發指南](../user/DEVELOPMENT.md)為準。

視覺模式的未知指令、環境與註解保留為原始碼區塊。區塊「編輯原始碼」開啟工作台內面板；未套用前不修改文件，取消／Esc 返回編輯器。

- NodeView 使用 textContent，來源中的 HTML 不轉成 DOM。
- 按鈕權限綁定目前 SourceDocument identity／version／區段 bytes；readonly、過期投影與卸載後 listener 失效。
- `rawEditTransaction` 驗證捕捉區段與 expected；未修改返回 null，不建立 dirty／undo。變更走共用 CodeMirror 工具交易，保留周邊 BOM、混合 EOL 與未知內容。
- 不猜測語法、不重新列印、不自動新增套件；明確空內容可刪除區段。NUL 拒絕，5 MiB 共用來源限制拒絕時保留面板草稿。
- 工具開啟時禁止普通 editor 輸入，套用由受控 `input.tool` 交易完成；這不是一般 readonly 文字交易。

本批測試由驗證子代理提供及執行，主代理整合 patch、不重跑。Raw 4／4 通過，包含 LF-normalized 不變草稿不 dirty／不產生 undo；完整前端 182／182、production 2／2 通過，check 0 errors／warnings。Electron 面板焦點、Esc／取消與儲存重開尚未驗收。
