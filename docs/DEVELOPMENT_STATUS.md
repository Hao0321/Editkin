# Current source and contribution coordination

Snapshot date: 2026-10-05. The active integration is [PR #77](https://github.com/Hao0321/Editkin/pull/77), branch `feat/latest-agent-engine-20261001`. Main remains protected; review and current CI precede a merge. This public update shares existing implementations early so contributors can extend them.

## What this source contains

| Area | Existing source | Useful contribution |
| --- | --- | --- |
| Original Motion authoring | [src/application/originalMotionScene2d.ts](../src/application/originalMotionScene2d.ts) | Extend the existing source contract and geometry/text authoring; demonstrate an editable output. |
| Original source revisions | [src/mcp/originalMotionSourceRevisionFile.ts](../src/mcp/originalMotionSourceRevisionFile.ts) | Preserve media and untouched project fields while changing text, font, palette or rhythm. |
| Painted media / typography | [src/domain/motionPaint.ts](../src/domain/motionPaint.ts) | Bind actual glyph layouts, authored geometry and matching runtime; verify decoded preview/output. |
| Physical glyph layouts | [src/render/motionPhysicalGlyphLayouts.ts](../src/render/motionPhysicalGlyphLayouts.ts) | Exercise actual font bytes and frame layouts; avoid estimated-width substitutes. |
| Floating video frames | [src/motion/floatingVideoFrame.ts](../src/motion/floatingVideoFrame.ts) | Build on current perspective/media geometry and enforce current color/runtime constraints. |
| V4 agent workflow | [src/mcp/originalMotionWorkflow.ts](../src/mcp/originalMotionWorkflow.ts) | Consume the machine-issued contract/scope; stop dispatch when a producer fails. |
| Project format | [src/domain/editGraph.ts](../src/domain/editGraph.ts) | Keep schema 9/10 persistence and old-project migration behavior. |
| Playback workspace | [src/ui/workspaceLayout.css](../src/ui/workspaceLayout.css) | Complete scrollbar/max-panel/native verification for the current minimum-width layout. |
| Motion text timing | [src/domain/types.ts](../src/domain/types.ts) | Use sequence.exitStaggerFrames; zero means simultaneous phrase exit. Verify readable entry/hold/exit. |

These modules have source implementations. Individual source checks, a web build, a partial browser observation and a complete delivered native journey are separate evidence. The recent narrow-workspace observation demonstrated real next-frame/play/pause at 689px and a 360px preview with wide panels. Manual horizontal scrolling, the exact maximum panel width, native installation, complete film/art and performance remain open. Prior experiments that exceeded their fixed budget stay blocked.

## Where help is useful

1. Read the source and the open PRs before building another authoring, render or agent pipeline.
2. Open a scoped issue describing the existing module, observed missing behavior, target platform and redistributable test fixture. Comment before working so maintainers can identify overlapping work.
3. Use the integration branch for changes depending on the current Motion/agent API. State the base branch in the PR. Independent small fixes can target main.
4. Complete real import/edit/preview/save/reopen/output journeys; attach results and decoded-output observations. Keep failed/untested paths explicit.
5. Preserve the protected security boundaries, audit/apply ordering, source identity, rights checks, update signatures and remote workspace confinement.

Open PRs already cover browser silence cutting (#80), browser draft video output (#81), caption SRT/VTT IO (#72), IPC path binding (#50), native plugin trust (#49), and CI concurrency (#76). Coordinate with those authors instead of duplicating their implementation. No approval of those open PRs is implied.

## Complete-delivery acceptance ledger

The maintainer's strengthening program uses 37 complete deliverable/journey units. Revision 26 remains **3/37**. The table records acceptance, while source code exists for many pending areas. It is not an estimate of effort, feature count, quality score or general editing-engine completion. Publishing this branch adds no acceptance credit.

| ID | Acceptance journey | Status |
| --- | --- | --- |
| M01 | 可編輯屬性／幾何 Motion 與局部導演修訂 | PENDING |
| M02 | 真字形、字體層級與可讀動態排版 | PENDING |
| M03 | 預覽／輸出與任意 seek 的同代一致性 | UNMEASURED |
| V01 | 自有影片柔邊浮框與原比例質感 | PENDING |
| V02 | 直式環繞與雙大型直式後景的真深度影片佈局 | UNMEASURED |
| V03 | 完整 2D／3D 動態美術與参考對照 | UNMEASURED |
| T01 | strike_reframe 完整可交付直式模板 | PENDING |
| T02 | level_bridge 完整可交付直式模板 | PENDING |
| T03 | comparison_pair 完整可交付直式模板 | PENDING |
| T04 | context_stack 完整可交付直式模板 | PENDING |
| T05 | evidence_takeover 完整可交付直式模板 | PENDING |
| T06 | focus_wall 完整可交付直式模板 | PENDING |
| T07 | brand_recap 完整可交付直式模板 | BLOCK |
| T08 | kinetic_network 完整可交付直式模板 | PENDING |
| T09 | 已保存模板更換授權素材與 source window | BLOCK |
| T10 | 模板改字／字型／配色／節奏並跨內容重用 | PENDING |
| T11 | 所有仍可用舊模板逐項遷移最新版共同Motion | PENDING |
| L01 | 長片04剪輯模式交付與本人接受 | PASS |
| L02 | 長片04完整內容／聲畫與同產物 QA | PENDING |
| L03 | 自然長片模式可執行套用與語意 Motion | PENDING |
| L04 | 獨立原創／授權日系插畫動畫 MV | BLOCK |
| U01 | 素材導入、自由跨軌拖移與磁吸逐格定位 | PENDING |
| U02 | 時間軸操作保存／重開／Undo 的實體閉環 | PENDING |
| U03 | 人性化播放／暫停／快轉／倒放與錯誤恢復 | BLOCK |
| A01 | 新剪輯 first-contract 與同政策／同代引擎入口 | PASS |
| A02 | 素材／權利／語意證據與缺口阻擋 | BLOCK |
| A03 | 同代 v4 audit→一次 atomic apply→可編輯專案 | BLOCK |
| A04 | render→完整 QA／自主藝審→發布中樞 | PENDING |
| K01 | 完整參考學習、自研 CSS／品質評分可執行記憶 | PENDING |
| K02 | 兩系統模組／操作流程與永久防回退 | PENDING |
| P01 | 最新版同代安裝與冷啟動完整桌面旅程 | PENDING |
| P02 | 當代產品拖移／播放／輸出效能與資源上限 | UNMEASURED |
| P03 | 指定18舊生成版本退役並只留可回退R16 | PASS |
| P04 | 當代安全更新、健康／回退與自有資源保護 | PENDING |
| R01 | 兩庫當代公開來源／權利／隱私界線 | PENDING |
| R02 | Editkin 最新已验版本推送及 exact 遠端 CI | PENDING |
| R03 | Video Autopilot 最新匹配版本推送及 exact 遠端 CI | PENDING |

PASS is a complete accepted journey; PENDING has unfinished acceptance; BLOCK has a known blocking condition; UNMEASURED lacks qualifying current evidence. Long-video source media, private art profiles, account information and personal music are absent. Rights approval for private test media does not permit redistributing it here.

## Release and validation boundaries

This is a public development source update. It does not change the package's release version, the installed desktop program, signing policy or official release channel. The public edition retains reviewed CI, public defaults, licenses and dependency pins. No new dependencies or private footage are added. A private-media showcase script is omitted because its required footage/music cannot be distributed.

Local validation and the exact remote commit are recorded in [SOURCE_VALIDATION.md](SOURCE_VALIDATION.md). Current GitHub checks appear on PR #77. Read [RELEASE.md](RELEASE.md) before publishing binaries.
