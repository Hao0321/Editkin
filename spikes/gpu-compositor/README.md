# Editkin GPU Compositor Spike

這是一個隔離、可稍後合併的 Rust／wgpu 原生 GPU 合成器。它不修改目前 Editkin 的
domain、renderer、UI 或 Tauri 核心，所以可以和另一個 session 同時工作。

目前可執行能力：

- `hao.gpu-render-graph/v1` JSON render graph。
- 最多 64 個 full-frame RGBA 圖層。
- 圖層排序、顯示、opacity、translate、scale、rotation。
- `normal / add / screen / multiply` 四種 blend mode。
- procedural solid、linear gradient、radial glow、rounded rect 與 PNG source。
- WGSL compute compositor，離屏輸出透明 RGBA PNG。
- 同公式 CPU fallback、GPU/CPU 每 channel parity gate。
- benchmark receipt，明確區分 prototype 的 upload/readback 成本與常駐紋理 production 路徑。

它不是完成版播放引擎。正式合併前仍需接硬體解碼、GPU texture residency、frame cache、
surface present、mask／matte、effect render nodes 與 dropped-frame telemetry。

## Build / test

```powershell
$cargo = '<CARGO_HOME>\bin\cargo.exe'
& $cargo test --manifest-path apps\hao-editor\spikes\gpu-compositor\Cargo.toml
& $cargo run --release --manifest-path apps\hao-editor\spikes\gpu-compositor\Cargo.toml -- `
  selftest `
  apps\hao-editor\spikes\gpu-compositor\fixtures\layer-stack.json `
  .rd\gpu-compositor-selftest
```

## Benchmark

```powershell
& $cargo run --release --manifest-path apps\hao-editor\spikes\gpu-compositor\Cargo.toml -- `
  benchmark `
  apps\hao-editor\spikes\gpu-compositor\fixtures\layer-stack.json `
  30 `
  .rd\benchmarks\editkin-gpu-compositor.json
```

## Runtime boundary

介面與編輯狀態可繼續由 React／TypeScript 負責。只有已量化到 frame 的 render graph 送進
Rust；GPU thread 不讀 UI state、不呼叫 AI、不碰網路，也不在每幀解析使用者 expression。
Expression 必須先由安全 AST 求值成 property buffer，再交給 compositor。

