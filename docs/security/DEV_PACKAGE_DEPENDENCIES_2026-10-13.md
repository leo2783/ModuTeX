# Dev 下載包依賴更新

乾淨 dev 整合工作區的 npm audit 發現 3 high、7 critical；下載包保留既有 high audit 與 registry signatures 門檻，不使用 force fix 或跳過檢查。

| 元件 | 採用版本 | 原因 |
| --- | --- | --- |
| MCP SDK | 1.32.1 | 修正 OAuth 授權伺服器信任問題 |
| simple-git | 4.0.2 | 修正 Git 設定、編輯器與參數安全檢查繞過 |
| concurrently | 9.2.5 | 採用修正後 shell-quote |
| Vitest | 4.1.11 | 移除受影響的 mocker／tinypool 版本 |
| ProseMirror view／model | 1.42.6／1.25.12 | 修正貼上 XSS，統一模型版本避免重複型別 |
| proxy-addr | 2.0.8 | 修正 IPv4-mapped IPv6 信任範圍 |
| source-map-js | 1.2.2 | 修正 indexed source-map 阻斷服務 |

根 manifest 與 lockfile 鎖定版本，security-floor 測試檢查所有解析路徑。前端第三方 notice 保留完整 MIT 授權並更新版本標示。Playwright 1.61.1 僅用於實際 EXE／npx 驗證，不放入下載包。

更新後 audit 為 0 high、0 critical；仍有 9 moderate、1 low。完整原始 audit／registry 簽章報告放入本次 build 證據，這份更新不代表中低風險全部解除。
