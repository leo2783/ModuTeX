# 視覺模式插入工具

> 歷史實作／審查紀錄。下列測試數字與待辦反映早期改寫階段；現行功能、版本及目錄以[實作狀態](FRONTEND_REWRITE_STATUS.md)與[開發指南](../user/DEVELOPMENT.md)為準。

公式、矩陣與表格工具可在原始碼、視覺或對照模式開啟。對照模式使用最後取得編輯焦點的 surface；視覺模式不沿用隱藏 CodeMirror 的游標。

- `VisualEditor.insertionSelection` 只捕捉同一文字 segment 的真 TextSelection，回傳當前來源 identity／version／span；跨 atom、跨格式、跨段落、Raw、readonly、過期及已卸載 view 拒絕。
- 標題與有格式文字只允許行內公式；正文可插入獨立公式、矩陣與表格。純公式段落的兩側文字邊界仍可插入。
- `visualInsertionTransaction` 以來源 span 映射至 LF 編輯座標，再走共用 CodeMirror 交易／5 MiB 限制／undo。獨立內容只在需要的兩側補換行，行內公式不補。
- 面板期間禁止一般輸入；套用時重新驗證捕捉版本。拒絕保留草稿與錯誤，不關閉面板；取消不修改文件，焦點返回原 surface。
- 不自動新增套件、不重列印周邊來源；既有生成器仍負責表格及矩陣的相容語法。

六項子代理測資使用真 PM／CM、實際公式／矩陣／表格生成器與 UTF-8 上限，6／6 通過。包含 Raw 補充回歸的完整前端 182／182、production 2／2 通過；check 0 errors／warnings、detector exit 0。DOM／來源交易測試不代替 Electron 面板焦點、IME、保存重開或實機 PDF 驗收。
