<p align="center"><img src="apps/desktop-tauri/icons/icon.png" alt="ModuTeX" width="64" height="64"></p>
<h1 align="center">ModuTeX</h1>
<p align="center">內建編譯器的視覺化 LaTeX 編輯器。</p>
<p align="center"><a href="README.md">English</a> · <a href="README.zh-TW.md">繁體中文</a></p>

ModuTeX 0.3.0 是適用於 Windows x64 的開源 LaTeX 編輯器，使用 Tauri 2 與 Svelte 開發。
左側編輯區可在「視覺化」與「原始碼」之間切換，右側保留編譯後的 PDF，方便對照內容與排版。

文件以純文字 `.tex` 檔案儲存。你可以在視覺模式撰寫內文、公式與表格，再點選「編譯 PDF」，透過內建 Tectonic 引擎產生文件。
視覺區是編輯草稿，最終字型、間距與分頁請看 PDF；首次編譯可能需要連線下載 TeX 資源。

![視覺編輯與編譯後的 PDF 並列](docs/images/workbench.png)

## 介面預覽

可切換至 LaTeX 原始碼，並同時查看 PDF 排版。

![LaTeX 原始碼編輯器與 PDF 預覽](docs/images/source-editor.png)

為工作區選擇主文件與編譯引擎，並設定文件標題是否顯示日期。

![工作區編譯設定](docs/images/compile-settings.png)

## 主要功能

- **兩種編輯模式**：在視覺草稿與 LaTeX 原始碼之間切換，兩者共用復原與重做紀錄。
- **Notebook 儲存格**：用可插入、移動與編輯的儲存格，組織文字與章節標題。
- **公式、表格與程式碼**：從模板建立公式與矩陣，調整表格行列，或插入程式碼區塊與圖片。
- **本機編譯**：點選「編譯 PDF」執行內建 Tectonic；缺少 TeX 資源時可能需要網路連線。
- **PDF 預覽與診斷**：在編輯區旁檢查編譯結果。失敗時顯示診斷，並保留前一次成功的 PDF。
- **範本、日期與語言**：將範本另存為 `.tex`，選擇標題日期格式，並以繁體中文或英文操作介面。

## 使用說明

ModuTeX 0.3.0 適用於 **Windows x64**。
發行版本可至 [GitHub Releases](https://github.com/leo2783/ModuTeX/releases) 下載。

1. 啟動 ModuTeX 並選擇「新文件」、「開啟檔案」或「開啟資料夾」。
2. 在視覺模式編輯，或切換原始碼模式輸入 LaTeX 指令。
3. 點選「編譯 PDF」，完成編譯與預覽。

## Fork開發建置

### 環境需求

- Windows x64
- Node.js `24.22.1` 與 npm `11.19.1`
- Rust（穩定版 MSVC 工具鏈）與 `wasm32-unknown-unknown` 目標（`rustup target add wasm32-unknown-unknown`）

### 建置與執行

安裝相依套件並編譯桌面應用程式：

```powershell
npm ci

# 建置前端與 Tauri Release 執行檔
npm run build

# 直接啟動已建置的 Tauri 執行檔
npm run tauri
```

### 驗證與測試

```powershell
npm run frontend:check
npm run frontend:test
```

## Code signing policy／程式碼簽章政策

目前正在準備 SignPath Foundation 申請。簽章範圍、團隊角色與發布核准流程請參閱 [Code signing policy](docs/distribution/SIGNPATH_ELIGIBILITY.md)；本機資料與網路行為請參閱[隱私政策](docs/user/PRIVACY.md)。

## 授權條款

目前 Tauri 應用程式的原創程式碼採用 [Apache-2.0](LICENSE) 授權。
各模組範圍與第三方聲明請參閱 [LICENSING.md](LICENSING.md)。
