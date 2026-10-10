# 0.2.0 主路徑驗收與接續

更新2026-10-10 23:02 Taipei。本輪主路徑驗收及程式提交完成；goal狀態以推送與method收尾核對後的工具結果為準。歷史交接留在工作區，不必載入整份歷史。

## 目標與結果

新版Electron載入、真開檔／編輯／儲存／編譯／取消／PDF，優先P0／P1，禁止假結果或降低驗收。

| 要求 | 當前證據 |
| --- | --- |
| 檢查／建置 | frontend check零error、兩個既有layout reactivity warning；frontend及Electron build成功 |
| 檔案／watch／recent／安全 | 正式host服務與guard 104 pass；源bytes與revision、真FS watcher、過期owner、guard拒絕邊界 |
| 編譯與發布 | 真Tectonic整合18 pass；成功／錯誤、取消drain、included-file變動阻發布、真diagnostics |
| 真瀏覽器工作台 | 7 pass，0 fail／skip／cancel；byte保存再開啟、watch衝突、真compile成功／失敗／取消／重試、PDF保留、乾淨teardown |
| 原生Electron GUI | 正式scripts/tests/frontend-electron-smoke.mjs 1 pass；真執行檔、建置URL、真recent／preload／IPC開檔、編輯、byte保存、真compile／PDF渲染、取消保留PDF bytes／pixels、重試、換頁IPC與legacy bridge隔離；正常關閉 |
| 編輯與效能 | Visual／performance／discovery14 pass；Desktop compile lifetime6 pass；production3 pass；初始JS102068 bytes <102400，未放寬門檻 |

瀏覽器與原生均零page／console error，無skip／cancel。原生近期截圖與程序清理已核對。

- 原生截圖：`.verification-artifacts/electron-native-workbench-20261010.png`、`electron-built-smoke-20261010.png`；真Chrome截圖`workbench-mainpath-browser-20261010.png`。
- Playwright `_electron.launch`仍在loader路徑逾時；不能歸罪正式main。原生正式測試改直接spawn Electron並CDP，明確timeout、userData／cache／文件隔離、finally清理，不替換IPC／engine結果。
- 修正AGY提出的全域MIME拒絕會破壞實際legacy .mp4資源：bundle保留既有octet-stream fallback，新frontend仍採嚴格MIME。
- 主路徑完成不等於完整0.2.0發布：OS picker自動操作、IME、跨平台、packaging與完整來源清查沒有列為已驗收；root AGPL、frontend UNLICENSED及0.1.0來源保留。

## 提交

- `21c22aa`：獨立測試discovery＋文件，已push。
- `54a68fd`：strict型別宣告，已push。
- `8946fcb`：純URL路由安全模組、九項測試與文件，已push。
- `4cbb896`：主工作台／host整合、必要依賴、真測資、文件，85檔。只stage指定檔案；root metadata僅加frontend scripts／workspace lock，保留舊legacy路徑。
- 大量歷史搬遷、其餘來源gate／舊client harness／font-t1map變動仍在工作樹，未混入主流程提交；禁止git add .或任意reset。

## 實際派工

容量AGY3＋API Luna3，完整功能分包，不為填滿製造工作。全部本輪worker已terminal，沒有在途工作。

- AGY1 conversation63ca1b8b-130a-4aab-b050-e0af09335e44：Electron共享protocol／host matcher修正版採用；root改用實際isSameDocument型別。
- AGY2 conversation90bbecce-6d7e-4aee-b725-59945b3d30ef：第三稿真browser harness採用，root修正fixture／契約／清理。
- AGY3 conversationf1db0560-7c2d-4a19-b50a-dccfef9e6aa4：啟動診斷SUCCESS；採用隔離／timeout方向，鎖衝突推測未被驗證，不採投機main修改；root直接執行檔真GUI通過。
- Luna1 receipt6e3a69b6-9a70-48ae-9e03-a3b9f6968d67：真compile lifetime測資。
- Luna2 receipt56a2590c主流程、84a174e8拒絕文案：取消意圖／過期結果隔離／adapter去重。
- Luna3 receipta2ea1eac-c4ee-4b5d-8a6b-ffd151dd87e5：schema range掃描與marked-edit／anchor／undo測資；拒絕二次source.apply熱路徑回退。

## 接續限制

- 使用者期限2026-10-11 18:00 Taipei，本輪提前通過主流程。
- 任務來源已授權既有AGY／API Luna，排除env／keys／憑證／使用者文件。遠端活躍時不並行本地test／build／index／GUI；無通知至少五分鐘查原handle。
- GUI授權僅workers停止後串行、disable-gpu、隔離fixture；不改driver／TDR／ACL。
- AGY真正啟動使用短prompt -p／read_file；text stdin不攜任務。CLI僅允許兩個精確ClineGlobal目錄列舉，副本tools/agy/cli-bootstrap-settings.json。

已讀AGENTS、引用聊天、CONTRIBUTING、method_map／maintenance／cache／skills／memory maps、Frontend／reviewer／Technical角色、docs_rule／commit_rule、SUBAGENT_ROUTING、Electron整合、Windows crash、IMPLEMENTATION_PLAN／FRONTEND_REWRITE_PLAN及本輪host／test／build依賴。已按規則維護method；maps只放連結。

