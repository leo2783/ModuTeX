# PDF compilation / PDF 編譯

Open a saved `.tex` document and choose **Compile PDF**. The new frontend uses bundled Tectonic.
Unsaved changes are saved first; resolve disk conflicts before compiling.
開啟已儲存的 `.tex` 文件後選擇「編譯 PDF」。新版前端使用內建 Tectonic，未儲存內容先保存，磁碟衝突需要先處理。

## Results / 結果

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
