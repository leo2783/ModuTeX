# Fixture inventory

這份清單對照 `IMPLEMENTATION_PLAN.md` 的測試案例與目前可直接供 production
測試使用的 fixture。清單只記錄實際檔案；尚未實作的 Wave 2/3 案例標為待建立，
不以 mock 取代 production path。

## Wave 1：編輯與 round-trip

| 計畫案例                                     | 現有來源                                                                                             |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| verbatim、巢狀外觀、comment environment      | `unit/lib/latex-parser/fixtures/verbatim-cases.tex`（由 `unit/testFixtures.ts` 依 CASE marker 載入） |
| LaTeX parser、serializer、局部編輯與未知語法 | `unit/lib/latex-parser/*.test.ts`、`unit/lib/serializer/*.test.ts`、`unit/lib/editor/*.test.ts`      |
| 字型與語言頁面輸出                           | `lang/{cjk-ttc,arabic-rtl,hebrew-rtl,greek,fontspec-space,cm-baseline}.{tex,jsonl,pages.json}`       |
| LaTeX log 錯誤、警告與 BibTeX/Biber          | `unit/lib/latex-log/fixtures/*.{log,blg}`                                                            |

## Live compile

| 計畫案例                        | 現有來源                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------- |
| 基本文件、兩頁、CJK、浮動物件   | `live/fixtures/{basic,twopage,cjk,floats}/`                                           |
| Beamer、book 文件               | `live/fixtures/{beamer,bookdoc}/main.tex`                                             |
| 多檔案教學、圖片與 bibliography | `live/fixtures/tut/{main.tex,basics.tex,math-and-figures.tex,references.bib,images/}` |

## Wave 2：Mermaid／Draw.io

計畫要求正常、繁中、錯誤、離線、大小上限、逾時、sidecar 遺失與 relink
案例。目前基線尚未有 diagram fixture；待對應 production parser/UI 完成後，
應新增真實 `.mmd`、`.drawio`、SVG/PDF sidecar 及錯誤輸出，並以斷網流程驗證。

## Wave 3：Tectonic

計畫要求首次套件下載同意、離線快取、拒絕下載、timeout、取消與 hash mismatch。
目前基線尚未有 managed Tectonic fixture；待 toolchain production path 完成後
再加入固定版本、真實輸出與 checksum 案例。

## 使用規則

- fixture 必須由 production parser、renderer、compile 或 log path 讀取；不得以 mock
  取代這些流程。
- 語言 fixture 的 `.jsonl` 與 `.pages.json` 由指定 capture script 產生，路徑欄位
  不作固定斷言。
- 新增案例時更新本清單，並在測試命令中列出實際檔案與 pass condition。
