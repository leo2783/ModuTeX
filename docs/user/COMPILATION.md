# PDF compilation / PDF 編譯

Open a saved `.tex` document and choose **Compile PDF**. The new frontend uses bundled Tectonic.
Unsaved changes are saved first; resolve disk conflicts before compiling.
開啟已儲存的 `.tex` 文件後選擇「編譯 PDF」。新版前端使用內建 Tectonic，未儲存內容先保存，磁碟衝突需要先處理。

## Chinese and English / 中英文排版

New documents load CTEX with Fandol fonts for mixed Chinese and English, including bold and italic text. English heading names remain unchanged. Use bundled Tectonic or XeLaTeX. The first compilation downloads the required TeX packages and fonts.
新文件載入 CTEX 與 Fandol 字型，支援中英文混排及粗體、斜體，保留英文標題名稱。請使用內建 Tectonic 或 XeLaTeX；首次編譯會下載所需 TeX 套件與字型。

Managed compilation automatically prepares Chinese and English typesetting for an open main document using the standard article, report or book class when it contains Chinese. This source change shares editor undo and is saved before compilation. Existing CTEX or CJK settings are retained. For other document classes or system engines, use **Settings → Compilation → Chinese and English typesetting** or edit the preamble in Source mode.
開啟的主文件使用標準 article、report 或 book 類別且含中文時，託管編譯會自動補齊中英文排版設定；變更可透過編輯器復原，並於編譯前儲存。既有 CTEX 或 CJK 設定會保留。其他文件類別或系統引擎可使用「設定 → 編譯 → 中英文排版」，或在原始碼模式調整前言。

## Results / 結果

The built-in PDF preview includes local character maps and font resources for Chinese PDFs. It does not fetch preview resources from a CDN. Package initialization details remain in the compile log; Problems lists warnings and errors, including missing glyphs. Wrapped font warnings appear as one message.
內建 PDF 預覽隨附中文所需的字元映射與字型資源，不透過 CDN 載入預覽資源。套件初始化細節保留在編譯記錄；「問題」列出警告與錯誤，包括缺字訊息。跨行字型警告會合併為一則訊息。

Successful compilation automatically saves the PDF beside the main `.tex` file. For example, `paper/main.tex` produces `paper/main.pdf`. No output setting is required. A later successful build replaces that PDF; a failed build retains the last successful file. Optional PDF paths and output directories in **Settings → Compilation** override this default.
成功編譯後，PDF 自動儲存在主 `.tex` 文件旁，例如 `paper/main.tex` 會產生 `paper/main.pdf`，不需設定輸出位置。再次成功編譯會更新 PDF，失敗則保留上一次成功的檔案。「設定 → 編譯」中的選用 PDF 路徑與輸出目錄可覆寫預設位置。

Successful builds display the latest PDF; failures and cancellations keep the previous successful preview.
The progress indicator describes the stage, not a numeric percentage.
成功後顯示最新 PDF；失敗或取消時保留上一份成功預覽，進度提示表示階段而非百分比。

Right-click a file for Open, Compile PDF or Copy relative path.
Compiling another document follows the same unsaved-change checks.
檔案右鍵提供開啟、編譯 PDF 與複製相對路徑；編譯其他文件仍會檢查未儲存修改。

## Errors / 錯誤

| Situation         | Action / 處理方式                                                                                                                               |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| TeX error         | Inspect the opened details; navigate to source when a valid filename/line is available. / 查看詳細資料，有有效檔名與行號時可定位原始碼。        |
| Missing resources | Allow Tectonic to download uncached resources, then retry. / 下載缺少資源後重試。                                                               |
| Disk conflict     | Keep the draft or reload from disk before saving. / 先保留草稿或重新載入磁碟內容。                                                              |
| Input limit       | Inspect the reported file; keep unrelated caches/application data outside the workspace. / 檢查被指出的檔案，將無關快取與應用資料放在工作區外。 |
| Cancellation      | Wait for the engine to stop before retrying. / 等待引擎停止後再重試。                                                                           |

The status provides a log toggle. Editing after compilation marks the preview as an earlier version.
編譯狀態可切換記錄顯示；編譯後再修改，預覽會標示為先前版本。

## Network / 網路

Tectonic fetches missing resources from its fixed official bundle source and reuses a local cache.
First compilation and newly used packages may need internet access.
`npx --offline` limits npm resolution, not Tectonic downloads.
引擎從固定官方來源下載資源並快取；首次編譯或新增套件可能需要網路，`npx --offline` 只限制 npm 解析。

[Installation / 安裝](INSTALLATION.md) · [Editing / 編輯](EDITING.md)
