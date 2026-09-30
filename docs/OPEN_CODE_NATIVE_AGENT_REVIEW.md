# OpenCode Agent 側欄實機 Review（2026-09-29）

## 第五十八輪：精簡來源選擇與 Agent 介面名稱（2026-09-30）

- 八個供應商／來源大項，再選來源模型；API／登入只在設定。輸入框底下一列模式、來源／模型按鈕及傳送，選單預設收合，未設定只顯示短提示。未知來源提示到設定；未設定來源保留原生模型及對話，按鈕與 Enter 皆阻止誤傳。
- 最終 `14-15-46` 的 `agent-caption-review-a6c1IU` PASS：八大項、來源模型隔離、設定導向、未設定阻擋、未知來源提示、四個閘道 fixture 路由共用 session、原生登入開始／取消、一次字幕修改／Undo／resume。收合輸入區高 124.5 px，選單隱藏且沒有水平溢位。
- 使用者要求不顯示 OpenCode：產品標題、設定、回覆署名、授權、提示及 aria/title 統一為 Agent；native EXE 檢查實際可見文字及標籤。內部相容性識別碼和開源歸屬保留，使用者輸入與模型內容不改寫。
- `agent-caption-review-ilkd3L` PASS 直接 API fixture（2.783 秒）及設定中的正常模型刷新／resume。`agent-caption-live-PAq4Mz` PASS 去重後真正本機模型（17.179 秒），一次成功修改、零失敗 apply、一次 Undo，原 Kit 證據不變。`agent-binding-review-nKzdDr` PASS 跨專案完成、舊結果重開、拒絕開啟保護未儲存內容。
- 114 項 Agent／MCP 來源測試、typecheck、封裝 build 通過；清理保護測試見保留政策。真實 OmniRoute、雲端帳號推論與登入額度仍未驗證。本輪建立本機還原點，不推送 GitHub。
- 中間 BLOCK `c7izLF`／`l6js6C` 是測試未等可傳送／切換時機；`tVytJe` 使用 UI 外 close/start 導致舊 UI 停止輪詢。最終改測使用者實際設定刷新流程，沒有宣稱一般外部 API 重連問題已修復。所有報告保留。

## 第五十七輪：OmniRoute 與共用 Agent 視窗（2026-09-30）

- OmniRoute 作為外部 OpenAI-compatible 閘道接入原生 OpenCode；本機、六家直接 API／ChatGPT 裝置登入、閘道路由共用原側欄輸入框、對話、模型選單與 ACP／MCP 剪輯工具。模型選單標明來源，沒有新增另一套剪輯 session。
- 僅納入 catalog 明確宣告 tool_calling=true 的模型，保留完整多層 route ID；未知、false 或矛盾能力資料排除。URL、回覆大小、redirect、設定檔路徑與版本刷新有門檻，HTTP401／429 不重送剪輯；閘道 key 只交原生 Auth API，app metadata 不存 key。
- 最終 `11-32-55` 去重後 `agent-caption-review-yFq3yf` PASS：同一視窗／session 切換 Claude、Codex、Grok、Gemini 的四個 fixture 路由，失敗 catalog 保留設定，刷新前拒絕 prompt；真正 native device auth 開始／取消、一次字幕修改／Undo、復原同步及 resume 不重複套用，1.663 秒。
- `agent-caption-review-IDOoiS` PASS 六家直接 API UI 與原生 device 流程、OpenRouter 格式 fixture 字幕修改／Undo／resume，2.682 秒。`agent-caption-live-KRNz73` PASS 真實本機模型，12.060 秒、一次成功修改、零失敗 apply、一次 Undo；其他欄位與原 Kit 證據保持。
- `agent-binding-review-suUcPO` PASS 跨專案忙碌回合後完成、舊結果可重開、拒絕開啟保護目前未儲存內容，沒有重送剪輯。69 項聚焦來源測試、typecheck、最終封裝通過。初次編譯使用不存在的 reqwest reexport，改用既有 tauri::Url 後成功，沒有新增依賴；`agent-caption-review-AScPm4` 為去重前 fixture PASS，最終證據採 yFq3yf。
- 本輪沒有部署真實 OmniRoute；目前本機 Node 版本不符合該 runtime engine。四路測試使用明示模擬 API，不代表四家帳號、額度或真實推論通過。API／登入方法依實際閘道與帳號決定，細節見 [OmniRoute 整合說明](OMNIROUTE_INTEGRATION.md)。改動只留本機，GitHub 提交等待使用者決定。

## 第五十六輪：多供應商 API、ChatGPT 裝置登入與協定（2026-09-30）

- 新增原生 OpenCode Auth API 控制及設定 UI，支援 OpenAI、Anthropic、Google Gemini、OpenRouter、xAI、DeepSeek。模型選擇與 resume 的 UI／Node／Tauri gates 一致；維持原 ACP、MCP、專案綁定、permission、schema、字幕目標凍結與單次 Undo。
- OpenAI 使用原生 headless/device 方法。測試過的 browser callback 會在 Windows 留下兩個 FirewallControlPanel 通知；已查明目標 EXE 結束，僅關閉兩個屬於本輪測試的通知，沒有改防火牆規則或停止 svchost。最終裝置流程沒有本機 OAuth callback listener。
- 供應商 child 受本機 Agent lane 管理，loopback＋隨機記憶體 Basic 密碼、20 秒啟動／15 秒一般 HTTP、60 秒 idle／10 分鐘登入上限。取消 abort callback，遲到完成被拒。憑證版本變更後刷新前 UI／backend 都拒絕新 prompt；已有剪輯回合和原專案邊界保留。
- 最終 `10-29-41` 已去重五项固定 vendor。`agent-caption-review-I7GbS3` PASS：六家 UI、遮罩空 key、真正 native device auth 開始／取消、auth URL 不進 renderer、雲端 fixture 模型／工具 schema／一次修改／一次 Undo／同一 cloud session 恢復不重送，2.843 秒。此為明示隔離 API fixture，沒有真實 API key、計費或已登入帳號推論。
- `agent-caption-live-DL72xa` PASS 真實本機模型，18.174 秒、一次成功修改、零失敗 apply、一次 Undo、其他欄位與原 Kit 證據不變。`agent-binding-review-7jDPqN` PASS 跨專案舊回合完成、結果重新開啟與未儲存內容保護。40 項相關測試與完整 build 通過。
- 中間 cloud 路徑 `bEJ7ox`、`iZxJxm`、`ECdAuY`、`QXJwKk` 的報告保留；`QXJwKk` 與最終 `I7GbS3` 為 device auth。最初編譯版發現 Tauri resume 仍限制本機，已在後續版修正，不把中間 build 當最終驗收。實際 ChatGPT 方案額度／token renewal、各家付費推論尚未驗證；細節見 `AGENT_PROVIDER_INTEGRATION.md`。

## 第五十五輪：完整字幕參數與精確字詞校對（2026-09-30）

- 前一輪真實模型缺少 projectPath。字幕 context 原本只列 commands，gateway 的 arguments 只宣告 object；現在給完整 call_editkin_tool envelope，宣告可見的 arguments.projectPath／commands。其他原生工具參數仍允許，原後端完整驗證與單專案邊界保留。
- 首個 `08-35-49` 中間版的 `agent-caption-live-rkY9rc` PASS／14.095 秒；第二個 `h2qALs` BLOCK：模型成功提交兩次，把「今天我们要把影片检好」改成「今天我要把影片剪好」，超出單字校對。這個反例顯示格式通過仍不代表文字範圍正確，原報告保留。
- 最終 `09-00-53` 針對唯一的一處引號字詞替換提供 exact patch.text 與 captionId，其他文字、標點、繁簡體保留。否定、條件、不同文字、多項替換或重複命中不產生直改提示；該提示不直接寫檔，仍經真正 MCP。`agent-caption-live-Nw00ab` 14.168 秒 PASS，資源去重後 `agent-caption-live-9X1doS` 13.192 秒 PASS；皆一次成功修改與一次 Undo，原 Kit 證據不變。
- `agent-caption-review-zfHkKc` PASS 原生模型 schema 及精確 envelope、凍結字幕目標、同步／取消引用；`agent-binding-review-9mPKAb` PASS 完整跨專案剪輯及明確重新開啟回歸。`native-agent-review-SKwotW` 通過中間版廣泛 Agent 回歸。27 項來源測試、typecheck／兩次 build 通過，沒有把同一案例的有限實測當成所有自由字幕改寫都可靠。
- 冷備份壓縮、實際還原與清理依據見 `PORTABLE_PREVIEW_RETENTION.md`。ASR `m4KyZm` 是驗收命令遺漏 WAV 參數造成的 BLOCK；補上既有真正 WAV 後，冷備份還原的 `05-04-35` 版 `packaged-asr-review-VFnCQg` PASS，125 檔還原且桌面語音辨識／粗剪入口可用，錯字品質仍未宣稱改善。

## 第五十四輪：跨專案完成結果與安全重新開啟（2026-09-30）

- 舊 `07-04-09` 的 `agent-binding-review-Ljm0Yl` 重現：B 回合經真實 ACP／MCP 完成一次音量修改，C 沒有被覆寫，但重新綁定 C 後 B 的結果入口消失。此為結果可見性缺口，沒有發現磁碟剪輯遺失。
- 新 `08-02-12` 保留最近五個先前完成專案的本機結果指標，顯示專案名稱及「開啟剪輯結果」。自動重新綁定不載入舊專案；只有明確開啟才載入。未儲存修改可拒絕離開，載入期間再次編輯／切換／儲存時拒絕取代目前內容。工作副本重新開啟後需儲存正式專案，沿用原副本與對話，不重送剪輯。
- `agent-binding-review-VYbEHH` PASS 基本跨專案剪輯；`agent-binding-review-X3KxUG` PASS 完整驗收：C 不變、B 修改一次、1280×720 提示可見、結果指標落在本機可選儲存、拒絕開啟保留 C 未儲存音量，再確認開啟 B，屬性面板顯示 37%。此多專案測試是 loopback 模型透過真正 MCP 執行，沒有冒充真實 Qwen 的多專案驗收。
- `agent-caption-review-8cXTp4` PASS，字幕目標、schema、一次修改／Undo、同步與取消引用，以及原 Kit 證據不變；`native-agent-review-hgh6WF` PASS 廣泛 Agent 回歸。31 項來源測試、typecheck、封裝 build 通過。`mcDzIY`、`njh10O`、`i1zHhW` 為新測試脚本的面板／初始頁查詢問題，修正後由 X3KxUG 驗證，原 BLOCK 報告保留。
- 真實 Qwen 的 `agent-caption-live-N9uywR` BLOCK：先有一次缺少 projectPath 的 apply 呼叫被拒，再查 schema 並成功修改一次。它沒有通過無失敗門檻；兩次嘗試不能被描述為兩次成功剪輯。本輪補記成功與失敗呼叫數的診斷，不放寬驗收。
- 維護工具也重現已存在完整還原清單時無法淘汰舊版。改為逐檔比對 SHA／bytes 後重用原清單，不重寫；不符或刪除前 bytes 變動時拒絕。八項隔離保護測試包括兩次 byte-exact restore 與既存備份拒絕／重用。

## 第五十三輪：啟動排隊不遺失與忙碌回合後續接（2026-09-30）

- 新 `review-agent-startup-binding.mjs` 使用封裝 EXE、真實 OpenCode ACP 與原生工作副本，只延遲 bridge 已完成呼叫的回應。舊 `05-40-33` 的 `agent-binding-review-diaVXF` 重現 A 已連線、B 副本已存在，但 B 排隊工作被 busy 狀態變更取消；原先 reservation 留著，後續不再啟動。報告分類 `REPRODUCED_STALE_BINDING`、status BLOCK 為預期基線失敗。
- `07-04-09` 的 `agent-binding-review-Ik31qD` 及 `agent-binding-review-upQY6K` PASS：延遲回應後綁定最新 B；B 回合尚在真正模型管道執行時開 C，維持 B 連線，不呼叫 close；B 正常 end_turn 後自動綁定 C，C selection 與磁碟 project ID 相符，舊 B 工作副本 bytes 不變。busy 更新只觸發已等待的續接，不取消正在排隊的 startup。回應來自 loopback 模型，沒有宣稱真實 Qwen 已完成這個多專案流程。
- 等待改為可理解的 role=status 提示，預期等待不作失敗警告；1280×720 WebView 完整可見且無水平溢位，截圖在 `agent-binding-review-upQY6K`。首個新測試 `sjyi4l` 因 bridge 尚未載入便查詢而失敗；`2f0ElA` 因忙碌時產品呈現停止鈕、沒有發送鈕而被測試誤判。腳本分別等待 bridge 及接受發送鈕不存在／停用，兩項不算產品修正。
- 啟動、字幕及 ASR 三個隔離 EXE 並行通過；字幕 `agent-caption-review-WUByCO` 檢查原生命令查詢與單次校對；ASR `packaged-asr-review-AK20QY` ready、無下載、可開始粗剪，誤辨「检好」仍保留。真實 Qwen `agent-caption-live-TaA8Bx` 28.217 秒校對成功、一次 Undo、原 Kit 證據不變；`native-agent-review-QOkkd8` 通過既有功能。10 個來源聚焦測試通過。
- 最終 EXE SHA-256 `566d1e5da67a26c0808328e359c25bc05972139e33e0965eaaf2afc8b62b3144`，需同層 resources。第五十二輪那次並行逾時沒有 lastObserved，不能反推唯一歷史原因；本輪有新的可重現故障與修正證據，且新並行驗收通過。正式多素材語音故事與真人審片仍未完成。
- 本版五項固定資源去重後，125 檔 hash 全相符，`agent-binding-review-H30Be4` 從實際去重後套件再次 PASS。十個本輪測試程序退出；快取清除、還原 tag／整包備份、版本及交接記錄見本輪 artifacts 與 `PORTABLE_PREVIEW_RETENTION.md`。

## 第五十二輪：精準命令查詢與封裝資源清理（2026-09-30）

- 新增 `inspect_editkin_tool({name:"apply_edit_commands",commandType:"update_caption"})`：直接讀原 backend schema 的命令分支及呼叫格式，返回原 schema path；其他工具拒絕 commandType，原有路徑與分頁查詢保留。4 項新測試及 3 項字幕引用測試 PASS，型別檢查與封裝 build PASS。
- 最終 `05-40-33` 的 `agent-caption-review-ING1Ms` 經內附 OpenCode／MCP 讀取真正命令 schema，再執行一次 edit；驗證請求送出後切換選取仍修改原字幕、一次 Undo、下次請求同步復原、引用取消。schema 回應有真實 `patch`，且不包含無關的素材匯入命令。
- `agent-caption-live-up8WCz` 使用已儲存的區網 Qwen，20.202 秒完成校對，edit 一次、failed 零次、schema query 零次；目標凍結、其他字幕與欄位不變、Undo 及原 Kit workflow／收據雜湊皆通過。新 query 的原生工具行為由前項證明，真實模型此回合沿用精確提示。
- 首次 `agent-caption-review-bm3gpJ` 與 ASR 並行時等待專案綁定逾時，沒有呼叫新 schema 工具；後續順序執行成功。原因未確認，驗收腳本增加逾時最後狀態記錄供下一輪追查，不宣稱 startup 已修復。
- 去重後 `packaged-asr-review-VvhRqI` PASS：內附 Whisper ready，中文 cues、無模型下載、粗剪入口可開始；字詞仍誤辨「检好」，工程 smoke 不等於語音準確性通過。原 `kit-voiced-prepare-IaRWnn` 的舊 Kit controller 從封存的原絕對路徑執行 status PASS，workflow 位元組不變，human-review 仍 pending。
- 同版 `native-agent-review-1BzvZ5` PASS：既有片段引用、音量修改、串流、歷史、工作副本與 MCP 同步回歸。最終 EXE SHA-256 `99528cba96e1f8e1a28bcb95b9884be670b8a84e2d6b7d3f7173949b4263d6f1`；`resources` 必須保留。原正式專案、逐字稿與 GPU 服務未改。本輪完整多素材故事及真人審片未完成。

## 第五十一輪：字幕目標與真實模型命令格式（2026-09-30）

- 原先 selection 只有 clip，字幕與片段現在有明確的分別。引用字幕顯示字詞及起點；提示含 captionId、文字、起迄所需時間資料與播放頭，不把字幕 ID 當片段 ID。引用可停用，文字超過 2,000 字時帶截斷標記，要求先讀完整專案字幕。
- `04-52-23` 的真實模型先漏 `patch`，backend 回 `commands.0.patch: expected object, received undefined`，重試導致兩次修改工具，且診斷回合遍查二十多個 schema 分支。原生字幕引用加入精確的 `update_caption`／`patch.text` 示意後才重新封裝。診斷證據保留 `agent-caption-live-KiFllg`、`agent-caption-live-Uz9DTW` 及 `agent-caption-inflight-diagnostic-round51.json`。
- `05-04-35` 的 `agent-caption-live-Ajap6o` PASS：區網 Qwen 經真正 OpenCode ACP／Editkin MCP，在 25.1 秒內只執行一次成功修改，沒有 failed 工具。送出第一句後立刻選第二句，第一句的「检好」變成「剪好」，第二句與其餘專案欄位保持一致；一次 Undo 還原。測試使用原含語音 Kit 樣片的隔離、未存檔專案副本，原素材／workflow／逐字稿收據 SHA 全相符。
- 同封裝 `agent-caption-review-UB0FAI` 使用 loopback 回應閘門，明確等選取切換後才回傳命令，再驗證復原同步到下一個模型請求、引用取消與單次套用。OpenCode 的無工具標題生成請求與實際 MCP 回合分開處理，避免驗收誤判。
- 既有側欄回歸 `native-agent-review-qmAcP3` PASS：片段引用與音量修改、模型、串流、歷史、MCP、工作副本同步均保留。型別／封裝 build、字幕引用與命令及快捷鍵共 52 項聚焦回歸通過；快取清理五項保護與保留證據測試亦 PASS。
- 交付仍是 Community 可攜預覽，完整多素材配音故事及真人審片尚未完成。字幕校對只改成片字幕，保留原始 ASR 證據。

## 第五十輪：成片字幕校對與封裝驗收（2026-09-30）

- 舊版 `03-39-18` 在字幕兩次輸入後一次 Undo 只退回中間字串，證據 `caption-correction-review-L406NO`。另確認預設簡易工作區隱藏 Inspector；新版本選字幕會直接顯示校對欄位並收合 Agent 側欄，既有 Agent session 保留。
- 最新 `04-23-43` 的 `caption-correction-review-JD897v` PASS：校對暫存不逐字改時間軸、一次 Undo／Redo、空白草稿保護、中文組字不提前套用、Ctrl＋S 將待校對新文字存入磁碟、前後句切換、播放至字幕結尾停止、1280×720 版面、儲存重開、單次 render 與影音全片解碼。截圖與成片留在該驗收目錄。原 Kit 專案、影片、workflow-state 與已完成收據全部 SHA 相符；沒有改寫 ASR 證據，也沒有代替真人審片。
- 測試曾在專案重開完成前送出 render，當時輸出被專案時效保護取消；驗收腳本已改為等待新 session、清空 Undo 與開啟完成，確認 render bridge 恰好收到一次。輸出路徑透過既有 `render_project_smoke` 代入隔離位置，執行真實 render 引擎；Windows 原生檔案對話框操作仍未涵蓋。
- 新版 Agent 回歸 `native-agent-review-Psx6g4` PASS：啟動、連線、模型、串流、歷史、MCP 讀寫、工作副本與復原同步。模型為本機 loopback stub，本輪不宣稱真實 Qwen 已自主完成含語音故事。字幕校對只修改成片字幕的界線及 required-transcript 起稿說明已加入 Agent 提示。
- 已發現原生 Agent 的 selection 提示目前只有片段，下一輪應補字幕目標；完整真實多素材語音故事與真人審片仍未完成。

## 第四十九輪：單來源語音整合、封裝回歸與安全清理（2026-09-30）

- 單來源 Kit 語音起稿及完成工具引用已讀 cue、語意收據與來源人聲，字幕對齊 cue 的影格範圍。拒絕缺 cue、虛構字幕與含語音 Smart Cut；完成前重查人聲音量與逐字稿。`kit-voiced-prepare-IaRWnn` 的原 controller 已完成 plan/audit/apply/render、5.109 秒 MP4 全片解碼及音軌確認，保留可編輯字幕，human-review 仍 pending。其 AAC 測試素材將「剪好」辨為「檢好」，不得宣稱語音準確性通過。
- 新 EXE `03-39-18` 的 `packaged-asr-review-xLL2jt` PASS：ready、中文 cues、未下載模型、粗剪設定可開始；原 WAV 這次辨為「今天我們要把影片剪好,先聽清楚每一句」。`native-agent-review-SPfg0P` PASS：Agent 連線、模型、輸入及歷史可見；`editor-project-review-TiAdh1` PASS：匯入、時間軸、存檔重開、MP4 輸出、不同尺寸與素材檢視回歸。這些是封裝工程驗收，不代替真人故事與視覺品質審片。
- `qwen-asr-live-probe-20260930-round2.json` 於 11:30（Asia/Taipei）記錄文字 200、三種聊天／Responses 音訊 400、轉錄 500；`get_model_info` 回報沒有音訊理解。未改動 GPU 服務，未輸出私人 origin 或音訊 bytes。
- 清理工具新增 workflow 引用與套件程序保護、無 BOM 中文 UTF-8 路徑讀取、literal hard-link、去重還原清單與刪除前重查。隔離回歸含 workflow 忽略檔、明確 discard 保護、移除、逐位元還原、scope 拒絕與危險 restore 拒絕共六項 PASS；實際封裝 131 個檔案復原 SHA 全相符。刪 11 版，保守回收 2.705 GiB；使用中的原有 EXE／Agent 保留。

舊輪次的可攜預覽路徑是歷史紀錄；2026-09-29 的保留清理只留下最新 3 版。已刪版的名稱、大小及 EXE 雜湊見 `docs/PORTABLE_PREVIEW_RETENTION.md` 指向的 manifest。各輪隔離測試報告仍保留。

## 判定

剪輯台已內附官方 OpenCode 1.18.32 Windows 執行核心，透過私有 ACP 子程序自動啟動。它不是連接使用者先行啟動的本機 OpenCode，也不是仿造工具執行的文字聊天框。側欄目前是 Editkin 自製的 ACP 客戶端，**不是** OpenCode 原版 Web 前端。這兩件事應分開描述。

原版 Web 前端已用同一份 binary 的 `serve` 短暫啟動並確認首頁 HTTP 200；直接嵌入會另開一個 HTTP 服務和不同的 session/MCP 綁定，也會改變目前私有子程序的連線邊界。因此本輪維持 ACP 架構，補齊原生 Agent 使用時最容易看見的行為。

## 第二輪 Review：原生感補缺（2026-09-29）

- 官方原版 Web 的首頁、設定及新對話在獨立本機瀏覽器測試可運作。測試中發現：把帳密寫在瀏覽器網址後，原版 Web 的頁面 context 報錯；完成驗證後改用不含帳密的乾淨網址則正常。這證明 Web 是可研究的後續方向，但尚未證明可安全嵌入 Tauri 側欄，亦未解決 Web 與剪輯台共用 project、MCP、session 和時間軸同步。
- 改用 OpenCode 真正的 `session/list` 展示目前工作資料夾的對話，包括在 Editkin 外建立的對話；列表目前最多 80 筆。舊對話載入仍要求模型符合本機／區網 allowlist。
- 傳訊息可附歌詞、字幕、文字、JSON 及 PNG/JPEG/GIF/WebP。文字用 ACP resource，圖片用 ACP image block，送出前在 UI 與服務層限制格式、數量與大小；圖片先由 WebView 解碼並檢查尺寸，服務層再檢查檔頭。編輯草稿與附件會保留到呼叫被接受。模型是否理解圖片，仍取決於所選模型能力。
- 用官方 OpenCode 1.18.32 binary、私有 ACP session 與短暫的本機假模型執行整合測試，證實文字和有效 PNG 會出現在模型請求中；假模型的影像能力需明確宣告 `modalities.input` 包含 `image`，否則 OpenCode 會從請求中移除影像。這不等於已驗證使用者區網 Qwen 的視覺能力。
- 本地 OpenAI 相容模型設定改用官方文件所示的 `@ai-sdk/openai-compatible`。原設定的 `@ai-sdk/openai` 會預設走 Responses API；若後端只提供 Chat Completions，就會出現路由錯誤。這次假模型回合驗證了相容套件路徑，區網 Qwen 實際回合仍待驗證。
- 回覆增加基本安全 Markdown 呈現（標題、段落、清單、粗體、行內及區塊程式碼）；文字不作 raw HTML 注入。這不是 OpenCode 原版 Web 的完整 Markdown/附件介面。

這輪驗證：`npm run typecheck`、`npx vitest run src/service/openCodePrompt.test.ts`、`npm run build`、`npm run source:scan` 通過；`node scripts/verify-opencode-acp-attachments.mjs` 的官方 binary／本機假模型整合測試通過。當時的 Tauri/Rust 可攜版為 `artifacts/autopilot-desk/portable-preview-2026-09-29T02-49-32-363Z/AutopilotDesk-Community-Preview.exe`，SHA-256 `3b6dbb50e8b07e64b5fa83cbf065c54971d4a1bde0b70ea507a9dd65308bce4b`，需保留同層 `resources`。當時尚未對該新產物完成桌面 GUI 測試；下方第三輪補上了更新版本的隔離桌面測試。真實區網模型的圖片附件回合仍未驗證。

## 第三輪 Review：桌面實測與操作修正（2026-09-29）

- 直接擷取先前可攜版桌面視窗，發現 OpenCode 雖已連線，側欄卻顯示 `Resident service queue deadline exceeded`。原因是啟動與會話操作共用序列化的 Agent service lane，側欄每秒仍排入狀態查詢。現改為只在連線成功後輪詢、同一時間最多一個查詢，會話操作期間暫停輪詢。
- 模型與模式選單原先位於對話上緣，實機遭內容擠壓而不可見。已改放在固定於底部的訊息輸入框，對話區獨立捲動。當時側欄採獨立深色介面；第七輪已改為跟隨剪輯台主題。OpenCode 原生 session、工具狀態、授權與模型選項仍保留。
- 歷史清單在側欄內被 flex 壓到半列，無法可靠點選舊對話。已保留可捲動的清單高度；測試明確檢查項目可見，再點選並驗證回到原本 session。
- 以隔離的 Tauri/WebView2 profile 啟動更新後的可攜 EXE，驗證自動連線、模型與模式選單可見、輸入框與對話區可見、超過 15 秒的啟動穩定性、新對話、歷史清單與舊對話載入。測試未發送模型 prompt，且只終止測試自己啟動的視窗；原先使用者的預覽視窗與復原專案維持原狀。

本輪可攜版：`artifacts/autopilot-desk/portable-preview-2026-09-29T03-14-32-254Z/AutopilotDesk-Community-Preview.exe`，SHA-256 `c1e687a7fa97bf561ad10fd06e16bc6a601599cce6bffeacc3cb113603930580`；`resources` 須與 EXE 同層。桌面實測腳本：`node scripts/review-opencode-agent-ui.mjs <portable-preview.exe>`；私有測試報告及畫面：`artifacts/autopilot-desk/native-agent-review-KE3gNt/`。這是 community preview，非正式安裝器。

## 第四輪 Review：長回覆與原生會話回放（2026-09-29）

- 發現 ACP 文字串流每一片段都佔一筆事件，長回答可能在 500 筆上限前就失去開頭；工具進度和計畫更新也會消耗紀錄容量。服務層改為以穩定 `entryId` 更新同一則訊息、工具卡與執行計畫；側欄依該 ID 更新既有卡片，避免重複字句及頻繁重建 DOM。
- 500 筆上限現在指對話與工具**紀錄**，而非串流更新次數。只有真的丟棄舊紀錄才顯示截斷提示。單則超過 100,000 字元時，側欄明示顯示上限；完整內容仍由 OpenCode session 保存。
- 四個聚焦測試涵蓋 800 個連續文字片段、工具卡更新、700 次計畫更新，以及舊工具卡延遲更新後的截斷判斷。
- 更新後的可攜 EXE 在隔離 Tauri/WebView2 環境連到短暫 loopback 假模型：從側欄送出 prompt，收到 824 個串流文字片段並完整顯示 824 字元，回合完成且沒有錯誤或歷史截斷；新建對話後再載入舊 session，回答開頭與結尾都仍存在。OpenCode 另有標題生成請求，假模型共收到兩次本機請求。此測試沒有聯絡區網 Qwen 或付費模型，也沒有測試剪輯工具執行。

本輪可攜版：`artifacts/autopilot-desk/portable-preview-2026-09-29T03-26-06-690Z/AutopilotDesk-Community-Preview.exe`，SHA-256 `4b4122960e98481f8ac005b4d4232864fd7b2b456f3caa4d616029bbde9d2ab8`；私有實測報告與畫面：`artifacts/autopilot-desk/native-agent-review-Hu2qwn/`。

## 第五輪 Review：未儲存專案也能用真實剪輯工具（2026-09-29）

- 空白或尚未儲存的剪輯台會在應用程式資料夾建立獨立的 Agent 工作副本，開啟側欄時自動綁定 OpenCode；不再要求先叫出「儲存專案」視窗。送出每一回合前會同步剪輯台最新內容，保留正式專案的儲存選擇權。
- 工作副本使用原有的版本檢查與原子寫入。Agent 修改完成後，只有剪輯台內容在回合期間沒有另行變動才自動載入；載入動作保留上一版在復原堆疊。若兩邊同時變動，側欄停止續送並要求使用者明確選擇載入 Agent 版本，避免下一回合直接覆蓋副本。這個衝突選擇尚未做真人介面驗收。
- 隔離 Tauri/WebView2 實測使用官方 OpenCode、內附的五工具 Editkin MCP gateway 與短暫 loopback 假模型。模型請求確實收到 `editkin_call_editkin_tool`；它先轉送原 Editkin `get_project_summary` 並取得成功結果，再轉送 `apply_edit_commands` 將私有工作副本改名。畫面標題同步成「Agent 工作副本驗證」，副本 revision 為 2，剪輯台復原鍵可用。按復原後再次送訊息，副本已同步回原標題。
- 同一隔離實測也涵蓋自動連線、模型／模式選單可見、824 字元串流回覆、新對話與舊 session 載入。這驗證了工具管線與桌面同步，**不代表**使用者區網 Qwen 已完成新版本實測，也不代表 Kit v4 全流程或正式影片輸出已通過。

本輪最終可攜版：`artifacts/autopilot-desk/portable-preview-2026-09-29T06-45-39-563Z/AutopilotDesk-Community-Preview.exe`，SHA-256 `aaaf845393316f9d5ae323e96513ae9b2c011b7dc9f3ad119101b19611ff7fb2`；私有實測報告與畫面：`artifacts/autopilot-desk/native-agent-review-IdzLHk/`。型別檢查、原始碼掃描與 25 個聚焦測試通過。此 EXE 是 community preview，須保留同層 `resources`。

## 第六輪 Review：側欄啟動感與版面（2026-09-29）

- 使用者畫面仍有「OpenCode 啟動中／未啟動」與「重新啟動 Agent」，加上大量佔位提示，容易讓內附 Agent 看起來像要另外連線。這些文字是桌面程式啟動內附 OpenCode ACP 子程序時的內部狀態，不是要求使用者啟動外部 OpenCode。
- 側欄現在維持固定的「新對話、目前專案、對話區、輸入框」版面。內部準備階段只在對話標題旁顯示小型進度點；輸入框可先編寫草稿，模型選單就緒後自動出現可用選項。初始化失敗時才顯示實際錯誤和「再試一次」。
- 新建未儲存專案的工作副本只以「草稿 · 工具就緒」顯示在專案資訊列，不再佔用一大塊黃色警告；工具數量和技能清單移到設定。只有已儲存專案另有未儲存修改、暫時不能安全交給 Agent 時，才保留儲存提示。
- 隔離桌面畫面已檢查版面，且同一套測試仍通過 824 字串流、新舊 session、真實 Editkin gateway 讀／寫、時間軸同步、復原及下一回合同步。這是介面與既有功能驗證，不是原版 OpenCode Web UI 已直接嵌入。

本輪可攜預覽：`artifacts/autopilot-desk/portable-preview-2026-09-29T06-57-46-405Z/AutopilotDesk-Community-Preview.exe`，SHA-256 `c0026b8f6e36d1ef465bde28eaf6e31a4acaa3bdf0c07419df8f27cd3b423ecd`；隔離桌面測試與畫面：`artifacts/autopilot-desk/native-agent-review-dOTzcd/`。先前已開啟的預覽視窗不會自動換成這版 UI。

## 第七輪 Review：與剪輯台同一套 UI 與持續工作（2026-09-29）

- 發現 Agent 對話頁硬覆蓋為炭黑與紫色，與剪輯台 sky/candy/volt 主題斷裂。現在移除側欄私有色票，讓標題、分頁、對話、工具卡、輸入框及警示沿用編輯器的 `--surface`、`--accent`、`--ink` 等變數；實機檢查三套主題的色票、控件可見性與 sky/volt 畫面。
- 「屬性」原先看似 Agent 分頁，實際只是收合側欄；已從分頁移除。標題改為「剪輯台 / OpenCode Agent」，保留官方引擎來源辨識，同時表明它屬於目前編輯工作區。
- 導演台顯示時，工具列現在將 Agent 視為收合；點「開啟 Agent」會切回同一個 Agent 工作區。由工具列開編劇或素材面板也會先關閉導演台，避免按鈕表示開啟卻看不到側欄。
- 發現切去「編劇／素材」或收合側欄時會卸載對話元件，可能錯過 Agent 回合結束後的時間軸同步。現在首次開啟後保持對話元件掛載，收合時隱藏整個側欄，切分頁時只隱藏對話畫面；內嵌 Agent 的進度與同一 session 繼續保留。
- 隔離桌面測試使用官方 OpenCode、內附 Editkin MCP gateway 和短暫 loopback 假模型。測試在送出真實 `apply_edit_commands` 工具任務後立即收合側欄；隱藏期間剪輯台標題已更新，重新展開後工具卡顯示完成、Undo 可用。另驗證切到編劇再返回時 session 與長回覆仍在、復原後工作副本可重新同步。這是合成專案的工具與 UI 測試，未驗證 Kit v4 成片或使用者區網模型。

本輪可攜預覽：`artifacts/autopilot-desk/portable-preview-2026-09-29T07-11-46-926Z/AutopilotDesk-Community-Preview.exe`，SHA-256 `7ae79ed38af0c3f000cb71ca1669ce2c484ce5bb49bace52eb4f6a7508cef790`；隔離桌面測試報告和 sky/volt 截圖：`artifacts/autopilot-desk/native-agent-review-5u9hT5/`。須保留 EXE 同層的 `resources`。`npm run typecheck`、`npm run desk:portable-preview`、`npm run source:scan`、16 個主題／工作區聚焦測試與擴充後的隔離桌面測試通過。

## 第八輪 Review：側欄 UI/UX 首屏與工作流（2026-09-29）

- 依 [UI/UX 藍圖](OPEN_CODE_AGENT_UX_BLUEPRINT.md) 重整側欄資訊層級：分頁改為「對話」，對話標題、目前專案與狀態分開；空態首屏顯示兩個可點的任務起點。起點只填入草稿，不直接傳訊或改時間軸。
- 輸入區將模式、模型與傳送操作分行；300／380／560 px 側欄寬度的模型選單、輸入框與傳送鍵在隔離桌面測試中均可見，未出現水平溢出。空對話捲動位置修正後，起點在首屏完整可見。
- 工具卡先顯示狀態與可讀標題，原始 OpenCode 工具名及結果放進「查看操作紀錄」。當時整合測試的 Editkin 卡片仍顯示「剪輯台工具」；第十四輪追查確認是側欄漏讀 `title` 形式的 gateway 呼叫，並已修正。
- volt 深色主題原先仍使用淺色系統捲軸／表單；改由共用主題 token 檔設定 dark color-scheme，主題一致性檢查與隔離桌面截圖均通過。sky、candy 仍為淺色。
- 最終隔離桌面測試以官方內附 OpenCode、暫時 loopback 假模型與真實 Editkin MCP gateway 驗證：自動就緒、空態、草稿不自動送出、三種寬度、三套主題、824 字串流、歷史會話、工具讀寫、收合後同步、Undo 與下一回合重新同步。沒有向使用者的區網 Qwen 或付費模型送出任務。

本輪可攜預覽：`artifacts/autopilot-desk/portable-preview-2026-09-29T07-49-16-663Z/AutopilotDesk-Community-Preview.exe`，SHA-256 `097ba4db75e4f881096901d94f39724855597985bac9eeb839c62e82fc0d0a96`；同層 `resources` 必須保留。隔離桌面報告與畫面：`artifacts/autopilot-desk/native-agent-review-42Aept/`，狀態 PASS。`npm run typecheck` 與 19 個聚焦測試通過。這版仍是 community preview，原版 OpenCode Web UI、真實區網 Qwen 回合及 Kit v4 完整成片另待驗收。

## 第九輪 Review：對話優先的精簡側欄（2026-09-29）

- 使用者截圖顯示前版仍有太多常駐列：品牌、分頁、對話、專案狀態及輸入區分開堆疊。將分頁併入標頭，對話操作收成同列圖示；專案狀態與設定移到「更多」浮層，技能、模型位址與診斷資訊再各自收合。正常操作不常駐顯示「可剪輯／草稿／技能數」。
- 空態只保留短引導與兩個草稿起點；片段引用縮為短標籤，完整素材及時間在滑鼠提示。模式、模型、附件、傳送在輸入框底行；新對話、歷史及更多圖示都有名稱與提示，鍵盤可操作。
- 隔離桌面測試量得固定標頭 83 px、輸入區 88 px、對話區 374.5 px。更多選單預設高 189.5 px，開啟選單和歷史紀錄都不改變對話區高度。300／380／560 px 與 sky/candy/volt 實際截圖、長串流、歷史會話、工具讀寫、收合後同步及 Undo 通過。

本輪可攜預覽：`artifacts/autopilot-desk/portable-preview-2026-09-29T08-00-37-146Z/AutopilotDesk-Community-Preview.exe`，SHA-256 `ed0151a21f31b00ef527da928e798bef05655b229fab7ef1c3131e8c1816d3c3`；`resources` 須與 EXE 同層。隔離桌面報告與截圖：`artifacts/autopilot-desk/native-agent-review-aTvnMP/`，狀態 PASS；包含多層收合的區網模型設定入口驗證。這是使用 loopback 假模型及合成專案的 UI／工具驗證；未向使用者區網 Qwen 送任務，也未完成 Kit v4 真實影片輸出驗收。

## 第十輪 Review：閱讀位置、長草稿與浮層退出（2026-09-29）

- 原先每一筆 Agent 更新都強制捲到對話底部，長回覆時無法往上讀。現在只在使用者原本靠近底部時跟隨；往上捲會停在原位置並顯示「最新訊息」。自行送出新任務或切換會話時恢復跟隨，側欄收合／恢復時依容器尺寸調整。
- 文字框依草稿內容長高，達 160 px 才在框內捲動。更多與歷史浮層可點外部退出；Escape 可關閉並把焦點送回觸發鈕。歷史按鈕標示展開狀態。
- 隔離桌面測試中，草稿框由 48 px 長到 124 px、送出後縮回。慢速串流途中捲到頂端後，回合結束仍停在 `scrollTop=0`，當時可捲動距離 714 px；點「最新訊息」後到 714 px。截圖已檢查按鈕位置。完整會話、工具讀寫、收合後同步與 Undo 流程再次通過。

本輪可攜預覽：`artifacts/autopilot-desk/portable-preview-2026-09-29T08-14-32-841Z/AutopilotDesk-Community-Preview.exe`，SHA-256 `4060a138ba5f02fd7013906005ea993ea1e5a5ee20b375886dbb9c4b2404487a`；`resources` 須同層保留。隔離測試報告和畫面：`artifacts/autopilot-desk/native-agent-review-QXWM6c/`，狀態 PASS。仍未用真實區網 Qwen 與正式素材跑完整 Kit v4 剪片。

## 第十一輪 Review：執行中草稿與待授權回應（2026-09-29）

- 前版 Agent 忙碌時整個輸入框停用，創作者只能等回覆完成才開始寫下一個任務。現在送出後立即清空已送出的內容，執行中可另寫草稿；新草稿不會自動傳送，回合結束仍保留。若送出呼叫失敗，原訊息與附件會回到草稿，避免輸入遺失。
- ACP 待授權事件若捲出對話區，側欄在輸入區上方顯示短提示；按「查看授權」可回到相應卡片並移動焦點。尾端執行狀態優先顯示待授權，其次是當前回合的工具名稱。正常對話不增加常駐列。
- 官方內附 OpenCode、暫時 loopback 模型與真實 Editkin gateway 的隔離桌面測試通過；特別驗證慢速串流期間草稿保留、授權卡片離開視野後能跳回、300／380／560 px 寬度與 sky/candy/volt 主題，以及原有會話、工具讀寫、收合、Undo 與重新同步。授權提示測試使用隔離的 ACP 事件替身，未聲稱完成真實模型的授權往返。

本輪可攜預覽：`artifacts/autopilot-desk/portable-preview-2026-09-29T08-24-58-356Z/AutopilotDesk-Community-Preview.exe`，SHA-256 `91ced54e908249e6b0425c2e97d23a53942fc9f56cfdbda8faf067b2ef6e057c`；需保留同層 `resources`。桌面測試報告及畫面：`artifacts/autopilot-desk/native-agent-review-O1nxYh/`，狀態 PASS。真實區網 Qwen 與 Kit v4 完整成片仍待另行驗收。

## 第十二輪 Review：可辨識的會話與無橫向捲動的歷史（2026-09-29）

- OpenCode 在這次隔離測試未回傳目前會話標題，頂部一直顯示「新對話」。側欄現在以第一則使用者任務暫代標題；新建會話恢復「新對話」，載入舊會話則從重播內容恢復原標題。若 ACP 提供正式標題，仍優先使用原生值。
- 歷史清單中的長標題曾撐出水平捲軸；按鈕內容現在有可截字欄位，保留完整標題的滑鼠提示。300／380 px 實測沒有水平溢出。
- 正常完成不再顯示 `回合結束：end_turn`。非正常停止、失敗或長度限制仍有中文狀態，完整事件仍保留在 ACP session 中。
- 新版桌面整合測試 PASS：目前會話標題、新建／載入、歷史寬度、長串流、待授權跳轉、三種寬度及主題、工具讀寫、收合、Undo 與重新同步均通過。測試模型是短暫 loopback 替身，不代表真實區網 Qwen 或 Kit v4 成片驗收。

本輪可攜預覽：`artifacts/autopilot-desk/portable-preview-2026-09-29T08-30-54-492Z/AutopilotDesk-Community-Preview.exe`，SHA-256 `03ee5d4c3dc88a1df260bb2680feb2f62a94d3ab69ce8b61105dbc7c5239c129`；同層 `resources` 必須保留。隔離桌面報告和畫面：`artifacts/autopilot-desk/native-agent-review-TvRmmc/`，狀態 PASS。

## 第十三輪 Review：原生指令鍵盤流程（2026-09-29）

- `/` 指令清單原先只能點滑鼠，而且出現在一般排版中，打開後壓縮對話區。現在清單浮在輸入框上方；方向鍵選擇、Enter 填入草稿、Escape 收起，沒有自動送出。
- 300 px 實機截圖發現長指令名被擠成多行，已改為名稱與描述各一行截字。重建後再看圖，清單在窄側欄可辨讀、沒有水平溢出，對話區高度維持 374.5 px。
- 內附 OpenCode／暫時 loopback 模型／真實 Editkin gateway 的完整隔離桌面流程 PASS，包含原有長串流、待授權提示、會話歷史、工具讀寫、收合、Undo 與重新同步。

本輪可攜預覽：`artifacts/autopilot-desk/portable-preview-2026-09-29T08-43-28-309Z/AutopilotDesk-Community-Preview.exe`，SHA-256 `db07d3d1cf648f78ffcf26e091e053c9e4ff187912f92fa1df670064d684ac83`；保留同層 `resources`。隔離報告與畫面：`artifacts/autopilot-desk/native-agent-review-2olavK/`，狀態 PASS。真實區網 Qwen 和 Kit v4 完整成片仍未在此輪驗收。

## 第十四輪 Review：工具卡顯示真實剪輯動作（2026-09-29）

- OpenCode ACP 對內附 gateway 的工具更新使用 `title`，未提供 `name`；原版側欄只在 `name` 存在時讀取 `rawInput.name`，因此卡片一直顯示「剪輯台工具」。修正後會驗證 `title` 是 gateway 呼叫，再從 `rawInput.name` 映射已知動作；原始參數不進入側欄事件。
- 曾試過由 gateway 在結果補動作標記，實測發現標記也進入使用者可展開的操作紀錄；已撤回這個做法。最終版本不改 gateway 結果，只讀 ACP 已有的欄位。工具執行中若尚未收到動作名稱仍可顯示通用標題；未收錄的動作也不臆測名稱。
- 隔離桌面測試以官方內附 OpenCode、短暫 loopback 模型和真實 Editkin gateway 讀取合成專案並修改工作副本。工具卡分別顯示「讀取專案摘要 · 完成」與「修改時間軸 · 完成」；結果紀錄沒有額外標記。原有的長串流、會話、窄側欄、收合後同步、Undo 等流程同次測試 PASS。

本輪最終可攜預覽：`artifacts/autopilot-desk/portable-preview-2026-09-29T09-07-25-897Z/AutopilotDesk-Community-Preview.exe`，SHA-256 `b5297c0497a50b6c43ab6370816b09270ee0f73b55a2ba48c6a22498f13308a7`；保留同層 `resources`。隔離桌面報告與畫面：`artifacts/autopilot-desk/native-agent-review-ScDh2D/`，狀態 PASS。真實區網 Qwen 與 Kit v4 完整成片不在本輪驗收範圍。

## 第十五輪 Review：Agent 工作副本保留可播放示範素材（2026-09-29）

- 第十四輪截圖顯示示範影片在 Agent 載入工作副本後無法預覽。原因是示範專案使用相對素材 URI；工作副本搬到應用資料夾後，來源會被當成工作副本旁的檔案。直接改指向程式資源目錄會超出 `EDITKIN_WORKSPACE`，原 MCP 安全邊界正確拒絕寫入。
- 建立尚未儲存的示範專案工作副本時，現在用 `create_new` 把內附影片複製到該副本所在的 Agent 工作區，專案只記錄這個工作區內的絕對來源。剪輯台 Undo 後再次同步，會沿用同一份來源；其他專案和素材路徑維持原規則，沒有放寬 MCP 邊界。
- 官方內附 OpenCode／短暫 loopback 模型／真實 Editkin gateway 的桌面測試 PASS：讀取專案、修改工作副本、收合後同步、Undo、重新同步都通過；新增斷言檢查影片來源位於授權工作區、預覽影片已解碼且不顯示錯誤。截圖中的示範影片畫面已可見。這不等於使用者真實素材或 Kit v4 成片已驗證。

本輪可攜預覽：`artifacts/autopilot-desk/portable-preview-2026-09-29T09-20-28-871Z/AutopilotDesk-Community-Preview.exe`，SHA-256 `866f3c36d9470adf1f3fc5cf98392192f1d9515dd2dfb64e05e6c6173766b404`；保留同層 `resources`。隔離桌面報告與畫面：`artifacts/autopilot-desk/native-agent-review-sq8O84/`，狀態 PASS。

## 第十六輪 Review：片段引用可辨識，並走完整工具編輯路徑（2026-09-29）

- 輸入框上方原本只寫「引用目前片段」，容易不知道將送出哪段素材。現在直接顯示素材名與時間軸起點；滑鼠提示可看完整範圍和播放頭。狹窄側欄仍能截短顯示，不增加常駐資訊列。
- 隔離桌面測試使用官方內附 OpenCode、短暫 loopback 模型替身和真實 Editkin gateway。勾選引用時，模型收到 `clip-demo` 與「Editkin 示範素材」的選取資訊，透過 `apply_edit_commands` 執行 `set_clip_volume`；工作副本中的該片段音量為 `0.65`，剪輯台顯示片段仍被選取且可 Undo。取消勾選後，下一則使用者訊息的模型提示未帶入選取資訊。
- 本輪沒有從屬性面板讀取畫面中的 65%：示範模式當時未顯示該面板。驗收依據是模型輸入、真實工具回覆、工作副本 JSON 和剪輯台重載／Undo 狀態；不把它擴大為真人使用真實 Qwen 自主判斷片段的證明。原有長串流、歷史、收合後同步、Undo、預覽解碼、授權提示替身及三種側欄寬度同次桌面測試 PASS。

本輪可攜預覽：`artifacts/autopilot-desk/portable-preview-2026-09-29T09-29-02-033Z/AutopilotDesk-Community-Preview.exe`，SHA-256 `bad7305ce1eacb3768c68883c633461389bed603e6d3c6bc1502e9ad7d97c451`；須保留同層 `resources`。桌面測試報告及畫面：`artifacts/autopilot-desk/native-agent-review-3XfSVp/`，狀態 PASS。`npm run typecheck`、`npm run desk:portable-preview` 和 `npm run source:scan` 通過。依預覽清理規則保留最新三版，刪除前一版的 manifest：`artifacts/autopilot-desk/portable-preview-prune-20260929T093520663Z.json`。

## 第十七輪 Review：工具卡直接說明 Agent 要求的剪輯動作（2026-09-29）

- 卡片原先只有「修改時間軸 · 完成」，看不出操作種類。現在從 OpenCode ACP 的 gateway `rawInput` 只抽取白名單剪輯命令，顯示「要求：片段音量設為 65%」或「要求：重新命名專案」；多筆命令只顯示數量，未知命令維持通用說明。這行是**要求內容**，完成狀態仍另由 ACP 回報，不能單憑這行判定編輯成功。
- 模型原始參數沒有進入摘要。聚焦測試確認專案路徑、片段 ID、專案名稱及額外敏感欄位不會被複製到 `requestedAction`；原始工具結果仍留在可展開的操作紀錄。待授權卡片收到相同已整理摘要時也可顯示。
- 官方內附 OpenCode、短暫 loopback 模型替身與真實 Editkin gateway 的桌面測試 PASS：片段音量與專案更名兩張工具卡都有正確摘要；300 px 截圖確認片段音量摘要可讀、無水平溢出。原有長串流、會話歷史、收合後同步、Undo、工作副本預覽解碼和授權提示替身同次通過。此處沒有驗證真實區網 Qwen 自主決策或 Kit v4 成片。

本輪可攜預覽：`artifacts/autopilot-desk/portable-preview-2026-09-29T09-40-54-896Z/AutopilotDesk-Community-Preview.exe`，SHA-256 `4e02d40202ccf8b07424182a14298676ae4fed03902d463f764182b176757693`；須保留同層 `resources`。桌面報告與截圖：`artifacts/autopilot-desk/native-agent-review-JiYEKi/`，狀態 PASS。`npx vitest run src/service/acpToolContent.test.ts`、`npm run typecheck`、`npm run desk:portable-preview` 與 `npm run source:scan` 通過。預覽只留最新三版，清理 manifest：`artifacts/autopilot-desk/portable-preview-prune-20260929T094340548Z.json`。

## 第十八輪 Review：最新版 EXE 與真實區網 Qwen 唯讀回合（2026-09-29）

- 先由本機既有設定檢查私有區網模型清單，確認 `qwen3.8-27b-nvfp4` 目前可用；再以**獨立示範專案與隔離的桌面測試資料**啟動官方內附 OpenCode。測試腳本不提交模型位址，報告只記錄模型 ID、工具標題與布林結果。
- 首次真實回合依序呼叫 `inspect_editkin_tool`、`get_project_summary`；摘要工具回傳 GREEN、OpenCode 回報專案未變更。測試程式當時誤把唯讀工具說明查詢列為不允許，故報告 BLOCK，並暴露側欄把它顯示為內部工具名稱。已將 `discover_editkin_tools`／`inspect_editkin_tool` 顯示為「尋找剪輯工具」／「查看剪輯工具說明」，且把兩者納入唯讀允許清單。
- 最終新版 EXE 的真實 Qwen 回合 PASS：工具依序為尋找工具、查看說明、讀取專案摘要；摘要回傳 GREEN，側欄顯示「我的第一支影片」及 1 個片段，工作副本前後 SHA-256 相同。這只驗證真實模型的唯讀查詢與內附 Agent 介面；真實 Qwen 的片段修改、Kit v4 audit/apply/render、正式素材審片及模型計費路由沒有由此證明。

本輪可攜預覽：`artifacts/autopilot-desk/portable-preview-2026-09-29T09-53-45-993Z/AutopilotDesk-Community-Preview.exe`，SHA-256 `20afa774c1b133e993e100d340947d55e949041dea617a712a7948caa9f9a615`；須保留同層 `resources`。真實區網測試報告與最終畫面：`artifacts/autopilot-desk/native-agent-live-qwen-xHHZ2y/`，狀態 PASS。可重跑 `node scripts/review-opencode-agent-live-qwen.mjs <可攜 EXE>`；它只讀本機已存模型位址、在暫存資料夾建立隔離測試環境，不修改目前使用者專案。`npx vitest run src/service/acpToolContent.test.ts`、`npm run typecheck`、`npm run desk:portable-preview` 和 `npm run source:scan` 通過。預覽僅保留最新三版，清理 manifest：`artifacts/autopilot-desk/portable-preview-prune-20260929T095749644Z.json`。

## 第十九輪 Review：真實區網 Qwen 修改選取片段（2026-09-29）

- 在隔離示範專案與桌面測試資料中，讓官方內附 OpenCode 使用已設定的區網 Qwen 3.8 27B NVFP4 接受自然語句：「請把這個片段的音量設為 65%」。測試使用選取片段引用，沒有觸碰使用者正式專案，也沒有把區網位址寫入腳本或報告。
- 首次實測確實完成 `apply_edit_commands`，但模型反覆讀取大型通用命令 schema 約 30 次。原因之一是 gateway 描述要求呼叫前先查詢，且原提示未提供這種明確單項操作的精確參數。現在 gateway 將工具發現定位為陌生操作才使用；選取片段且語句明確指定音量百分比時，Agent 提供對應的 `set_clip_volume` 參數。完整多步自動剪輯仍走原 Kit durable controller。
- 最終 EXE 實測 PASS：Qwen 只呼叫一次「修改時間軸」，沒有 schema 查詢或 Kit 流程呼叫。工具回傳 GREEN；工作副本的選取片段音量是 `0.65`，除了版本與更新時間外沒有其他專案欄位變化；剪輯台立即同步，片段維持選取，Undo 可用，無須重載。回覆顯示「該片段的音量已設為 65%」，沒有內部片段 ID、工具名或結果碼。桌面截圖已人工檢視。
- 測試腳本的初版斷言把正常更新的 `updatedAt` 視為額外修改，已修正；這是驗收程式誤報，不是模型額外編輯。最後一輪從送出到完成約 15 秒；單次速度不代表長期效能或其他模型的表現。

本輪最終可攜預覽：`artifacts/autopilot-desk/portable-preview-2026-09-29T10-16-05-341Z/AutopilotDesk-Community-Preview.exe`，SHA-256 `3f0652b7a6e7b4b651764f1f38a7cc0770d3d66de38f4ed6023fc9fedd73a73`；須保留同層 `resources`。真實區網報告與畫面：`artifacts/autopilot-desk/native-agent-live-qwen-edit-GEqI8k/`，PASS；桌面整合報告：`artifacts/autopilot-desk/native-agent-review-iG0Ptu/`，PASS。`npm run typecheck`、`npm run desk:portable-preview`、`npm run source:scan` 通過。舊預覽依授權清理，只保留最新三版；清理 manifest：`artifacts/autopilot-desk/portable-preview-prune-20260929T101801908Z.json`，刪除約 0.77 GiB。

## 第二十輪 Review：Kit v4 從剪輯台專案建立可續跑流程（2026-09-29）

- 查出 Agent 無法從精簡專案摘要取得 `clipId` 對應的本機來源檔，因此原本無法只靠內建工具建立 Kit run。`run_kit_workflow(create)` 現在可省略 `materials`，由已綁定的開啟專案推導最多 32 個真實來源片段；來源必須仍在授權 workspace，重複片段 ID、無來源、越界來源都會拒絕。UI 示範片段不算正式素材；只有示範片段時會要求先加入自己的素材。明確指定 `materials` 的路徑保留原契約驗證。
- Windows 上的 Kit Python 控制器曾在中文路徑回傳 `��`，雖然 run 已建立，Agent 卻不能用回傳路徑繼續。橋接器的兩種 Python 子程序呼叫均固定 UTF-8；隔離中文路徑實測可立即用 create 回傳的 run 進行 status／next。先前失敗的隔離測試目錄各自保留原 run，沒有在狀態不明時重送同一 run。
- 用實際 Kit controller、Editkin MCP 和**最新版 EXE 內附的 Agent gateway／Kit**，在隔離的本機合成影片與 EditGraph 專案完成 create、contract、session、prepare、keyframes、context。五個 machine step 都有原工具回覆與 gateway 保留結果的 Kit receipt；準備結果 GREEN，3 張 JPEG 通過 byte-bound 影像收據驗證，脈絡查詢完成，下一個 ready step 是 `semantics:m01-clip-source`；專案 SHA-256 未變。這驗證資料與收據通道，沒有宣稱模型已看懂畫面或寫出語意。
- 首個合成片因缺少可驗證色彩標籤，被現行影格門檻擋下，沒有把零張影格標為完成。最終 fixture 用 FFmpeg 明確寫入 Rec.709 stream tags 後才通過。真實來源若沒有可信色彩標籤，也會停在素材證據階段。
- 四個聚焦測試覆蓋自動來源綁定、示範素材拒絕、越界路徑與重複 ID；`npm run typecheck` 通過。最終隔離報告與三張測試影格：`artifacts/autopilot-desk/kit-bound-create-xMnsej/`。一般匯入的素材若位於專案工作目錄之外，現行 MCP／Kit workspace 邊界仍會阻擋；後續需設計正式的來源整理與工作副本機制，不能把本次同目錄 fixture 當成任意真實專案已可成片。

本輪可攜預覽：`artifacts/autopilot-desk/portable-preview-2026-09-29T10-33-28-226Z/AutopilotDesk-Community-Preview.exe`，SHA-256 `2a35a650eeb91cd2815d989d1d3bb03046b64e7bc68e12e78211010d6062a3a0`；保留同層 `resources`。桌面整合報告：`artifacts/autopilot-desk/native-agent-review-aiGyBa/`，PASS；真實 Qwen 單片段編輯回歸：`artifacts/autopilot-desk/native-agent-live-qwen-edit-IlvKfd/`，PASS。完整 v4 plan、audit、apply、render 與真人審片仍未完成。
本輪依既有授權將可攜預覽保留最新三版，清理 manifest：`artifacts/autopilot-desk/portable-preview-prune-20260929T104740206Z.json`，騰出約 0.26 GiB。

## 第二十一輪 Review：已匯入的專案外素材可由 Agent 編輯（2026-09-29）

- 正式桌面匯入保留來源檔的絕對路徑；Agent 的 workspace 是專案檔所在資料夾。原本只要來源檔在別處，任何 `apply_edit_commands` 存檔都會被 workspace 邊界擋下。本輪在 MCP 啟動時只釘住**已綁定專案原始素材清單內**的既有外部檔；一般檔案、輸出路徑與新匯入的外部來源仍維持原邊界。工作區內經 junction 逸出的路徑也不會列入例外。
- 專案外來源只有讀取與保留原檔關聯的用途；Agent 存回專案時會確認目前實體路徑仍是啟動時的檔案。已檢查的來源分析工具與存檔共用這條窄邊界，不讓通用 workspace resolver 變成整碟存取。
- 聚焦測試覆蓋連續兩次存檔、拒絕新外部素材、拒絕 junction 逸出。用最新版可攜 EXE 內附的 Agent gateway + MCP，在隔離專案中分析專案外的真實測試影片並完成專案更名，拒絕第二個外部來源；來源 SHA-256 與拒絕後 revision 不變。桌面 Agent UI 回歸亦通過。
- **Kit v4 `create` 的原始 controller 仍要求素材在 workspace 內。** 因此本輪不宣稱外部匯入素材可走完整 Kit 自動剪輯；需要另做有容量、進度與失敗恢復的來源整理，不能用存檔測試替代全片驗收。

本輪可攜預覽：`artifacts/autopilot-desk/portable-preview-2026-09-29T11-00-25-697Z/AutopilotDesk-Community-Preview.exe`，SHA-256 `5adbe401dfe1a0ff879a3924150f447be65cdcba66d76ea33ebfbbe20981f4ea`；須保留同層 `resources`。內附 Agent 外部素材報告：`artifacts/autopilot-desk/agent-external-import-oEAQ1M/review-report.json`，PASS。最新版桌面回歸：`artifacts/autopilot-desk/native-agent-review-wzckYQ/`，PASS。`npx vitest run src/mcp/storage.test.ts src/mcp/remoteOnlyServer.test.ts src/mcp/kitWorkflowBridge.test.ts` 共 15 項、`npm run typecheck`、`npm run desk:portable-preview`、`npm run source:scan` 通過。依既有授權保留最近三個可攜預覽，清理 manifest：`artifacts/autopilot-desk/portable-preview-prune-20260929T110137898Z.json`，釋出約 0.51 GiB。

## 第二十二輪 Review：Kit v4 接受專案外的已匯入素材（2026-09-29）

- 確認原始 Kit controller 的 `create` 及每個素材綁定都要求來源檔在 workspace 內。採用[工作區來源副本契約](KIT_EXTERNAL_SOURCE_SNAPSHOT.md)：內附 Agent 啟動時固定已存在的外部來源清單；省略 `materials` 建立 Kit run 時，對外部來源計算 SHA-256、複製到目前專案的隱藏工作區資料夾、核對副本，再把副本交給**未修改的原始 Kit controller**。正式專案仍引用原片，原片與專案都不改寫。
- 已完成副本 manifest 重用、磁碟空間預檢、不完整複製鎖與雜湊檢查。Kit run 後續步驟核對原片仍屬目前專案，apply/render 前完整重算原片 SHA；內容不同就停止，避免 Kit 分析副本、剪輯台卻輸出另一版原片。
- 聚焦測試覆蓋原片／專案不變、相同副本重用、Agent 啟動後才插入的外部路徑拒絕、畸形片段綁定拒絕，以及原片變更時停下。隔離的 Rec.709 合成影片放在專案目錄外；用最新版 EXE 內附 gateway/MCP 及 Kit 完成 create → contract → session → prepare，prepare 的 source SHA 與原片、副本一致，收據成功交回 controller。桌面 Agent 基本回歸通過。
- 此輪**沒有**完成 semantics、v4 plan、audit、apply、render 或真人審片。副本複製目前在單次工具呼叫執行，尚缺大檔的進度、取消、跨重啟續傳；副本未自動刪除，以免破壞仍引用它的 Kit run。

本輪可攜預覽：`artifacts/autopilot-desk/portable-preview-2026-09-29T11-19-28-385Z/AutopilotDesk-Community-Preview.exe`，SHA-256 `2b2a6f64b9c0041ffc63a86bb2048212aabfd31746b3b300e842ddc21cef4984`；須保留同層 `resources`。Kit 外部來源報告：`artifacts/autopilot-desk/kit-external-source-kYS39t/review-report.json`，PASS；最新版桌面回歸：`artifacts/autopilot-desk/native-agent-review-iBuJxu/`，PASS。`npx vitest run src/mcp/kitSourceStaging.test.ts src/mcp/kitWorkflowBridge.test.ts src/mcp/storage.test.ts src/mcp/remoteOnlyServer.test.ts`、`npm run typecheck`、`npm run desk:portable-preview`、`npm run source:scan` 通過。預覽依既有授權保留最近三版，清理 manifest：`artifacts/autopilot-desk/portable-preview-prune-20260929T112108491Z.json`，騰出約 0.51 GiB。

## 第二十三輪 Review：大型來源準備可查進度、取消與恢復（2026-09-29）

- 前輪的大檔來源副本在單次 Agent 工具呼叫內執行，側欄長時間只顯示「執行中」。本輪對超過 64 MiB 的外部來源改為程序管理的準備工作：立即回傳 ID，記錄原片雜湊／副本檢查／複製／驗證階段。`source-status` 顯示估計位元組進度，側欄工具卡轉成短中文摘要；`source-cancel` 可在 controller 前中止，`source-resume` 重用已驗證的整檔副本。
- 工作與固定 run ID 落在目前專案工作區；同一請求重送回同一工作結果。若程序在 controller 建立 run 時中斷，狀態標為 `UNCERTAIN` 並要求查證原 run ID，避免自動重建。沒有單檔中間位元組續傳，也沒有對話外的自動輪詢進度列。
- 以**新版可攜 EXE 內附 gateway、原版 Kit controller**在隔離專案測 65 MiB 合成來源：初次 create 回 `PREPARING`，取消後 controller status 查不到 run；同一 ID 恢復後觀察到 hashing／copying／verifying／ready，最後建立 Kit run。原片、正式專案和副本的 SHA-256 核對相符。原有 Rec.709 小檔 create→contract→session→prepare 回歸也通過；桌面 Agent 介面、模型選單、工具讀寫、歷史與 Undo 的隔離回歸 PASS。
- 聚焦測試 20 項通過，包含取消後恢復、複製中斷清理、同請求合併、controller 階段中斷結果待查證、工具卡不暴露路徑；`npm run typecheck`、`npm run source:scan`、`npm run desk:portable-preview` 通過。尚未驗證真實 Qwen 自主執行此長流程，也未完成 v4 semantics、plan、audit、apply、render 或真人審片。

本輪最終可攜預覽：`artifacts/autopilot-desk/portable-preview-2026-09-29T11-42-13-713Z/AutopilotDesk-Community-Preview.exe`，SHA-256 `758bd7eb613a955a0b376abec61df7672baa2632b6cb6754b754e7cf79120153`；須保留同層 `resources`。最終版大檔 gateway 報告：`artifacts/autopilot-desk/kit-source-job-review-2026-09-29T11-42-24-213Z.json`，PASS；小檔完整素材前段報告：`artifacts/autopilot-desk/kit-external-source-XmASdB/review-report.json`，PASS；同一 UI 建置內容的桌面 Agent 回歸與畫面：`artifacts/autopilot-desk/native-agent-review-rhcrHj/`，PASS。預覽依既有授權只留最近三版，清理 manifest：`artifacts/autopilot-desk/portable-preview-prune-20260929T114253858Z.json`，刪除 2 版約 0.51 GiB。

## 第二十四輪 Review：側欄自動顯示來源進度並停止準備（2026-09-29）

- 補上上一輪的 UI 缺口：桌面服務每秒從目前已綁定專案的工作紀錄讀取安全摘要，側欄在準備中顯示階段、估計百分比與細進度條；Agent 對話結束後仍可見。狀態為中斷、失敗或 controller 結果不明時，保留短提示；完成後收起，不增加永久面板。
- 側欄「停止」與 OpenCode 取消同時送出工作 ID 專用取消標記。gateway 在複製／雜湊進度與 controller 起始邊界讀取標記，確保準備階段停止且未建立 run。controller 已開始時不提供工作取消，對話停止鍵改稱「停止對話」；不把未知結果誤標為已取消。
- 封裝版 65 MiB 合成來源由桌面同款取消標記中斷，controller 查不到 run；同一準備 ID 恢復後完成 verified snapshot 與 create，原片及專案 SHA-256 不變。桌面測試在 380 px 側欄看到「複製素材 · 50%」、停止與取消中狀態，以及 controller 階段無工作停止鍵；原有模型選單、會話、工具讀寫、Undo 與預覽回歸 PASS。桌面狀態由隔離工作紀錄驅動，並未要求真實 Qwen 自主選擇此流程。
- 聚焦測試 16 項通過，涵蓋 Agent 空閒時的取消、controller 起始後拒絕取消、複製中斷清理及工作恢復。完整 v4 語意、計畫、audit、apply、render 和真人審片仍待驗證。

最終可攜預覽：`artifacts/autopilot-desk/portable-preview-2026-09-29T11-54-40-995Z/AutopilotDesk-Community-Preview.exe`，SHA-256 `c7a3fa5e298a1f88cb98223063bd9425160198ce01dc73481df18aa56d8566fa`；同層 `resources` 必須保留。大檔真實 gateway 報告：`artifacts/autopilot-desk/kit-source-job-review-2026-09-29T11-54-53-212Z.json`，PASS；桌面報告與畫面：`artifacts/autopilot-desk/native-agent-review-2FoPad/`，PASS。

本輪 `npm run source:scan` 為 GREEN（1332 檔）；`git diff --check` 通過。可攜版只留最新三版，清理 manifest：`artifacts/autopilot-desk/portable-preview-prune-20260929T115802345Z.json`，狀態 `complete`，刪除 2 版約 0.51 GiB。

## 第二十五輪 Review：素材完成後接續 Agent，驗證原 Kit 語意收據（2026-09-29）

- 修正背景素材準備完成後沒有接續入口的斷點。側欄空閒時顯示「接著剪輯」；點擊只產生自然語句草稿，不自動請求模型。精確準備 ID 留在傳給 Agent 的上下文，使用者看得到的草稿不顯示內部工具名。送出失敗會保留草稿和工作綁定，只有成功送出才記住通知已處理。
- 既有隔離合成片段的原 Kit 驗收由五步擴至八步：真實 Editkin gateway 完成 contract、session、prepare、keyframes、context、semantics、route、plugin-discovery；原 controller `verify` 為 GREEN，下一個 ready step 是 `plan`。語意內容明確標為 FFmpeg `testsrc2` 技術測試圖，只引用該次已取回的 3 張關鍵幀；這是可執行收據鏈驗證，沒有聲稱模型看懂真實影片。
- 最新可攜 EXE 的 380 px 桌面回歸 PASS：完成提示、草稿、故意讓第一次傳送失敗後恢復、第二次傳送時的隱藏準備 ID、模型選單、會話、工具讀寫、Undo 與預覽均通過，沒有橫向溢出。此輪沒有用區網 Qwen 自主產生語意或 v4 計畫；plan、audit、apply、render、技術 QC 與真人審片仍待驗證。

最終可攜預覽：`artifacts/autopilot-desk/portable-preview-2026-09-29T12-16-27-517Z/AutopilotDesk-Community-Preview.exe`，SHA-256 `f86857e39eaaac24a8dbe9dcfc88737702a40f343f4f8af826a02e5b2b45f496`；同層 `resources` 必須保留。桌面報告與畫面：`artifacts/autopilot-desk/native-agent-review-2YgZrH/`，PASS；原 Kit 八步報告：`artifacts/autopilot-desk/kit-bound-create-VZE5zS/review-report.json`，PASS。`npm run typecheck`、`npm run source:scan`、`git diff --check` 通過。兩次清理 manifest 為 `portable-preview-prune-20260929T121426248Z.json` 與 `portable-preview-prune-20260929T121746125Z.json`，均為 `complete`；合計刪除 3 個中途／舊預覽約 0.77 GiB，保留最新三版。

## 第二十六輪 Review：原 Kit 從設計計畫走到可解碼成片（2026-09-29）

- 發現 Editkin 舊版匿名美感預設把科技題材選為 `shape_play`，而目前封裝 Kit 的設計編譯器要求 `cobalt_lime_ui` 等科技家族。新增只讀 `get_autopilot_aesthetic_system`：Agent 先讀 Kit 每段配方的 `route.primary_family`，再取得與該配方一致的完整 Editkin `aesthetic`／`set_aesthetic_system` 結構；未知家族直接 BLOCK。`get_autopilot_design_brief` 的工具說明也明確要求不確定時先省略舊風格預設。
- 隔離合成專案改用 Editkin 正式讀寫時相同的正規化結構。手工寫入的未正規化示範 JSON 曾造成 Kit 原始檔身分與 Editkin 審計收據的結構身分不一致；真實 Editkin 儲存流程會正規化。審計收據含程序內簽章，故 `audit → apply` 驗收必須在同一 Agent 程序連續執行。`apply`／`render` 必須攜帶當次 Kit claim token；漏傳時寫入被拒絕。失敗的隔離 run 保留供診斷，沒有假裝完成或重試不確定的寫入。
- **最新版封裝 EXE** 的 Agent gateway、MCP、原 Kit controller 連續完成八個素材前段步驟、`plan`、`audit`、`apply`、`render`。計畫從 Kit 配方選 `cobalt_lime_ui`，封裝的新工具產生美感結構；原 Kit 最終 `next` 僅剩 `human-review`。專案保留 3 段可編輯字幕，輸出 MP4 為 4 秒，FFmpeg 全片解碼通過，來源 SHA-256 不變。合成 `testsrc2` 無故事也無音軌；計畫與報告明示工程測試，沒有將其當成真實模型的編劇能力或真人審片。
- 隔離驗收可重跑 `review-kit-open-project-create.ts` → `review-kit-plan-gateway.ts` → `review-kit-execute-gateway.ts --through-render`，後兩者需傳入同一測試工作目錄和同一可攜 EXE；輸出後可用 `--qc-only` 重驗技術 QC。最後報告：`artifacts/autopilot-desk/kit-bound-create-PgVuaY/kit-through-render-report.json`，影片：同目錄 `videos/_AUTOPILOT/editkin-v4/gateway-smoke/render/current.mp4`，SHA-256 `3ff9945b8b8d07134a5ec5c7e97c18bab3b07b9192ab9ab7fa4fe70dacda09c4`。
- `npm run typecheck`、美感與 Agent claim 邊界聚焦測試 9 項、`npm run source:scan` 通過。新版可攜桌面回歸 PASS：`artifacts/autopilot-desk/native-agent-review-RJmds0/`，含模型選單、輸入、歷史及原有工具流程。仍未測真實 Qwen 自主寫出完整 v4 計畫、實際素材敘事與美感、真人確認；`human-review` 沒有由機器代填。

本輪可攜預覽：`artifacts/autopilot-desk/portable-preview-2026-09-29T12-38-57-434Z/AutopilotDesk-Community-Preview.exe`，SHA-256 `271d873bafe5d2a222a1c4b9064059c3463a025c2075e4d04030858616c4b078`；同層 `resources` 必須保留。依已授權的最新三版規則，唯讀盤點後清理一個舊預覽，manifest：`artifacts/autopilot-desk/portable-preview-prune-20260929T124027597Z.json`，刪除約 0.26 GiB。

## 第二十七輪 Review：Qwen 自主計畫的資訊路徑與權限邊界（2026-09-29）

- 先確認已儲存的區網 Qwen 模型服務可用，然後在隔離的四秒 FFmpeg 合成專案讓內附 OpenCode Agent 接續原 Kit 八個已完成素材步驟。第一次六分鐘內，Qwen 自行讀取大量原始收據與工具格式，最後 claim `plan`，但未寫出 `plan.v4.json` 或完成收據。依原 Kit 控制器 `resume` 規則釋放可安全重試的 plan claim；未重跑八個已完成步驟。
- 新增唯讀 `get_kit_plan_context(run)`：它先經原 Kit controller 驗證 run 與目前專案綁定，再檢查狀態與已完成收據的 SHA-256，回傳約 3 KB 的來源、語意收據、推論路由與 plan 狀態索引。它不替模型編劇、不判讀畫面，也不代替 Kit claim／design brief／audit。側欄完整自動剪輯提示會先導向此工具；工具卡顯示「整理剪輯計畫證據」。隔離 MCP 測試涵蓋原始碼與新 EXE 封裝 gateway，並拒絕工作區外 run。
- 第二次真實 Qwen 回合確實先用了新索引，但約七分鐘後在 OpenCode 的工作區外檔案搜尋授權要求停下；當時 `plan` 已 claim，沒有計畫檔。沒有自動授權，原 Kit `resume` 再次把 plan 復位。載入同一 OpenCode session 的第三次短回合重現工作區外搜尋授權；驗收報告只記錄權限種類與位置是否在隔離工作區內，沒有輸出私人路徑。最終 run 的 `plan` 是 pending，來源 SHA-256 未變；Qwen 自主完整 v4 計畫仍未通過，不能將既有腳本合成計畫算作模型成果。
- `npm run build`、`npm run source:scan`、聚焦測試 14 項通過；新版可攜桌面側欄回歸 `artifacts/autopilot-desk/native-agent-review-lldOx6/` 為 PASS。最新版 EXE：`artifacts/autopilot-desk/portable-preview-2026-09-29T13-14-50-713Z/AutopilotDesk-Community-Preview.exe`，SHA-256 `0276be49d8514966f7d0b8a62ccf323c9a7437835dcb2dde43078e38f4510117`；須保留同層 `resources`。依最新三版規則清理一個舊預覽約 0.26 GiB，manifest：`artifacts/autopilot-desk/portable-preview-prune-20260929T131716991Z.json`。

## 已驗證的體驗

| 項目 | 結果 | 證據 |
| --- | --- | --- |
| 開啟側欄自動啟動內附 OpenCode；無須先手動連線 | 通過 | 可攜 EXE 實測 `OpenCode Agent` 與模型選單 |
| 原生 session 新建、列表、載入、對話重播 | 通過 | EXE 實測新舊 session ID、原生 `session/list`/`session/load` |
| 原生模型與 build/plan 模式、技能命令 | 通過 | Qwen 選擇、build↔plan、93 條 OpenCode 公告的命令；未逐一執行命令 |
| 工具狀態、結果、檔案位置 | 通過 | 區網 Qwen 真實呼叫 Editkin `get_project_summary`；側欄出現完成工具及可展開文字結果；OpenCode 內建 read 的檔案位置亦可見 |
| 最新版內附 Agent 的真實區網 Qwen 唯讀回合 | 通過 | 第十八輪獨立示範專案：工具查詢、schema 查詢、`get_project_summary` 回傳 GREEN，畫面有正確專案名及片段數，工作副本雜湊未改變 |
| 剪輯台目前片段引用 | 真實區網模型實測通過 | 側欄顯示素材名與時間；Qwen 在隔離示範專案中依選取片段引用，只呼叫一次真實 Editkin 工具把音量改為 65%，畫面與專案 JSON 均驗證；取消勾選不帶片段資訊仍由 loopback 測試覆蓋 |
| 唯讀回合不要求重載 | 通過 | 工具回合 `projectChanged=false`、重載按鈕未出現 |
| Agent 修改專案後自動同步剪輯台 | 通過 | 只修改合成專案副本；`apply_edit_commands` 更名後，磁碟 JSON 與剪輯台標題均為「OpenCode Agent 實機驗證」 |

可攜版實測產物：`artifacts/autopilot-desk/portable-preview-2026-09-29T02-12-48-804Z/AutopilotDesk-Community-Preview.exe`，SHA-256 `feb7e2ff2d9bf73b1cee896fe52ab2901caa0d12f253761961b1efd685d2b832`。`resources` 必須與 EXE 同層保留。以上為 community preview，未驗證正式安裝器。

## 尚未達到「完整原版 OpenCode」的地方

- 側欄不是原版 Web UI；現在有基本 Markdown 與圖片附件傳送，但尚未驗證真實模型對附件的接收與理解，也沒有長對話分頁及原版所有 UI 操作。側欄只載入最近 500 則對話與工具紀錄，達上限會提示。
- ACP 授權要求已顯示工具內容與允許／拒絕選項，但本輪未觸發真實授權要求進行互動驗證。
- 目前傳送模型限本機／區網。ChatGPT 訂閱、Claude 訂閱、DeepSeek API、OpenCode Go 的成本與認證路由尚未逐一驗證，因此不能把選單中的同名模型當作已接通。
- `花火` 的完整 Kit v4 plan → audit → apply → render 與真人審片尚未測試；此處的合成專案更名只證明 Agent 可操作 Editkin，不等於自動剪輯成片。
- 新建但未儲存的專案已可直接透過 Agent 工作副本使用真實工具。已開啟的正式專案若在 Agent 綁定前已有未儲存修改，仍需先儲存；若 Agent 正綁定正式專案時使用者再改時間軸，也會先阻止送出。工作副本跨重啟恢復、與正式專案的完整衝突合併尚未完成。
- 原版 OpenCode Web UI 尚未嵌入；目前是官方 OpenCode 核心與 Editkin ACP 側欄。訂閱模型、原版完整 UI 操作及不間斷的跨專案對話轉移仍有差距，不能宣稱與原版桌面程式完全相同。

下一個驗收應用獨立的**真實素材**專案確認：區網 Qwen 自主產生語意與完整 v4 計畫、媒體附件與選取素材、長對話恢復、影片敘事及剪輯台視覺審查；計費路由仍須逐一核對。合成 fixture 的 Kit 收據與輸出技術 QC 已完成，不代表實際影片的內容品質。不得以 OpenCode process 已啟動或工具清單存在替代這些結果。

## 第二十八輪 Review：原生 Agent 草稿驗證與假編輯攔截（2026-09-29）

- 在隔離的 4 秒合成測試專案延續同一個 OpenCode／區網 Qwen session。新增 `get_autopilot_plan_structure`，只提供明標 `EXAMPLE_ONLY` 的短版 v4 結構範例；`get_kit_plan_context` 指向正式 schema 的 `/properties/plan/anyOf/0`，避免模型反覆展開全部命令型別。
- 新增唯讀 `validate_autopilot_plan_draft`，可收完整物件或工作區內的 `plan.v4.json` 路徑，檢查 v4 schema 與交叉綁定。封裝 gateway 實測：結構範例通過，Qwen 第一份只有 `set_aesthetic_system` 的草稿被擋下，原因是節拍沒有綁到實際可見／可聽命令。路徑模式限制在綁定工作區、檔名 `plan.v4.json`、大小最多 1 MiB；它只做草稿解析，不代替 Kit 收據或素材審計。
- Qwen 在同一 session 修訂草稿，原 Kit controller 把 `plan` 標成 completed，來源雜湊未變，`audit/apply/render` 仍 pending。但獨立檢查發現它用 `update_clip_transform` 的空 `patch` 充當視覺命令，說明文字還稱為 `smart_cut_clip`。這不會改畫面，所以**不能視為自主完成有效剪輯計畫**。已在正式 v4 parser 拒絕空 transform／3D transform／color patch；Kit 橋接器也在 `complete plan` 前先執行同一解析器。新版封裝對這份已封存草稿回傳 `empty patch`，帶錯誤 token 的再封存呼叫在控制器前被拒絕；原 run 的 attempts 仍是 3，`audit/apply/render` 仍 pending。沒有修改既有收據。
- 本輪型別檢查、聚焦測試 32 通過／1 跳過、公開原始碼掃描、封裝 gateway 草稿與封存前檢查及桌面側欄 smoke 均通過。可攜預覽：`artifacts/autopilot-desk/portable-preview-2026-09-29T14-28-30-430Z/AutopilotDesk-Community-Preview.exe`，SHA-256 `865d2715b4bc24b109b071fc5880a86b4851268ad98119eb12d5a3cc5e4853ad`；須保留同層 `resources`。桌面報告 `artifacts/autopilot-desk/native-agent-review-F6CXAL/` PASS；Qwen 回合報告 `artifacts/autopilot-desk/qwen-kit-plan-bU0Slz/report.json` 的 PASS 僅代表舊 Kit 完成 plan 狀態，**不代表計畫內容通過新版品質檢查**。

## 第二十九輪 Review：空白 run 的原生 Agent 起稿瓶頸（2026-09-29）

- 使用最新版封裝在新隔離 4 秒合成素材專案建立 Kit run；八個來源證據步驟完成，三個抽樣影格與語意收據存在，`plan` 起始 pending。原始碼與 Kit 技能 SHA 均核對，未使用正式使用者影片。
- 區網 Qwen 從空白 run 的第一個八分鐘回合使用了素材及設計工具，但停在查詢 schema／收據，未寫計畫；同一 OpenCode session 的聚焦續跑約兩分半後結束，仍無檔案。報告：`artifacts/autopilot-desk/qwen-kit-plan-MeJqSb/report.json`、`qwen-kit-plan-eLvoDj/report.json`。兩次都無權限要求，來源未變、Kit plan 嘗試次數零。
- 為縮短固定欄位整理，`get_kit_plan_context` 增加由已驗證收據導出的 `sourceBoundSeed`，並直接給出設計工具與 factual caption 的呼叫形狀。封裝 gateway 實測 packet 約 7.1 KB，正確含來源、素材語意 SHA、專案摘要和路由 SHA。新 OpenCode session 使用此入口的第三個八分鐘回合仍反覆搜尋工具，沒有計畫檔；報告 `artifacts/autopilot-desk/qwen-kit-plan-4FUwlV/report.json`。**來源綁定索引已接通，Agent 自主從空白產出有效 v4 計畫仍未通過。**
- 下一步需按 [起稿藍圖](AGENT_PLAN_AUTHORING_BLUEPRINT.md) 實作高階工具，讓 Agent 提交節拍與實際編輯命令，由 Editkin 組裝固定證據欄位並先驗證。不能再以更長提示詞或手填假欄位充當完成。

## 第三十輪 Review：單片段高階起稿與原 Kit 完整驗收（2026-09-29）

- 新增 `draft_kit_single_clip_plan`。Agent 可提交單一無音軌片段的短字幕與 proof beat 意圖，Editkin 從已驗證 Kit 收據、設計 brief 與美學系統組裝完整 v4 草稿。工具只寫新檔，仍由原 Kit 控制器執行 plan、audit、apply、render。無音軌計畫的 `editorial.audio.layers` 允許空陣列，不再為了通過 schema 偽造音軌。
- 原始碼 gateway 的第一個隔離 run `kit-bound-create-Y5CvTT`：起稿、Kit plan、audit 均通過，來源未變。另在**新版可攜 EXE 內附 gateway**建立 `kit-bound-create-8djv7J`，按起稿 → Kit plan → audit → apply → render 連續驗收，Kit 下一步為 `human-review`。輸出 4 秒 MP4，FFmpeg 全片解碼通過；正式專案留有 1 段可編輯字幕，原片 SHA-256 未變。報告：`artifacts/autopilot-desk/kit-bound-create-8djv7J/kit-through-render-report.json`，輸出 SHA-256 `09a827961b7daa88878146d1394b4d403df03c4c9c66d8955cddb05d5519f2b2`。
- audit 收據有程序內簽章。刻意把第一個 run 的 audit 與 apply 分在兩個 Agent 程序，apply 拒絕「不是由目前 Editkin 程序簽發」；第二個 run 把 audit → apply → render 放在同一程序後通過。這是原 Kit 與 Editkin 的既有安全邊界，並非自動恢復能力。
- 區網 Qwen 的原生 OpenCode session 對新 run `kit-bound-create-6Uz1R3`，首回合誤把起稿 gateway 工具當成一般 Editkin 工具，未產出檔案；同一 session 第二回合在明確工具名稱和測試字幕／節拍參數的提示下，**確實呼叫** `editkin_draft_kit_single_clip_plan`，產生通過目前 v4 parser 的草稿，來源未變。原測試腳本因預期連 Kit plan 一起完成而報 BLOCK；依這次只要求 DRAFT_WRITTEN 的正確判準，起稿已成功。隨後由驗收腳本接手 Kit plan、audit、apply、render，4 秒影片全片可解碼、1 段可編輯字幕、下一步 `human-review`。這是模型呼叫高階工具，**不是模型自主判讀畫面、選節奏或完成整片**。報告：`artifacts/autopilot-desk/qwen-kit-plan-GBr9a6/report.json` 與 `kit-bound-create-6Uz1R3/kit-through-render-report.json`。
- 修正工具發現路徑：`get_kit_plan_context` 現在回傳 OpenCode 實際呼叫名稱，側欄完整自動剪輯提示也指向該 gateway 工具，避免模型誤走 `call_editkin_tool`。最新封裝版重新驗證來源綁定起稿與重複起稿不得覆蓋，桌面 Agent 視窗 smoke PASS，包含模型選單、輸入區、歷史區；真人介面體驗仍需使用者檢視。
- 最新預覽：`artifacts/autopilot-desk/portable-preview-2026-09-29T15-31-50-512Z/AutopilotDesk-Community-Preview.exe`，SHA-256 `258d5e1c16f67966882da008537645494d802e7d3dfc24da9a8de962014e5d71`，同層 `resources` 必須保留。`npm run typecheck`、聚焦測試 20 項、`npm run source:scan`、`git diff --check` 通過。已清理兩個過渡版約 0.51 GiB，manifest `artifacts/autopilot-desk/portable-preview-prune-20260929T152406328Z.json`；目前 4 版均由驗收 run 綁定或為最新預覽。

## 第三十一輪 Review：自然語句從起稿走到可編輯影片（2026-09-29）

- 在新版封裝的隔離 4 秒 FFmpeg `testsrc2` 專案，區網 Qwen 收到接近剪輯台的上下文與使用者自然語句：「剪成讓人一眼看懂素材性質的簡短影片」。草稿回合沒有在使用者句子裡指定工具；Qwen 自行讀 Kit 索引，再呼叫內附起稿工具，約 56 秒產出有效 v4 草稿。報告 `artifacts/autopilot-desk/qwen-kit-plan-PaTiP3/report.json` 為 PASS；這仍使用工程腳本提交的素材語意收據，不能當成真實畫面理解驗證。
- 新增 `finish_kit_single_clip_edit`：只收一段 visual-only、單一字幕且沒有音訊層的有效草稿，執行前核對綁定、來源與草稿 SHA。在同一 gateway 程序依原 Kit claim、原 Editkin audit、apply、render 逐步推進；維持 apply/render claim token、來源 SHA 與不確定結果不得盲重試的既有防線。工具輸出 `RENDERED_AWAITING_HUMAN_REVIEW`，不代填真人審片。
- `get_kit_plan_context` 增加 `savedDraft`（MISSING／VALID／INVALID）與完成工具名稱；側欄提示依使用者只要草稿或要求輸出選擇工具。封裝版隔離 run `kit-bound-create-exlzM2` 通過起稿、重複起稿不得覆蓋、同程序 plan→audit→apply→render；4 秒 MP4 全片解碼、1 段可編輯字幕、原片未變。
- 第二個區網 Qwen 回合依「完成輸出讓我看片」的自然語句，按索引→起稿→重讀草稿狀態→完成工具的順序，約 58 秒讓 Kit 的 plan／audit／apply／render 均 completed。獨立 FFmpeg 解碼與專案字幕核對 PASS，Kit 下一步為 `human-review`；報告 `artifacts/autopilot-desk/qwen-kit-plan-NgRA7j/report.json` 與 `kit-bound-create-xS9sfA/kit-through-render-report.json`。已完成的 run 再呼叫完成工具會拒絕，專案與輸出 SHA 均未變。字幕文字由 Qwen 在已提交的合成素材語意範圍內選定，尚未有人用正常速度看完這支影片。
- 最新可攜預覽：`artifacts/autopilot-desk/portable-preview-2026-09-29T15-44-02-519Z/AutopilotDesk-Community-Preview.exe`，SHA-256 `8bde2ffb6a5d0a5b1445ed9a3ab1482b3b8dd64017ca610b9438cad1f53c4943`；同層 `resources` 必須保留。桌面 Agent 基本回歸 `native-agent-review-rlZu9b` PASS。完整能力仍限單段無音軌素材；多片段選鏡、歌曲節拍、真實素材品質與真人審片待驗證。

## 第三十二輪 Review：來源語意綁定的真正裁切（2026-09-30）

- 修正設計證據白名單使用過期命令名稱，讓原生 `smart_cut_clip`、起訖修剪、ripple delete 等實際時間軸命令能綁定敘事節拍。既有拒絕 metadata 作為可見編輯的門檻保持有效。
- `draft_kit_single_clip_plan` 增加可選 `keepRanges`：僅接受與完整 Kit 語意收據中的不同片段完全對齊、有已檢視影格、符合影格格點，而且確實刪除中間至少一格的區間。只允許單一無音軌來源且專案沒有其他片段、字幕與動態圖層。草稿產生原生 Smart Cut 加可編輯字幕；完成工具再次核對來源片段、語意邊界、成片長度與字幕覆蓋，再交原 Kit audit／apply／render。這是保守的單素材裁切能力，沒有宣稱多素材選鏡或音樂卡點。
- 三色隔離素材以 FFmpeg 產生 6 秒紅／綠／藍場景，逐段提交具有已檢視影格 ID 的 Kit 語意。新版封裝 gateway 的腳本驗收 `kit-bound-create-T5nCdp` 通過起稿→plan→audit→apply→render，成片 4 秒，專案保留兩段可編輯片段與字幕；輸出中心像素在首段為紅、末段為藍。原 4 秒單素材加字幕路徑 `kit-bound-create-aAR0xS` 同樣回歸通過。
- 另把同一需求以自然語句交給**內附 OpenCode Agent＋區網 Qwen 3.8 27B**，沒有預填 `keepRanges`。約 80 秒內它讀 Kit 索引、起稿並呼叫完成工具，產生 0–2 秒與 4–6 秒的 Smart Cut，原 Kit 到 `human-review`。獨立報告 `artifacts/autopilot-desk/qwen-kit-plan-jRYNTX/report.json` 與 `artifacts/autopilot-desk/kit-bound-create-QUUS7e/cut-render-qc.json`：原片 SHA 不變，4 秒 MP4 全片解碼、兩段可編輯片段、一段可編輯字幕，中心 RGB 分別為 `[250,0,0]` 和 `[0,0,250]`。這是已知合成顏色場景的操作驗收，不能當作真人素材畫面理解或完整 MV 品質證明。
- 仍未驗證歌曲音訊、節拍對齊、多來源選鏡、真實畫面語意判讀與真人審片。下一階段須讓 Agent 為多個素材及音軌建立可檢查的故事／節拍計畫，再做整片驗收。
- 加強語意影格時間核對後，最終可攜預覽為 `artifacts/autopilot-desk/portable-preview-2026-09-29T16-12-50-118Z/AutopilotDesk-Community-Preview.exe`，SHA-256 `3589f7302244958ebcce721040b6a4b9b79898e4be6c39af4af13d4e9ed0e393`，需連同同層 `resources` 使用。最終封裝的隔離 run `kit-bound-create-IWpE2V` 再次通過起稿→原 Kit 審核／套用／輸出及獨立畫素與時間軸核對，報告 `artifacts/autopilot-desk/kit-bound-create-IWpE2V/cut-render-qc.json`。`npm run typecheck`、聚焦測試 28 通過／1 跳過、`npm run source:scan` 均通過。可攜預覽供本機試用，未做真人審片。

## 第三十三輪 Review：雙來源故事順序與原生 Agent 單回合輸出（2026-09-30）

- 新增 `draft_kit_two_clip_story_plan` 與 `finish_kit_two_clip_edit`。Agent 提交有順序的 setup／payoff 節拍；Editkin 只接受原 Kit 已綁定且已檢視影格的兩段 visual-only 素材，核對語意區間、原片收據、設計配方與美學家族，生成真正刪除並重新加入片段的可編輯 v4 計畫，每段各有獨立字幕。完成工具再次核對兩份原片、時間軸順序、敘事範圍、字幕時間與計畫 SHA，再由原 Kit 同程序完成 plan→audit→apply→render，停在 `human-review`。重複完成會拒絕。
- 區網 Qwen 3.8 27B 在原始碼 gateway 的隔離 run `kit-two-source-9atYUB`，依自然語句「藍色開場、紅色收尾，並輸出」於**單一回合**呼叫索引→起稿→完成，約 53 秒。獨立驗收證實 4 秒成片首段中心 RGB `[0,11,253]`、末段 `[255,23,0]`，兩段可編輯片段及兩段字幕，兩份原片 SHA-256 不變。報告：`artifacts/autopilot-desk/qwen-two-story-xArFlN/report.json` 與 `kit-two-source-9atYUB/two-story-render-qc.json`。
- 新版可攜 EXE 內附 gateway 先於 `kit-two-source-2IWks6` 通過原 Kit 全流程；再用**該版內附 OpenCode Agent、gateway、MCP 與區網 Qwen**對新 run `kit-two-source-II2nY1` 單回合完成，約 48 秒。獨立驗收再次確認藍→紅、4 秒、兩片段／兩字幕、原片不變與下一步 `human-review`。報告：`artifacts/autopilot-desk/qwen-two-story-fFlHio/report.json`、`kit-two-source-II2nY1/two-story-render-qc.json`。桌面側欄以 loopback 測試模型驗證模型選單、輸入、歷史與原有工具操作，`native-agent-review-lrcNBn` PASS；這不是桌面視窗內的真人操作驗收。
- `npm run typecheck`、27 項聚焦測試（另 1 跳過）、`npm run source:scan`、`git diff --check` 通過。可攜預覽 `artifacts/autopilot-desk/portable-preview-2026-09-29T16-32-46-575Z/AutopilotDesk-Community-Preview.exe`，SHA-256 `9a20360a617c758b9675da4f9b0e84eed36fddddb40e79aa05af5946f72f7b1f`，必須保留同層 `resources`。
- 能力邊界：只驗證了兩份各 2 秒的合成純色、無音軌素材，以及使用者明確指定的故事順序。語意收據由驗收腳本根據已知合成畫面提交，尚未證明 Agent 能從真實鏡頭自主判讀劇情、挑選多於兩份素材、依歌曲卡點、剪出完整 MV 或通過真人審片。

## 第三十四輪 Review：選取圖片建立 Kit run 與混合專案時間軸（2026-09-30）

- 追查使用者反覆遇到的兩個 create 錯誤：未指定素材時會綁全專案，碰到 Agent 啟動後才出現的異源片段；手填 `materials.sourcePath` 則繞過 Editkin 自動著陸，受工作區檔案閘門阻擋。`transcriptPolicies` 只控制逐字稿策略，不能縮小素材範圍。新增 `clipIds` 選取範圍，保留來源固定與檔案邊界，由 Editkin 為指定專案片段建立工作區快照；側欄把目前所選 clipId 傳給 Agent，且來源拓撲有變動時自動重建內附 Agent 綁定並嘗試續接對話。
- 原 Kit receipt 準備器原先只接受影片；相鄰 Kit checkout 提交 `c15aa7f`，允許經證據鏈核對的靜態圖片使用 `visual-only` 策略。Editkin 的 JPEG 影格擷取在來源 0 秒只看一張，不把 JPEG 未宣告的色彩原色／傳遞函數假裝成 Rec.709。影片的嚴格色彩檢查仍保留。
- 單素材起稿改為從專案讀取已綁定片段的實際時間軸位置。混合專案中字幕與 proof beat 對齊該片段；完成工具在 audit 前再次核對其時間、長度、素材收據和計畫。Smart Cut 仍只允許空白時間軸上的單一原片，不套用到混合專案。
- 原始碼與新版 EXE 各跑一次隔離混合圖片專案：選取片段從 5 秒開始，unselected 異源素材不進 run；原 Kit 完成影格、語意、路由、起稿、audit、apply、render，字幕從 5 秒開始，10 秒 MP4 全片可解碼，停於 `human-review`。新版封裝報告：`artifacts/autopilot-desk/kit-selected-image-dXEOqi/selected-image-report.json`。另用使用者 10 片段專案的**唯讀副本**驗證 create→準備→實際影格觀看→上下文，停在語意步驟；原專案雜湊未變，未捏造真人圖片的內容或執行正式剪輯。封裝報告：`artifacts/autopilot-desk/kit-selected-image-T9NRNb/selected-image-report.json`。
- `npm run typecheck`、`npm run source:scan`、相關 17 項測試、原 Kit 18 項 contract selftest 與圖片 receipt 3 項測試通過。新版桌面側欄回歸 `artifacts/autopilot-desk/native-agent-review-C993pG/` PASS。可攜預覽：`artifacts/autopilot-desk/portable-preview-2026-09-29T18-32-53-778Z/AutopilotDesk-Community-Preview.exe`，SHA-256 `7fa1f922bce09d8660d93174a382d66590455d6b3833e4bb63e220ee223499fd`；需保留同層 `resources`。
- 限制：目前圖片實證只覆蓋 JPEG；真實圖片語意仍須 Agent 根據實際影格提交，使用者正式專案的配音剪輯、全片品質與真人審片未完成。側欄的來源變更自動續接已有型別與一般桌面回歸，尚無實際匯入中途的端到端操作測試。

補上混合專案能力邊界後重新封裝。**本輪最終版**為 `artifacts/autopilot-desk/portable-preview-2026-09-29T18-36-40-159Z/AutopilotDesk-Community-Preview.exe`，SHA-256 `a3eac62723dfbff424b929c531f90be23e2eea63e1bcde4647f8f026ab909d8b`。此版內附 gateway 的完整合成圖片 run 報告 `artifacts/autopilot-desk/kit-selected-image-SpdciD/selected-image-report.json` 為 PASS；使用者專案唯讀副本報告 `artifacts/autopilot-desk/kit-selected-image-7c7tjb/selected-image-report.json` 為 PASS 且原專案未變；桌面側欄報告 `artifacts/autopilot-desk/native-agent-review-JqpWNN/` 為 PASS。需保留 EXE 同層 `resources`。

## 第三十五輪 Review：全專案圖片策略與區網 Qwen 真實圖片語意（2026-09-30）

- 找出一個仍會在建好 run 後重現的缺口：Kit 未指定逐字稿策略時預設 `required`；圖片即使成功著陸，仍會在 `prepare` 收據被「必須轉錄」擋住。Editkin 的 Kit 入口現在根據**專案資產類型**自動將圖片綁為 `visual-only`，明確傳入圖片 `required` 則拒絕；模型毋須記得補參數。影片原有的預設轉錄策略不改。
- 用最新版封裝對使用者 10 片段專案的隔離副本執行**全專案 create**：10 個真實片段全部進 run，其中 8 個圖片片段自動取得 `visual-only`，原專案與副本 JSON 雜湊皆未變。報告 `artifacts/autopilot-desk/kit-mixed-project-1YO6rC/mixed-create-report.json`。合成混合專案也在省略圖片策略時通過影格、語意、plan、audit、apply、render；刻意指定圖片 `required` 的負例被拒，字幕仍對齊所選 5 秒片段。報告 `artifacts/autopilot-desk/kit-selected-image-iP8S93/selected-image-report.json`。
- 另在前一版封裝建立的**真實專案副本** run 上，讓內附 OpenCode＋區網 Qwen 3.8 27B 接手唯一 pending 的圖片語意步驟。單回合完成 Kit 收據，引用已建立的影格證據 ID，停於 `plan` pending；沒有 apply 或 render。人工比對原圖與語意收據：模型正確認出資訊圖的主題、兩個目錄的角色和尺寸，並對被浮水印遮住的小字標示不確定。原專案與測試副本雜湊一致。隔離報告 `artifacts/autopilot-desk/qwen-selected-image-qFSMNh/report.json`。ACP 重播有工具事件，但其摘要未保留具名工具，因此「模型在該回合呼叫了哪個看片工具」不能僅從 ACP 事件證明；實際內容核對及 Kit 影格收據是本輪語意驗收依據。
- 現有正式專案的時間軸音軌沒有獨立配音片段；其中一份影片資產有內嵌音訊。原始碼也沒有可用的 TTS／配音生成工具。因此本輪證明的是**素材綁定與圖片語意**，沒有完成配音生成、全 10 片段節奏設計或真人審片。不能把單圖 proof 字幕工具當成整片配音剪輯。
- 本輪最終可攜版：`artifacts/autopilot-desk/portable-preview-2026-09-29T18-48-27-905Z/AutopilotDesk-Community-Preview.exe`，SHA-256 `14871c3dd1fa91f221507900c57545849b7a4230016beb0d9407f85f4c710036`，同層 `resources` 必須保留。

最終封裝的桌面側欄回歸 `artifacts/autopilot-desk/native-agent-review-2EcTBP/` 為 PASS：內附 Agent 可連線，模型、輸入區與歷史區可見。`npm run typecheck`、`npm run source:scan`、`git diff --check` 通過。

## 第三十六輪 Review：全專案證據流程與逐字稿失敗邊界（2026-09-30）

- 延續既有的真實專案**隔離副本** `kit-mixed-project-1YO6rC/all-materials`，未建立重複 run。Kit 契約、session、10 個片段的 prepare 與 10 個片段的 keyframes 均完成，圖片影格與來源綁定成立；到第一個影片 context 才被 `Transcript not ready` 擋下。原專案未修改，也沒有宣稱已完成全片配音剪輯。
- 查明原因：該影片含音訊、預設要求逐字稿，但封裝版 FFmpeg 沒有 Whisper filter，portable 也沒有 whisper-cli；prepare 回傳 `PARTIAL` 與 `transcript.state=blocked`，舊 Kit 卻封存為成功。新 Kit `66b83f3` 在 prepare 收據就要求必要逐字稿為 `ready`，將辨識器缺失與處理方向直接回報，不允許把失敗的辨識偷改成 visual-only。Editkin Agent 工具說明同步要求遇到此情況停止該 run，不再猜路徑或重試 context。
- 封裝來源測試：Kit 5 個聚焦單元測試與 controller selftest 18 步通過；新版封裝中的 controller selftest 同樣通過。把舊 run 的真實 `PARTIAL` prepare 收據交給新版封裝驗證，於 prepare 立即拒絕。驗收腳本也會辨識舊 run 已封存的壞逐字稿，拒絕續跑。這修正了錯誤階段與診斷，**未提供新的語音辨識執行器**。
- 新版 portable 的隔離合成圖片 run `kit-selected-image-8crDXK` 通過影格證據、語意、plan、audit、apply、render，下一步為真人審片；此測試只驗證無配音的圖片剪輯路徑。`npm run typecheck`、`npm run source:scan`、Kit selftest 與聚焦 Editkin 8 個測試通過。
- 新預覽位於 `artifacts/autopilot-desk/portable-preview-2026-09-29T19-04-08-901Z/AutopilotDesk-Community-Preview.exe`，SHA-256 `49cb4c2a02826abc73d77a3f3d4b595cacca15c20c6ab46f5d64082b529222aa`，需保留同層 `resources`。含音訊素材的全片 run 仍需可用的本機 ASR；正式專案亦無獨立配音來源，不能宣稱配音剪輯完成。

## 第三十七輪 Review：必要逐字稿失敗後釋放 Agent 工作（2026-09-30）

- 追查上一輪的後續狀態，發現 prepare 收據被拒後原 Kit claim 仍可能保持 `running`，讓 Agent 側欄像持續工作。新 Kit `4d337b0` 將已確認的 `REQUIRED_TRANSCRIPT_UNAVAILABLE` 視為不可重試的 prepare 失敗：step 轉 `failed`、run 轉 `blocked`，立即釋放 claim。其他可安全重試的失敗仍沿用既有策略。
- Agent gateway 在封存必要逐字稿的 prepare 收據遭拒時，使用原 claim token 呼叫 Kit `fail`，清除該次記憶體證據引用，並回傳 `BLOCKED_REQUIRED_TRANSCRIPT` 與明確的下一步。這避免模型對同一個 claim 反覆呼叫 context 或 prepare；不會將辨識失敗改寫成 visual-only，也不會碰正式專案。
- 新版 portable 的封裝 gateway 隔離實測 `kit-required-transcript-73z4En`：有音訊的合成影片在無 Whisper 執行器時於 prepare 停止，run 為 `blocked`、step 為 `failed`、claim 為 null；同版 `kit-selected-image-qIkbPF` 的圖片 run 仍通過 plan、audit、apply、render，停在真人審片。Kit 6 個聚焦單元測試、18 步 controller selftest、Editkin 8 個聚焦測試、型別檢查與原始碼掃描通過。
- 首輪預覽：`artifacts/autopilot-desk/portable-preview-2026-09-29T19-11-41-103Z/AutopilotDesk-Community-Preview.exe`，SHA-256 `aed010e0bf96b8e03555fb647e73cda93fba965731e7fc9badfeb4da59294c88`；須保留同層 `resources`。後續檢查發現失敗原因可能含換行，會被 Kit 的單行理由驗證拒絕；Agent gateway 已將控制字元轉成空格，避免 claim 因錯誤文字卡住。
- **本輪最終封裝**：`artifacts/autopilot-desk/portable-preview-2026-09-29T19-13-57-509Z/AutopilotDesk-Community-Preview.exe`，SHA-256 `09f229f7507a39cfb5056dac97313d889abfa7dfb1cd94b44ad52cbadc223e5a`。封裝 gateway 再以隔離 run `kit-required-transcript-kxRZZN` 驗證 `BLOCKED_REQUIRED_TRANSCRIPT`、run blocked、claim null。此輪修正錯誤後的狀態與呈現，**尚未加入 ASR，也未完成全片配音**。

## 第三十八輪 Review：Agent 側欄呈現被阻斷流程（2026-09-30）

- 追查 `BLOCKED_REQUIRED_TRANSCRIPT` 已從 gateway 回傳後的 ACP/UI 路徑。原側欄把結構化失敗顯示成泛稱「執行自動剪輯流程 · 失敗」，且 OpenCode 仍在產生說明時顯示「正在處理剪輯任務」，容易誤認 Kit 還在剪輯。
- ACP 工具更新現在只對 `run_kit_workflow(complete)` 的精確 `BLOCKED_REQUIRED_TRANSCRIPT` 結果顯示固定中文摘要，並將工具卡標為失敗；即使 ACP 把已收到的工具結果標成 `completed` 也不會顯示成功。側欄把後續 Agent 忙碌狀態寫成「流程已停止，Agent 正在整理原因」，原始工具記錄仍可展開核查。其他工具的同名文字不會觸發此摘要。
- `acpToolContent`/`openCodeAcp` 聚焦測試 12 個、typecheck、source scan 通過。第一版封裝 desktop smoke `native-agent-review-WhSAu9` 通過原生 Agent 對話、編輯、回讀與合成失敗狀態的可見性檢查；側欄 380px 寬時沒有水平溢位。其後發現真實失敗事件會自動展開長篇原始 JSON，因此保留中文摘要並把原始記錄收折。最終封裝 desktop smoke `native-agent-review-bNxQad` 再次通過，確認失敗紀錄可展開但預設收折；畫面證據為該資料夾的 `agent-blocked-transcript.png`。失敗狀態用注入事件驗證 UI；真實 Kit 封裝失敗與 claim 釋放由第三十七輪隔離測試驗證，兩者不可混稱為完整音訊剪輯驗收。
- **本輪最終預覽**：`artifacts/autopilot-desk/portable-preview-2026-09-29T23-29-37-415Z/AutopilotDesk-Community-Preview.exe`，SHA-256 `39511aa6f1a6c76bffda9edfde4a9d0fab839b3686ab0c9186923ed83513151b`，須保留同層 `resources`。本輪未新增 ASR 依賴；全片配音仍未完成。

## 第三十九輪 Review：首次開啟的真實狀態與選用素材庫（2026-09-30）

- 建立可滾動的 `EXE_QUALITY_GOAL.md`，以封裝版驗收、功能正確性、使用理解與視覺品質作為後續 review 優先順序。編輯器工具列原有四步進度並不隨專案狀態前進，還把輸出按鈕重複當第四步；已移除編輯器的假進度，保留實際專案狀態與直接操作，將原生自動功能明確命名為「本機粗剪」。首次開始與教學文案同步取消無條件的全自動成片承諾。
- 桌面截圖發現首畫面充滿彩條測試片。保留可播放、可核查的原示範片，在未動過的示範專案 0 秒暫停時顯示安靜的起始提示；播放時立即顯示真實影像。測試用效能浮窗僅在 `EDITKIN_INTEGRATION_SMOKE=1` 出現，不屬正常產品畫面。
- 封裝 screenshot 還發現全域狀態列的「Creator Pack 載入失敗」。Community 預覽沒有附 Creator Pack manifest；原服務把選用素材庫缺席當啟動故障。現在缺席時回傳可辨識的空庫，素材頁寫明可加入自己的檔案；已存在但格式損壞的 manifest 照常拋錯。此修正沒有憑空加入或聲稱提供 Creator Pack 素材。
- 最終可攜版 `artifacts/autopilot-desk/portable-preview-2026-09-29T23-51-54-157Z/AutopilotDesk-Community-Preview.exe`，SHA-256 `81e6a4d9a289693bfdce355b61d6b9c46ef630eba6e7654b59b6babb3d1916fa`，必須保留同層 `resources`。封裝桌面 smoke `native-agent-review-WZEvUe` 為 PASS：起始提示、播放切換、選用素材庫空狀態、Agent 連線／歷史／編輯操作及側欄無溢位；首次開啟沒有 Creator Pack 失敗訊息。`npm run typecheck`、相關 19 個聚焦測試、`npm run source:scan`、可用性規則負例及 `git diff --check` 通過。
- 限制維持：本輪沒有增加 ASR 執行器，也沒有完成使用者正式多片段與配音的全片輸出或真人審片。此版本是需本機 Node、FFmpeg、WebView2 的 Community 可攜預覽，尚非正式安裝版。

## 第四十輪 Review：匯入時間軸與啟動拖放時序（2026-09-30）

- 追查封裝版操作發現匯入共用全專案尾端游標：先加入聲音再加入畫面時，畫面被放到聲音結束後；先加入畫面再加入聲音時，聲音被放到畫面結束後。現在每條軌道按自己的尾端接續；首次加入真素材，不論是聲音或畫面，均移除示範片。空素材庫不再推廣「查看 0 份」。
- 第一次封裝 `00-03-21` 在等候後的拖放與儲存重開通過，但加入「編輯器剛顯示就拖入」驗收後重現無反應。等待 800 毫秒通過，證明是桌面拖放監聽的啟動時序。僅把拖放元件提早載入的 `00-07-06` 版仍未通過；最終在 App 顯示前註冊監聽，並緩存載入期間的 drop。
- 最終可攜預覽 `artifacts/autopilot-desk/portable-preview-2026-09-30T00-10-36-487Z/AutopilotDesk-Community-Preview.exe`，SHA-256 `4807c6e78c7f2681200c2f1add5054e3f245b7b956ffdcc0745dd7e82bba7bec`；必須保留同層 `resources`。封裝桌面匯入／儲存／重開驗收連續兩次 PASS：`editor-project-review-uV5ZOe`、`editor-project-review-AhOX6K`。合成 WAV 在第一畫面立即拖入後，示範片消失、音軌從 0 秒起；新空專案依序加入 WAV 與影片，兩軌均從 0 秒起；透過產品的儲存與開啟路徑重開 JSON 後，可播放畫面仍存在。腳本用隔離目標路徑替代系統選檔對話框，所以不代表 OS 對話框已驗收。
- 同版原生 Agent 桌面回歸 `native-agent-review-vT720r` PASS：內附 Agent 可連線，模型、輸入、歷史、剪輯操作與被阻斷逐字稿狀態仍可呈現。`npm run typecheck`、9 個聚焦測試、`npm run source:scan` 與 `git diff --check` 通過。
- 這是以合成音訊及內附測試影片驗證匯入流程；尚未完成正式多片段專案、語音辨識、成片輸出或真人審片。此 Community 可攜預覽仍需本機 Node、FFmpeg、WebView2。

## 第四十一輪 Review：單一輸出工作與可核查聲畫對位（2026-09-30）

- 原輸出按鈕在 render 進行中沒有鎖定；使用者重按，或在 MP4、OpenEXR、Alpha 間切換，可能重複提交工作。現在同一個 App 工作階段使用同步鎖攔截重複要求，三種輸出入口在忙碌期間停用，主按鈕顯示「輸出中…」；結束後釋放。聚焦測試覆蓋畫面重建後再次呼叫、跨輸出類型呼叫與結束後恢復。
- 最終可攜預覽 `artifacts/autopilot-desk/portable-preview-2026-09-30T00-24-10-060Z/AutopilotDesk-Community-Preview.exe`，SHA-256 `5b7771146f4ed28dbfe12f1e1fda2e306bb7bfd1cd6915dc2c8ad750cffe71bc`，須保留同層 `resources`。封裝桌面驗收 `editor-project-review-sArQpq` PASS：合成 WAV 與測試影片從 0 秒同時起、產品儲存／重開後按 UI 的輸出按鈕，由原生 `render_project_smoke` 轉接到同一真實 render service。MP4 為 12 秒／360 格、約 14.9 MB，全片聲畫解碼成功；440 Hz 音訊在 0.5 秒為 −20.4 dB，超出三秒音軌後在 4 秒降至 −91 dB。畫面顯示輸出忙碌與完成狀態，提交計數為一次。
- 同一封裝的內附 Agent 桌面回歸 `native-agent-review-XdsQaR` PASS；模型、輸入、歷史和剪輯側欄可見。`npm run typecheck`、9 個聚焦測試、`npm run source:scan`、`git diff --check` 通過。
- 系統儲存與輸出選檔對話框由隔離測試路徑代入，未驗收 OS 對話框本身。這份影片只證明工程接線與時間對位，不代表使用者正式專案的音樂、配音、剪輯敘事、美感或真人審片已完成；可攜版仍非正式安裝版。

## 第四十二輪 Review：常見桌面尺寸的預覽與時間軸（2026-09-30）

- 在封裝版把 WebView 視口量成 1366×768，發現預覽下方「素材證據」與「影片類型」各占一排，真實畫面只剩 462×260。將兩者合成一條精簡列；影片類型原展開選項與素材證據 Agent 分頁仍可操作。新版相同條件下預覽為 562×316，沒有整頁水平溢位。
- 1280×720 下，時間軸原有 `max-height:760px` 規則位於後續預設樣式之前，被 66px 工具列和 52px 軌道覆蓋。把完整緊湊規則移到後方並套用至 820px 以下；新版工具列為 48px，時間尺、畫面軌、聲音軌各 44px，聲音軌底端在可見時間軸內，播放頭起點與時間尺相差小於 1px。片段名稱與時長也完整顯示。
- 最終可攜預覽 `artifacts/autopilot-desk/portable-preview-2026-09-30T00-38-02-443Z/AutopilotDesk-Community-Preview.exe`，SHA-256 `31f794c74236d328bd38742dfa532d90f3ed9c0d240ca0644df7d5f7f676fb4f`，須保留同層 `resources`。封裝桌面回歸 `editor-project-review-wYJuwW` PASS，報告與兩張尺寸截圖同目錄；匯入、儲存重開、12 秒聲畫輸出、剪輯類型展開和素材證據入口仍通過。此測試使用 CDP 視口模擬，證明 WebView 排版，未驗收 Windows 實際拖曳調整視窗框。
- 同版內附 Agent 桌面回歸 `native-agent-review-0smnS9` PASS。`npm run typecheck`、Timeline 與 Toolbar 聚焦測試 4 項、`npm run source:scan`、`git diff --check` 通過。正式專案的配音、語音辨識與真人審片缺口仍依品質目標繼續處理。

## 第四十三輪 Review：真實模型的一般剪輯工具重試（2026-09-30）

- 以第 42 輪封裝版和已儲存的區網 Qwen，在隔離工作副本實測唯讀專案摘要 `native-agent-live-qwen-xrd9tj`：工具讀取成功、專案雜湊未變、中文回答可見。同版音量 65% 測試 `native-agent-live-qwen-edit-DmcOPo` 最終雖成功，操作紀錄顯示模型第一次對一般 `apply_edit_commands` 多帶 Kit 證據保留旗標，gateway 回「Only evidence tools in a named Kit run can retain raw results」，第二次才成功。這是可見的冗餘失敗，不應視為一次完成。
- 修正 gateway 工具描述與側欄選取片段音量提示。對沒有 Kit run 的一般 `apply_edit_commands`，多餘的保留旗標不再阻斷操作；若帶具名 Kit run，仍按原證據規則拒絕非證據工具。驗收腳本新增失敗工具卡和重複剪輯呼叫的拒絕條件。
- **本輪封裝**：`artifacts/autopilot-desk/portable-preview-2026-09-30T00-47-12-273Z/AutopilotDesk-Community-Preview.exe`，SHA-256 `e000efbd1f9c4acd2233c6c17c46dc6da97e07d736d149f84921972465110139`，須保留同層 `resources`。新封裝真實 Qwen 音量測試 `native-agent-live-qwen-edit-oFafKx` PASS：一次工具呼叫、零失敗、選取片段音量 65%、其他專案欄位不變，編輯器可復原且顯示同步。封裝 gateway 的定向測試 `agent-direct-edit-retention-IyDPKS` PASS：多餘證據旗標不阻斷一般剪輯，沒有產生 Kit 引用；具名 run 的同一操作在修改前拒絕。內附 Agent 側欄回歸 `native-agent-review-5pnebu` PASS。`npm run typecheck`、`acpToolContent` 7 個聚焦測試、`npm run source:scan`、`git diff --check` 通過。
- 這是隔離示範片段的真實模型剪輯驗收，不代表正式多素材專案、配音 ASR 或成片審片完成。既有舊版 Editkin 與其 OpenCode 子程序仍在執行，沒有把使用者正在使用的程序誤當殭屍程序終止。

## 第四十四輪 Review：正式專案副本與 Agent 自動綁定（2026-09-30）

- 以已儲存的正式專案副本做封裝桌面驗收，原始專案 SHA-256 `513f9ed230f3acd0b815324a3437fdf0d61ad351b336046c7b4e8f74b5f5264d`。專案含 9 素材、10 片段、48 秒；輸入專案始終唯讀，驗收前後雜湊相同。新腳本 `scripts/review-existing-project-desktop.mjs` 保留隔離專案、報告、截圖及輸出，可重做同一套核查。
- 第一輪封裝驗收顯示「更多」選單在開啟專案後仍遮住預覽，Agent 工作副本也可能在專案切換後回報「請再試一次」。工具列動作現在關閉選單；工作副本準備在 session 切換時按新狀態有限重試，內容同步衝突仍停止。最終版兩次正式專案桌面回歸通過，最後報告 `artifacts/autopilot-desk/existing-project-review-29Lwp1/report.json`：開啟及重開後，內附 Agent 均自動連到目前專案、選取本地 Qwen 且無錯誤；儲存後 9 素材與 10 片段不變；輸出按鈕只提交一次。
- 最終封裝 `artifacts/autopilot-desk/portable-preview-2026-09-30T01-05-52-100Z/AutopilotDesk-Community-Preview.exe`，SHA-256 `fd55cc4e66a674280dca63f5152448a704c8d116e2cb809e72d04d39c07b8f97`，必須保留同層 `resources`。正式專案副本輸出 `artifacts/autopilot-desk/existing-project-review-29Lwp1/review.mp4` 為 48 秒／1440 格／13,066,374 bytes，影片全片解碼成功；有音訊串流，但開頭 1–3 秒約 −20 dB，12–14 秒與 44–46 秒均約 −91 dB。後段目前缺可聽聲音。這是既有專案內容缺口，未完成配音、必要逐字稿或真人審片。
- 系統開檔、存檔及輸出對話框在隔離測試中由固定路徑代入；測試驗證產品 UI 動作與實際儲存、輸出服務，不宣稱 OS 對話框已驗收。封裝仍未附 Whisper 執行器，含語音的 Kit 必要逐字稿流程仍可能阻斷。
- 同一最終封裝的 Agent 側欄回歸 `native-agent-review-OYocWh` PASS；`npm run typecheck`、`npm run source:scan`、工具列聚焦測試 2 項與 `git diff --check` 通過。這個回歸使用隔離模型回應，真實本地模型是否出現在專案側欄由上述正式專案測試核查，沒有讓模型在正式專案執行變更。

## 第四十五輪 Review：可見缺聲區間與啟動序列化（2026-09-30）

- 實際專案的 8–48 秒只有圖片，既無聲音軌片段，也無其他可發聲來源。加入保守的時間軸覆蓋檢查：只在至少 2 秒無可發聲片段時顯示精簡標示，點擊跳至缺口起點並顯示補聲提示；靜音軌、音量 0、停用圖層、圖片不算聲音來源，影片先按可能有聲計算。這項檢查不取代 ffprobe 或實際聆聽，也不阻止有意留白的輸出。
- 初版封裝 `01-17-51` 的隔離桌面測試確認缺聲標示與跳轉，但快速開啟專案時抓到 Agent 舊 session 啟動尚未結束，新專案接著 start 而遭拒；該版未通過。將自動啟動和專案重新綁定串行執行後，最終封裝 `01-21-02` 連續三次 PASS：開啟與重開後 Agent 都綁定當前專案、無啟動錯誤，顯示已選本地 Qwen；缺聲提示可見並跳到 8 秒；儲存不掉素材；48 秒／1440 格影片只提交一次且完整解碼；原專案雜湊未變。最後一次同時檢查 1280×720 沒有橫向溢位且標示完整可見。
- 最終 EXE：`artifacts/autopilot-desk/portable-preview-2026-09-30T01-21-02-640Z/AutopilotDesk-Community-Preview.exe`，SHA-256 `a906c86bf99340932861dcb9b262177128c0c097259baf98b4b5af43985ad6eb`，必須連同同層 `resources` 使用。最終驗收證據保留 `artifacts/autopilot-desk/existing-project-review-EFiikl`；內附報告、畫面及 MP4。封裝 Agent 側欄回歸 `native-agent-review-N26tSJ` PASS。正式配音、Whisper ASR 與真人審片依舊未完成；缺聲標示是防止誤判成片的使用提示。
- 最終 MP4 聲音抽查：1–3 秒平均 −20.0 dB，12–14 與 44–46 秒均為 −91.0 dB，與標示的圖片區域缺聲一致。型別檢查、來源掃描、音訊覆蓋與工具列聚焦測試 5 項、差異空白檢查均通過。Windows 系統檔案對話框仍由隔離路徑代入，沒有把這項驗收擴張成真人審片。

## 第四十六輪 Review：封裝語音辨識與區網模型能力（2026-09-30）

- 官方 whisper.cpp v1.9.2 Windows x64 CPU 套件與固定多語模型加入私人可攜封裝。執行器來源為官方 release，模型來源為 ggerganov/whisper.cpp；模型 190,085,487 bytes、SHA-256 `ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb`。`whisper-runtime-gate.mjs` 的檔案、授權與 CLI 能力檢查 GREEN。執行器與模型不進入公開 source commit，封裝時須與同層 `resources` 一起交付。
- 第一輪真實 WAV 測試在中文專案路徑引發官方 CLI 例外；追查發現 `buildWhisperCliArgs` 會把相對模型名重新轉成絕對路徑。保留模型所在目錄為 `cwd`，模型參數用 ASCII 檔名後，源碼整合測試 `review-community-asr.ts` PASS，產生兩段中文時間碼，約 4 秒完成。
- 封裝端對能力查詢、服務工作池白名單、產品 runtime 閉世界欄位逐層回歸並補齊。最終 `portable-preview-2026-09-30T01-56-30-579Z` 的 `review-packaged-asr.mjs` PASS：讀到 `ready`，同一支 EXE 透過桌面 bridge 對五秒中文 WAV 產生兩段字幕，沒有下載模型；本機粗剪視窗選好片型後可開始。報告在 `packaged-asr-review-qhxfvp/report.json`。內建 Agent 側欄 `native-agent-review-l7cc4v` PASS，連線、模型、輸入與歷史正常。
- 區網 Qwen 現有服務的 `/v1/models` 只列出目前文字模型；文字控制請求回覆 OK。相同中文 WAV 以 `input_audio` 與 `audio_url` 呼叫 chat completions 均回 HTTP 400 `Unexpected item type in content`，audio transcriptions 呼叫回 HTTP 500，無逐字稿。這是此服務目前的實測結果，不推論其他 Qwen 模型或未來配置。現階段本機 Whisper 負責 ASR，Qwen 可繼續處理文字與編劇。
- 可攜 EXE SHA-256 `5b5c22e2fca66b6c830b8c8dbe75fe93b80e24f90f5245fe480af08a42133333`；型別檢查、四組聚焦測試共 36 項及原生 Agent 桌面回歸通過。公開原始碼掃描因工作目錄內有刻意忽略的私人 `vendor` 模型快取而拒絕；以目前 Git 追蹤與新增來源檔複製成乾淨來源樹後，`--scan` 檢查 1359 檔為 GREEN，暫存掃描副本已刪除。未有正式配音素材，也未用正式多片段專案走完 Kit 含語音的 audit／apply／render；本輪成功不代表那段內容已完成或經真人審片。

## 第四十七輪 Review：含語音 Kit prepare 與失敗收束（2026-09-30）

- 使用最終可攜封裝 `02-22-45` 的真實內附 Agent gateway 與 Kit controller，以隔離的五秒中文語音影片走 create→contract→session→prepare→context。來源是合成測試語音加已驗證 Rec.709 色彩標籤的測試畫面；逐字稿 `ready`、兩段中文 cue、prepare 收據 `completed`，下一步為 `keyframes`。原專案與影片雜湊不變，正例報告在 `artifacts/autopilot-desk/kit-voiced-prepare-7VgO5W/voiced-prepare-report.json`。
- 負例使用同一段語音，但影片刻意缺色彩標籤：逐字稿仍 `ready`，三個抽樣影格均因 `unknown-or-incomplete-color-tags` 被拒。原本 Kit 只說「需要關鍵幀」，Agent 的 prepare claim 留在 running；新 Kit `9fcd84691a0a2c2af1b8144ca5b6d4df04d7b0ba` 說明真正原因，Agent gateway 呼叫原 controller 的非重試失敗路徑，run 變 `blocked`、claim 為 null。側欄摘要不顯示私人路徑，指示先確認來源色彩資訊；負例報告在 `artifacts/autopilot-desk/kit-voiced-prepare-Burxa5/voiced-prepare-report.json`。
- 最終 EXE SHA-256 `f832dea6f173aa556448ba378a37b24fb694c0e1dc3b2dda5a959728aad6ab06`；同包 `native-agent-review-vi6gKj` 驗證 Agent 連線、模型、輸入與歷史，`packaged-asr-review-AF8f2q` 驗證桌面 bridge 辨識與粗剪入口。Kit 9 項聚焦測試、兩份 workflow selftest、Editkin 型別與側欄狀態 8 項測試通過。尚未處理正式多片段故事、獨立配音、完整 audit／apply／render 或真人審片。

## 第四十八輪 Review：區網 Qwen 語音辨識重新實測（2026-09-30）

- 從第四十七輪已由本機 Whisper 辨識出兩段中文逐字稿的測試影片擷取 5.108 秒單聲道 16 kHz WAV；用使用者剪輯台已儲存的私人區網設定，對目前清單唯一模型 `qwen3.8-27b-nvfp4` 重跑。探測器只把模型 ID、音訊雜湊、HTTP 狀態及截短的錯誤寫到報告，不記錄位址或音訊位元組。
- `/v1/models` HTTP 200；文字 chat completion HTTP 200，回覆 `OK`。帶相同 WAV 的 `input_audio` 與 `audio_url` 各回 HTTP 400 `Unexpected item type in content.`；`/v1/audio/transcriptions` 回 HTTP 500 `Internal server error`，沒有逐字稿。報告：`artifacts/autopilot-desk/qwen-asr-live-probe-20260930.json`。因此目前這個服務不能作為剪輯台的 ASR；不推論模型權重或其他 Qwen 部署永遠不能處理音訊。
- 現有封裝 Whisper 的正例仍見 `kit-voiced-prepare-7VgO5W/voiced-prepare-report.json` 與 `packaged-asr-review-AF8f2q/report.json`。本輪沒有修改或重啟區網模型服務，也沒有修改使用者正式專案。
