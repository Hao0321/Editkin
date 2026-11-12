# Kit v4：專案外素材的工作區副本

## 問題與決策

桌面匯入會保留原始影片的絕對路徑。Kit v4 原始 controller 的 `create` 僅接受工作區內的素材，並對檔案內容建立 SHA-256 綁定。直接擴大 Kit 工作區會讓可讀範圍超出目前專案，因此在**目前專案的工作區內**建立經驗證的來源副本；正式專案與原片保持原樣。

本次核對的來源：Editkin `0.15.0`；Kit README `v0.23.0`，乾淨 checkout `a1434c520b2d471fff7744771f01a784d836e1b5`。副本邏輯只在 Editkin 橋接器，沒有修改 Kit checkout。

## 執行契約

1. 內附 Agent 啟動時記錄已綁定專案中存在的外部來源路徑。後來被加入專案的任意外部路徑不能藉由 Kit 建立流程取得讀取權。
2. `run_kit_workflow(create)` 省略 `materials` 時，從目前專案的真實片段推導來源。工作區內來源直接交給 Kit；外部來源計算 SHA-256，在 `.editkin-kit-sources/<fingerprint>/` 複製並比對副本雜湊。副本 manifest 記錄來源、大小、雜湊與相對路徑。同一組來源再次建立 run 時，先重新驗證再重用副本。
3. 外部來源合計大於 64 MiB 時，`create` 立即回傳 `PREPARING` 與 `preparationId`。Agent 用 `source-status` 查雜湊、檢查、複製、驗證階段及估計進度；`source-cancel` 可在 controller 開始前取消，`source-resume` 可在中斷或取消後恢復。只有驗證副本完成，背景工作才呼叫原始 controller；`COMPLETED.result` 是其建立的 run。相同請求會回傳同一工作，不重複建立 run。
4. Kit 原始 controller 只收到工作區內的副本路徑。後續 Editkin 素材分析仍讀正式專案引用的原片；Kit 的素材 receipt 要求兩者 SHA-256 一致。
5. Kit 後續步驟檢查原片是否仍與副本綁定；`apply_autopilot_plan` 與 `render_project` 前會完整重算原片雜湊。來源變更時停下，不套用或輸出另一版內容。
6. 複製前檢查磁碟空間，複製到暫存檔後驗證再改名。已有不完整副本時只重用雜湊正確的檔案；損壞的檔案不會被靜默覆蓋。只清除本次暫存檔與鎖，不自動刪除已建立的來源副本。

程序異常結束若留下鎖，後續準備會拒絕覆蓋該鎖。確認沒有進行中的工作後，才可清理殘留鎖並重試；目前不自動回收鎖，以免與另一個工作競爭時誤刪其鎖。

## 中斷與進度

- 工作紀錄儲存在專案的 `.editkin-kit-sources/jobs/`，記錄原專案雜湊、外部來源大小／修改時間、固定 run ID、階段與結果。Agent 關閉後，準備階段的工作標成 `INTERRUPTED`；恢復時重新確認專案與來源，重算當前檔案的雜湊，已完成且雜湊正確的整檔副本可重用。**不支援單一檔案從中間位元組續傳。**
- 若中斷點落在原始 Kit controller 建立 run 的階段，狀態是 `UNCERTAIN`，回報固定 run ID 供 `status` 查證，不自動重送 create。controller 開始後也不允許取消，以免結果不明。
- 側欄工具卡用白名單階段名稱與估計百分比顯示進度；桌面 Agent 狀態也每秒讀取目前專案的工作紀錄，在輸入框上方顯示一條緊湊進度列。這不需模型反覆呼叫 `source-status`。百分比基於預估的讀、複製、驗證位元組量，不是成片完成率。
- 側欄「停止」在 `PREPARING` 時寫入只屬於目前工作 ID 的取消請求；擁有工作的 gateway 在進度回報及 controller 起始邊界檢查並中止。`CREATING` 後只可停止對話，不能把原始 Kit controller 的結果當成已取消；需按固定 run ID 查證。

## 邊界與待驗收

- 這只打通 Kit 建立 run 與素材分析的外部來源接線。完整語意、計畫、audit、apply、render、成片解碼與真人審片仍須逐步驗證。
- 側欄會自動顯示進度，但 Agent 若要取得已建立的 run 結果並繼續 v4 步驟，仍需呼叫 `source-status`。關閉 Agent 後可恢復整檔工作，但不會從單檔複製的中間位元組續傳。
- 副本會占用專案所在磁碟。為了讓 Kit run 可驗證，不會自動清理；清理前需辨識哪些 run 仍引用副本。
- 實測採隔離合成來源，未改動使用者正式專案或私人媒體。正式素材成片驗收仍未完成。
