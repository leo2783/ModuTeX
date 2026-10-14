# 原創來源核心

> 歷史實作／審查紀錄。下列測試數字與待辦反映早期改寫階段；現行功能、版本及目錄以[實作狀態](FRONTEND_REWRITE_STATUS.md)與[開發指南](../user/DEVELOPMENT.md)為準。

## 定義與邊界

`packages/document-core` 是不依賴 renderer／IPC 的 UTF-8 來源緩衝。保留 BOM、原始 EOL、註解與未知 LaTeX；已加入有限子集 parser，尚無視覺 serializer／worker。輸出採 ESM，Node 24.19.0／npm 11.17.0；建置工具沿用根 workspace 的 TypeScript 6.0.3。

`parseSource` 產生文件／版本綁定的 spans，辨識章節、格式、數學與容器；未知指令／環境保留完整 Raw，動態語法與不完整輸入不猜測還原。這不是 TeX interpreter。104 項測試通過，證據：`.verification-artifacts/frontend-parser-2026-10-07/tests.txt`；大型輸入與逐鍵 worker 驗收尚未完成。

| 實作位置 | 計算目的 |
| --- | --- |
| `src/utf8.ts` | 每個來源片段只建立一次 UTF-16 → UTF-8 offset 索引；拒絕非法編碼／單獨 surrogate |
| `src/source.ts` | immutable piece table；局部修改共享未變動片段，明確保存時才組合 bytes |
| `src/changes.ts` | 游標位置變換；未受影響 span 移位，受影響節點返回 null 供重解析 |
| `tests/source.test.ts` | 自製保真 corpus、Unicode、版本、原子 transaction 與隨機編輯 oracle |
| `tests/source.bench.ts` | 固定大小／次數的來源緩衝量測；不包含 GUI |

## 契約

`EditorProjection` 將 editor LF 座標映射到原始來源，保留既有 CRLF／CR／LF；新增換行採文件偏好。局部 patch 接合原先分離的 CR 與 LF 時，回傳 `editorCorrections` 刪除多餘的 editor 換行。`apps/frontend/src/features/source-editor/state.ts` 已將修正合成同一個 CodeMirror transaction；undo 還原 projection snapshot 與游標，版本仍遞增，不以 LF inverse patch 改寫原始混合換行。真正 DOM 輸入／桌面保存仍待驗收。

2026-10-07 全套 120 項測試通過，0 skip，包含 16 項 editor projection 測試；來源／測試型別檢查與 ESM 重建成功。

`open(bytes)` 複製輸入以取得所有權；`toBytes()` 回傳新陣列。所有 offset 使用 UTF-16 code units，BOM 不計入文字位置。無修改保存不做重新列印；新文字只編碼新增片段，既有換行不正規化。`profile.originalLineEndings` 是開檔時統計，並非每次編輯後的換行數。

`apply({expectedVersion, patches})` 使用修改前座標，patch 必須按位置排序、不重疊；同一位置的兩次插入須先合成一個 patch。`expected` 可檢查目標片段。先驗證整個 transaction，再產生新 snapshot；失敗不改原物件。相同內容／空 transaction 不增加版本。

`restore(snapshot, expectedVersion)` 僅接受同一來源的 snapshot；undo／redo 仍增加目前版本，避免舊 parse 結果重新有效。`acceptCurrent` 同時比對 `documentId` 與版本；worker 結果與 span 也必須帶文件識別。UI 後續只持有一個目前 snapshot，不能以舊 snapshot 另建分支後混用相同版本。

| 錯誤碼 | 邊界 |
| --- | --- |
| ENCODING | 非法 UTF-8／未配對 surrogate；不使用替代字元修復 |
| RANGE | 越界、非整數、反向範圍、切開 Unicode scalar |
| VERSION | 過期 transaction／span 或版本耗盡 |
| PATCH | 重疊、亂序、同位置多插入、非文字插入 |
| CONTENT | expected 與目前片段不符 |
| ORIGIN | undo snapshot 屬於另一文件 |

## 驗證

在儲存庫根目錄執行：

```powershell
npm run check --workspace=@modutex/document-core
npm run build --workspace=@modutex/document-core
npm run test --workspace=@modutex/document-core
npm run bench --workspace=@modutex/document-core
```

來源核心首輪 69 項通過、0 skip；型別檢查同時涵蓋來源與測試，建置的 ESM 已直接執行。該輪 install policy 通過：6 manifests、977 lock entries。來源核心 workspace 增加兩筆 lock entry，無新第三方依賴；新增桌面契約後的整合證據見 [桌面契約](FRONTEND_CONTRACTS.md)。

## 來源緩衝量測

AMD Ryzen 9 5900HX、16 logical CPUs、約 16 GB RAM、Windows x64、Node 24.19.0。每份文件 1,000 次中段插入；序列化 comparator 200 次。來源 patch 預算為 p95 < 8 ms。

| Corpus | 開檔 ms | patch p95 ms | 保存 ms | 全文字串編碼 comparator p95 ms |
| --- | ---: | ---: | ---: | ---: |
| 100 KB | 6.8362 | 0.0700 | 0.3442 | 0.1147 |
| 1 MB | 20.1948 | 0.0479 | 0.4231 | 2.0512 |
| 5 MB | 30.2846 | 0.0777 | 1.4136 | 7.2312 |

Comparator 是每次修改後重編 UTF-8 字串，不是已發布 legacy App 的量測。記憶體 delta 含 offset 索引、保存與 oracle 陣列，不能作 GUI／worker 回收證據。實際 renderer 輸入、parser worker、切模式、資源釋放及長時間編輯的片段增長仍待整合量測。

原始證據：`.verification-artifacts/frontend-core-2026-10-06/tests.txt`、`benchmark.json`。來源盤點見 [frontend-origin.json](../licensing/frontend-origin.json)，目前審查待完成；新 package 保持 private／UNLICENSED，沒有改根授權。

規格參考：[WHATWG Encoding](https://encoding.spec.whatwg.org/#interface-textdecoder)、[Node TypeScript 執行文件](https://nodejs.org/api/typescript.html)。
