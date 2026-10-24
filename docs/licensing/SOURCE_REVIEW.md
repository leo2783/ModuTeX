# 來源、授權範圍與證據

更新：2026-10-18。本文件整併日期審查；實際授權全文維持在各套件 LICENSE／NOTICE、`apps/frontend/THIRD_PARTY_NOTICES.md`、`LICENSES` 與 `vendor/notices`。

## 已確認範圍

- 2026-10-12 owner 決定：`apps/frontend`、`packages/document-core`、`packages/frontend-contracts` 的自有 source／tests／build scripts 與自有矩陣程式採 Apache-2.0；private 屬性不變。完整路徑例外見 [LICENSING](../../LICENSING.md)。舊審查的自有碼 UNLICENSED 狀態已被此決定取代。
- Electron／legacy 與歷史 AGPL 發行保留原授權；第三方 runtime、字型、WASM、素材各保留原條款。Tauri 新自有碼採 Apache，分發閉包依[遷移計畫](../architecture/TAURI_APACHE_MIGRATION_PLAN_2026-10-17.md)驗收。
- 2026-10-04 `vendor-manifest.mjs`／test 的 Apache 範圍以基準 `6c11ff87`、Texpile `8bf1ca1c` 盤點。其他 Electron compiler／integrity／diagram／contracts／tools 是候選項，不能由此批次整體改授權。

## 來源比較與尚待完成項

2026-10-07 前端審查涵蓋當時來源與 imports；Home／Help／Release Notes 另由 root 閱讀 callback／安全文字處理。作者曾讀舊來源，不採嚴格 clean-room 主張；靜態 import 沒有 AGPL 不等同完成歷史表達比較。

document-core 保存 bytes／BOM／EOL、不可變 pieces、交易／restore 與 UTF-16 邊界；parser 超預算保留 Raw，`parseSource` 仍透過 `document.read()` 配置完整字串。2026-10-10 比較七個新檔與舊 parser／types／index，converter 只讀 createHeading／latexToProseMirror 周邊：新版是 SyntaxNode／span，舊版是 unified／PMNode；index 從六個模組匯出。span 是 UTF-16 units，byteBoundary 才映射 bytes。

未採用「無文字片段重合／整個舊版無對等功能」等未具證據結論。尚需完成巨集子集、錯誤降級、編輯座標與舊 editor 其他目錄的合理對照，以及實際發行素材／依賴閉包。

## 台帳與產物追蹤

- [frontend-origin.json](frontend-origin.json)：前端逐項來源／審查；[tauri-origin.json](tauri-origin.json)：Tauri 檔案來源與基準 hash。來源變更後重新核對，不將歷史摘要當目前 bytes。
- collector `frontend-artifacts` 以 realpath 限制 source／emitted containment，解析 TS AST 與已知 `?url` wrapper，逐檔 hash 唯一匹配；未知／不符／多重匹配拒絕。query 變體與 canonical dedupe 仍需完整覆蓋，source map 不能代表全部 runtime。
- 2026-10-12 `ed3acae` 曾掃描 74 sources／0 static violations；53 MIT、1 Apache、3 UNLICENSED、1 root AGPL 是當時 heuristic 分類。root AGPL 實為 generated MathLive runtime 的 nearest-package 歸類，bytes 匹配 MIT 上游；不能把 heuristic 當實際 AGPL import，也不能據此宣布全部來源結案。
- PDF.js 6.2.108 預建 worker 曾核對 2222991 bytes、SHA-256 `1a7607f28cfbc63f0e4e0a41927c89f991e353e4f3fb4565ecfd621ac5975089`；無 map 的預建 JS 仍須 notices。不同批次產物／source 數量是歷史快照，不作目前數量。
- 本機證據：`.verification-artifacts/frontend-origin/artifacts.json`、`.verification-artifacts/frontend-agpl-review-20261012.json`。`verify-frontend-origin` 維持未結案門檻，直到來源比較、素材／CSS／字型、內嵌 notices、runtime SBOM／來源包完成。

## 第三方處理

| 元件                                                                                                 | 已確認條款／處理                                                                                                       |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| CodeMirror language 6.12.3／state 6.7.0／view 6.43.2；Lezer common 1.5.2／highlight 1.2.3／lr 1.4.10 | MIT；lr 未在特定 SourceView chunk map 出現不代表整個 bundle 不含它                                                     |
| ProseMirror、Svelte 5.56.9、MathLive 0.110.0                                                         | MIT；ProseMirror 版本更新見[依賴紀錄](../reference/REPOSITORY.md)                                                      |
| MathLive input-only runtime                                                                          | 固定上游、移除虛擬鍵盤；保留 notices、maps、字型，依生成 bytes 驗來源                                                  |
| PDF.js 6.2.108                                                                                       | Apache-2.0，Mozilla notices 隨 worker 分發                                                                             |
| MathLive 20 WOFF2                                                                                    | 字型內 name IDs 0／13／14 含 copyright、OFL 1.1／Reserved Font Name／URL；字型未修改，不由 MIT code 或專案 Apache 取代 |
| Tectonic 0.17.0／Typst WASM wrapper                                                                  | MIT engine／Apache wrapper；實際 target／feature／runtime 傳遞閉包尚待完成                                             |
| Draw.io 31.1.8                                                                                       | Apache 核心、libavoid LGPL-2.1、模板 CC-BY-4.0、Atlassian stencil 限制；排除新 Tauri 核心                              |
| Lightning CSS／Poppins／file icons                                                                   | MPL-2.0／OFL-1.1／MIT（Material Icon Theme 5.37、LaTeX Workshop 10.16）                                                |
| Google logo 等來源未明素材                                                                           | 依台帳補來源或替換，不標記已結案                                                                                       |

## 字型 bytes 證據

MathLive 0.110.0 的 20 WOFF2 與官方 commit `b0a4b033997d897970e40da9ad9a0ad90358a198` 的 `css/fonts` Git blobs 相同；LICENSE blob `97ba1353dc3d2a84eb6e064a39b3e92664d7f09c`。實際 name tables 由 fontTools 解碼，完整 declarations／SHA-256 見 [frontend-font-metadata.json](frontend-font-metadata.json)，重現用 [font-metadata.py](../../scripts/licensing/font-metadata.py)。全文在 [OFL-1.1.txt](../../LICENSES/OFL-1.1.txt) 及 frontend notices。KaTeX fonts `56e79c93c88c9054b017cc92e496b383e0bf82d7` 的不同 blobs 不作本批 bytes 證據。

| Font basename (all `.woff2`) | Git blob ID                                |
| ---------------------------- | ------------------------------------------ |
| KaTeX_AMS-Regular            | `0acaaff03d4bb7606de02a827aeee338e5a86910` |
| KaTeX_Caligraphic-Bold       | `f390922eceffe1f6dfb81a3dc086a92d98171b02` |
| KaTeX_Caligraphic-Regular    | `75344a1f98e37e2c631e178065854c3a81fb842f` |
| KaTeX_Fraktur-Bold           | `395f28beac23c7b0f7f3a1e714bd8dac253dd3bc` |
| KaTeX_Fraktur-Regular        | `735f6948d63c8cc7f8233735bb9c8d843c83d804` |
| KaTeX_Main-Bold              | `ab2ad21da6fbe6c171bb869240954d0ead8f68fd` |
| KaTeX_Main-BoldItalic        | `5931794de4a2a485fa70099bf2659b145976d043` |
| KaTeX_Main-Italic            | `b50920e138807f385d0b0359f4f0f09891f18406` |
| KaTeX_Main-Regular           | `eb24a7ba282b03d830fa6c63ee897d92a5188736` |
| KaTeX_Math-BoldItalic        | `29657023adc09956249f6295746c8ce4469b50d3` |
| KaTeX_Math-Italic            | `215c143fd7805a5c2b222bd7892a1a2b09610020` |
| KaTeX_SansSerif-Bold         | `cfaa3bda59246b49e94298478d6de3b3208066c8` |
| KaTeX_SansSerif-Italic       | `349c06dc609f896392fd5bc8b364d3bc3efc9330` |
| KaTeX_SansSerif-Regular      | `a90eea85f6f7bded69ff5d40114447a6d8b48cfe` |
| KaTeX_Script-Regular         | `b3048fc115681ee6c1bc86b0aa158cfbbf59daa3` |
| KaTeX_Size1-Regular          | `c5a8462fbfe2c39a7c1857b9e296e62500a8a8a5` |
| KaTeX_Size2-Regular          | `e1bccfe2403a4ed770c1697ae7c15b9e1cd9bc4e` |
| KaTeX_Size3-Regular          | `249a28662218a7a17ad8bd1fe072169ecb666a49` |
| KaTeX_Size4-Regular          | `680c13085076a2f6c5a7e695935ec3f21cddb65f` |
| KaTeX_Typewriter-Regular     | `771f1af705f5cef5f578b3a1e7d8eff66f9b76b0` |

## 2026-10-10 核心讀取快照

| 檔案                                                   | SHA-256                                                            |
| ------------------------------------------------------ | ------------------------------------------------------------------ |
| `packages/document-core/src/parser.ts`                 | `D1EE61BE66EBC50AB5D657CA36949624C5094719AB0927C52AC39433D3D0BE1B` |
| `packages/document-core/src/source.ts`                 | `FA59FE2F9198B8E6CA48688AF13B53841E2C716ED43A077BBAE09308B15FDFE1` |
| `packages/document-core/src/utf8.ts`                   | `F2E6FE2774799C689CE45484EA30F047E620590EEC6F4D908E9417B77CBF8321` |
| `packages/document-core/src/changes.ts`                | `C8645D7281EF9BCF573658F079E56A5CB89CB0D4CAF5EBED5B41E3398DEFE7B0` |
| `packages/document-core/src/editor-projection.ts`      | `8B936F2680D3360C5E1B252628B05FAE565BA0625B2C9E7C27961A8B53220209` |
| `packages/document-core/src/projection.ts`             | `AF658318B5CFFA7B304610759BEC6A1F0EF608016AAC8994A4CAAC03D023FF4E` |
| `packages/document-core/src/index.ts`                  | `D7E86A9C9BB43FE109F5032FDC3993043F3A4D5B165E062B3C7AA2ACD86AD982` |
| `apps/editor-legacy/src/lib/latex-parser/parser.ts`    | `CD925ECEBF0FEA07C769F369AAE9C701E9928BC9177D4424EE2679BCD71CEF51` |
| `apps/editor-legacy/src/lib/latex-parser/converter.ts` | `DF9F27B7E88ECC846B3BAD3BCD591D6CF5B10D697E463D7A7495667E02098455` |
| `apps/editor-legacy/src/lib/latex-parser/types.ts`     | `9FDC532EB69A5E7A6FDBAFCEB0548FCB7E15F8AEC6D603BC61809DA553134226` |
| `apps/editor-legacy/src/lib/latex-parser/index.ts`     | `A0DCB25471709F67156652E464DE7A359FFF9C75E9074B85B930693ECBDDA689` |
