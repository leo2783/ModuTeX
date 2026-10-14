# 編譯診斷與 PDF 版本

> 歷史實作／審查紀錄。下列測試數字與待辦反映早期改寫階段；現行功能、版本及目錄以[實作狀態](FRONTEND_REWRITE_STATUS.md)與[開發指南](../user/DEVELOPMENT.md)為準。

- Host 只辨識真正 Tectonic `error: entry.tex:line: message` 格式；路徑須精確符合編譯入口，最多 256 筆、單筆訊息 512 字元。無檔名 `l.N`、included file 或其他格式保留記錄，不猜位置。
- 真 Tectonic 失敗回歸已確認 `main.tex:2`，失敗後既有 PDF bytes 保留。
- Renderer 診斷綁定編譯 identity；只定位同 documentId／version／entryPath 的來源。混合 CRLF／CR／LF 行號走保真來源座標及真正 CodeMirror selection，來源 bytes、dirty／undo 不變；未知 column 語意不猜測。
- 點擊診斷切至原始碼；過期結果停用定位，位置不存在時提供編譯記錄提示。included-file 開檔及完整 column 定位仍待實作。
- PDF 分別標示外部、目前編譯與文件已變更的上次編譯；保存不會把舊 PDF 升級為新版本，失敗／取消保留原 PDF。
- 保存後編譯再次核對原文件／工作區／path 及忙碌／卸載狀態，防止 await save 後編譯另一份新開文件。
- 本輪：前端 73、診斷 2、真引擎 5、production 1 項通過；check／Electron 建置通過，沒有假引擎／假 PDF。GUI 點擊／focus、首次下載、完全離線及 heap 尚未驗收。
