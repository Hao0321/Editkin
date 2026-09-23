# Editkin creator tools

Editkin discovers installed tools from this directory. Each immediate child directory may contain one `editkin-plugin.json` manifest using schema `editkin.plugin/v1`.

The host currently recognizes these capability families:

- effects, transitions and generators;
- analysis and workflow tools;
- importers and exporters;
- asset and knowledge packs.

The executable contract lives in `src/plugins/manifest.ts`. `creator-accelerators/editkin-plugin.json` is the bundled working example.

## Automation contract

An EditGraph command tool declares semantic roles, supported formats, prerequisites, avoid conditions, typed parameters and a bounded command template. Clip-scoped tools apply to the selected clip; project-only tools are marked `專案` and do not require a clip selection. `video-autopilot` uses the same manifest through `list_installed_plugins`, `get_plugin_capability` and `invoke_plugin_tool`, so newly installed tools do not need to be hard-coded into the Skill.

The current clip-scoped allowlist is `set_clip_creative`, `set_clip_color`, `set_clip_layout`, `set_clip_layer` and `update_clip_transform`. The current project-scoped allowlist is `configure_particle_simulation` and `set_particle_simulation_settings`. Authors do not declare scope separately: the host owns the mapping, injects `clipId` only for clip commands and rejects templates that try to override `type` or `clipId`. Every resolved command is parsed by the canonical host schema; a multi-command capability is committed as one revision-bound, undoable project transaction.

`particle-highlight-vfx` in the bundled manifest is the reference project-scope example. It accepts an explicit `start` and `duration`, persists the interval in project state, and lowers it to a native frame range. Project scope means the command owns project-level VFX state; it does not mean the effect is active for the entire program.

`dual-particle-burst-vfx` demonstrates bounded multi-emitter automation. One atomic project transaction creates a warm primary burst and a cool secondary trail with independent intervals, seeds, motion and colors. The product accepts at most four emitter layers and an aggregate budget of 192 particles; each emitter is still capped at 64. The resident preview returns every active emitter receipt in graph order while retaining the legacy first-emitter receipt for compatible hosts.

An effect may instead declare `runtime.type: "gpu_effect_graph"` with ABI version 1. This is a bounded, data-only shader graph—not arbitrary WGSL or a native binary. It supports one to four ordered operations chosen from `gain`, `invert`, `grayscale`, `saturation`, `contrast`, `tint`, `posterize` and `vignette`; every argument must be a finite literal or a declared numeric/boolean parameter. The host validates operation arity and ranges, binds the exact plugin version plus manifest SHA-256 into the project, hashes the canonical program, and validates it again inside the Rust GPU engine.

Creators can now author `runtime.type: "gpu_effect_module"` with `editkin.gpu-effect-module/v1`. It is a public, data-only node SDK that compiles to the same stable runtime bytecode and adds `hue_rotate`, `lift_gamma_gain`, `filmic_curve` and `temperature_tint`. Modules declare one `$source`, one output and at most four connected unary nodes. Cycles, recursion, branches, orphan nodes, undeclared parameters and out-of-range values fail closed before the GPU receives a program. See `plugins/sdk/README.md` and its starter template; validate a package with `npm run plugin:validate -- path/to/editkin-plugin.json`.

`gpu_effect_graph` currently has these deliberate product boundaries:

- up to four ordered third-party graphs per clip and sixteen flattened operations; CPU/GPU effect mixing remains blocked;
- spatial, frame-local effects only (`maxTemporalRadius: 0`);
- linear `rgba16_float` or `rgba32_float` processing in the resident GPU preview path;
- the same Rust shader executor is used for formal output, with verification readback recorded in the render receipt;
- `render.effect` permission is required, and only `assisted`/`full` capabilities are exposed to automatic editing.

The bundled `Creator Accelerators` manifest includes three automation-ready GPU examples—clean punch, warm cinematic and monochrome editorial—plus bounded EditGraph workflow examples. Their `requires` and `avoidWhen` fields are part of the automation contract; a Skill must evaluate them instead of applying a look globally.

## Security and compatibility

Plugins fail closed when the host version is too old, required permissions are absent, IDs collide, paths escape the plugin root, a native library SHA-256 does not match, parameters are invalid or a template attempts to replace the host-controlled command type or target clip. Project commands containing a clip identity and clip commands not bound to the invocation target are also rejected. GPU graphs additionally fail closed on missing/stale identity bindings, parameter mismatch, unsupported opcodes, overlong programs, canonical program hash mismatch and orphan bindings.

Native effect ABI manifests can be discovered, integrity-checked and rendered as a formal CPU sequence, but remain unavailable to automatic editing because their resident preview path is not yet same-source. Do not describe Editkin's bounded GPU graph/module SDK as AE, OFX, arbitrary WGSL, temporal-effect or shader-binary compatibility.
