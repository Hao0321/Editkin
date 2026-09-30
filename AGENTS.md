# AGENTS.md

Guidance for AI coding agents (Codex, Claude Code, Cursor, and similar) working in this repository. Human contributors should start with `CONTRIBUTING.md`. `CLAUDE.md` imports this file, so this is the single source of agent instructions.

Everything below was derived from the source, configuration, and docs in this checkout. If this file disagrees with the code, the code wins; fix this file.

---

## 1. What this project is

Editkin (`package.json` name `editkin`, product name "Editkin", version `0.15.0`, author Hao0321 Studio) is a **local-first, AI-native video editor** with an editable timeline.

Core concepts:

- **EditGraph**: the single source of truth for a project (`EditProject`, `src/domain/types.ts`). Current `schemaVersion` is **8**; versions 1–7 are upgraded by `migrateProject` in `src/domain/editGraph.ts`.
- **EditorCommand**: every mutation is a structured command (`src/domain/commandTypes.ts`). The UI, the MCP server, agents, and plugins all go through the same command path.
- **MCP server** (`npm run mcp`, `src/mcp/server.ts`): lets an external agent inspect media, prepare/audit/apply an editable "v4 plan", and render, using the same commands as the UI. The agent makes editorial decisions; Editkin is the engine.
- **Video Autopilot Kit** (external repo `Hao0321/video-autopilot-kit`) supplies agent-side editing rules. It is optional and not vendored here; `EDITKIN_VIDEO_AUTOPILOT_SKILL` points at its `codex-skill/video-autopilot/SKILL.md`. `video-autopilot-skill-integration.json` declares `sourcePolicy: "community-optional-skills"` with no dependencies.

### Community source edition

This repository is the **community source edition**. It contains neutral default presets, a neutral Wave 2 registry, a tiny community knowledge example, synthetic FFmpeg `lavfi` demo MP4s, and five pinned SIL OFL fonts. It does **not** contain the maintainer's private creative packs, music, personal Skills, model weights, signing credentials, or prebuilt media runtimes (FFmpeg, whisper.cpp, ONNX Runtime). The owner visual grant is absent and its claims fail closed. License: GPL-3.0-or-later (fonts carry their own OFL 1.1 notices; the ACES config carries its upstream license). Official branding and release signing stay with the maintainer (`TRADEMARKS.md`).

---

## Current mesh and agent workflow scope

Video Autopilot workflow revision 6 uses the v4 material → audit → apply → render → policy-bound visual review → outcome chain. An authorized agent review is recorded as agent_review and never as a human approval.

Optional scene3d data uses the shared CPU triangle/z-buffer executor with physical Noto Sans TC 700/900 font faces. This is bounded opaque Rec.709 geometry, not GPU PBR or complete 3D feature parity. The three rejected mesh recipes remain DESIGN_REWORK: UI creation is withdrawn, MCP discovery is empty, and prepare rejects before project IO. Existing research scenes remain editable. See docs/mesh3d-scenes.md.

## 2. Tech stack

| Layer | Technology |
| --- | --- |
| UI | React 19.2, Vite 6, TypeScript 5.9 (`strict`, `isolatedModules`, `moduleResolution: Bundler`, `jsx: react-jsx`, target ES2022) |
| Validation | Zod 4 (`import * as z from "zod/v4"`) |
| Tests | Vitest 5 (globals enabled via `"types": ["vitest/globals", "node"]`) |
| Agent interface | `@modelcontextprotocol/server` and `client`, both 2.0.0 |
| Desktop shells | **Tauri 2** (`src-tauri/`; resident service, GPU/audio preview; calls into `src/application` via the protocol in `src/service/cli.ts`) and **Electron** (`electron/main.ts` imports `src/application` directly; `forge.config.cjs` Squirrel packaging; `updateIpc.ts` Windows Authenticode update flow) |
| Native | Rust: `native/hao-core` (frame/timebase alignment, render scheduling, CPU reference executor, auto-roto, effect plugin runner), `spikes/gpu-compositor`, `native/shared/owned_process`, `native/effect-sdk` (C ABI headers `editkin_effect_plugin_v1.h`/`v2.h`), `native/effect-test-plugin` |
| Runtime | Node `>=22.13` (CI pins 22.23.2). ESM (`"type": "module"`). `node:sqlite` is used in `projectFiles.ts`, so use a Node that provides it |

Runtime dependencies are deliberately tiny: `react`, `react-dom`, `zod`, `qrcode`, `@tauri-apps/api`, the two MCP packages, `three` (mesh geometry), and `opentype.js` (font outlines). Do not add dependencies for trivial functionality.

---

## 3. Repository map

```
src/
  main.tsx, App.tsx      Web entry; App wires the project session, playhead, hooks, lazy-loads EditorShell
  domain/                EditGraph, commands, history (undo/redo), zod schemas, validation, migration. Pure logic
  application/           Use-case layer (largest; ~209 files). Project file IO, autopilot, auto color/white balance/roto,
                         captions, smart cut, scene detection, montage, templates, export, updates, creative library…
  render/                Render planning and adapters: FFmpeg, native core, GPU compositor, ACES2, EXR, captions (ASS)
  mcp/                   MCP tool registration (server.ts is the entry), workspace boundary (storage.ts), zod tool schemas
  service/               Resident service and CLI protocol (cli.ts, residentProtocol.ts, autoRotoServiceArtifact.ts)
  desktop/               Renderer-side Tauri bridge (tauriBridge.ts), useXxx hooks, GPU/audio preview types and validators
  ui/                    React components, CSS, timeline interaction/snapping/viewport logic, theme
  plugins/               editkin-plugin.json manifest schema, registry, GPU effect graph/module SDK, workflow profiles
  creative/              Presets and packs (corePack, motion graphic presets, lower thirds, cinematic language, wave2Registry)
  motion/                2.5D Motion scenes: floating video frame, floating frame scenes, panel geometry, composition v2
  color/                 LUT parsing, display transfer, primary grade, linear white balance, OCIO GPU helpers
  typography/            Font face and em-metrics helpers
  remote/                Mobile remote HTTP server (token-authenticated)
  knowledge/             Community knowledge JSON
  shared/                Cross-runtime helpers: canonicalJson, update version compare, visual asset rights (.mjs + .d.mts)
  lib/                   browserMedia.ts, format.ts (makeId etc.)
  generated/             GENERATED (font faces/index/em metrics). Do not hand-edit
  types/                 Ambient type shims
src-tauri/               Rust desktop shell (~33 files): resident service, service pool, GPU preview owner/cache/worker,
                         audio session host/clock/registry, remote agent launcher, agent setup, remote provider connector
electron/                main.ts, preload.ts, updateIpc.ts, batchIpc.ts, agentCli.ts
native/                  Rust crates and the effect C ABI (see native/README.md)
plugins/                 Bundled plugins (creator-accelerators, creator-workflow, gpu-color-lab) and sdk/ templates
scripts/                 ~370 build, gate, integration, and benchmark scripts. Most need external runtimes
spikes/gpu-compositor/   Rust GPU compositor research and integration crate
config/                  Policy JSON (retired-product-surfaces.json, auto-roto benchmark/candidate configs)
docs/                    BUILDING, RELEASE, SECURITY_MODEL, FIXTURES, COMMUNITY
public/                  Synthetic demo MP4s, benchmark MP4s, OFL fonts, ACES config
```

Entry points: Web `src/main.tsx` → `src/App.tsx`; MCP `src/mcp/server.ts`; Tauri `src-tauri/src/main.rs` (~98 `#[tauri::command]` functions); Electron `electron/main.ts` (`package.json#main` is `desktop-dist/main.mjs`).

Other roots: `index.html`, `vite.config.ts`, `tsconfig.json`, `forge.config.cjs`, `performance-budgets.json`, `source-test-exclusions.json`, `PUBLIC_SOURCE_MANIFEST.json`.

---

## 4. Commands

```sh
npm ci                                       # clean install (lockfile is authoritative)
npm run dev                                  # vite --host 127.0.0.1 -> http://127.0.0.1:5173 (strictPort)
npm run typecheck                            # tsc --noEmit
npm test                                     # vitest run (only suites runnable from this checkout)
npx vitest run src/domain/history.test.ts    # single test file
npm run build                                # tsc --noEmit && node scripts/build-web-public.mjs && vite build
npm run preview                              # vite preview
npm run mcp                                  # tsx src/mcp/server.ts (stdio MCP server)
npm run test:journey                         # tsx scripts/public-source-journey.ts; needs FFmpeg + ffprobe on PATH
npm run source:verify                        # exact initial publication snapshot + hash manifest
npm run source:verify:self-test              # negative controls of the verifier (CI step)
npm run source:scan                          # scan current tree: private paths, binaries, keys, CI permissions (CI step)
npx tsx scripts/architecture-check.ts        # dependency graph / boundary / cycle check (see section 5)
EDITKIN_FULL_TESTS=1 npm test                # also attempt the excluded integration suites
```

CI (`.github/workflows/source-ci.yml`, ubuntu + windows + macos, read-only `contents` permission) runs in this order: `source:verify:self-test` → `source:scan` → `npm ci` → `npm test` → `npm run build`. Before proposing a change, run at least `npm run typecheck`, `npm test`, and `npm run build`.

`test:journey` uses the synthetic MP4 to exercise import, EditGraph changes, preview state, atomic save/reopen, export, and a decoded preview frame. It writes evidence under the ignored `.rd/`. On Windows set `HAO_FFMPEG_PATH` and `HAO_FFPROBE_PATH` if the tools are not on `PATH`.

### Things that surprise people

- **`typecheck` does not check test files.** `tsconfig.json` excludes `src/**/*.test.ts`, `*.test.tsx`, `*.test.mjs`, and only includes `src` and `vite.config.ts`. Vitest transpiles tests without type checking, so type errors in tests are invisible to CI. Be careful when editing tests, and do not assume green CI means well-typed tests.
- **`npm test` intentionally skips suites.** `vite.config.ts` excludes (a) `.rd/**`, (b) a hardcoded `nodeTestFiles` list of `.test.mjs` files, (c) `scripts/electron-update-ipc.test.ts` on non-Windows, and (d) every file listed in `source-test-exclusions.json` unless `EDITKIN_FULL_TESTS=1`. Those excluded suites need external FFmpeg, native runtimes, the separately installed video-autopilot skill, generated font/color products, or official artifact fixtures. A green default run does **not** cover them. If you add a test that needs an external binary, register it in `source-test-exclusions.json` with a `prerequisite`.
- **Many scripts and doc references have no npm script here.** `plugin:validate`, `retired-surfaces:*`, the bundle-size gate, and most `*-gate` scripts are not in this public `package.json`. That is a result of the community-edition trimming. Do not invent npm scripts or hunt for private files to make them work. Run a script directly with `node scripts/x.mjs` or `npx tsx scripts/x.ts` and expect it may fail for lack of a runtime or owner-only inputs.
- **The three Source CI jobs do not compile Rust.** The additional `Linux GTK desktop` job introduced by #29 performs a locked community desktop build, dependency audit and focused native smoke test on Ubuntu. Read the current workflow before describing its coverage; that job does not verify Windows/macOS native behavior, all Rust crates or official installers. If you change Rust, run `cargo check`/`cargo test` in the relevant crate and say exactly what ran. `src-tauri` has `tests/preview_process_faults.rs` and many `*_tests.rs` modules; `native/hao-core` has `tests/` and `engine-*-selftest` subcommands.
- **Desktop builds** have distinct source and official-release routes. Use the documented `--community` and `community-desktop` feature for the public Linux source smoke path. Official product build scripts still require runtimes, owner-only inputs and release identity; a community build cannot replace those gates (`docs/BUILDING.md`).

---

## 5. Architecture rules (enforced by `scripts/architecture-check.ts`)

The checker walks `src/` and `electron/`, parses with the TypeScript AST, and fails on:

| Rule | Detail |
| --- | --- |
| `domain` isolation | `src/domain/**` must not import `src/ui`, `src/mcp`, `src/render`, `src/desktop`, or `electron/` |
| `render` isolation | `src/render/**` must not import `src/ui`, `src/mcp`, or `electron/` |
| `mcp` isolation | `src/mcp/**` must not import `src/ui`, `src/render`, or `electron/` |
| `electron` isolation | `electron/**` must not import `src/ui` or `src/render` directly |
| No production → test edges | Production code must never import `*.test.*`, `*.spec.*`, or `__tests__/` |
| No cycles | Any import cycle fails |
| Static imports only | Relative imports must be static string literals and must resolve (`non-static-module-import`, `unresolved-relative-import`) |
| Non-empty graph | Must resolve edges; `commands → editGraph` edge must exist |

Test files are exempt from the layering rules (integration tests may touch many adapters) but still participate in resolution and cycle checks. Additionally `verify-public-source.mjs` rejects any relative import that resolves outside the repo root.

Note that `src/mcp` reaches `src/application` freely, and `src/application` is the shared hub. Put reusable use-case logic in `application`, not in `mcp`, `ui`, or `desktop`, so all surfaces share it.

---

## 6. Core invariants

1. **All project mutation goes through `EditorCommand` → `applyCommand`** (`src/domain/commands.ts`). `applyCommand` is pure: try the fast path (`applyFastCommand`), otherwise `cloneProject` → `commandInternal` → normalize (creative transitions, motion references, layer state) → `touch` (monotonic `updatedAt`) → `validateProject` (plus aesthetic revalidation). Never mutate an `EditProject` in place from UI, MCP, or plugin code.
2. **Adding a command touches several places**, keep them in sync: the union in `commandTypes.ts`; the implementation in `commands.ts` / `timelineCommands.ts` / `fastCommands.ts`; the agent-visible zod contract `editorCommandSchema` in `src/mcp/schemas.ts`; the persisted-project schema in `src/domain/schema.ts` if state shape changes; `agent.ts` if natural-language compilation is affected; plugin allowlists in `src/plugins` if plugins may use it. `fastCommands.ts` must keep the same validation semantics as the normal path and must preserve reference equality for untouched project branches (asserted in `history.test.ts`).
3. **Time is frame-aligned.** Use `alignTime(value, fps)` (`Math.round(value * fps) / fps`). The Rust `hao-core` planner and the TypeScript planner (`src/render/planner.ts`, `nativeCore.ts`) must produce equivalent frame boundaries on the frozen corpus; the TS planner is the fallback on unsupported platforms. If you change trim/split/segment logic, inspect both.
4. **History semantics** (`src/domain/history.ts`): `dispatchCommand` keeps the last 100 `past` snapshots and appends to `journal`; the UI uses `dispatchCommandSafely`, which returns the original state plus an error message on failure (the mounted editor state must survive an invalid command). Undo/redo must never roll back the on-disk `revision`.
5. **Project files** (`src/application/projectFiles.ts`): extension `.editkin.json` (legacy `.haoedit.json` remains readable). Writes go through `writeProjectFileAtomic` (lock file, `.previous` backup, atomic rename) with an optimistic `revision` check that throws `ProjectRevisionConflictError`. Reads fall back to `.previous` if the primary is missing or corrupt. Never write project JSON with a bare `writeFile`. `parseProject` = `migrateProject` → zod `projectSchema` → `validateProject`.
6. **Schema evolution**: changing the `EditProject` shape requires bumping `schemaVersion`, extending `migrateProject`, updating `projectSchema`, and adding/adjusting tests. Old files must still open.
7. **MCP workspace boundary** (`src/mcp/storage.ts`): all paths are confined to `EDITKIN_WORKSPACE` (legacy `HAO_EDITOR_WORKSPACE`, default `cwd`), checked lexically and again with `realpath` to defeat symlink/junction escapes (`WorkspaceBoundaryError`). Tool failures return `errorResult` (`{ status: "BLOCK", error }`, `isError: true`). `EDITKIN_MCP_MODE=remote-only` is a closed-world mode exposing exactly three remote-onboarding tools; do not widen it, and any unknown mode value must throw.
8. **Plugins fail closed** (`plugins/README.md`, `src/plugins/manifest.ts`, schema `editkin.plugin/v1`): reject on old host version, missing permission, ID collision, path escaping the plugin root, native library SHA-256 mismatch, invalid parameters, or a template that tries to override `type` or `clipId`. The host, not the plugin, owns clip-scope vs project-scope allowlists (clip: `set_clip_creative`, `set_clip_color`, `set_clip_layout`, `set_clip_layer`, `update_clip_transform`; project: `configure_particle_simulation`, `set_particle_simulation_settings`). A multi-command capability commits as one revision-bound, undoable transaction. GPU effects (`gpu_effect_graph` / `gpu_effect_module`) are bounded, data-only bytecode with a small op set, not arbitrary WGSL, and never describe them as AE/OFX/temporal/shader-binary compatible. Native effect ABI plugins are not exposed to automatic editing.
9. **The auto-roto SAM/ONNX product route is retired.** `src-tauri/Cargo.toml` keeps an `auto-roto-research` feature that deliberately `compile_error!`s in `main.rs`; `config/retired-product-surfaces.json` lists retired script names and required `research:*` replacements. Do not revive, rewire, or compile that route.
10. **Never weaken integrity/identity checks** (resident audio decoder SHA-256, render receipts, plugin manifest hashes, update signature verification, GPU program hash binding). Fix performance by optimizing the check (see the `sha2` `opt-level` note in `src-tauri/Cargo.toml`), not skipping it.
11. **Untrusted inputs**: external Skills, plugins, models, and media are untrusted. Keep private files and credentials out of logs and telemetry. `src/remote/server.ts` refuses to start without a token of at least 12 characters and required queue/snapshot/device paths; keep it that way.

---

## 7. Conventions

### Language
- User-visible strings and domain error messages are mostly **Traditional Chinese** (for example `找不到專案`, `專案已被其他視窗或 Agent 更新`, default track names `主畫面`/`聲音`/`字幕`, default project name `未命名影片`). Tests often assert on Chinese fragments with `toContain`. Match the surrounding language; do not translate existing messages without updating every dependent test and consumer.
- Identifiers, comments, and docs are English. `README.zh-TW.md` is the Traditional Chinese README; keep it consistent when changing `README.md` claims.

### Naming heritage
- `Hao`, `HAO_*`, `hao-core`, `haoedit` are the previous brand and remain **live interfaces** (`HAO_FFMPEG_PATH`, `HAO_FFPROBE_PATH`, `HAO_NATIVE_CORE_PATH`, `HAO_MCP_*`, `HAO_EDITOR_DEV_URL`, `.haoedit.json`, `native/hao-core`). Do not mass-rename them. New environment variables should use `EDITKIN_*`.

### Environment variables (non-exhaustive)
`EDITKIN_WORKSPACE`, `EDITKIN_CACHE_ROOT`, `EDITKIN_MODEL_ROOT`, `EDITKIN_PLUGIN_ROOTS`, `EDITKIN_FONT_ROOT`, `EDITKIN_COLOR_ROOT`, `EDITKIN_CREATIVE_PACK_ROOT`, `EDITKIN_PERSONAL_MUSIC_ROOT`, `EDITKIN_PERSONAL_VISUAL_ROOT`, `EDITKIN_WHISPER_CLI_PATH`, `EDITKIN_WHISPER_MODEL_PATH`, `EDITKIN_FFMPEG_PATH`, `EDITKIN_FFPROBE_PATH`, `EDITKIN_GPU_COMPOSITOR_PATH`, `EDITKIN_WORKFLOW_PROFILE_PATH`, `EDITKIN_MCP_MODE`, `EDITKIN_VIDEO_AUTOPILOT_SKILL`, `EDITKIN_REMOTE_*` (token, queue, snapshot, devices, relay), `HAO_FFMPEG_PATH`, `HAO_FFPROBE_PATH`, `HAO_NATIVE_CORE_PATH`, and `HAO_WINDOWS_*` signing variables used only by `forge.config.cjs`. The `EDITKIN_*_ROOT` pack roots default to gitignored `.creative-packs/` and `.personal-packs/`; they will be absent in a community checkout.

### Testing
- Tests live beside the source as `name.test.ts(x)` (about 316 test files: `application` 101, `render` 52, `ui` 51, `desktop` 33, `domain` 20, `mcp` 9, plus color/creative/motion/plugins/service/shared/typography). Heavier integration and gate scripts live in `scripts/`.
- Reuse existing fixtures such as `createDemoProject` (`src/domain/demo.ts`) and `createUiDemoProject`. Follow nearby test style (some existing tests are dense single-line style).
- Bug fix: reproduce first, fix the root cause with the smallest change, add a test that fails before the fix. Behavior changes need updated adjacent tests.
- For visual behavior (import, edit, preview, save/reopen, export), inspect the actual decoded output; unit tests alone do not prove it.
- Do not claim a render, GPU, color, or native path is verified unless you ran the corresponding gate. `native/README.md` states the current frame/audio pipeline is a CPU reference executor and does not prove hardware video zero-copy, direct GPU present, OCIO GPU parity, an audio-device callback, or interactive GPU 3D/VFX parity.

### Style
- Follow the neighboring file. Do not reformat unrelated code or restyle files while fixing something else.
- `.gitattributes` sets `* -text`: **preserve existing line endings** and never let an editor convert a whole file's EOL (the source manifest hashes exact bytes). `*.sh`, `*.bash`, `*.command` must be LF.
- Strings in zod schemas use `strictObject` heavily (see `src/plugins/manifest.ts`); unknown keys are rejected, keep that.

### Frontend and build constraints
- `vite.config.ts` sets `base: "./"`. Tauri/Electron load production UI from `file://`, so assets must stay relative to `index.html`; never introduce absolute `/assets/...` URLs.
- On `vite build`, `publicDir` is `.web-public` (generated by `scripts/build-web-public.mjs`), containing only UI-critical assets. Large OCIO LUTs and static render fonts are loaded from Tauri/Electron resources via bounded desktop commands. `vite dev` uses `public/`.
- `performance-budgets.json`: main JS ≤ 320,000 B (gzip ≤ 105,000), initial JS ≤ 330,000 B (gzip ≤ 110,000), main CSS ≤ 48,000 B (gzip ≤ 10,500). Lazy-load large UI (as `App.tsx` does with `EditorShell`); `react`/`react-dom` are split into a `react-vendor` chunk.
- Tauri CSP, asset protocol scope, and `capabilities/` in `src-tauri/` are security boundaries. Loosen them only with a written justification. Bundled resources are `demo-source.mp4`, `editkin-demo-preview.mp4`, fonts, `color/aces2`, and `plugins`.

### Motion and timeline notes
- Motion presets include an editable floating video frame with softened edges, portrait perspective orbit, and a scene with two larger rear portrait panels. `prepare_floating_frame_scene` compiles that scene into commands for the audited v4 plan. It is a 2.5D perspective plane, **not** a 3D mesh; do not describe it as 3D.
- Timeline asset drops snap to editing anchors and clips move in frame increments (`src/ui/timelineSnapping.ts`, `timelineAssetDrop.ts`, `timelineViewport.ts`).

---

## 8. Source boundary and security (read before committing)

- **Never add**: private footage, paid assets, credentials/tokens, local user paths (Windows user-profile directories and the maintainer's private drive paths are rejected by the scanner), model weights without redistribution rights, or opaque executables. Also never commit secret patterns (`-----BEGIN … PRIVATE KEY-----`, `ghp_…`, `github_pat_…`, `sk-…`).
- **Forbidden extensions**: `.exe .dll .pdb .zip .dmg .p12 .pfx .pem .key`.
- **Binary assets** (`.mp4 .mov .mp3 .wav .ttf .otf .png .jpg .jpeg .ico .icns`) are rejected by `source:scan` except the allowlisted classes: `src-tauri/icons/` (Editkin visual identity), `public/fonts/*.ttf` (SIL-OFL-1.1 rights record), and `public/*.mp4` (synthetic FFmpeg lavfi fixtures). Anything else needs maintainer review and a refreshed rights record.
- **Forbidden directories**: `.personal-packs`, `.creative-packs`, `vendor`, `desktop-deliveries`, `.desktop-resources`, `.desktop-product-release-candidates`. **Forbidden root files** include `audit.config.json`, `autopilot-capabilities.json`, `market-parity-contract.json`, `model-capability-contract.json`, `product-capabilities.json`, `video-autopilot-rule-coverage.json`.
- **Gitignored build/evidence output**: `dist/`, `desktop-dist/`, `.web-public*/`, `out/`, `release/`, `reports/`, `.rd/`, `native/**/target/`, `native/bin/`, `src-tauri/target*/`, `src-tauri/product-*/`, `src-tauri/gen/`, `public/fonts/render/`, `public/color/aces2/luts/`, `public/color/aces2/gpu/`, `.env`, `.env.*` (except `.env.example`), and key/cert files. Never force-add them.
- **`PUBLIC_SOURCE_MANIFEST.json`** is a maintainer-managed hash manifest of the published snapshot. Do not hand-edit or regenerate it.
- **`.github/`, `scripts/`, `src-tauri/`, `native/`** are CODEOWNERS-protected (`@Hao0321`); changes there get human security review. New network behavior, file writes, process execution, dependencies, and build scripts are reviewed manually and must be listed in the PR.
- **Pull requests are untrusted** in CI: fork PRs run read-only with no signing/publication secrets, actions are pinned by commit SHA (keep that when editing workflows), and dependency review and CodeQL run as extra signals. A passing scan is not merge approval.
- **Releases**: there is no signed installer. Never present a PR artifact or local build as an official Editkin download. The packaged Windows updater requires Authenticode; **never relax that signature check** to ship an unsigned installer (`docs/RELEASE.md`). Official binaries need exact-artifact review: third-party corresponding source and notices (especially FFmpeg), per-platform edit/export tests, SBOM, SHA-256, project-key-signed metadata, and provenance attestation.
- **Vulnerabilities**: report privately via GitHub private vulnerability reporting (`SECURITY.md`). Do not put exploit details in public issues, commits, or PRs.

---

## 9. Workflow

- **Commits** require a DCO sign-off: `git commit -s` (`Signed-off-by:` trailer). Do not `commit`, `push`, force-push, rewrite history, or open/merge PRs unless the user explicitly asks. Before a requested commit, inspect the diff so unrelated changes are not swept in. Existing uncommitted changes may belong to the user; never overwrite or discard them.
- **Pull requests** follow `.github/PULL_REQUEST_TEMPLATE.md`: what changed; user journey and platform; validation commands and any import/preview/save-reopen/export evidence; security and provenance (new dependencies, network access, process execution, file writes, permissions, added media/fonts/models with license and source, confirmation of no secrets or private footage); DCO.
- Open an issue first for a large feature or architecture change; a small bug fix can go straight to a PR. `main` is protected: PRs, three platform checks, and CODEOWNERS review are required.
- Explain the intent, platform, and affected user journey. For import, edit, preview, save/reopen, or export changes, add a small redistributable fixture and describe the observed result.
- Prefer the smallest complete change. Do not refactor, rename, or reformat unrelated code, and do not add abstractions or dependencies without need.
- State plainly what you verified and what you could not (for example, "Rust not built", "excluded integration suites not run"). Never imply a check passed when it was not run.
- Keep public claims conservative: a web build proves only the web build; a green default `npm test` does not prove excluded paths, native runtimes, fonts, color transforms, captions, or model features.

---

## 10. Quick pointers

| Task | Start here |
| --- | --- |
| Add or change an editing operation | `src/domain/commandTypes.ts`, `commands.ts`, `src/mcp/schemas.ts` |
| Change project file format | `src/domain/editGraph.ts` (`migrateProject`), `schema.ts`, `src/application/projectFiles.ts` |
| Add an MCP tool | `src/mcp/*Tools.ts`, register in `src/mcp/server.ts` (`createServerForEnvironment`) |
| Change render output | `src/render/planner.ts`, `ffmpeg*.ts`, `nativeCore.ts`, `native/hao-core/src/engine` |
| Timeline UI behavior | `src/ui/Timeline.tsx`, `timelineInteraction.ts`, `timelineSnapping.ts` |
| Desktop IPC / native calls | `src/desktop/tauriBridge.ts`, `src-tauri/src/main.rs`, `electron/main.ts`, `src/service/cli.ts` |
| Plugin capability or GPU effect | `src/plugins/manifest.ts`, `registry.ts`, `effectSdk.ts`, `plugins/README.md` |
| Auto-update logic | `src/application/updateManager.ts`, `electron/updateIpc.ts`, `docs/RELEASE.md` |
| Build/contribution policy | `docs/BUILDING.md`, `docs/SECURITY_MODEL.md`, `CONTRIBUTING.md` |
