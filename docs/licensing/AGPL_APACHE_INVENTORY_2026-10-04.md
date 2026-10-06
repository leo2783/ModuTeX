# AGPL／Apache-2.0 來源盤點

盤點基準：dev `6c11ff87f287ffa42a4cfd84a18ca7672809280a`；固定上游 Texpile `8bf1ca1c318b64b2e9531247116d8d2d5dbe6d97`。使用者於 2026-10-04 授權局部改授權，並確認持有 ModuTeX 原創碼的改授權權限。此聲明不涵蓋 Texpile、第三方或來源未明的片段。本檔是技術來源盤點，不是法律意見或無侵權保證。

## 第一批已修改的授權範圍

| 檔案 | 來源證據 | 本批變更 |
|---|---|---|
| `scripts/vendor/vendor-manifest.mjs` | 上游無此檔；`9ce5e11` 新增、`133cb52` 修正；無 imports，固定 metadata 與 schema 驗證 | Apache-2.0 SPDX；程式邏輯不變 |
| `scripts/vendor/vendor-manifest.test.mjs` | 同上；僅 Node、同 validator 及本專案 manifest fixture | Apache-2.0 SPDX；fixture／第三方授權不變 |

完整來源審查未見上游應用依賴或可見搬移片段，並結合使用者的權利聲明限定授權。全文與精確例外見 [LICENSING.md](../../LICENSING.md)；獨立使用這兩個工具可依 Apache-2.0，整個桌面應用及未列名的檔案沒有因此改成 Apache。

## 後續原創候選：尚未改授權

| 範圍 | 已查來源 | 正式改授權前的工作 |
|---|---|---|
| `electron/src/tectonic-integrity.ts`、`tectonic-runtime.ts` | `61c1124` 新增；Node／本地 integrity imports | 逐檔記錄來源與權利、保留 Tectonic notice；與 compiler／上游 glue 分開 |
| `electron/src/managed-compile.ts` | `7378a90` 新增；Node、contracts、runtime imports | 核對契約來源及搬移片段，明列獨立重用範圍；main／preload 接線不連帶換授權 |
| `electron/src/diagram-security.ts`、`diagram-service.ts`、`diagram-publication.ts`、`diagram-pdf.ts` | 新增紀錄 `aa1bc36`／`cf9794e`／`498a7a0` | 各模組來源／依賴審查後逐檔授權，保留 Electron／上游接線邊界 |
| `electron/src/diagram-svg.ts`、`drawio-vector-source.ts`、`diagram-cpu.ts`、`diagram-cpu-worker.ts` | 新增模組；使用 `@xmldom/xmldom`／Draw.io 格式，worker 新增於 `89e38b1` | 區分原創 validator 與第三方解析器／vendor；檢查引用片段與 fixtures |
| `packages/modutex-contracts` | `65aca53` 新增，後有 `fda7b46`／`20e5748`／`7378a90` 修改 | 比對完整宣告來源；三個通用 engine literals 與上游相同，不據此斷言整包衍生或侵權。完成審查再建立 package 授權與 SPDX |
| `scripts/verify-install-policy.mjs`、`run-verification.mjs` | 新增於 `89ec3f4`／`6b85693` | 檢查是否引用上游／套件程式、逐檔設定授權；工具呼叫 AGPL 程式不等於已完成整體切割 |
| `scripts/stage-npm-desktop.mjs`、`verify-npm-desktop.mjs`及新增 vendor verifier | `ad40a83` 等新增 | 工具自身授權與其產出的 AGPL app metadata／source offer 分開；不能為了工具改授權而移除 app 的 AGPL gate |
| 原創文件、fixture、圖示 | 新增檔名／Git author 不足以證明內容全原創 | 逐項確認素材、文字、樣本來源及生成來源；不能把 `docs/**` 或 `tests/**` 一次整批改標 |

上述候選的 Git 作者線索是 Leo Lo，但改授權依據是使用者的權利聲明及內容來源審查，不是 author 欄位。候選不等於已獲 Apache 授權。

## 保留 AGPL 或取得原權利人同意／替換

| 範圍 | 原因 | 後續移除 AGPL 的方法 |
|---|---|---|
| `apps/texpile-editor/src/lib/editor/**`、converter／serializer／schema／round-trip 與其修改 | Texpile 上游編輯器及衍生修改；改 UI 或品牌不消除來源義務 | 向相關權利人取得改授權同意，或按獨立規格另行實作並留下來源紀錄；不能翻寫檔名／重排程式冒充重寫 |
| `apps/texpile-editor/src/lib/workspace/**`、來源模式／PDF／GUI／語系的既有檔案 | 上游應用及其整合介面仍在 | 新版前端／狀態管理採原創或允許的第三方實作；逐一替換，不複製現有實作後只換標頭 |
| `electron/src/main.ts`、`preload.ts`、`fs-service.ts`、`fs-watch.ts`、`draft-*`、`mcp/**`、`toolchain.ts`、`typst-*`、`window-chrome.ts`及既有服務 | 上游已有；例如 watcher `049adaa`／`d46b4b7` 本輪僅修改 | 重建必要 main／preload／IPC／檔案服務並獨立驗證；新模組 Apache 不授權這些既有檔案 |
| `scripts/build-electron.mjs`、`after-pack.cjs`、上游 landing／既有 docs 與素材 | 上游既存；局部修改不授予整檔改授權權限 | 保留現有條款，或使用原創替代；第三方素材另外按自身條款處理 |
| 根 `LICENSE`、桌面 `package.json`／production metadata／SOURCE-OFFER | 現有分發物仍包含 AGPL 衍生程式 | 在實際移除／取得所有相關授權前維持 AGPL；不能先換 package license 再補來源檢查 |

## 已有第三方授權：保留，不算本專案改授權

| 元件／素材 | 固定來源與實際授權範圍 | 注意事項 |
|---|---|---|
| Draw.io | `31.1.8`；主程式 Apache-2.0；`vendor/vendor-lock.json`／`vendor/notices/DRAWIO-*` | `js/libavoid-js/LICENSE` 是 LGPL-2.1；templates 是 CC BY 4.0；img／shapes／stencils 禁止未經書面許可用於 Atlassian 產品／生態系，終端圖表輸出不受該限制。不能把整包一概改標 Apache |
| Tectonic | Windows x64 `0.17.0`；本專案保留 MIT LICENSE 與官方 binary | 未修改 binary；第三方元件閉包尚無逐元件清單，不宣稱 binary 只有 MIT |
| Typst WASM wrapper | `packages/typst-syntax-wasm/package.json`／`Cargo.toml` 已宣告 Apache-2.0 | 上游既有明確例外，不是此次從 AGPL 轉出；`Cargo.lock` 的完整 Rust 依賴授權仍需盤點 |
| PDF.js | `draft/type1/README.md` 保留 `v5.7.284` 的五個 Type1 檔案；`pdfjs-dist@6.2.108` lock metadata 為 Apache-2.0 | 適配檔保留 Mozilla 標頭；兩個來源版本不能混為一個 |
| Fileicons／LaTeX completion | Material Icon Theme `5.37.0`、LaTeX Workshop `10.16.1`，各有本地 MIT notice | 保留 `fileicons/NOTICE.md` 及 `intellisense/data/VENDORED-LICENSES.md`；不改成自有 Apache 素材 |
| Lightning CSS／Poppins | lock metadata：`lightningcss@1.32.0`／Vite 內 `1.33.0` 為 MPL-2.0；`@fontsource/poppins@5.2.7` 為 OFL-1.1 | npm／字型不是此次換授權對象；仍有自身條款 |
| 其他素材 | GoogleLogo、editor／logo 資產的逐項來源授權本輪尚未確認 | 列待查，不因沒有標頭就當成原創或 permissive |

`package-lock.json` 中 957 個 `node_modules` 記錄未出現 AGPL／GPL／LGPL metadata，但根 metadata 仍是 AGPL，且 Draw.io 內有 LGPL 元件。24 筆 Lightning CSS 記錄包括平台套件；不能以筆數作程式比例。8 筆無 license 欄位：四個第三方 `@inlang/plugin-m-function-matcher@2.2.9`、`@inlang/plugin-message-format@4.4.0`、`rechoir@0.6.2`、`sqlite-wasm-kysely@0.3.0`，及四個 workspace links。欄位缺失不代表可自由換授權；這不是完整 npm／Rust／native binary 授權閉包審查。

## 逐步替換順序

1. 建立此逐檔授權清單；先處理獨立原創工具，再審 compiler／contracts／diagram modules。每批保留 exact SHA、來源、權利確認及 PR。
2. 新儲存庫若要以 Apache-2.0 為主要授權，先建立乾淨的原創應用骨架，移入已明確授權的模組及允許的第三方依賴；不要把現有整包 fork 搬過去後改根 LICENSE。
3. 優先替換上游 editor／converter／serializer／workspace 與 main／preload；以功能規格及合法取得的測試資料驗證，不把 AGPL 實作拆散改寫後宣稱來源已消失。
4. 審查分發與依賴閉包、生成物、圖片／字型／stencil／WASM，保留其他必要 LICENSE／NOTICE。AGPL 清除完成不代表第三方全變 Apache。
5. 最後再更新整體 package metadata／source offer／CI 授權驗證與發布文件；原 AGPL 版本的既有使用者授權不撤銷。對組合／衍生邊界有爭議的部分，發布前請專業授權審查。

依據：[AGPL 第 4–6 節](https://www.gnu.org/licenses/agpl-3.0.html)、[GNU 授權 FAQ](https://www.gnu.org/licenses/gpl-faq.en.html)、[Apache-2.0 第 4 節](https://www.apache.org/licenses/LICENSE-2.0)。授權新原創模組不解除 AGPL 衍生作品的整體義務；是否獨立作品須依實際組合判斷，不能以檔案／目錄／行程分開作唯一判準。

## 最小驗證

固定 Node 24.19.0 執行 `node --test scripts/vendor/vendor-manifest.test.mjs`：21/21 通過，零略過；兩個程式檔只加註解。Apache 全文 SHA-256 與保留的官方 vendor 文字相同：`aa96f93cf345d3419677ff9061de26e389ed511502ec2681e9d7e03fa980510d`。根 LICENSE、package metadata、lockfile 與第三方 notices 未修改。PR／CI 狀態另以實際 GitHub 紀錄為準。
