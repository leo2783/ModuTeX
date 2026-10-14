# 前端第三方依賴實體授權證據清冊 (2026-10-07)

基準分支：`refactor/frontend`
採集時間：2026-10-07
採集方式：**直接讀取本地 `node_modules/` 磁碟實體授權文件與標頭註解（無猜測、無外部網路推導、無虛構條款）**
目的：供後續建立 `apps/frontend/THIRD_PARTY_NOTICES.md` 及獨立授權審查提供實體證據對照。

---

## 1. 第三方依賴實體證據總表 (Evidence & Notice Obligations Table)

| 套件名稱 (Package) | 安裝版本 | 本地磁碟實體授權文件路徑 | 宣告授權類別 | 實體揭露義務 (Notice Obligations) | 磁碟查驗狀態與缺漏分析 (Status & Gaps) |
|---|---|---|---|---|---|
| **mathlive** | `0.110.0` | `node_modules/mathlive/LICENSE.txt` | MIT | 須保留版權聲明與許可文字於分發物中。 | **程式碼授權齊全；字型授權缺漏**：磁碟內含 20 份 `fonts/KaTeX_*.woff2`，但安裝目錄內**無任何字型授權檔（無 OFL.txt）**。 |
| **pdfjs-dist** | `6.2.108` | `node_modules/pdfjs-dist/LICENSE`<br>`build/pdf.worker.mjs` (L1–21) | Apache-2.0 | 須保留 Apache-2.0 條款、Mozilla Foundation 版權聲明及 worker 標頭 notices。 | **齊全**：包含完整 Apache-2.0 授權文件與 worker 內嵌之 `@licstart ... @licend` 版權聲明。 |
| **@codemirror/language** | `6.12.3` | `node_modules/@codemirror/language/LICENSE` | MIT | 須保留 Marijn Haverbeke 及其他人版權聲明與 MIT 條款。 | **齊全**：實體 LICENSE 存在。 |
| **@codemirror/state** | `6.7.0` | `node_modules/@codemirror/state/LICENSE` | MIT | 須保留 Marijn Haverbeke 及其他人版權聲明與 MIT 條款。 | **齊全**：實體 LICENSE 存在。 |
| **@codemirror/view** | `6.43.2` | `node_modules/@codemirror/view/LICENSE` | MIT | 須保留 Marijn Haverbeke 及其他人版權聲明與 MIT 條款。 | **齊全**：實體 LICENSE 存在。 |
| **@lezer/common**<br>(轉導相依) | `1.5.2` | `node_modules/@lezer/common/LICENSE` | MIT | 須保留 Marijn Haverbeke 及其他人版權聲明與 MIT 條款。 | **齊全**：實體 LICENSE 存在。 |
| **@lezer/highlight**<br>(轉導相依) | `1.2.3` | `node_modules/@lezer/highlight/LICENSE` | MIT | 須保留 Marijn Haverbeke 及其他人版權聲明與 MIT 條款。 | **齊全**：實體 LICENSE 存在。 |
| **prosemirror-model** | `1.25.9` | `node_modules/prosemirror-model/LICENSE` | MIT | 須保留 Marijn Haverbeke 及其他人版權聲明與 MIT 條款。 | **齊全**：實體 LICENSE 存在。 |
| **prosemirror-state** | `1.4.4` | `node_modules/prosemirror-state/LICENSE` | MIT | 須保留 Marijn Haverbeke 及其他人版權聲明與 MIT 條款。 | **齊全**：實體 LICENSE 存在。 |
| **prosemirror-view** | `1.41.9` | `node_modules/prosemirror-view/LICENSE` | MIT | 須保留 Marijn Haverbeke 及其他人版權聲明與 MIT 條款。 | **齊全**：實體 LICENSE 存在。 |
| **svelte** | `5.56.9` | `node_modules/svelte/LICENSE.md` | MIT | 須保留 Svelte Contributors 版權聲明與 MIT 條款。 | **齊全**：實體 LICENSE.md 存在。 |

---

## 2. 磁碟實體授權文本精確抄錄 (Verbatim License Texts on Disk)

以下內容均完整抄錄自專案 `node_modules/` 內部實體檔案：

### 2.1 MathLive (0.110.0)
* **實體檔案**：[node_modules/mathlive/LICENSE.txt](../../node_modules/mathlive/LICENSE.txt)
```text
Copyright (c) 2017 - present Arno Gourdol. All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a
copy of this software and associated documentation files (the "Software"),
to deal in the Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, sublicense,
and/or sell copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.
```
* **字型資產與授權缺漏事實查證**：
  * 套件目錄 `node_modules/mathlive/fonts/` 實體存放 20 份 KaTeX 字型（如 `KaTeX_AMS-Regular.woff2`, `KaTeX_Main-Regular.woff2` 等）。
  * 樣式表 `node_modules/mathlive/mathlive-fonts.css` 透過 `@font-face` 引用上述字型。
  * **重要事實**：在 `node_modules/mathlive/` 安裝目錄內，**不存在任何字型授權檔（無 OFL.txt、無字型版權文件）**。
  * **不得虛構條款**：本報告依實際磁碟狀態記錄為**字型授權文件缺漏**，絕不捏造或預設 OFL Reserved Font Names 聲明。後續需透過正式上游查證補齊。

---

### 2.2 PDF.js (`pdfjs-dist` 6.2.108)
* **實體檔案**：[node_modules/pdfjs-dist/LICENSE](../../node_modules/pdfjs-dist/LICENSE)
  * 內容為標準 Apache License Version 2.0, January 2004 全文。
* **Worker 內嵌標頭實體檔案**：[node_modules/pdfjs-dist/build/pdf.worker.mjs](../../node_modules/pdfjs-dist/build/pdf.worker.mjs) (第 1–26 行)
```javascript
/**
 * @licstart The following is the entire license notice for the
 * JavaScript code in this page
 *
 * Copyright 2024 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * @licend The above is the entire license notice for the
 * JavaScript code in this page
 */

/**
 * pdfjsVersion = 6.2.108
 * pdfjsBuild = 0365cbde0
 */
```

---

### 2.3 CodeMirror 系列與 Lezer
* **`@codemirror/language` (6.12.3)**：[node_modules/@codemirror/language/LICENSE](../../node_modules/@codemirror/language/LICENSE)
* **`@codemirror/state` (6.7.0)**：[node_modules/@codemirror/state/LICENSE](../../node_modules/@codemirror/state/LICENSE)
* **`@codemirror/view` (6.43.2)**：[node_modules/@codemirror/view/LICENSE](../../node_modules/@codemirror/view/LICENSE)
```text
MIT License

Copyright (C) 2018-2021 by Marijn Haverbeke <marijn@haverbeke.berlin> and others

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```
* **`@lezer/common` (1.5.2)**：[node_modules/@lezer/common/LICENSE](../../node_modules/@lezer/common/LICENSE)
* **`@lezer/highlight` (1.2.3)**：[node_modules/@lezer/highlight/LICENSE](../../node_modules/@lezer/highlight/LICENSE)
```text
MIT License

Copyright (C) 2018 by Marijn Haverbeke <marijn@haverbeke.berlin> and others

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

---

### 2.4 ProseMirror 系列
* **`prosemirror-model` (1.25.9)**：[node_modules/prosemirror-model/LICENSE](../../node_modules/prosemirror-model/LICENSE)
* **`prosemirror-state` (1.4.4)**：[node_modules/prosemirror-state/LICENSE](../../node_modules/prosemirror-state/LICENSE)
* **`prosemirror-view` (1.41.9)**：[node_modules/prosemirror-view/LICENSE](../../node_modules/prosemirror-view/LICENSE)
```text
Copyright (C) 2015-2017 by Marijn Haverbeke <marijn@haverbeke.berlin> and others

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

---

### 2.5 Svelte (5.56.9)
* **實體檔案**：[node_modules/svelte/LICENSE.md](../../node_modules/svelte/LICENSE.md)
```text
Copyright (c) 2016-2025 [Svelte Contributors](https://github.com/sveltejs/svelte/graphs/contributors)

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

---

## 3. 待追蹤缺漏事項 (Action Items for Third-Party Notice Integration)

1. **MathLive 字型授權缺漏處理**：
   `mathlive@0.110.0` 釋出物包含 KaTeX WOFF2 字型，但缺少獨立授權標記文件。在建立 `apps/frontend/THIRD_PARTY_NOTICES.md` 前，需依上游官方授權記錄確認是否需以獨立 notice 補充 KaTeX 字型條款。
2. **PDF.js Worker 授權揭露**：
   產物直接引用預編譯之 `pdf.worker.mjs`，必須在第三方宣告文件中明載 Mozilla Foundation Apache-2.0 聲明。
3. **無任何授權授與行為**：
   本清冊僅為本地安裝套件之客觀證據整理，不代表法務放行，亦不構成任何授權宣告變更。
