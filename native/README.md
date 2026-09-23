# Hao Native Core

`hao-core` owns deterministic frame/timebase alignment, render scheduling and native reference execution. Its JSON/file protocol is shared by Tauri, Electron and MCP without placing native code in the WebView renderer.

Current executable paths include:

- `engine-compile`, `engine-dirty`, `engine-selftest`: typed graph, invalidation, clock/ring/cache/recovery contracts.
- `auto-roto`: frozen per-pixel alpha sequence plus PNG frame previews.
- `engine-pipeline-selftest <dir>`: actual 48 kHz audio-DAG WAV and deterministic 2.5D/composite/VFX PNG.
- `effect-plugin-run <request.json>`: SHA-256-bound C ABI plugin in a supervised short-lived worker. The public ABI is `effect-sdk/editkin_effect_plugin_v1.h`.

The product keeps a TypeScript fallback for unsupported platforms. Release promotion requires the Rust and TypeScript planners to produce equivalent frame boundaries on the frozen corpus.

The frame/audio pipeline is currently a CPU reference executor. It does not prove hardware video zero-copy, direct GPU surface present, OCIO GPU parity, an audio-device callback, or interactive GPU 3D/VFX parity.
