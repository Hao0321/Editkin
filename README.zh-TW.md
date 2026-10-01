# Editkin

Editkin 是以本機為主的影片剪輯器，提供可修改的時間軸、共用的 EditGraph，以及讓 AI 工具操作剪輯的結構化指令。這個儲存庫是社群原始碼版，使用中性的預設樣式與合成示範影片；不包含維護者的私人素材、音樂、個人 Skill、模型權重、簽章憑證或預先編譯的媒體執行檔。

## 與 Video Autopilot Kit 一起自動剪輯

[Video Autopilot Kit](https://github.com/Hao0321/video-autopilot-kit) 提供 AI Agent 使用的剪輯規則與公開設計參考。Codex、Claude Code 或其他支援 MCP 的 Agent 讀取 Kit、檢查素材，再透過 Editkin 的本機 MCP 工具準備、審核、套用與輸出可編輯的 v4 剪輯計畫。Editkin 是影像引擎；剪輯決策由 Agent 負責。

開發整合功能時，先安裝或 clone Kit，在啟動 Editkin 的 `npm run mcp` 前，將 `EDITKIN_VIDEO_AUTOPILOT_SKILL` 設為 Kit 中 `codex-skill/video-autopilot/SKILL.md` 的絕對路徑，並讓 Agent 讀取同一份 Kit。Editkin 會將選用的 Skill 與工作流程契約綁定計畫，套用前再檢查變動。公開 Kit 不依賴維護者私人美感資料；真實素材與成片品質仍須審查。

## Motion 與時間軸原始碼

Motion 預設包含外緣羽化的可編輯浮空影片框、直式透視環繞，以及主片後方兩片大型直式影片框。`prepare_floating_frame_scene` 會將場景編譯為可放進已審核 v4 計畫的指令。此效果使用 2.5D 透視平面，尚非立體網格。素材拖入時間軸可吸附剪輯定位點，片段也能依影格移動。預覽與輸出效能取決於媒體執行環境和機器，原始碼功能不代表每支影片的美術品質已通過驗收。

## 瀏覽器版本

網頁版（`npm run build`，或本機 `npm run dev`）可匯入素材、預覽、編輯時間軸及輸出**草稿影片**；需要本機 Whisper 或 FFmpeg 的自動工作流程仍須使用桌面版。專案不會自動儲存或還原，重新整理頁面就會遺失。可另從**更多 → 專案、工作區與進階 → 下載專案 JSON** 保留可編輯的 EditGraph。

**輸出草稿**使用 Canvas、Web Audio 與 MediaRecorder，不新增依賴、不上傳素材，也不需要 SharedArrayBuffer 或另一個 service worker。每次匯出會偵測編碼器支援：優先 H.264/AAC MP4，否則使用 VP9/Opus 或 VP8/Opus WebM。即使瀏覽器回報支援，錄製時仍可能失敗；解碼或編碼不支援會明確報錯，不下載半成品。匯出耗時約等於片長，請保持分頁在前景；取消、修改專案、切到背景或播放時鐘中斷會停止匯出。檔名帶 `_draft`，畫面有 `Editkin · DRAFT` 標示；**不等同 Rust／GPU 管線**，也不綁定正式輸出審查。

草稿限制：最長 5 分鐘、最多 32 個啟用的素材片段、長邊 1280 像素、目標最高 30 fps，128 MiB 編碼輸出緩衝、不同來源檔案合計 128 MiB，以及解碼後圖片／影片最多 16 MiPixels、單邊 8192 像素（不是瀏覽器記憶體沙箱）。影格間距、片段邊界及音訊時序是即時錄製近似，不是逐幀精準交付；MediaRecorder 的 WebM 可能缺少片長／快速定位中繼資料。支援本頁匯入且瀏覽器可解碼的影片、聲音、圖片、來源裁切、時間軸空隙、多軌與音量混音、2D 變形／關鍵影格、裁切／畫中畫版面、混合模式、相容預覽等級的調色／Look／效果／轉場近似，以及燒錄字幕／翻譯。只讀取本頁匯入的 blob 素材；原生／GPU 外掛、遮罩／去背／Matte、父子／控制／調整圖層、巢狀合成、浮空／3D／粒子場景、動態圖文、明確指定的 opaque／premultiplied Alpha 解讀、ACES／HDR／Log／線性色彩及線性白平衡會阻擋而非偷偷略過。這些功能與正式高品質輸出請使用桌面版。

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
