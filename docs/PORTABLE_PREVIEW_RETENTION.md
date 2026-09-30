# 可攜預覽版保留與還原

## 第五十八輪：精簡 Agent 封裝與使用中檔案保護（2026-09-30）

最終完整版本為 `14-15-46`，SHA-256 `8d98d30380a640b39314767d29b6c845ef3b5c23089f5ab05f9dff32f5ad950b`；保留同層 resources。最新三版 `14-15-46`／`11-32-55`／`10-29-41`、使用中的 `2026-09-29T16-32-46` 與 16 份原位置 Kit 來源封存保留；本輪四個建置均有完整 125 檔 CAS 還原清單。

已淘汰三個本輪中間版及舊 `09-00-53`，原完整 SHA 備份保留。首次中間版去重碰到另一視窗使用共用檔案，回滾後的暫存 hard link 等檔案未被載入才清除。隨後最終封裝五項固定資源去重成功；一次舊版本刪除又碰到實機驗收使用同一 image，三個中間版已刪、舊版剩 121 檔。驗收退出後逐檔核對完整 125 檔 CAS 及剩餘 121 檔，按精確目標完成刪除。兩份 partial manifest 保留，完成證據分別為 `dedup-temporary-cleanup-round58.json`／`package-prune-final-round58.json`，不把中断記錄改成成功。

維護工具新增共用 executable 的 file ID 保護，避免只看 package 路徑漏掉另一版正在使用的 CAS image；去重 10 項及淘汰／還原 9 項隔離檢查通過。19 項檢查包括使用中 CAS 保護、操作前阻擋、完整 byte-exact 還原与 workflow pin；沒有停止使用者的視窗或 Agent 以解鎖。

九份本輪實機驗收均已退出，刪除 WebView2 快取 102,078,070 bytes，報告／測試專案／截圖保留。另壓縮三個冷 CAS 檔案，GetCompressedFileSizeW 前後差估計 25,900,032 bytes；不是整體磁碟淨增加值，歷史 CAS 未刪除。最終還原清單、來源 tag、整包與流程 SHA、程序引用檢查見 `RESTORE-POINT-20260930-ROUND58.json` 及交接。

## 第五十七輪：共用 Agent 閘道封裝（2026-09-30）

最新三個完整封裝為 `11-32-55`、`10-29-41`、`09-00-53`；使用中的 `2026-09-29T16-32-46` 與 16 個原位置最小 Kit 來源保留。本版 EXE SHA-256 `d2ab821a476f6379a038cb30395fd57e4d10d4bb268b0708e8c4f2ec4cda28c8`，需同層 resources。

本版 125 檔完整備份後，五項固定 vendor 資源去重；最終清單 `portable-resource-dedup-20260930T114114399Z.json` 只含本版，估計 412,135,911 bytes。過期 `08-02-12` 逐檔備份相符、無程序引用後移除，`portable-preview-prune-20260930T114123180Z.json` complete；保守物理回收估計 0.015 GiB，未把整包 0.44 GiB 或共享資源重複計入。

新增一個冷 CAS 物件壓縮，`cold-recovery-compression-20260930T114130304Z.json` complete，儲存差估計 8,606,208 bytes；bytes／SHA／file ID 保持。五份已完成驗收的 WebView2 快取共 55,710,263 bytes 清除，`review-cache-prune-20260930T115302288Z.json` complete；只移除本輪公開來源研究暫存 1,172,809 bytes，固定 commit 與研究摘要保留。歷史 CAS 仍有 rollback 引用，沒有刪除，也沒有宣稱磁碟淨空間增加。所有 package／CAS／Kit 雜湊及程序驗證，見 `RESTORE-POINT-20260930-ROUND57.json`／本輪交接；報告、專案、截圖與原素材保留。

## 第五十六輪：Agent 多供應商封裝與清理（2026-09-30）

最新三個完整封裝為 `10-29-41`、`09-00-53`、`08-02-12`；使用中的 `2026-09-29T16-32-46` 及 16 個原位置最小 Kit 來源保留。最終 EXE SHA-256 `8b7bc1ed87c0740f49b8c99488b5b3977fa695b14e4a97b35ce6150d24517b02`，需同層 resources。

本版完整備份後五项 immutable vendor 資源去重，最終可還原清單 `portable-resource-dedup-20260930T103259950Z.json` 只指向本版。早先混合去重清單含已退休中間版，不能直接拿它宣稱最終資源獨立還原。兩份 prune 清單 `101607977Z`／`103307264Z` 共移除五個過期／中間完整包，先核對逐檔 CAS 備份與程序引用；最後 link／不同 recovery file ID 的物理回收估計分別 0.428／0.796 GiB。

本輪初版與最終版 vendor 去重各估計 412,135,911 bytes，冷備份新增 3＋2 個物件壓縮，前後儲存差估計 25,812,992＋17,224,704 bytes；清單 `cold-recovery-compression-20260930T101622231Z.json`／`cold-recovery-compression-20260930T103318036Z.json`。bytes／SHA／file ID 保持，原還原工具可透明讀取。這些都是估計，沒有量測整顆磁碟淨空間增加，也沒有刪除歷史 CAS。

測試時 Windows 留下兩個指向已退出中間版的防火牆通知。精確比對 binary、PID、建立時間及命令後只關閉該兩個通知；最終切換 native device auth，沒有更動 firewall rules。七份已完成的 WebView2 快取在原生 PID 與引用為零後按精確名稱清理，`review-cache-prune-20260930T104318490Z.json` complete，共 78,880,095 bytes；報告、專案、截圖與素材保留。實際總量、程序樹及完整 package／CAS 雜湊驗證以 `RESTORE-POINT-20260930-ROUND56.json` 和本輪交接為準。

## 第五十五輪：可逆冷備份檔案壓縮（2026-09-30）

最終完整封裝保留 `09-00-53`、`08-02-12`、`07-04-09` 與使用中的 `2026-09-29T16-32-46`。最終 EXE SHA-256 `1275897832ab663fa4fd6bc8ae93f3654a94d05d38e02805c3617762d857bc6b`，需同層 resources；16 个原位置 Kit 來源封存仍保留。

新增 `compress-cold-preview-recovery.ps1`，dry-run 先盤點；`-Apply` 只壓縮有歷史清單引用、未被最新三版／使用中版本／Kit 來源保護、只有一個 hard-link 的 ≥1 MiB CAS 檔案。每個檔案先驗 SHA／file ID／link count 與程序引用，落 manifest，再用 Windows compact `/C`，確認 bytes／file ID 不變且壓縮旗標存在，計算 GetCompressedFileSizeW 前後差。沒有對目錄／整個磁碟套用壓縮，也沒有刪除舊 CAS。

`cold-recovery-compression-20260930T085058520Z.json` complete／40 物件／295,673,965 bytes；`cold-recovery-compression-20260930T090813739Z.json` complete／1 物件／8,606,208 bytes，合計 304,280,173 bytes 的儲存差估計。原全包 recovery manifests、16 个 source archive marker 與原 restore 工具契約不變。九項隔離測試包括最新三版、共享／程序引用保護、完整套件還原、解壓還原、壞物件及越界拒絕。

已用原 `restore-portable-preview.ps1` 真正還原 `05-04-35` 的 125 檔並跑 desktop ASR PASS，隨後清除該測試副本；這段重建後再刪除的暫存空间不計入本輪淨回收。過期 `05-40-33` 與中間 `08-35-49` 逐檔備份相符後移除，最終和中間封裝固定 vendor 去重，驗收快取按精確目錄清理。

`review-cache-prune-20260930T092410186Z.json` complete：本輪十份已完成的 WebView2 快取共 133,067,039 bytes 已清除，報告與專案保留。清理器對有完整原生 EXE 路徑證據的報告辨識 Windows PID 重用，仍保護同名原生程序與所有驗收根目錄引用；缺少 executable 的舊報告保留保守 PID 保護。七項隔離測試通過。實際廣泛回歸報告的舊 PID 一度被 svchost 重用，未停止它；該 PID 自然消失並重查所有引用為零後才完成清理。

解除冷 CAS 壓縮：`restore-cold-preview-recovery.ps1 -Manifest <對應 cold-recovery-compression 清單>`，拒絕 bytes／file ID 改變、成為共享物件或被程序引用的檔案。正常全包還原不必先解壓。原生語意依 [Microsoft compact 文件](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/compact) 與 [GetCompressedFileSizeW 文件](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getcompressedfilesizew)。

壓縮保留歷史全包資料，尚不是有界歷史保留政策；下一輪需按使用者「最新幾版」要求建立準確的到期／来源保留契約。精確總量、程序、還原 tags 及證據見本輪交接與 `RESTORE-POINT-20260930-ROUND55.json`。

## 第五十四輪保留與備份重用（2026-09-30）

最新三個完整封裝為 `08-02-12`、`07-04-09`、`05-40-33`；使用中的 `2026-09-29T16-32-46` 及 16 個原位置 Kit 來源封存保留。EXE SHA-256 `05585c96237112f6a25eae3912e3b51518d1bcb084c5b36b7a02fdb7012687eb`，需同層 resources。

`prune-portable-previews.ps1` 原先遇到已存在的 recovery manifest 就拒絕；本輪淘汰 `05-04-35` 時重現，partial 清單没有刪除目標。現在既存清單的 schema、name、唯一完整 paths、SHA 與 bytes 全部相符才重用，清單本身不重寫；刪除前再次檢查備份 SHA 與實際檔案 bytes。八項隔離測試通過，相符清單淘汰後仍能逐位元還原，不符清單保留套件。

本版五項固定 vendor 資源去重，完整 package manifest 保留。盤點腳本 `review-preview-recovery-inventory.ps1` 只讀，報告指出原 35 份清單、415 個物件約 1.95 GiB；其中 1.42 GiB 冷資料仍有歷史還原引用。這不是可丟棄快取，本輪未刪 CAS，沒有更改 16 個來源封存的完整還原承諾。按最新三版與運行中版本保護引用，後續需驗證可讀冷存還原及有界保留契約。

每輪實際清理量、manifest、程序樹與還原點以本輪 `HANDOFF-20260930-ROUND54.md`／`RESTORE-POINT-20260930-ROUND54.json` 為準。原始專案、逐字稿、workflow receipts、截圖和報告保留；只有可再生快取及已備份的過期完整版移除。

## 第五十三輪保留、清理與還原（2026-09-30）

最新三個完整版為 `07-04-09`、`05-40-33`、`05-04-35`；使用者執行中的 `2026-09-29T16-32-46` 保留，16 個原位置最小 Kit 封存不變。最終 EXE SHA-256 `566d1e5da67a26c0808328e359c25bc05972139e33e0965eaaf2afc8b62b3144`，需同層 resources。

- 本版及前版整包備份已逐檔驗證：`portable-preview-recovery/portable-preview-2026-09-30T07-04-09-703Z.json` 與 `portable-preview-recovery/portable-preview-2026-09-30T05-40-33-501Z.json`。來源還原點為 `restore/round53-before` 與 `restore/round53-accepted`；實際 commit、SHA 與指令在 `RESTORE-POINT-20260930-ROUND53.json`／`HANDOFF-20260930-ROUND53.md`。來源不作強制 reset，還原工具拒絕執行中或已變動目標。
- `portable-resource-dedup-20260930T071907368Z.json` complete：本版五種固定 vendor 資源全部去重，估計回收 412,135,911 bytes（0.384 GiB）；125 個封裝檔案 hash 全相符，`resource-dedup-acceptance-round53.json` PASS。此清單只包含仍保留的本版，能直接用 `restore-portable-resources.ps1 -Manifest` 建立獨立副本。去重後 `agent-binding-review-H30Be4` 的實際啟動／忙碌回合／自動續接／小視窗提示驗收再次 PASS。
- round50 的 `04-23-43` 已先做完整 CAS 備份，確認無 Kit workflow 或程序綁定後移除；`portable-preview-prune-20260930T071915576Z.json` complete。按最後 hard-link、非 compressed/sparse 與不同 recovery file ID 保守估計回收 0.015 GiB；沒有把整包 0.44 GiB 都當作已回收。
- 十份本輪完成測試 WebView2 快取共 108,254,855 bytes 已清除；清單 `review-cache-prune-20260930T071926570Z.json` 九份、`review-cache-prune-20260930T072546559Z.json` 一份，均 complete。報告、專案、兩張 1280×720 截圖與原素材保留，快取可重建。新增精確 allowlist prefix `agent-binding-review`，清理保護五項測試 PASS。
- `process-cleanup-round53.json` PASS：十個驗收 EXE 及狀態引用程序為零，本版所有 executable／commandline 資源引用程序為零。使用者原 EXE PID 84520 → Node PID 87964 → OpenCode PID 88188 正常程序樹保留；其他工作未停止。合計估計回收約 0.50 GiB。

CAS 唯讀盤點有 415 個物件、約 1.95 GiB，包含歷史整包 rollback，尚需依最新還原點及 Kit workflow 引用閉包建立有界保留策略；現存最小 Kit 的 marker 仍宣告可整包還原，在調整該契約前不刪其 recovery objects。

## 第五十二輪保留、封存與還原（2026-09-30）

目前完整可執行版保留最新三版 `05-40-33`、`05-04-35`、`04-23-43`，以及使用者仍執行的 `2026-09-29T16-32-46`。最終 EXE SHA-256 `99528cba96e1f8e1a28bcb95b9884be670b8a84e2d6b7d3f7173949b4263d6f1`。其餘 16 個舊目錄只有原位置 `resources/video-autopilot-kit` 與封存 marker，沒有可執行 EXE。下列歷史「保留整版」敘述是當輪紀錄，以此輪狀態為準。

- `compact-portable-resources.ps1 -Names <明確版名>` 先盤點；`-Apply` 才共用五種固定 vendor 檔案。限定本機 NTFS、regular 路徑與 SHA 相同，保護所有引用套件的執行程序。Windows literal hard-link 支援方括號字型；替換前保留原檔，核對 bytes 與 file ID 後才退休備份。編輯器程式、Kit、workflow、專案與媒體不共用。vendor 檔案必須維持不可變，OpenCode auto-update 已停用；需要獨立檔案時先執行還原。
- `restore-portable-resources.ps1 -Manifest <去重清單>` 從已驗證 CAS 以獨立副本還原，不改其他套件。支援中斷替換與缺 target 的恢復。實際最新包的方括號字型已完成獨立還原、hash/linkcount 核對及再次去重；九項隔離測試 PASS。
- `backup-portable-preview.ps1 -Names <明確版名>` 建立整包檔案清單與 hash CAS，拒絕異常路徑／秘密檔案及不同的既存備份。round51 與 round52 完整備份已驗證，供本輪還原點使用。
- `archive-pinned-previews.ps1 -Keep 3` 先盤點；`-Apply` 在完整備份後移除舊 Kit 綁定包的執行部分，保留來源原路徑與 SHA，workflow bytes 不變。首輪遇使用中 hard-link binary 拒絕刪除；程序正常退出後沿原備份續接，16／16 完成，沒有強制解鎖。六項測試含完整獨立還原及中斷封存續接；真實舊 run 的原 controller status 也通過。
- 整包還原使用 `restore-portable-preview.ps1 -Manifest <portable-preview-recovery/版名.json>`；若目標是已完成最小 Kit 封存，需明確加 `-ReplaceKitArchive`。驗證 marker、保留來源與 CAS 後，以獨立 stage 取代原目錄；被程序引用時拒絕。既存完整目錄不覆寫，先使用保留的完整前版即可回退。

清單 `portable-resource-dedup-20260930T054354990Z.json` complete：86 個資源、81 次替換，估計回收 **4.814 GiB**；`resource-dedup-acceptance-round52.json` 確認 20 包／2,416 檔案 hash 相符。`pinned-preview-archive-20260930T060459052Z.json` complete：16 包封存。一般清理清單 `portable-preview-prune-20260930T060552917Z.json` 移除舊 round49 一包；它使用舊 logical-byte 回收統計，去重後不能把其 0.399 GiB 再加入物理回收量。清理器已改按不同 file ID、最後一個 hard-link 與非 compressed/sparse 檔案保守估算，封存刪除的其他收益也未重複計入。

四份本輪完成的測試快取回收 43,730,246 bytes，清單 `review-cache-prune-20260930T062050313Z.json` complete。後續盤點 131 份歷史／最後回歸快取，其中 129 份核對已完成報告及無程序引用後清理，回收 1,467,470,494 bytes；`review-cache-prune-20260930T063127780Z.json` complete，實際重查 129 個 cache 均不存在。兩份的報告 PID 現在被 Code／Edge 使用，保守保留，未停止這些應用。快取可重建，報告／專案／媒體保留。

本輪五個測試 EXE 及其隔離狀態引用程序均退出，範圍內額外 bundled Agent 為零；使用者原 EXE／Node／OpenCode 的有效程序樹保留，見 `process-cleanup-round52.json`。去重及快取合計估計約 6.22 GiB，未另加舊版封存／刪除的收益。CAS 包含既有完整還原資料，不能以「舊檔」直接清空；後續應以還原點與現存 workflow 引用盤點無引用物件。本輪 `RESTORE-POINT-20260930-ROUND52.json` 記錄前後 Git tag 與兩份完整封裝備份的已驗證 SHA 清單；還原操作見 `HANDOFF-20260930-ROUND52.md`。

## 第五十一輪保留與清理（2026-09-30）

保留最終 `portable-preview-2026-09-30T05-04-35-322Z`，EXE SHA-256 `8aa9abc3da0d8bd7589d4031d51e593aee00aba0e6b752d4f2fb5b772e3b3eab` 及同層 `resources`。真實模型字幕驗收 `agent-caption-live-Ajap6o` 和固定回應驗收 `agent-caption-review-UB0FAI` PASS。

新增 `scripts/prune-review-caches.ps1 -Names <精確驗收目錄名稱>` 唯讀盤點；加 `-Apply` 才刪指定驗收的 `webview2`。要求已完成報告與 appPid，拒絕仍存在的應用 PID、命令列仍引用該驗收目錄的子程序、越界路徑及 reparse points。刪除前重查程序、快取檔案數／bytes 與報告 SHA；manifest 在刪除前落檔並逐項更新。快取可由驗收腳本再生，報告、專案、媒體與其他 app data 保留。隔離測試包含執行中 PID、未完成報告、越界拒絕、dry-run 與只清快取保留證據五項 PASS。

清理中間版 `04-52-23` 一份，去重備份與 SHA 驗證後移除，保守回收 0.399 GiB；清單 `portable-preview-prune-20260930T050913825Z.json` complete。七份驗收快取回收 97.56 MiB，清單 `review-cache-prune-20260930T050906157Z.json` complete。另外唯讀盤點後移除三個所有檔案均超過 24 小時、且無 Cargo／Rust 編譯程序的增量快取，回收 88.42 MiB；`build-cache-cleanup-round51.json` complete，保留最新編譯快取與套件，舊增量快取可從來源重建。合計保守估計 0.58 GiB，未刪被原 Kit run 引用的封裝及還原物件。

## 第五十輪保留與清理（2026-09-30）

保留最終 `portable-preview-2026-09-30T04-23-43-950Z` 與同層 `resources`，EXE SHA-256 `f1aedde04835c7ac4093ff7da1a247b97dbd59432b2f8477d860be0e2ccc45af`。校對、存檔、輸出、IME 與 Ctrl＋S 驗收 `caption-correction-review-JD897v`，Agent 回歸 `native-agent-review-Psx6g4` 均 PASS。前輪 `03-39-18` 與 17 個仍被原 Kit run 綁定的版本繼續保留。

本輪兩個中間封裝 `04-08-51`、`04-14-50` 在確認無 Kit 綁定及執行程序後，各經去重備份、雜湊驗證再清理。清單 `portable-preview-prune-20260930T042057970Z.json`、`portable-preview-prune-20260930T042909570Z.json` 均 complete；保守回收估計各 0.399 GiB，合計 0.798 GiB，不把獨有還原物件算作已釋出。

清理本輪 8 個已退出的隔離驗收 WebView2 快取，回收 138.75 MiB；清單 `review-cache-cleanup-round50.json` complete。每個驗收的報告、專案與媒體仍保留，瀏覽器快取可由腳本重建。原使用者 EXE 與內建 Agent 及其他工作不納入停止或刪除範圍。

## 第四十九輪保留與還原驗收（2026-09-30）

新版 `portable-preview-2026-09-30T03-39-18-306Z` 已完成桌面 ASR、Agent、匯入與輸出回歸，EXE SHA-256 `469198a4794ddf632fa8799f8405bc0b7968a01cdf75206a4fe30971702c5809`。保留同層 `resources` 及 `packaged-asr-review-xLL2jt`、`native-agent-review-SPfg0P`、`editor-project-review-TiAdh1`。原含語音 Kit 成片與工程證據 `kit-voiced-prepare-IaRWnn` 也保留，真人審片仍 pending。

盤點 29 版；自動保護 17 個仍由 Kit workflow 綁定的舊版，以及使用者正在執行的 `16-32-46` 版。指定淘汰未使用的 `02-45-59` 中間版後，移除 11 版，原檔案合計 3.19 GiB；獨有還原資料 0.485 GiB，保守估計回收 **2.705 GiB**。清單 `portable-preview-prune-20260930T034447077Z.json` 狀態 complete、已刪 11／11。另有首次清理中止的 partial 清單，因方括號字型檔名被 PowerShell 當 wildcard，當時未刪除任何目標；修正後才完成上述清理。

實際將 `02-45-59` 版從還原清單復原到隔離目錄，驗證 131 個檔案全部 SHA-256 相符，再清除該測試副本。證據 `recovery-round49-report.json` PASS。三份本輪桌面驗收 EXE 的 PID 45200、115496、124832 均已退出；使用者原有 EXE PID 84520、其 Node PID 87964 與 OpenCode PID 88188 仍屬正常父子程序鏈，繼續保留。沒有停止其他 OpenCode 或 GPU 工作。

日期：2026-09-29。範圍僅限工作區 `artifacts/autopilot-desk/portable-preview-*`，每個目錄包含一個可攜預覽 EXE 及同層 `resources`。

## 規則

- 保留按目錄時間戳排序的最新 3 版；可用 `-Discard` 指定已知失敗的實驗版，讓保留名額留給可用版本。正在執行的套件程序，以及所有保留 Kit workflow 的 `governance.skill_path` 所在版本都自動保護，明確 `-Discard` 也不能繞過。
- 清理前先用 `scripts/prune-portable-previews.ps1 -Keep 3` 唯讀盤點。加 `-Apply` 才會移除舊封裝目錄。`-Discard` 只接受已存在且名稱完全符合規則的預覽目錄；每個待刪目錄都驗證絕對父目錄與連結屬性。
- 真正刪除前，在同一產物根目錄寫入 `portable-preview-prune-*.json`，記錄保留版、待刪版、每版大小、檔案數及 EXE SHA-256。每刪一版更新清單，最後驗證保留版的 EXE 和 `resources`。
- Git 保留原始碼與建置腳本，可從相應提交重建功能版本；清單保留已刪 EXE 的辨識資料。重新建置不保證逐位元產出相同二進位。最新 3 版保留為直接回退選項。
- 自第四十九輪起，每份待清封裝先保存 `portable-preview-recovery/<版本>.json` 及 SHA-256 定址物件。與保留封裝相同的 immutable 資源採 NTFS hard link 共用；不同檔案也保留原 bytes。寫入且驗證還原清單後才刪除目錄，刪除前重新盤點程序與 workflow。hard link 不得當成可修改的工作副本。
- 還原命令：`powershell -NoProfile -File scripts/restore-portable-preview.ps1 -Manifest <還原清單絕對路徑>`。先驗證所有物件、SHA 與路徑，再以獨立複本建立 EXE/resources；拒絕覆蓋現存目錄或越出 artifact root。舊清理清單若沒有 recovery manifest，仍只能從 Git 重建，不能宣稱逐位元還原。
- `reclaimedGiB` 是扣除獨有還原 bytes 後的保守回收估計，不把保留在還原區的獨有 EXE 算成已釋出。還原區屬於必要復原資料，本輪不清除它。

## 本次盤點

施工前有 75 個預覽目錄，總計約 13.97 GiB。未將 `native-agent-review-*` 測試證據或其他產物列入刪除範圍。

新版完成並驗證後共有 77 個預覽目錄。實際刪除 74 個，刪除檔案大小合計約 **13.71 GiB**；當時只剩最新 3 版，合計約 0.77 GiB。沒有正在執行而需額外保留的舊版。

保留版本：

1. `portable-preview-2026-09-29T08-43-28-309Z`，本輪最終驗證版，EXE SHA-256 `db07d3d1cf648f78ffcf26e091e053c9e4ff187912f92fa1df670064d684ac83`。
2. `portable-preview-2026-09-29T08-41-17-390Z`，本輪 UI 第一版。
3. `portable-preview-2026-09-29T08-30-54-492Z`，前輪已驗證版。

刪除清單：`artifacts/autopilot-desk/portable-preview-prune-20260929T084638813Z.json`。狀態為 `complete`，記錄 74／74 目錄均已刪除，並記錄清理時的 Git 提交 `e2ff7712d9a420894759b6d5c35909c97c11b1d0`。清理後重新核對只有上述 3 個預覽目錄，最新 EXE 雜湊相符且同層 `resources` 存在。測試報告、素材與其他產物未納入這次刪除。

## 第十四輪後續整理

工具卡修正時建立了 4 個新預覽，最後一版已通過桌面測試。其中 `08-54-45` 與 `08-57-43` 兩版含已撤回的 gateway 標記，列入 `-Discard`。唯讀盤點顯示共 7 版、預計刪除 4 版，沒有正在執行的預覽版。實際刪除 4 版、釋出約 **1.02 GiB**，其餘產物未動。

當時保留的 3 版為 `portable-preview-2026-09-29T09-07-25-897Z`（該輪最終驗證版）、`portable-preview-2026-09-29T09-03-10-324Z`（前一個通過桌面測試的版本）與 `portable-preview-2026-09-29T08-43-28-309Z`（前輪通過版本）。清單 `artifacts/autopilot-desk/portable-preview-prune-20260929T090923021Z.json` 狀態 `complete`、已刪 4／4，記錄施工提交 `a4d0aad498eea517e40e5c710d812bd3095db769`。清理後核對僅剩上述 3 個目錄，該輪最新 EXE SHA-256 為 `b5297c0497a50b6c43ab6370816b09270ee0f73b55a2ba48c6a22498f13308a7`，同層 `resources` 存在。

## 第十五輪後續整理

可播放示範素材修正後共有 5 版。`portable-preview-2026-09-29T09-15-59-370Z` 的素材仍位於 Agent 工作區外，列入 `-Discard`；另有一個較舊預覽超出 3 版保留額。唯讀盤點顯示沒有正在執行的預覽，預計刪除 2 版、約 0.51 GiB；實際刪除 2／2，清單 `artifacts/autopilot-desk/portable-preview-prune-20260929T092301789Z.json` 狀態 `complete`，記錄提交 `2424eab`。

目前保留 `portable-preview-2026-09-29T09-20-28-871Z`（示範影片可預覽的最終版）、`portable-preview-2026-09-29T09-07-25-897Z`、`portable-preview-2026-09-29T09-03-10-324Z`。最終版 EXE SHA-256 為 `866f3c36d9470adf1f3fc5cf98392192f1d9515dd2dfb64e05e6c6173766b404`，同層 `resources` 必須保留。

## 第二十三輪後續整理

大型來源工作與側欄進度完成後，唯讀盤點找到 5 個可攜預覽版本，沒有正在執行的預覽。依最新 3 版保留規則清理 2 版，釋出約 0.51 GiB；manifest 為 `artifacts/autopilot-desk/portable-preview-prune-20260929T114253858Z.json`。保留 `11-42-13`（最終驗證版）、`11-37-13`（上一個驗證版）及 `11-19-28`（前輪驗證版）。最終 EXE SHA-256 `758bd7eb613a955a0b376abec61df7672baa2632b6cb6754b754e7cf79120153`，其同層 `resources` 必須保留。

## 第二十四輪後續整理

側欄自動進度與跨程序取消完成後，先唯讀盤點確認共 5 版、沒有執行中的預覽、預計刪除 2 版約 0.51 GiB。實際清理結果為 2／2，清單 `artifacts/autopilot-desk/portable-preview-prune-20260929T115802345Z.json` 狀態 `complete`；只有預覽目錄被清理，桌面測試報告與素材產物未納入。

目前保留 `portable-preview-2026-09-29T11-54-40-995Z`（本輪最終驗證版）、`portable-preview-2026-09-29T11-51-34-231Z`（本輪上一個驗證版）及 `portable-preview-2026-09-29T11-42-13-713Z`（前輪驗證版）。最終 EXE SHA-256 為 `c7a3fa5e298a1f88cb98223063bd9425160198ce01dc73481df18aa56d8566fa`；三版的 EXE 與同層 `resources` 均已核對存在。

## 第二十五輪後續整理

接續入口驗證後唯讀盤點共 5 版、沒有執行中的預覽；按最新 3 版規則刪除 2 版約 0.51 GiB。manifest `artifacts/autopilot-desk/portable-preview-prune-20260929T121426248Z.json` 狀態 `complete`，已刪 2／2。修正指令輸入的邊界後又封裝最終版，唯讀盤點共 4 版、沒有執行中的預覽；manifest `artifacts/autopilot-desk/portable-preview-prune-20260929T121746125Z.json` 狀態 `complete`，再刪 1 版約 0.26 GiB。

目前保留 `portable-preview-2026-09-29T12-16-27-517Z`（最終驗證版）、`portable-preview-2026-09-29T12-11-30-721Z`（上一個驗證版）及 `portable-preview-2026-09-29T12-06-51-984Z`（更早的驗證版）。最終 EXE SHA-256 `f86857e39eaaac24a8dbe9dcfc88737702a40f343f4f8af826a02e5b2b45f496`；三版 EXE 與同層 `resources` 必須保留。桌面與 Kit 測試報告不在刪除範圍。

## 第二十六輪後續整理

新可攜 EXE 完成原 Kit 合成片 `plan → audit → apply → render` 與桌面回歸後，唯讀盤點共 4 版、沒有執行中的預覽；按既有最新 3 版規則刪除 1 版約 0.26 GiB。manifest `artifacts/autopilot-desk/portable-preview-prune-20260929T124027597Z.json` 狀態 `complete`。目前保留 `12-38-57`、`12-16-27`、`12-11-30` 三版；最新 EXE SHA-256 `271d873bafe5d2a222a1c4b9064059c3463a025c2075e4d04030858616c4b078`，同層 `resources` 保留。

## 第二十七輪後續整理

新可攜 EXE 的 Kit 計畫索引與側欄通過封裝 gateway、桌面回歸後，先 dry-run 確認共 4 版、沒有執行中的預覽，僅 `12-11-30` 為待清理版本。依既有最新 3 版規則刪除 1 版約 0.26 GiB，manifest `artifacts/autopilot-desk/portable-preview-prune-20260929T131716991Z.json` 狀態 `complete`。保留 `13-14-50`、`12-38-57`、`12-16-27` 三版；最新版 EXE SHA-256 `0276be49d8514966f7d0b8a62ccf323c9a7437835dcb2dde43078e38f4510117`，同層 `resources` 必須保留。

## 第二十八輪後續整理

隔離 Kit run 的治理資訊仍綁定 `12-38-57` 版技能檔，故清理時保留它以維持原 run 可驗證。先 dry-run 確認 7 版、沒有執行中的預覽，指定淘汰中間的三個過渡版後，保留最新 `14-21-45`、上一個 `14-12-29` 與綁定版 `12-38-57`。實際刪除其餘 4 版約 1.02 GiB，manifest `artifacts/autopilot-desk/portable-preview-prune-20260929T142402317Z.json` 狀態 `complete`。最新版 EXE SHA-256 `ee59aa0578b8acc16cb6a9f3154e30a10447fa875c3b51036ab1de4b428f5197`，同層 `resources` 已由清理腳本驗證。

加入封存前計畫解析後，再產出 `14-28-30` 版。唯讀盤點 4 版且沒有執行中的預覽，刪除 `14-12-29` 一版約 0.26 GiB；manifest `artifacts/autopilot-desk/portable-preview-prune-20260929T143032514Z.json` 狀態 `complete`。目前保留 `14-28-30`（最新版）、`14-21-45`（上一版）與仍被 Kit run 綁定的 `12-38-57`。最新版 EXE SHA-256 `865d2715b4bc24b109b071fc5880a86b4851268ad98119eb12d5a3cc5e4853ad`。

## 第三十輪後續整理

新的單片段起稿版完成合成素材的 Kit 全流程及桌面 smoke 後，唯讀盤點有 5 版、沒有執行中的預覽。`12-38-57` 與 `14-28-30` 仍由隔離 Kit run 綁定，故指定清理 `14-21-45` 與 `14-51-29` 兩個過渡版；dry-run 核對只涉及這兩個目錄後執行，釋出約 0.51 GiB。清單 `artifacts/autopilot-desk/portable-preview-prune-20260929T152406328Z.json` 狀態 `complete`。保留 `15-20-29`（最新驗證版）、`14-28-30` 與 `12-38-57`；最新版 EXE SHA-256 `02635f1fee4eafea03c19f1c6c15c144dc42e92689fe4c64c07a443b5463063a`，須保留同層 `resources`。

工具發現指引修正後又產出 `15-31-50` 版；新版封裝起稿、重複起稿拒絕、桌面 smoke 通過。再次唯讀盤點共有 4 版，均為最新或仍由 Kit run 綁定；`-Keep 4` 顯示待清理 0 版，故未刪除。最終版 EXE SHA-256 `258d5e1c16f67966882da008537645494d802e7d3dfc24da9a8de962014e5d71`，同層 `resources` 必須保留。

## 第三十一輪保留狀態

加入單片段完成工具後產出 `15-44-02` 版。此前 `12-38-57`、`14-28-30`、`15-20-29`、`15-31-50` 均仍被保留的 Kit 驗收 run 綁定；新版 `15-44-02` 亦綁定本輪驗收 run。這五版應保留同層技能檔與 `resources`，以維持原 controller 的治理來源可核查。新版 EXE SHA-256 `8bde2ffb6a5d0a5b1445ed9a3ab1482b3b8dd64017ca610b9438cad1f53c4943`。本輪沒有刪除預覽；待舊 run 完成封存策略後再清理。

## 第三十二輪保留狀態

`16-03-32` 版內附 Kit 技能已由隔離裁切 run `kit-bound-create-T5nCdp`、`kit-bound-create-QUUS7e` 及單片段回歸 run `kit-bound-create-aAR0xS` 綁定。這些 run 的治理驗證仍依賴該版 `resources`，不得直接刪除。此前五版同理仍有保留中的 run；因此超過「最新三版」規則時以治理來源完整性優先。清理必須先解決對舊技能路徑的引用，且經 dry-run 核對後才能進行。

最終 `16-09-49` 版也由 `kit-bound-create-5Ftdh5` 綁定，EXE SHA-256 `0e0947a1dc70fcb2ead948885a02e00cf0ca996b9d2a6235d4a1e381b222b066`。本輪沒有刪除預覽；各 run 的來源治理可追溯性優先。

影格時間核對加強後的最終 `16-12-50` 版由 `kit-bound-create-IWpE2V` 綁定，EXE SHA-256 `3589f7302244958ebcce721040b6a4b9b79898e4be6c39af4af13d4e9ed0e393`。目前八版均有保留中的 Kit 驗收 run；沒有直接刪除任何治理來源。

## 第三十三輪保留狀態

`16-32-46` 版的內附 Kit 技能與 gateway 已由雙來源驗收 run `kit-two-source-2IWks6`、`kit-two-source-II2nY1` 綁定；後者使用內附 OpenCode Agent 接區網 Qwen 完成輸出。EXE SHA-256 `9a20360a617c758b9675da4f9b0e84eed36fddddb40e79aa05af5946f72f7b1f`，同層 `resources` 必須保留。此前八版仍由既有 run 綁定，目前沒有安全的直接刪除清單；本輪沒有清理預覽。

## 第三十四輪保留狀態

`18-32-53` 版的內附 Kit 已由選取圖片完整驗收 run 與真實專案副本證據 run 綁定；EXE SHA-256 `7fa1f922bce09d8660d93174a382d66590455d6b3833e4bb63e220ee223499fd`。保留整個 `portable-preview-2026-09-29T18-32-53-778Z` 目錄與 `resources`。此前版本仍有來源治理綁定，本輪沒有清理舊版。

最終 `18-36-40` 版內附 Kit 另由 `kit-selected-image-SpdciD` 與 `kit-selected-image-7c7tjb` 綁定，桌面側欄回歸也通過；EXE SHA-256 `a3eac62723dfbff424b929c531f90be23e2eea63e1bcde4647f8f026ab909d8b`。兩個本輪預覽均有驗收來源依賴，未直接刪除。

## 第三十五輪保留狀態

`18-48-27` 版新增專案圖片逐字稿策略的自動綁定，已由 `kit-mixed-project-1YO6rC` 全專案 create 與 `kit-selected-image-iP8S93` 合成完整輸出 run 綁定。EXE SHA-256 `14871c3dd1fa91f221507900c57545849b7a4230016beb0d9407f85f4c710036`；需保留整個 `portable-preview-2026-09-29T18-48-27-905Z` 目錄與 `resources`。本輪沒有清理受既有 run 綁定的版本。

## 第三十六輪保留狀態

`19-04-08` 版內附 Kit `66b83f3`，已由 `kit-selected-image-8crDXK` 的完整合成圖片驗收 run 綁定；EXE SHA-256 `49cb4c2a02826abc73d77a3f3d4b595cacca15c20c6ab46f5d64082b529222aa`。保留整個 `portable-preview-2026-09-29T19-04-08-901Z` 目錄與 `resources`。先前 `18-48-27` 版仍是全專案隔離 run 的治理來源，本輪未清理這些已綁定版本。

## 第三十七輪保留狀態

`19-11-41` 版內附 Kit `4d337b0`，由 `kit-required-transcript-73z4En` 失敗釋放驗收 run 與 `kit-selected-image-qIkbPF` 完整圖片驗收 run 綁定；EXE SHA-256 `aed010e0bf96b8e03555fb647e73cda93fba965731e7fc9badfeb4da59294c88`。保留整個 `portable-preview-2026-09-29T19-11-41-103Z` 目錄與 `resources`。此前版本仍由各自 run 的治理資訊綁定，本輪未清理。

最終 `19-13-57` 版加強失敗理由的單行處理，內附 Kit `4d337b0` 已由 `kit-required-transcript-kxRZZN` 綁定，EXE SHA-256 `09f229f7507a39cfb5056dac97313d889abfa7dfb1cd94b44ad52cbadc223e5a`。保留整個 `portable-preview-2026-09-29T19-13-57-509Z` 目錄與 `resources`；此前驗收版仍需保留其各自綁定的治理來源。

## 第三十八輪保留狀態

`23-26-22` 版新增側欄的逐字稿阻斷呈現，已由桌面 UI smoke `native-agent-review-WhSAu9` 驗證；EXE SHA-256 `0a8d2ea1fd4ee70c7a9e872d065605fafdaa4637f3aa74be0c43a3aba465f129`。保留整個 `portable-preview-2026-09-29T23-26-22-888Z` 與同層 `resources`。本輪未刪除其他仍被驗收 run 綁定的預覽。

最終 `23-29-37` 版收折已有清楚中文摘要的原始失敗記錄，桌面 UI smoke `native-agent-review-bNxQad` 通過；EXE SHA-256 `39511aa6f1a6c76bffda9edfde4a9d0fab839b3686ab0c9186923ed83513151b`。保留整個 `portable-preview-2026-09-29T23-29-37-415Z` 與同層 `resources`；本輪未清理其他預覽。

## 第三十九輪保留狀態

`23-51-54` 版完成首次開啟與可選素材庫修正，桌面 UI smoke `native-agent-review-WZEvUe` 通過；EXE SHA-256 `81e6a4d9a289693bfdce355b61d6b9c46ef630eba6e7654b59b6babb3d1916fa`。保留整個 `portable-preview-2026-09-29T23-51-54-157Z` 與同層 `resources`。本輪尚未對既有 Kit run 所綁定的舊版進行來源遷移，因此沒有直接刪除既有預覽。

## 第四十輪保留狀態

`00-10-36` 版完成軌道匯入與即時拖放修正，兩次桌面專案回歸 `editor-project-review-uV5ZOe`、`editor-project-review-AhOX6K` 和 Agent 回歸 `native-agent-review-vT720r` 通過；EXE SHA-256 `4807c6e78c7f2681200c2f1add5054e3f245b7b956ffdcc0745dd7e82bba7bec`。保留整個 `portable-preview-2026-09-30T00-10-36-487Z` 與同層 `resources`。本輪另外產生兩個除錯封裝 `00-03-21`、`00-07-06`，但未取得清理其目錄的當次精確授權；既有 Kit run 的治理來源亦未遷移，本輪沒有刪除任何預覽。

## 第四十一輪保留狀態

`00-24-10` 版完成輸出工作鎖與聲畫對位驗收，EXE SHA-256 `5b7771146f4ed28dbfe12f1e1fda2e306bb7bfd1cd6915dc2c8ad750cffe71bc`。封裝桌面專案回歸 `editor-project-review-sArQpq` 與內附 Agent 回歸 `native-agent-review-XdsQaR` 均 PASS，保留其隔離專案、12 秒 MP4 與報告；須保留整個 `portable-preview-2026-09-30T00-24-10-060Z` 和同層 `resources`。本輪曾產生中間封裝 `00-20-18`，未做舊 Kit run 來源遷移或精確清理授權，因此未刪除預覽。

## 第四十二輪保留狀態

`00-38-02` 版完成精簡預覽控制列與小視窗時間軸排版，EXE SHA-256 `31f794c74236d328bd38742dfa532d90f3ed9c0d240ca0644df7d5f7f676fb4f`。封裝桌面回歸 `editor-project-review-wYJuwW` 和內附 Agent 回歸 `native-agent-review-0smnS9` 均 PASS，保留 1366×768 與 1280×720 截圖、報告、隔離專案及測試 MP4。須保留整個 `portable-preview-2026-09-30T00-38-02-443Z` 與同層 `resources`。本輪中間封裝 `00-31-45`、`00-36-18` 及過去 Kit run 綁定版本未經來源遷移；本輪未刪除預覽。

## 第四十三輪清理與保留狀態

最新 `00-47-12` 版在真實區網 Qwen 的隔離音量編輯與桌面側欄回歸通過；EXE SHA-256 `e000efbd1f9c4acd2233c6c17c46dc6da97e07d736d149f84921972465110139`，保留 `portable-preview-2026-09-30T00-47-12-273Z` 及同層 `resources`。

按使用者新增的每輪清理要求，腳本新增 `-OnlyDiscard` 模式：只有列明的預覽目錄能進入刪除清單，仍檢查絕對路徑、reparse point、執行中的 EXE、檔案雜湊與刪除 manifest。兩次 dry-run 後清理 8 份沒有 Kit run 綁定的過渡封裝：`00-36-18`、`00-31-45`、`00-20-18`、`00-07-06`、`00-03-21`、`23-48-59`、`23-44-07`、`23-37-33`，合計釋出約 2.05 GiB。清單分別為 `artifacts/autopilot-desk/portable-preview-prune-20260930T005019243Z.json` 與 `artifacts/autopilot-desk/portable-preview-prune-20260930T005057575Z.json`，兩者狀態均為 `complete`。仍由 Kit run 綁定的舊版及執行中的 `16-32-46` 版保留；該版的 Editkin、Node 和 OpenCode 子程序為相連的執行樹，不是本輪殭屍程序。

## 第四十四輪保留狀態

最終 `01-05-52` 版以正式專案隔離副本完成兩次開啟、Agent 綁定、儲存重開與 48 秒輸出驗收；EXE SHA-256 `fd55cc4e66a674280dca63f5152448a704c8d116e2cb809e72d04d39c07b8f97`。保留整個 `portable-preview-2026-09-30T01-05-52-100Z` 及同層 `resources`，以及驗收證據 `existing-project-review-29Lwp1`。`01-02-23` 為本輪中間封裝，沒有 Kit run 來源綁定；dry-run 確認唯一目標且無執行中 EXE 後精確清理，釋出約 0.26 GiB，清單 `artifacts/autopilot-desk/portable-preview-prune-20260930T011121089Z.json` 狀態 `complete`。本輪另刪除 3 份由本輪產生的失敗／重複桌面驗收隔離資料，合計 64.55 MiB；保留最終 PASS 的專案、截圖、報告與成片。既有來源綁定版本及執行中的 `16-32-46` 保留。

## 第四十五輪保留狀態

最終 `01-21-02` 版三次通過正式專案副本的缺聲提示、Agent 重新綁定、儲存重開與輸出驗收；EXE SHA-256 `a906c86bf99340932861dcb9b262177128c0c097259baf98b4b5af43985ad6eb`。保留整個 `portable-preview-2026-09-30T01-21-02-640Z` 及同層 `resources`，以及最終證據 `existing-project-review-EFiikl`、Agent 側欄回歸 `native-agent-review-N26tSJ`。`01-17-51` 為本輪失敗的過渡封裝，沒有 Kit run 來源綁定；dry-run 核對後精確清理，釋出約 0.26 GiB，清單 `artifacts/autopilot-desk/portable-preview-prune-20260930T012502620Z.json` 狀態 `complete`。另清理 3 份本輪失敗／重複的隔離桌面驗收資料，釋出 85.75 MiB；最新報告、截圖、成片及前一輪驗收證據均保留。執行中或被 Kit run 綁定的舊版繼續保留。

## 第四十六輪保留狀態

保留最終 `portable-preview-2026-09-30T01-56-30-579Z` 及同層 `resources`，EXE SHA-256 `5b5c22e2fca66b6c830b8c8dbe75fe93b80e24f90f5245fe480af08a42133333`。此版含固定版本本機 Whisper 執行器與 190 MB 多語模型；`packaged-asr-review-qhxfvp` 完成封裝 ASR 與粗剪視窗驗收，`native-agent-review-l7cc4v` 完成內建 Agent 回歸。四份本輪中間封裝 `01-43-54`、`01-47-13`、`01-49-43`、`01-51-44` 在 dry-run 確認無執行中 EXE 與 Kit run 綁定後精確清理，共釋出約 1.77 GiB；清單 `artifacts/autopilot-desk/portable-preview-prune-20260930T015847739Z.json` 狀態 `complete`。另清除六份本輪失敗或重複的 ASR 隔離驗收目錄（62.3 MiB）與已由 `vendor` 保留的重複模型下載檔（181.3 MiB），清單為 `artifacts/autopilot-desk/round46-review-cleanup.json`。舊版有 Kit run 綁定或使用者仍在執行者繼續保留。

## 第四十七輪保留狀態

保留最終 `portable-preview-2026-09-30T02-22-45-444Z` 與同層 `resources`，EXE SHA-256 `f832dea6f173aa556448ba378a37b24fb694c0e1dc3b2dda5a959728aad6ab06`。保留 Kit 語音正例 `kit-voiced-prepare-7VgO5W`、缺色彩資訊負例 `kit-voiced-prepare-Burxa5`、桌面 Agent `native-agent-review-vi6gKj` 及 ASR `packaged-asr-review-AF8f2q` 的驗收證據。七份本輪失敗或被最終版取代的 Kit 隔離 run 已核對精確目錄、reparse point 與執行程序後清理，清單 `artifacts/autopilot-desk/round47-voiced-review-cleanup.json`，釋出約 1.8 MiB。`02-18-25` 為本輪中間封裝；它的測試 run 已清理，無執行中的 EXE 或其他 Kit run 綁定；`-OnlyDiscard` dry-run 後精確清理，釋出 0.44 GiB，清單 `artifacts/autopilot-desk/portable-preview-prune-20260930T022655518Z.json`。使用者正在執行的舊版與有其他 run 綁定者保留。
