# Editing / 編輯指南

Source and Visual modes share document bytes and undo history.
原始碼與視覺模式共用文件內容及復原記錄。

## Cells and text / 儲存格與文字

Click a cell, place the caret, then use a tool to insert content without replacing existing text.
Drag the left handle to reorder cells; the pickup and drop markers show the movement.
The boundary `+` menu explicitly creates a separate cell.
點選儲存格並放置游標後，工具在游標處插入內容；拖曳左側把手可排序，邊界 `+` 選單則另外新增儲存格。

Choose body text, paper title, abstract or heading level from the structure menu.
Changing structure retains the cell's content and starts a new cancel-edit checkpoint. Each insertion above a heading or abstract adds one cell.
Text wraps with available width. Enter in a heading continues as body text within the same cell. Moving or deleting that cell includes all its content. Text and abstract cells retain line breaks. The outline displays heading text without formatting commands.
文字依可用寬度換行。標題內按 Enter 後接續正文，仍在同一儲存格；移動或刪除作用於整格內容。正文與摘要支援格內換行。大綱顯示標題文字，省略格式指令。
切換層級會保留儲存格內容，並重新建立取消編輯的起點。在標題或摘要上方插入文字時，每次只新增一格。

## Math / 數學

Choose inline math to stay in the current text, or display math for a centered expression.
Select a category before its graphical template, or search for `lim`, `dx` or a symbol.
Click an existing equation to edit it. Matrices use the same math input and support mixed expressions,
scripts and row/column size controls.
行內公式留在文字中，獨立公式置中。先選種類再選圖形模板，也可搜尋 `lim`、`dx` 或符號。
點選既有公式可再編輯；矩陣共用數學輸入，支援混合式子、上下標及行列尺寸調整。

## Other content / 其他內容

| Content       | Operation / 操作                                                                                                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Table / 表格  | Click to edit rows, columns, widths, borders, header and caption. / 點選編輯行列、欄寬、框線、表頭及說明。                                                                                  |
| Code / 程式碼 | Choose a language. Above 100,000 UTF-16 units, the complete code stays literal text without automatic highlighting. / 選擇語言；超過 100,000 個 UTF-16 units 時保留完整純文字，不自動高亮。 |
| Image / 圖片  | Insert or Ctrl+V PNG/JPEG; select its cell and Ctrl+C to copy. Input limit: 5 MiB. / 插入或 Ctrl+V 貼上 PNG/JPEG，選取圖片格後 Ctrl+C 複製；輸入上限 5 MiB。                                |

Save to persist image assets with the workspace. Unsupported commands remain editable in Source mode.
儲存可將圖片資產保存到工作區；不支援的語法仍可在原始碼修改。

## Shortcuts / 快捷鍵

| Keys                  | Action / 操作                                                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Ctrl+O / Ctrl+S       | Open / Save · 開啟／儲存                                                                                                    |
| Ctrl+Z / Ctrl+Shift+Z | Undo / Redo · 復原／重做                                                                                                    |
| Ctrl+Enter            | Compile PDF; configurable. / 編譯 PDF，可在設定調整。                                                                       |
| Escape                | Cancel a draft or enter cell navigation. / 取消草稿或進入儲存格導航。                                                       |
| Delete / Backspace    | Delete a cell in cell navigation mode, with confirmation for nonempty content. / 在儲存格導航模式刪除整格，非空內容需確認。 |
| Up / Down             | Navigate selected cells. / 導航選取儲存格。                                                                                 |
| Alt+Up / Alt+Down     | Move the selected cell. / 移動選取儲存格。                                                                                  |

[Compilation / 編譯](COMPILATION.md) · [Limitations / 限制](KNOWN_LIMITATIONS.md)
