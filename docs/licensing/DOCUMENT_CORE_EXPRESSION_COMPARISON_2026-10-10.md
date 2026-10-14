# 來源核心有限範圍對照

日期：2026-10-10。用途：記錄可由目前原始碼重現的結構差異與未解事項，不核准改授權。

## 範圍與證據

新版七個核心檔案已逐檔閱讀；舊版 parser、types、index 已完整閱讀，converter 僅檢查 createHeading 與 latexToProseMirror 周邊及 handler 宣告位置。未比較舊版完整編輯器、歷史提交或第三方實作。

| 新版 | 本地舊版對照 | 確認內容 |
| --- | --- | --- |
| parser.ts：parseSource | parser.ts：parseLatex、createLatexParser | 新版以本地 command／balanced／parse 掃描並產生 SyntaxNode；舊版呼叫 unified 管線或 getParser。這是入口與資料結構差異，不是獨立創作證明。 |
| parser.ts：heading 分支 | converter.ts：createHeading | 新版建立含 span／children 的 heading 語法節點；舊版 getMacroFirstArg→convertNodesToInline→el('heading') 產生 PMNode。兩者同樣處理標準 LaTeX 章節指令。 |
| source.ts：SourceDocument | 指定四個舊版檔案未提供完整對等範圍 | 新版持有不可變 pieces、原始 bytes，apply 先驗證交易，restore 保留 origin 並增加版本。不能因此宣稱整個舊版沒有類似資料管理。 |
| utf8.ts：segment、byteBoundary | 同上 | 新版以 Uint32Array 記錄 UTF-16 邊界到 UTF-8 byte 位移，拒絕拆開 surrogate；這是通用編碼處理，不以演算法相同或不同判斷作者來源。 |
| changes.ts：mapPosition、remapSpan | 同上 | 新版按 SourceChange 的插入長度與替換範圍映射位置，檢查 documentId／version；本次沒有跨舊版其他目錄的比較。 |
| editor-projection.ts：EditorProjection | 同上 | 新版記錄 CRLF 壓縮位置，以二分搜尋映射 LF editor 座標，局部處理重新相鄰的 CR/LF；未對照完整舊版 editor state。 |
| projection.ts：projectionIsCurrent | 同上 | 新版只比對 documentId／version；不宣稱舊版其他模組不存在這個概念。 |
| index.ts | 舊版 index.ts | 新版從六個模組匯出來源／投影 API；七個受審檔案包含 index 本身。舊版另匯出 unified AST、ast-utils 與 ProseMirror converter。 |

## 更正未採用的交付結論

- 不採用「無文字片段重合」：交付未附完整逐片段比較證據，且本次 converter 只讀指定片段。
- 不採用「新版從七個模組匯出」：實際是六個模組，index 為第七個檔案。
- 不採用「span 為 byte 位移」：parser 從 document.read() 的字串索引建立 span；來源座標是 UTF-16 code units，byteBoundary 才映射到 bytes。
- 不把含 `{ ... }` 的縮寫當作可逐字驗證的舊版引文。parseSource 的預算預設確為 maxNodes 32768、maxSteps 8_000_000，但這不提供原創性證據。

## 未完成事項

1. 巨集子集、錯誤降級策略與編輯器座標規格的來源證據，仍需與功能規格／允許的官方文件逐項對應。
2. 新版 source、changes、utf8、editor-projection 與舊版編輯器其他目錄的合理對照尚未完成；不得以此次範圍缺少對應檔案作來源獨立性結論。
3. 生產 bundle 的傳遞依賴、素材／字型／CSS 來源閉包及獨立審查仍待完成。套件維持 private UNLICENSED，桌面 AGPL 邊界与 0.1.0 不變。

## 讀取快照

SHA-256 用於識別這次實際檔案；檔案改動後應重新比對，不把舊摘要當現況。

| 檔案 | SHA-256 |
| --- | --- |
| `packages/document-core/src/parser.ts` | `D1EE61BE66EBC50AB5D657CA36949624C5094719AB0927C52AC39433D3D0BE1B` |
| `packages/document-core/src/source.ts` | `FA59FE2F9198B8E6CA48688AF13B53841E2C716ED43A077BBAE09308B15FDFE1` |
| `packages/document-core/src/utf8.ts` | `F2E6FE2774799C689CE45484EA30F047E620590EEC6F4D908E9417B77CBF8321` |
| `packages/document-core/src/changes.ts` | `C8645D7281EF9BCF573658F079E56A5CB89CB0D4CAF5EBED5B41E3398DEFE7B0` |
| `packages/document-core/src/editor-projection.ts` | `8B936F2680D3360C5E1B252628B05FAE565BA0625B2C9E7C27961A8B53220209` |
| `packages/document-core/src/projection.ts` | `AF658318B5CFFA7B304610759BEC6A1F0EF608016AAC8994A4CAAC03D023FF4E` |
| `packages/document-core/src/index.ts` | `D7E86A9C9BB43FE109F5032FDC3993043F3A4D5B165E062B3C7AA2ACD86AD982` |
| `apps/editor-legacy/src/lib/latex-parser/parser.ts` | `CD925ECEBF0FEA07C769F369AAE9C701E9928BC9177D4424EE2679BCD71CEF51` |
| `apps/editor-legacy/src/lib/latex-parser/converter.ts` | `DF9F27B7E88ECC846B3BAD3BCD591D6CF5B10D697E463D7A7495667E02098455` |
| `apps/editor-legacy/src/lib/latex-parser/types.ts` | `9FDC532EB69A5E7A6FDBAFCEB0548FCB7E15F8AEC6D603BC61809DA553134226` |
| `apps/editor-legacy/src/lib/latex-parser/index.ts` | `A0DCB25471709F67156652E464DE7A359FFF9C75E9074B85B930693ECBDDA689` |

依據：[核准計畫](../architecture/FRONTEND_REWRITE_PLAN.md)、[來源台帳](frontend-origin.json)。
