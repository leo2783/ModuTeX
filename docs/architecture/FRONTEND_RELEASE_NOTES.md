# 版本紀錄接線

> 歷史實作／審查紀錄。下列測試數字與待辦反映早期改寫階段；現行功能、版本及目錄以[實作狀態](FRONTEND_REWRITE_STATUS.md)與[開發指南](../user/DEVELOPMENT.md)為準。

- `#/release-notes` 讀取建置時的根 `CHANGELOG.md`；版本索引不查網路或啟動 updater。
- `#/release-notes/limitations` 顯示附帶的 0.1.0 限制文件，不把歷史功能宣稱為新版前端現況。
- 保留文件中的版本與日期／狀態文字。使用者確認：前端重寫為 `0.2.0 — Unreleased`，`0.1.0 — 2026-10-06` 為已發布版本；不改寫舊版功能或推定其他日期。
- heading／list／paragraph／inline code 由語意 Svelte 元件輸出；未知語法按文字顯示，不使用 HTML 注入。
- 只將明確的 `docs/user/KNOWN_LIMITATIONS.md` 連結映射到附帶閱讀頁；其他連結不啟動任意 URL。
- 來源限 128 Ki UTF-16 units、版本限 100，重複索引拒絕；清單以線性追加建立，不逐項複製累積陣列。
- 新台帳記錄 bundled 文件待獨立審查；不將原有文件來源自動認定為已通過 Apache 審查。
- 四項新增回歸涵蓋真文件、上限／重複索引、inline 路由及真 Svelte/Vite SSR。SSR 不等於 Electron 點擊／焦點／縮放或 Impeccable fidelity 驗收。
