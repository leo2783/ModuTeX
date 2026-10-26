# 安裝與啟動

ModuTeX 0.3.0 適用於 Windows x64。

1. 從 [GitHub Releases](https://github.com/leo2783/ModuTeX/releases) 選擇對應版本的 Windows x64 安裝包。
2. 執行安裝程式，完成後從開始功能表開啟 ModuTeX。
3. 選擇「新文件」、「開啟文件」或「開啟資料夾」。

已有下載檔與 SHA-256 時，可用 PowerShell 核對：

```powershell
Get-FileHash -LiteralPath '.\安裝檔.exe' -Algorithm SHA256
```

需要更新時，使用 App 的更新提醒下載新版本。安裝前依提示儲存文件，並等待編譯結束。

開發者從原始碼啟動的方式見[開發指南](DEVELOPMENT.md)。
