# 說明頁接線

> 歷史實作／審查紀錄。下列測試數字與待辦反映早期改寫階段；現行功能、版本及目錄以[實作狀態](FRONTEND_REWRITE_STATUS.md)與[開發指南](../user/DEVELOPMENT.md)為準。

- `#/help`／`#/help/<topic>` 提供開始使用、編輯、表格／公式、編譯、快捷鍵、0.1.0 安裝指南、授權與 notices。未知分類回到開始使用；不開啟任意外部 URL。
- 操作指引為新寫文字，依目前接線撰寫；Ctrl+O 與可配置編譯快捷鍵已接線，不宣稱 autosave、MathLive 或尚未完成的工具已可用。
- 安裝指南為實際 `docs/user/INSTALLATION.md`；明確標為 0.1.0，不冒稱新版已發布。Markdown fence 由安全的文字／code 元件保留換行，內容不執行；超限及未封閉 code block 拒絕。
- AGPL／Apache 全文直接讀附帶檔案；授權範圍分開 host、新前端待審查與兩項既有 Apache 例外。Tectonic／Draw.io 及已列前端元件的聲明可讀；完整依賴／font／asset 閉包及 notices 審查仍待完成。
- Help 與授權文件為真正延遲 chunk，初始靜態閉包不含全文；切至 Help 保留已開文件，隱藏 editor 唯讀，PDF 暫停。分類改變將焦點移至標題；桌面焦點仍待验收。
- 三項新增回歸包含路由、fence 安全與真正 Svelte/Vite SSR；JSDOM 驗證 code 命令換行、無 script 與 AGPL／Apache 全文一致。不是 Chromium／Electron／320px／150%／英文或 Impeccable fidelity 證據。
- 本輪前端 76、production 產物 1 項通過，check 0 errors／warnings；初始 JS 94.24 KB、Help 79.33 KB，門檻不變。未修改套件／根授權／legacy、未 commit／push。
