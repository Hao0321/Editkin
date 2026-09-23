# Editkin

Editkin 是以本機為主的影片剪輯器，提供可修改的時間軸、共用的 EditGraph，以及讓 AI 工具操作剪輯的結構化指令。這個儲存庫是社群原始碼版，使用中性的預設樣式與合成示範影片；不包含維護者的私人素材、音樂、個人 Skill、模型權重、簽章憑證或預先編譯的媒體執行檔。

## 與 Video Autopilot Kit 一起自動剪輯

[Video Autopilot Kit](https://github.com/Hao0321/video-autopilot-kit) 提供 AI Agent 使用的剪輯規則與公開設計參考。Codex、Claude Code 或其他支援 MCP 的 Agent 讀取 Kit、檢查素材，再透過 Editkin 的本機 MCP 工具準備、審核、套用與輸出可編輯的 v4 剪輯計畫。Editkin 是影像引擎；剪輯決策由 Agent 負責。

開發整合功能時，先安裝或 clone Kit，在啟動 Editkin 的 `npm run mcp` 前，將 `EDITKIN_VIDEO_AUTOPILOT_SKILL` 設為 Kit 中 `codex-skill/video-autopilot/SKILL.md` 的絕對路徑，並讓 Agent 讀取同一份 Kit。Editkin 會將選用的 Skill 與工作流程契約綁定計畫，套用前再檢查變動。公開 Kit 不依賴維護者私人美感資料；真實素材與成片品質仍須審查。

## 從原始碼開始

安裝 Node.js 22.13 以上，於新的 checkout 執行：

```sh
npm ci
npm test
npm run build
npm run dev
```

瀏覽器介面會在 `http://127.0.0.1:5173` 啟動。完整桌面版還需要 Rust 與各平台的媒體依賴。若已自行安裝 FFmpeg 與 ffprobe，可執行 `npm run test:journey`，使用合成素材驗證匯入、修改、預覽狀態、存檔重開及輸出。詳見 [建置說明](docs/BUILDING.md)。

## 一起貢獻

[GitHub Issues](https://github.com/Hao0321/Editkin/issues) 是公開工作清單，可先找 `good first issue` 或 `help wanted`。歡迎回報問題、改善無障礙與跨平台體驗、補文件，或用小型 Pull Request 改進功能。重大設計先開 Issue 討論。送出前請閱讀 [貢獻規則](CONTRIBUTING.md)、[社群合作](docs/COMMUNITY.md)、[安全通報](SECURITY.md)與[商標說明](TRADEMARKS.md)。每個 commit 請用 `git commit -s` 附上 DCO 簽署；貢獻者保留自己的著作權，無須移轉給維護者。

程式碼以 GPL-3.0-or-later 提供。第三方字型和色彩設定保留各自的授權與來源聲明。未來的贊助可支持開發與維護，但不影響社群貢獻的授權。

## 安全與發行狀態

外部 PR 視為不受信任的程式碼：CI 不持有正式簽章憑證，合併須經人工審查與檢查。自動掃描無法保證程式碼沒有惡意行為。發現漏洞請依 [安全通報](SECURITY.md)私下回報，不要在公開 Issue 放利用細節。

目前公開的是可協作的原始碼，**沒有通過正式安裝包的發行審查**。任何 PR 產物或自行建置的執行檔都不代表官方發行。正式下載會在相依授權、各發布平台的實機測試、最終檔案雜湊、SBOM、專案簽章與來源證明完成後另行公告；若尚無作業系統簽章，會明確標示並停用現有需要 Authenticode 的 Windows 自動更新。
