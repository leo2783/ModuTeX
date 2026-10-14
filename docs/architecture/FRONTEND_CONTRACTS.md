# 桌面契約與資料驗證

> 歷史實作／審查紀錄。下列測試數字與待辦反映早期改寫階段；現行功能、版本及目錄以[實作狀態](FRONTEND_REWRITE_STATUS.md)與[開發指南](../user/DEVELOPMENT.md)為準。

`packages/frontend-contracts` 定義新版前端唯一的 `DesktopPort` 邊界與 runtime validators，不依賴 Electron、legacy 或舊 contracts。現在沒有 host 適配，也沒有以 stub 實作開檔／編譯。此模組的測試不計入 F4 桌面驗收。

## 功能契約

| 操作 | 輸入／輸出與邊界 |
| --- | --- |
| openWorkspace | 使用者選檔／選資料夾，取消回傳 null；只回傳不透明 ID 與標籤 |
| listFiles／watchFiles | 相對檔案路徑；事件綁定 workspace；訂閱返回解除函式 |
| readFile | workspace＋相對路徑；回傳 owned bytes 與磁碟 revision |
| writeFile | bytes、expectedRevision、documentId／documentVersion；回覆須對應同一文件 snapshot |
| compile | 已保存 revision、文件 snapshot、managed／system 選擇；沒有任意 command／flags／URL |
| CompileHandle | identity、finished Promise、cancel；成功才有 PDF，失敗／取消不提供替換 PDF |
| closeWorkspace | host 解除 watcher 與編譯資源；尚待真實適配驗證 |

`expectedRevision: null` 表示新檔建立，host 必須拒絕覆寫已存在的檔案；非 null 時須在寫入邊界比對 revision。runtime validator 保留與核對欄位，不替 host 完成原子寫入／衝突檢查。

## 驗證位置與限制

`src/validate.ts` 使用 exact records：拒絕額外欄位、繼承式 record、getter／setter、稀疏／附加屬性的陣列。bytes 透過原生 typed-array intrinsic 驗證與複製，不信任可覆寫的 byteLength 或 iterator；shared／detached backing storage 拒絕。

識別碼為 1–128 個 ASCII 字母、數字、底線或連字號；revision 為 1–256 字元，可包含冒號。一般文字上限 32,767 個 UTF-16 units。relativePath 使用檔案路徑語意、不作 URI 解碼；拒絕 absolute／drive／UNC／URL、控制字元、點路徑、空段、Windows device names 與末尾空白／點。

來源 bytes、PDF、log、diagnostic／file count 的上限由可信 caller 明確傳入，不內建猜測的 transport 大小；上限須為正 safe integer。host 適配前必須設定限額，且在傳輸前限制資料量，不能等 IPC 已複製大資料才檢查。

編譯結果逐項核對 runId、workspace、entryPath、documentId、documentVersion、savedRevision；診斷座標為 1-based，column 需要 line，line 需要 path。PDF 僅驗證 byte limit 與 `%PDF-` header，並非完整 PDF／腳本安全檢查；PDF.js 與真實編譯驗收另行處理。

字面路徑驗證不保證 containment。main 必須再檢查 sender／frame、工作區權限、realpath／junction／symlink、Windows 路徑規則與原子檔案操作；renderer 不取得 raw IPC 或 shell 能力。參考：[Electron 安全指南](https://www.electronjs.org/docs/latest/tutorial/security)、[contextBridge API](https://www.electronjs.org/docs/latest/api/context-bridge)。

## 已驗證

在儲存庫根目錄使用 Node 24.19.0／npm 11.17.0：

```powershell
npm run check --workspace=@modutex/frontend-contracts
npm run build --workspace=@modutex/frontend-contracts
npm run test --workspace=@modutex/frontend-contracts
```

15 項契約測試通過、0 skip；連同來源核心為 84 項。來源／測試型別檢查與 ESM 建置通過。install policy 為 7 manifests、979 lock entries；契約 workspace 沒有新第三方依賴，只新增兩筆 lock entry。

第一輪一項測試失敗：fixture 用 Object.assign 從 accessor 物件複製，建構階段自行觸發 getter。已改為獨立 data fixture，保留 getter 不得執行的斷言，沒有降低驗證。

證據：`.verification-artifacts/frontend-contracts-2026-10-06/regression.txt`、`install-policy.txt`。來源盤點：[frontend-origin.json](../licensing/frontend-origin.json)。獨立來源審查未完成，package 保持 private／UNLICENSED；根 AGPL 與已發布版本不變。
