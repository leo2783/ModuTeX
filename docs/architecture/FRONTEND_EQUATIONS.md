# 公式輸入與重編輯

數學入口合併行內公式、公式儲存格與矩陣。公式直接在文件內編輯，展開選單提供 191 個項目；原始碼模式仍可編輯 LaTeX。不提供數學鍵盤入口，確認綠色、取消紅色。完整收據及最新驗證見 [數學與內容編輯驗收](FRONTEND_MATH_PARITY_2026-10-11.md)。

| 路徑 | 行為與限制 |
| --- | --- |
| math/catalog.ts | 共用原創功能目錄；包含 lim、積分／微分、希臘字母、集合、多行函數與矩陣運算。文件內與來源面板共用。 |
| math/inline.ts | 文件內 MathLive 草稿；選單只更新草稿，確認才提交。未填空格拒絕提交，取消不改來源。 |
| math/source.ts／editor.ts | 從當前 parser spans 回讀四種公式分隔符；拒絕未知環境、未閉合及過期身份。無修改回 null；修改走 CodeMirror 交易及精確 undo。 |
| source-editor/SourceView.svelte | 行內公式捕捉真實文字游標；公式／矩陣儲存格使用 Notebook 插入位置。套件與內容同一筆 undo。 |
| math/MathInput.svelte | 原始碼模式的視覺輸入，共用目錄與公開 MathLive API，局部草稿與原文欄位同步。 |
| visual-editor/schema.ts／view.ts | $…$／\(…\) 為真正 inline atom；$$…$$／\[…\] 為 block atom。普通文字交易不得改寫公式。 |
| math/render.ts | 本地延遲載入，viewport 內才建立唯讀欄位；generation 防止過期 import，卸載移除 observer／listener／欄位。 |
| tables/preamble.ts | 核對缺少的 amsmath／amssymb，套件與公式組合成原子來源交易；未知前言不猜測改寫。 |

初始化使用 silent setValue，不把函式庫正規化值回寫來源。公式上限 65,536 UTF-16 單位；超限保留 Raw 或拒絕輸入。保存分隔符、BOM、周邊原始 bytes 與來源換行策略；未知語法不被普通文字或格式交易吞掉。

固定 MathLive 0.110.0，使用本地字型與 CSS，不使用 CDN、不改 CSP。上游大型模組仍延遲載入；建置 warning 不當作已完成全部效能驗收。第三方來源閉包與整體應用授權維持既有審查範圍。

原生 Electron fixture 將所有目錄模板空格替換為 x，使用真 Tectonic 編譯並驗證 PDF 像素；真 Chrome 驗證行內位置、希臘字母、分類展開及確認／取消。任意使用者 macro、套件或語法是否有效，仍依真編譯結果顯示原因。
