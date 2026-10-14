<p align="center"><img src="build/icons/128x128.png" alt="ModuTeX" width="80" height="80"></p>
<h1 align="center">ModuTeX</h1>
<p align="center">內建編譯器的視覺化 LaTeX 編輯器。</p>
<p align="center"><a href="README.md">English</a> · <a href="README.zh-TW.md">繁體中文</a></p>

ModuTeX 將視覺編輯、LaTeX 原始碼與 PDF 預覽整合在桌面工作區。
可輸入文字、建立公式與表格，再透過隨附的 Tectonic 引擎編譯。

## 功能

- **視覺與原始碼編輯**：直接修改支援的內容，兩種模式共用復原記錄；自訂指令可在原始碼編輯。
- **Notebook 儲存格**：用滑鼠拖曳排序、在目前游標插入內容，並設定論文題目、摘要與標題層級。
- **公式與矩陣**：透過圖形模板尋找分數、極限、微積分等結構；矩陣可與一般數學混用。
- **表格、程式碼與圖片**：調整行列與欄寬、選擇程式語言並顯示語法色彩，以及插入或貼上 PNG/JPEG 圖片。
- **PDF 預覽**：在文件旁編譯、查看錯誤；失敗時保留上一份成功的預覽。
- **雙語介面**：從地球選單選擇繁體中文或英文。

## 下載與啟動

桌面套件支援 **Windows x64**，可從 [0.2.0 發行頁](https://github.com/leo2783/ModuTeX/releases/tag/v0.2.0) 選擇：

| 格式 | 檔案 | 需求 |
|---|---|---|
| Windows 安裝程式 | `ModuTeX-Setup-0.2.0.exe` | 不需另外安裝 Node.js、npm 或 TeX。 |
| 本地 npx 套件 | `modutex-desktop-0.2.0.tgz` | Node.js 24.19.0 與 npm 11.17.0。 |

同時下載所選檔案與對應的 `.sha256`。
使用安裝程式時，先以 `Get-FileHash .\ModuTeX-Setup-0.2.0.exe -Algorithm SHA256` 核對雜湊，
再雙擊 `.exe` 並依安裝精靈操作。

從 [0.2.0 發行頁](https://github.com/leo2783/ModuTeX/releases/tag/v0.2.0)
下載 `modutex-desktop-0.2.0.tgz` 與對應的 `.tgz.sha256`。
在下載資料夾開啟 PowerShell，核對雜湊後再啟動：

```powershell
$package = 'modutex-desktop-0.2.0.tgz'
$expected = (Get-Content ".\$package.sha256").Split(' ')[0].ToLowerInvariant()
$actual = (Get-FileHash ".\$package" -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw 'Checksum mismatch' }
npx --offline --yes --ignore-scripts --package ".\$package" -- modutex
```

此方式透過本地套件啟動程式，不會永久安裝 Windows 應用程式。
首次解包可能需要幾分鐘；首次編譯或缺少快取資源時，Tectonic 仍需要網路。
詳細步驟見[安裝與疑難排解](docs/user/INSTALLATION.md)。
使用先前編輯器的 [0.1.0 發行版](https://github.com/leo2783/ModuTeX/releases/tag/v0.1.0) 仍可下載。

### Windows 阻擋下載或啟動

安裝程式尚未簽章，Windows 可能顯示「不明的發行者」或 SmartScreen 信譽警告。
先確認檔案來自本儲存庫的 Release，且 SHA-256 與核對檔一致。
若是「無法辨識的應用程式」警告，Windows 有提供選項且你信任已核對的檔案時，可選「其他資訊 → 仍要執行」。
檔案因下載標記被封鎖時，可能可從「內容 → 解除封鎖」處理。
若防毒回報惡意程式、雜湊不符，或 Smart App Control／組織政策阻止執行，
請停止並回報訊息或聯絡管理員，不要關閉整體防護；`.tgz` 也不會繞過 Windows 對內含執行檔的檢查。
詳見 [Windows 疑難排解](docs/user/INSTALLATION.md#windows-blocking--windows-封鎖)、
[Microsoft SmartScreen 說明](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)
與[檔案封鎖說明](https://support.microsoft.com/en-gb/windows/security/information-about-the-attachment-manager-in-microsoft-windows)。

## 開始編輯

1. 選擇「新文件」、「開啟文件」或「開啟資料夾」。
2. 在視覺模式編輯，或切換原始碼模式輸入 LaTeX 指令。
3. 選擇「編譯 PDF」。未儲存修改會先保存；磁碟衝突需要先處理。

操作細節見[編輯指南](docs/user/EDITING.md)與[編譯指南](docs/user/COMPILATION.md)。

## 開發

在儲存庫根目錄使用上述指定的 Node/npm 版本：

```powershell
npm ci
npm run electron:dev:frontend
```

此指令在 Electron 開啟新版前端，Vite 使用 5174 埠。
本機靜態建置使用 `npm run electron:frontend`；
`npm run electron:dev` 則開啟 5173 埠的先前編輯器。

`npm run verify:modutex` 檢查共用套件、新前端及保留的 host／編輯器。
個別指令見[開發與打包](docs/user/DEVELOPMENT.md)。

## 範圍與授權

安裝程式尚未簽章；新版介面尚未提供 Draw.io、Mermaid 或 Tauri host。
自訂 System TeX 設定屬於先前編輯器的功能。其他限制見[已知限制](docs/user/KNOWN_LIMITATIONS.md)。

完整桌面應用程式衍生自 Texpile，採 [AGPL-3.0-only](LICENSE)。
[LICENSING.md](LICENSING.md) 明列的原創前端及共用套件採 Apache-2.0；
第三方元件保留各自授權與 notices。

[版本紀錄](CHANGELOG.md) · [安裝說明](docs/user/INSTALLATION.md) · [授權範圍](LICENSING.md)
