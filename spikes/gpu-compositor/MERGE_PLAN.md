# 合併計畫（核心 session 完成後執行）

## 不可直接複製的部分

這個 spike 每次 render 都會 upload 全部圖層並 readback 到 CPU，目的是建立可驗證的離屏基準。
正式 preview 不可照搬這個生命週期，否則 GPU 很快也會被同步等待拖慢。

## 正式架構

1. 在 Tauri／Rust host 建立長生命週期 `GpuPreviewEngine`。
2. 解碼器把硬體 frame 交給 resident GPU texture；相同 frame hash 不重傳。
3. project command 只更新 dirty node／property buffer；拖曳時不重建整張 render graph。
4. render thread 持續 present；UI thread 只送 command，不等待 frame。
5. 以三格 texture ring buffer 解耦 decode、composite、present。
6. export 共用相同 WGSL node，但走無掉幀、frame-accurate 的 offscreen scheduler。
7. 只有 proxy thumbnail、測試與輸出 encoder 需要 readback；正常預覽不 readback。

## 資料模型新增

- `TimelineClip.blendMode`
- `TimelineClip.transform` 保留，量化後送 GPU property buffer
- `TimelineClip.matte?: { type: alpha|luma, sourceLayerId, invert }`
- `TimelineClip.masks[]`
- `TimelineClip.effects[]`
- `TimelineTrack.compositing?: { adjustment, precomposeId, parentId }`

先以 project migration 增加 defaults；舊專案全部為 `normal`，視覺結果不可改變。

## 合併門檻

- 同一 frozen graph 的 CPU/GPU 最大 channel error ≤ 2。
- 1080p 6-layer resident-texture preview 的 p95 compositor time ≤ 8.3 ms。
- 4K 6-layer p95 ≤ 16.6 ms，否則自動降 proxy scale。
- 300 次 seek 無 device loss、無 unbounded texture growth。
- GPU 初始化失敗時自動回 CPU／現有 FFmpeg preview，不破壞專案。
- 所有 blend mode 都有透明邊緣與色彩空間 golden image。

## 防衝突流程

合併前重新計算以下檔案 SHA-256，再建立 adapter：

- `src/domain/types.ts`
- `src/domain/schema.ts`
- `src/render/planner.ts`
- `src/render/ffmpeg.ts`
- `src/application/previewMedia.ts`
- `src-tauri/src/main.rs`

若任一檔和本 spike 建立時不同，重新讀取後做語意合併，不覆蓋另一個 session 的內容。

