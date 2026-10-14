# 文字格式交易

> 歷史實作／審查紀錄。下列測試數字與待辦反映早期改寫階段；現行功能、版本及目錄以[實作狀態](FRONTEND_REWRITE_STATUS.md)與[開發指南](../user/DEVELOPMENT.md)為準。

`source-editor/format.ts` 透過真正 CodeMirror 交易在來源邊界插入或刪除 `\textbf`、`\textit`、`\underline` wrapper。同一來源核心／undo stack 保留已選文字的 BOM、Unicode、混合換行與鄰接未知內容；不將整段文字重新序列化。完整已知 wrapper 或完整內容可取消相同格式；`\emph` 與 `\textit` 都可取消斜體。

| 入口 | 範圍與防護 |
|---|---|
| 原始碼 | 當前 parser 的純文字選取或完整已知格式區段；空選取建立空 wrapper，游標置於內部。 |
| 視覺 | `VisualEditor.formatSelection()` 將同一 source_block 的真正 PM 選取映射為當前版本 SourceSpan，再走相同 CodeMirror 交易。 |
| 對照 | 使用最後聚焦的來源／視覺編輯器，工具列聚焦不改選取 owner；未就緒的視覺不退回來源舊游標。 |
| 拒絕 | readonly、過期／外來 parser、Raw、公式、註解、literal、不完整 command 與跨 wrapper／block 選取保持來源不變。 |

純文字格式內容支援部分取消：例如選取 `\textbf{abcdef}` 的 `cd`，產生 `\textbf{ab}cd\textbf{ef}`；首段／尾段取消亦保留其他文字格式。只修改 wrapper 邊界，保留選取與未選取內容的原始 bytes。包含巢狀格式、未知指令、公式、註解或 literal 的 wrapper 不拆分。

原始碼與視覺編輯器接入 Ctrl／Command+B、I、U；排除組字、229、repeat、Alt、Shift 與已處理事件，保留 Shift+B 編譯快捷鍵。快捷鍵判定有真正 KeyboardEvent 測試，Electron 路由／IME 仍待驗收。

本輪視覺格式需要非空文字選取。視覺 collapsed stored marks、複雜巢狀子區間取消、跨 wrapper／block 的格式指令及 Electron 鍵盤／IME 驗收仍未完成；不能把原始碼空 wrapper 當成視覺 stored marks。現有內容輸入與跨行內刪除回歸保留。

## 驗證

子代理新增 25 項真正 source/parser／CodeMirror／ProseMirror／DOM 測試：三種套用、取消、巢狀、來源空選取、BOM／mixed EOL、共享 undo／redo、版本／readOnly 拒絕，以及 PM selection→source span→交易→重新投影。jsdom 不代表 Electron 幾何或 IME 驗收。

本批子代理另新增 23 項部分取消／快捷鍵測試：四種 wrapper 的首段、中段、尾段、全部取消；Unicode／mixed EOL／undo／redo、危險範圍拒絕與真正 PM→來源交易→DOM 重投影。

主代理完整前端 164、production 2 項通過，0 skip；check 0 errors／warnings，Impeccable 靜態 detector exit 0／無輸出。正式入口 100.01 KB、editor 495.79 KB；MathLive 800.66 KB 警告保留，門檻未提高。無 dependency／lock／根授權變更，未操作桌面或 commit／push。前批真 Tectonic 與 host 結果不冒稱本輪重跑。
