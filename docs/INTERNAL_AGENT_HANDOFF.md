# 內部 Agent 任務交接

預設在 Editkin 的 Agent 視窗交代目標；使用者不需要把外部啟動指令貼給 AI。本機、原生 API、帳號登入與 OmniRoute 來源共用 ACP 對話與原 Editkin MCP 執行器。來源先分供應商，再選模型；登入與金鑰設定留在設定選單。外部 AI 工作階段保留為明確開啟的進階入口。

## 任務與通訊

- ACP 使用 process-local `editkin` profile，固定 system briefing 取自 `agentTaskGuidance.ts`。只開放 `editkin_*` MCP 工具，避免攜入通用檔案編輯、shell、搜尋與技能工具。舊 `build`／`plan` 對話 ID 使用相同受限 profile；模式選單不佔用編輯器畫面。Profile 不寫入共用 provider/auth 設定。
- 每次送出只附目前綁定專案、送出時的選取、小範圍必要提示與準備續接 ID。一般剪輯直接使用原 `apply_edit_commands` 完整 envelope；唯讀問題不建立 workflow。字幕原文有截斷標記，必須讀完整內容才能覆寫。唯一的明確字詞替換可產生精確提示，但仍須模型透過 MCP 執行；提示本身不改檔。
- `get_editkin_task_guidance` 提供 `overview`、`edit`、`autopilot`、`continue`，完整 JSON response 使用保守估算控制在 1,100 token 內。它是工作索引；正式自動剪輯仍讀原 Kit contract、素材證據、當次設計與授權。
- Draft/finish helpers 直接呼叫，不包在 `call_editkin_tool` 裡。Finish helper 自行管理原 Kit plan/audit/apply/render；Agent 不可在外圍手動 claim 同一步。Flow ID 必須原樣取自核對過的 context。格式不合法時先拒絕，回傳 `INVALID_KIT_RUN_ARGUMENT`／`mutationAttempted:false`；只有被污染 ID 的首行與已核對 ID 相同才提供更正提示，不偷偷修正後執行。
- 原後端 schema、專案綁定、來源雜湊、claim、收據、audit、單次 apply 與 human-review 邊界不變。不確定的修改結果先核對状态，不能直接重送；真人驗收不由 Agent 簽署。

## 驗證與限制

聚焦來源測試及封裝原生驗收涵蓋：內部入口／進階外部入口、來源分層、未設定阻擋、原生模型 schema、精確字幕目標、單次修改與 Undo、取消引用、供應商刷新後同一 session、舊模式安全相容及跨專案結果。接續故事驗收只給專案／既有素材證據 run／使用者目標，完整流程由內部 briefing 與工具取得；輸出另經原 Kit receipt 及解碼／像素檢查。

Token 比較使用實際 native HTTP 傳送內容的保守估算，分開記錄 user packet、messages、tool schemas。不是付費帳單，也不代表 cache 命中。原生 device login 的開始／取消與 API fixture 不等於真實各家帳號、額度、續期與推論驗收。

檔案符號連結安全案例在 Windows 無建立權限時明確 skipped；其餘 hardlink／directory-junction 安全檢查照常執行。不得把這個平台限制當作安全驗證全數完成。封裝版是可審查的 community preview；完整多來源語音故事、任意剪輯任務與真人視覺品質仍需逐案驗收。

Runtime 設定參考：[agent prompt 與權限](https://opencode.ai/docs/agents/)、[工具權限](https://opencode.ai/docs/tools/)、[process-local inline config](https://opencode.ai/docs/config/)。

## 上游相容性

與上游 Tauri Rust 2.12.0 對齊既有 JavaScript API 至 2.12.0；未新增套件，保留完整跨平台 lockfile entries。GPU receipt／expectation 的型別直接引用定義模組，避免 Agent desktop API 經 barrel 回接 application/render 形成靜態循環。上游網頁版引擎限制與匯出專案標示保留。
