# 0.1.0 已知限制

- Draw.io 完整編輯／重開驗收延後；文字仍在編輯時保存可能漏掉最新內容。不將它列為 0.1.0 已驗收功能。
- Mermaid 留至 0.2.0；視覺章節折疊延後，原始碼模式已有折疊。
- 虛線橫線表格樣式：首列表頭的行為仍需修正；其他表格功能不因此視為全部驗收完成。
- EXE／NSIS installer 與程式簽章留至 0.1.1。
- 尚未公開 npm registry 發布；目前只能使用附帶的本地 `.tgz`。套件名稱／scope 與發布權限需另行確認。
- 此份 `.tgz` 尚未追加乾淨 Windows、儲存庫外 npx GUI 開檔／編譯 smoke；首次資源下載及完全斷網快取也未完成 clean VM 驗收。
- MCP 的實際 client 端完整流程仍待驗證。
- 大文件擊鍵序列化、Draw.io IPC 及 SVG→PDF 的效能與資源釋放仍待量測。
- Windows 同 commit 本地 CI 通過不代表 Linux 或 GitHub Actions 已綠燈；遠端當時受執行額度限制。

已有的表格 `tabularx` 套件補入與 Managed Tectonic 固定來源自動下載修正包含在本版，不列為待實作項目。應用仍是 AGPL 衍生作品，不是整體 Apache-2.0。
