# Editkin

Editkin 是以本機為主的影片剪輯器，提供可修改的時間軸、共用的 EditGraph，以及讓 AI 工具操作剪輯的結構化指令。這個儲存庫是社群原始碼版，使用中性的預設樣式與合成示範影片；不包含維護者的私人素材、音樂、個人 Skill、模型權重、簽章憑證或預先編譯的媒體執行檔。

## 與 Video Autopilot Kit 一起自動剪輯

[Video Autopilot Kit](https://github.com/Hao0321/video-autopilot-kit) 提供 AI Agent 使用的剪輯規則與公開設計參考。Codex、Claude Code 或其他支援 MCP 的 Agent 讀取 Kit、檢查素材，再透過 Editkin 的本機 MCP 工具準備、審核、套用與輸出可編輯的 v4 剪輯計畫。Editkin 是影像引擎；剪輯決策由 Agent 負責。

開發整合功能時，先安裝或 clone Kit，在啟動 Editkin 的 `npm run mcp` 前，將 `EDITKIN_VIDEO_AUTOPILOT_SKILL` 設為 Kit 中 `codex-skill/video-autopilot/SKILL.md` 的絕對路徑，並讓 Agent 讀取同一份 Kit。Editkin 會將選用的 Skill 與工作流程契約綁定計畫，套用前再檢查變動。公開 Kit 不依賴維護者私人美感資料；真實素材與成片品質仍須審查。

## Motion 與時間軸原始碼

Motion 預設包含外緣羽化的可編輯浮空影片框、直式透視環繞，以及主片後方兩片大型直式影片框。`prepare_floating_frame_scene` 會將場景編譯為可放進已審核 v4 計畫的指令。此效果使用 2.5D 透視平面，尚非立體網格。素材拖入時間軸可吸附剪輯定位點，片段也能依影格移動。預覽與輸出效能取決於媒體執行環境和機器，原始碼功能不代表每支影片的美術品質已通過驗收。

## 瀏覽器版本

網頁版（`npm run build`，或本機 `npm run dev`）提供桌面版介面的瀏覽器版本。它可以匯入素材、預覽並編輯時間軸；需要本機 Whisper 或 FFmpeg 的自動工作流程，例如語音轉字幕與媒體分析，必須使用桌面版。網頁版無法輸出影片：「匯出專案」只會下載 EditGraph JSON。專案不會自動儲存或還原，重新整理頁面就會遺失。若有公開的網頁版部署（例如 GitHub Pages），可用來試用介面；上述自動工作流程與影片輸出請使用桌面版。

網頁版「刪掉停頓」會用 Web Audio 在本機分析本次匯入的影片／音訊：以 10 ms RMS 視窗偵測靜音，預設門檻 -35 dB、最短停頓 0.35 秒；沿用桌面版逐幀對齊的 planner 與 `smart_cut_clip` 指令，可復原／重做。在「更多」→「專案、工作區與進階」的工作區設定開啟自動剪輯面板，選取時間軸片段，再展開更多一鍵功能即可使用。**整份來源檔案須在 32 MiB、5 分鐘以內**，並含瀏覽器可解碼的單／雙聲道音訊；裁短片段不能繞過來源上限。Web Audio 必須整檔解碼，並非串流；音訊會重採樣至 16 kHz，僅分析所選來源區間，所有聲道都安靜才算靜音。不支援的格式、沒有音軌或找不到本次匯入的檔案時，會顯示錯誤而不修改時間軸；重新整理後須重新匯入素材。素材不會上傳。RMS 偵測結果不保證與 FFmpeg `silencedetect` 逐樣本相同。

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
