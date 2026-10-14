# Windows 意外重啟：2026-10-08

> 歷史實作／審查紀錄。下列測試數字與待辦反映早期改寫階段；現行功能、版本及目錄以[實作狀態](FRONTEND_REWRITE_STATUS.md)與[開發指南](../user/DEVELOPMENT.md)為準。

## 證據

- Event 1001，10:44:48：bugcheck `0x119`，第一參數 `2`，圖形驅動提交命令失敗。
- Dump：`C:\WINDOWS\Minidump\100826-12312-01.dmp`。尚未分析故障模組，不上傳 dump。
- 同日 10:03:24：`0x116`（顯示驅動逾時恢復失敗）；前日 17:36:42：`0x10e`（視訊記憶體管理錯誤）。
- 重啟後可用實體記憶體約 4.85 GiB，不是事故前峰值。
- AMD 驅動 30.0.13002.19003；NVIDIA 驅動 32.0.15.9579。尚不能指定故障顯示卡或觸發程序；工作負載是否促成故障未排除。
- 本輪專屬 Luna Node 命令查詢沒有存活程序；不得使用重啟前的 PID 終止程序。

## 已採取措施

### WER 新證據

- Application／Windows Error Reporting Event 1001：10:46:43 的 BlueScreen bucket 為 `0x119_2_DRIVER_FAILED_SUBMIT_COMMAND_dxgmms2!VidSchiSendToExecutionQueue`，與上述 bugcheck 及報告識別碼相同。
- 10:46:29 的 LiveKernelEvent bucket 為 `LKD_0x117_Tdr:9_IMAGE_amdkmdag.sys`；附加 WATCHDOG dump 標記 10:34。
- 10:46:11 的 bucket 為 `LKD_0x117_Tdr:9_IMAGE_nvlddmkm.sys_Ampere_UserOC`；附加 WATCHDOG dump 標記 10:43。
- 10:45:12、10:45:49 另有 NVIDIA `0x141` Tdr bucket；附加 dump 標記 10:38、10:41。報告提交時間不是故障發生時間。
- 這些簽章同時涉及 AMD／NVIDIA 及 Windows 排程器；不是單一驅動根因的證明。`UserOC` 是 bucket 字串，不單獨證明使用者超頻。
- minidump 資料夾存取遭拒；未更改 ACL、取得擁有權或提升 Windows 管理員權限來繞過。未安裝 debugger 或上傳記憶體內容。

- 已更新十五分鐘 heartbeat：使用者明確同意恢復前，不啟動代理、建置、測試、索引、瀏覽器或 Electron，不自動重試 API。
- 不殺全部 Node／Electron／AGY，不修改驅動、TDR 登錄檔或系統安全設定。
- 保留中斷 API 的未知保留額，不能當成未計費。完整 0.2.0 目標保留；無 commit／push。

## 恢復限制

2026-10-08 12:55：使用者最新明確調整總數為Luna3＋AGY2，五個實際遠端子程序已核對，取代四項上限；不升到六個。此前所有worker結束後串行跑完48項回歸才啟動新批。事故根因仍未解決、未授權native桌面；任何worker活躍時禁止主代理並行test/build/index/browser/Electron，worker禁shell與測試，保留記憶體／新TDR監測及未知API預留。4473MiB可用RAM只是啟動前取樣，不是GPU安全保證。詳細所有權見AGY_SETTINGS_HANDOFF。

2026-10-08 12:00 更新：使用者明確授權先恢復Luna2＋AGY2，查證四個真遠端程序存活。已更新heartbeat，保持最多四項且禁止並行本地測試／建置／索引／GUI；記憶體初步快照5862MiB可用，不是GPU故障已修復或可以加量。此前「未同意恢復」限制已由本次限定授權取代，其餘系統／原生桌面限制維持。

- 先確認 dump 故障模組；驅動處理需另外確認，不承諾目前已修好關機問題。
- 恢復開發時先用單一工作負載，不恢復六項並行，不同時建置、測試與索引。
- Codebase Memory 僅 CLI，維持三檔範圍，不重試全庫索引。容量監測是取樣限制，不是系統硬配額。

來源：[0x119](https://learn.microsoft.com/en-us/windows-hardware/drivers/debugger/bug-check-0x119---video-scheduler-internal-error)、[0x116](https://learn.microsoft.com/en-us/windows-hardware/drivers/debugger/bug-check-0x116---video-tdr-failure)、[0x10e](https://learn.microsoft.com/en-us/windows-hardware/drivers/debugger/bug-check-0x10e---video-memory-management-internal)。
