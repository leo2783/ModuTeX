# 儲存格拖曳與數學、程式碼編輯

## 行為與來源

按住儲存格左側把手時，整格抬起並顯示陰影；移動後跟隨滑鼠，原位置保留空間，落點顯示藍線。放開才提交排序，Escape、視窗失焦或文件版本改變會取消。拖動支援上下任意位置及邊緣捲動，來源與方向鍵移動共用一次 undo；BOM、混合換行與未知語法保留。首段移到另一文字段後補入段落邊界，避免兩格合併。

矩陣在視覺模式中使用同一個數學輸入器，可與一般公式、上下標混用；移除重複預覽。行內切換保留段內位置。公式空白槽可確認為空群組，不要求數字或積分上下限；模板選單仍先選種類再選公式。

程式碼使用 CodeMirror 語言目錄的 145 個選項，包含 WSL、Rust、R、Go、XML、Markdown、Java。輸入及文件呈現共用延遲載入的語法解析與配色，文字以 textContent 寫入，不執行程式。新增語法模組不觸發開發伺服器重新載入，避免未儲存內容消失。PDF 使用 listings 能辨識的語言映射；其餘保留語言 metadata 與原文，未宣稱 PDF 有完整語法配色。

| 程式位置 | 責任 |
| --- | --- |
| visual-editor/cell-drag.ts | 滑鼠、浮起、落點、捲動及取消清理 |
| source-editor/cell-move.ts、state.ts | 版本檢查、精確來源交易、共同 undo |
| math/inline.ts、field.ts、source.ts | 矩陣與一般公式混用、行內及空槽 |
| code/source.ts、highlight.ts、CodePanel.svelte | 語言目錄、文字安全、輸入及顯示配色 |

## 審查

本批獨立依使用者需求實作，未讀取或複製 legacy 實作。AGY3 與 API Luna3 真實程序僅審查新版來源；主代理整合版本檢查、生命週期、滑鼠選取及數學焦點的意見，未整包採用重寫儲存格結構的建議。

| 範圍 | AGY3 回件 | API Luna3 回件 |
| --- | --- | --- |
| workbench | 11f2816b-facc-40dd-a5a8-e87b34798834 | 4a2a7f8a-7e98-49d3-aa50-75a539b01815 |
| blocks | 1288026f-6a92-4dbe-8478-6f31e9ec23c8 | 6d9dca72-5a2a-452e-b0ce-12266119e33f |
| math | 8ce4122f-0ca5-46be-86ed-d324e6ca58d3 | e5c0fdc7-4133-49f8-a53a-5c4554f7eb23 |

三份 Luna 回件各 cached_tokens=3954；不據此推論帳戶整體快取比例。代理全部結束後才執行單一停用 GPU 的瀏覽器驗證。來源盤點及新增 runtime 套件的授權全文已更新，應用整體授權審查狀態維持原紀錄。

## 驗證

| 檢查 | 結果與證據 |
| --- | --- |
| 完整前端 | 344／344；cell-drag-code-tests-final.log |
| 真滑鼠 GUI | 13／13；cell-drag-float-gui.log；按住陰影、拖後選取、前後跨格、Escape、來源 undo |
| 正式產物 | 3／3；cell-drag-code-production-confirmed.log；延遲載入與逐項授權原文 |
| 型別 | 0 errors、既有 2 warnings；cell-drag-float-check-final.log |
| 程式碼及來源 | 145 語言原文往返、安全 DOM、高亮取消、混合換行及 BOM 精確 undo |

證據位於本機 .verification-artifacts。本批沒有修改 IPC 或編譯後端；未重新宣稱已完成全部 145 語言的原生 PDF 配色驗收。前批原生驗證見 [互動修正](FRONTEND_NOTEBOOK_INTERACTION_2026-10-11.md)。
