<p align="center">
  <img src="build/icons/128x128.png" alt="ModuTeX" width="80" height="80">
</p>

<h1 align="center">ModuTeX</h1>

<p align="center">內建編譯器的視覺化 LaTeX 編輯器。</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-TW.md">繁體中文</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.1.0-526B87?style=flat-square" alt="版本 0.1.0">
  <img src="https://img.shields.io/badge/Windows-x64-526B87?style=flat-square" alt="Windows x64">
  <img src="https://img.shields.io/badge/Node.js-24.19.0-4D7756?style=flat-square&amp;logo=nodedotjs&amp;logoColor=white" alt="Node.js 24.19.0">
  <img src="https://img.shields.io/badge/npm-11.17.0-AC5151?style=flat-square&amp;logo=npm&amp;logoColor=white" alt="npm 11.17.0">
  <a href="LICENSING.md"><img src="https://img.shields.io/badge/license-AGPL--3.0--only-76638A?style=flat-square" alt="授權：AGPL-3.0-only"></a>
</p>

ModuTeX 將文件編輯與 PDF 編譯整合在同一個桌面工作區。可切換視覺編輯與 LaTeX 原始碼、編輯公式及表格，並在文件旁預覽編譯結果。


新版工作台提供原始碼／視覺化切換、文件內文字編輯，以及區塊間的文字、公式、矩陣與表格插入；未儲存關閉可選儲存、放棄或取消。驗收範圍與限制見 [前端品質驗收](docs/architecture/FRONTEND_UX_ACCEPTANCE_2026-10-11.md)。

## 功能

- **視覺與原始碼編輯**：以視覺方式編輯支援的文件結構；自訂指令與版面可直接修改 LaTeX 原始碼。
- **公式與矩陣**：在文件中插入數學內容與編輯矩陣。
- **表格編輯**：增刪行列、調整欄寬、選擇說明文字位置，並套用常見論文表格樣式。
- **內建 PDF 編譯**：使用隨附的 Tectonic 引擎，無須另裝 TeX 發行版；缺少的資源會從固定來源下載並快取於本機。
- **繁體中文與英文介面**：可在偏好設定中切換語言。

## 開始使用

桌面版支援 Windows x64，需使用上方標示的 Node.js 與 npm 版本。

從 [GitHub Releases](https://github.com/leo2783/ModuTeX/releases) 下載 `modutex-desktop-0.1.0.tgz`，在下載資料夾中執行：

```powershell
npx --offline --yes --ignore-scripts --package .\modutex-desktop-0.1.0.tgz -- modutex
```

上述指令會啟動桌面應用程式。npm 的 `--offline` 僅限制套件解析；首次編譯或文件需要尚未快取的資源時，Tectonic 仍需網路。

開啟專案資料夾、選取 `.tex` 文件，並將編譯器設為 **Managed Tectonic**。已設定本機 TeX 工具鏈時，也可選擇 System TeX。

## 開發

在儲存庫根目錄執行：

```powershell
npm ci
npm run electron:dev:frontend
```

此指令會在 Electron 開啟新版工作台，前端開發伺服器使用 5174 埠。若要建置並從本機靜態檔案開啟新版工作台：

```powershell
npm run electron:frontend
```

新版工作台仍在開發中，與已發行的 0.1.0 套件不同。`npm run electron:dev` 會開啟 5173 埠的舊版編輯器；切換啟動模式前，先在目前的啟動終端按 `Ctrl+C`。驗收結果與限制請見[新版前端與 Electron 整合](docs/architecture/FRONTEND_ELECTRON_INTEGRATION.md)。

建置舊版正式應用程式或執行其驗證套件：

```powershell
npm run app:build
npm run verify:modutex
```

專案使用 Electron、Svelte 與 TypeScript，依賴版本固定於 `package-lock.json`。

## 文件

- [安裝與編譯器設定](docs/user/INSTALLATION.md)
- [版本紀錄](CHANGELOG.md)
- [已知限制](docs/user/KNOWN_LIMITATIONS.md)
- [授權與第三方元件](LICENSING.md)

Draw.io、Mermaid、視覺章節折疊與簽章安裝程式不在 0.1.0 功能範圍內。表格目前的行為限制與平台條件請見已知限制。

## 授權

ModuTeX 衍生自 Texpile，整體採用 [AGPL-3.0-only](LICENSE)。[LICENSING.md](LICENSING.md) 明列的原創工具採用 Apache-2.0；第三方元件保留各自授權與 notices。
