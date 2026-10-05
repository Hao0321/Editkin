# 開發進度與避免重複實作

更新日期：2026-10-05。最新整合來源集中在 [PR #77](https://github.com/Hao0321/Editkin/pull/77)，分支 `feat/latest-agent-engine-20261001`。main 維持審查與 CI 保護。依賴新版 Motion／Agent 的改動請以此整合分支為基礎，並在 PR 寫清楚 base。

## 已有程式，請直接延伸

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

以上是已有來源的功能區域。最近窄視窗的局部瀏覽器觀測已操作逐格、播放、暫停，並看到寬側板下預覽最小360px。手動橫捲、最大側板、原生安裝、完整成片／美術與效能仍待驗。來源測試與局部操作各有範圍，超出固定時間預算的實驗仍保留阻擋狀態。

## 怎麼幫忙最快

先讀現有程式、[英文完整狀態與37項表](DEVELOPMENT_STATUS.md)及 open PR，再開有範圍的 issue：寫明延伸哪個模組、缺少什麼行為、目標平台與驗收素材。認領前留言，避免兩組人同時做同一件事。補齊已有功能的匯入、編輯、預覽、保存重開、解碼輸出驗收，很有價值。

瀏覽器靜音切除 #80、草稿影片匯出 #81、字幕 SRT/VTT #72、IPC 路徑綁定 #50、原生插件信任 #49、CI 併行 #76 都已有未合併 PR，請先跟原作者協調。它們的存在不等於已通過或合併。

維護者的37項強化交付旅程（revision26）仍 **3／37 完整验收**；此公開來源更新不增加票數。其餘項目有不同程度的來源實作，需要延伸或驗證。這是完整交付的驗收數，不是工時或美術評分。

本次分享開發來源，沒有升級桌面安裝檔或官方release。保留公开中性資料、現有安全流程、依賴版本與授權。私人原片、音樂、個人美感資料、帳號、金鑰不公開；私人測試素材獲准使用也不代表可對外散布。對照 [SOURCE_VALIDATION.md](SOURCE_VALIDATION.md)與 [RELEASE.md](RELEASE.md)。
