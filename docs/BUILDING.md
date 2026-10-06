# Building Editkin from source

## Verified source path

Use Node.js 22.13+ and `npm ci`. Run `npm test` and `npm run build`; `npm run dev` starts the browser UI. In the contributor's npm 11.x run, npm printed `install-scripts ... not yet covered by allowScripts` warnings for `esbuild` and `fsevents` during `npm ci`; the source test/build completed without approving those scripts in that run. Check the exact npm version and dependency error before changing installation policy. The source repository includes neutral JSON presets, a neutral Wave 2 registry, a tiny community knowledge example, synthetic MP4 fixtures, and the five pinned OFL font sources. It contains no prebuilt FFmpeg, whisper.cpp, ONNX Runtime, model weights, owner music, or creative library. The owner visual grant is absent, and its claims fail closed in this edition.

`npm test` runs the suites that can execute from this source checkout. [source-test-exclusions.json](../source-test-exclusions.json) names retained integration suites that need external binaries, the separately installed video-autopilot skill, generated font/color products, or official artifact fixtures. The Windows Authenticode installer suite runs only on Windows. To attempt the other excluded suites, set `EDITKIN_FULL_TESTS=1` and run `npm test`. Installing FFmpeg on `PATH` is not enough: 31 test files reference the vendored Windows runtime at `vendor/ffmpeg/win32-x64/`, and several of them hard-code that path without consulting `PATH` or `HAO_FFMPEG_PATH`, so they fail with `ENOENT` on other platforms or in a community checkout that does not contain it. The video-autopilot plan-hash suite starts `python` unless `EDITKIN_PYTHON_EXECUTABLE` names another interpreter, and also needs the separately installed skill. The contributor reported that on macOS with FFmpeg 9.0.1 on `PATH` and no vendored runtime, `EDITKIN_FULL_TESTS=1 npm test` finished with 117 failed, 2170 passed, and 81 skipped tests. These counts are a reported observation, not a portable acceptance baseline. Attribute each failure to its documented prerequisite before treating it as expected; investigate every unexplained failure. A green default suite does not claim those excluded paths.

With an independently installed FFmpeg and ffprobe on `PATH` (verified with Homebrew FFmpeg 9.0.1, whose build includes the `libx264` and `aac` encoders), run `npm run test:journey`. On Windows you may set `HAO_FFMPEG_PATH` and `HAO_FFPROBE_PATH` to their exact executable paths. This uses the synthetic MP4 to check import, EditGraph changes, preview state, atomic save/reopen, export, and a decoded preview frame. It writes evidence under ignored `.rd/` and does not test a delivered desktop installer.

`npm run source:verify:self-test` checks the source verifier's negative controls. `npm run source:verify` checks the exact initial publication snapshot and its hash manifest. `npm run source:scan` checks the current checkout, including pull requests, for private paths, unexpected binaries, key patterns, and the CI permission boundary while allowing ordinary text source changes. New binary assets need maintainer review and a refreshed rights record. These checks support maintainer review; they cannot decide whether arbitrary contributor code is malicious.

## Desktop and release path

The Rust and Tauri source is included for development. The desktop media pipeline needs platform-specific runtimes and generated color/font products. A developer must fetch or build those from their upstream sources and comply with their licenses. The existing internal release scripts may expect owner-only creative packs or signing inputs; their failure in this community checkout is an explicit limitation, not a request to obtain the maintainer's private files.

Do not distribute a binary as an official Editkin release based solely on a passing web build or source test. A public installer needs a fresh, exact-artifact review: third-party corresponding source and notices (especially FFmpeg), platform-specific build and edit/export testing, final hashes and SBOM, a verified release identity, and provenance attestation. The current packaged Windows updater specifically requires Authenticode; an unsigned community build cannot use that updater. [RELEASE.md](RELEASE.md) tracks the available release paths.

### Linux community desktop (GTK 0.19 migration)

Use Node.js 22.13+ on `PATH`, Rust 1.92 or newer (verification used 1.98.1), a C/C++ toolchain, and `pkg-config`. GTK **Rust crate** 0.19 still targets system GTK **3**, not GTK 4. The locked Linux features require GTK 3.24+, GLib/GIO 2.70+, WebKitGTK 4.1 API 2.40+, JavaScriptCoreGTK 4.1 API 2.38+, and libsoup 3.0+. These minimums come from the enabled sys-crate features and their `system-deps` metadata.

Ubuntu 24.04 prerequisites:

```sh
sudo apt-get update
sudo apt-get install -y build-essential pkg-config libgtk-3-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev libxdo-dev webkit2gtk-driver xvfb dbus-x11
npm ci
npm run build
node scripts/build-desktop.mjs --community
CARGO_BUILD_JOBS=2 cargo build --locked --manifest-path src-tauri/Cargo.toml --features community-desktop,tauri/custom-protocol
cargo tree --locked --manifest-path src-tauri/Cargo.toml --target x86_64-unknown-linux-gnu --features community-desktop,tauri/custom-protocol -i glib
cargo install cargo-audit --version 0.22.2 --locked
cargo audit --file src-tauri/Cargo.lock --deny unsound
cargo install tauri-driver --version 2.1.0 --locked
dbus-run-session -- xvfb-run -a -s '-screen 0 1440x1000x24' node scripts/linux-native-editor-smoke.mjs src-tauri/target/debug/editkin
```

For aarch64, use `aarch64-unknown-linux-gnu` in the tree command. Ubuntu 26.04 calls the WebDriver package `webkitgtk-webdriver`. The smoke harness resolves Node on `PATH` to its canonical executable and configures the existing debug resident-service `EDITKIN_NODE_PATH`; it does not relax executable validation.

[Ubuntu 24.04 GTK](https://packages.ubuntu.com/noble/libgtk-3-dev) 3.24.41, [GLib](https://packages.ubuntu.com/noble/libglib2.0-dev) 2.80.0, [WebKit/JavaScriptCore](https://packages.ubuntu.com/noble/libwebkit2gtk-4.1-dev) 2.44.0 or newer, and [libsoup](https://packages.ubuntu.com/noble/libsoup-3.0-dev) 3.4.4 satisfy the selected feature minimums. This is a package/manifest compatibility check, not an executed Ubuntu 24.04/x86_64 native result; that job remains to be exercised in CI.

The actual locked aarch64 Linux path is Editkin → Tauri 2.12.0 → GTK 0.19.0 → GLib 0.22.10, with Tauri runtime/runtime-wry 2.12.0, Tao 0.37.0, Wry 0.57.0, Muda 0.20.0, and WebKitGTK Rust 2.0.2. The whole lockfile has one version of each GTK-family crate, including optional tray dependencies; no GTK 0.18/GLib 0.18 chain remains. Optional tray dependencies are present in the lockfile but are not enabled by the app or exercised by the native smoke. JavaScriptCore Rust 2.0.0 and Soup Rust 0.9.0 complete the migration.

These are unreleased upstream migration revisions, pinned by full immutable Git commit in [Cargo.toml](../src-tauri/Cargo.toml): [Tauri #16170](https://github.com/tauri-apps/tauri/pull/16170), [Tao #1332](https://github.com/tauri-apps/tao/pull/1332), [Wry #1843](https://github.com/tauri-apps/wry/pull/1843), [WebKitGTK #167](https://github.com/tauri-apps/webkit2gtk-rs/pull/167) (including #166), [Muda #403](https://github.com/tauri-apps/muda/pull/403), [tray-icon #369](https://github.com/tauri-apps/tray-icon/pull/369), and [libappindicator #53](https://github.com/tauri-apps/libappindicator-rs/pull/53). Replace them with compatible registry releases only after rechecking the complete chain, audit, native build, and smoke.

### Observed native verification and limits

On 2026-09-30, Ubuntu 26.04 aarch64 with Rust 1.98.1, Node 22.22.1, GTK 3.24.52, WebKitGTK 2.52.6, and system GLib 2.88.0 compiled and ran the real community desktop under Xvfb/D-Bus. The native WebKit page used `tauri://localhost` and real IPC. The public synthetic demo accepted caption text “Linux native caption edit” and duration 5, undo restored duration 3, redo restored 5, and autosave/recovery preserved the exact edit and the original 12-second demo clip/asset. Final evidence is under ignored `.rd/tmp/linux-native-editor-0wGr6t/`; the exercised binary SHA-256 was `b4e713aea4d13e93e6dfba5c9b72ccc68ecba4b6eb026388e83e381950b3cd74`.

The inspected final screenshot showed the edited caption on the timeline and duration 5 in the inspector. The preview was hidden by a native ffprobe error card reporting the missing relative path `editkin-demo-preview.mp4`; rendered preview captions and playback were not verified. The public demo fixture exists in the checkout/build, but its relative media URI did not resolve through the native media path. CJK glyphs were tofu, and the absent private Creator Pack remained unavailable/loading. This does **not** prove full rendering or media playback, import, codecs/GPU, export, native dialogs, installers, signatures, private speech models, Windows, macOS, Wayland, or an exact delivered official artifact. No private assets are needed for this limited public smoke.

The community service builder bundles the real service, and the explicit Cargo feature generates schema 1 identity with scope `editkin.community-desktop-build/v1` and `officialRelease: false`. It is not a fallback official manifest. An unflagged native build still requires the owner's schema 2 `.release-input-manifest.json`; even spoofing the ambient `CARGO_FEATURE_COMMUNITY_DESKTOP` variable does not bypass the compile-time feature guard.

### macOS community desktop (unsigned, Apple Silicon)

The `macOS community desktop` workflow ([macos-community-desktop.yml](../.github/workflows/macos-community-desktop.yml)) builds a portable release `Editkin.app` and DMG for Apple Silicon with the `community-desktop` feature. It is **not an official release**: the app is ad-hoc signed (no Developer ID, not notarized) and automatic updates stay disabled.

Run it from GitHub: **Actions → macOS community desktop → Run workflow** on `main`. Manual runs are limited to the maintainer's account; same-repository pull requests that change this pipeline also run it. The run's `Editkin-community-macos-arm64` artifact holds `Editkin-community-macos-arm64.dmg`, `Editkin-community-macos-arm64.app.zip` and `SHA256SUMS` for 14 days (`shasum -a 256 -c SHA256SUMS`). The `macos-community-evidence-*` artifact holds the staging summary, runtime manifest, FFmpeg provenance, gate reports and launch logs.

To open it, copy `Editkin.app` to `/Applications` and remove the download quarantine from the app and its bundled tools:

```sh
xattr -dr com.apple.quarantine /Applications/Editkin.app
```

Finder's right-click **Open** (macOS 14 and earlier) or **System Settings → Privacy & Security → Open Anyway** (macOS 15 and later) can approve the app, but may leave the quarantine flag on the bundled FFmpeg, Node.js and helper tools; prefer the command above.

What the workflow bundles in `Contents/Resources`:

- FFmpeg 8.1.2 built from the release tarball pinned by SHA-256 (its signature was checked against the FFmpeg release key `FCF986EA15E6E293A5644F10B4322F04D67658D8` when the pin was recorded), with `--enable-gpl`, libx264, libx265, zimg, libass, dav1d, VideoToolbox/AudioToolbox and library autodetection disabled. Its Homebrew-bottle libraries are copied into `runtime/lib` and rewritten to `@loader_path`.
- Node.js 22.23.2 and whisper.cpp 1.9.2 (`whisper-cli`, Metal) with the same pins as `scripts/stage-platform-runtime.mjs`, plus `hao-core` built from this repository. `editkin-gpu-compositor` is not bundled; see the limits below.
- The real service, MCP and Remote bundles (`node scripts/build-desktop.mjs --community --with-mcp-and-remote`) and the Agent launcher files.
- The font pack with static caption faces generated by `scripts/build-static-font-pack.py` and the pinned fontTools 4.60.2 wheel (installed by pip in hash-checking mode). Export requires `font-packs/editkin-open-fonts/render/`, which the published font pack omits.

Every bundled Mach-O except the upstream-signed Node.js binary is ad-hoc re-signed. `scripts/stage-macos-community-runtime.mjs` stages `.platform-runtime/` and records hashes in `runtime/PLATFORM-MANIFEST.json`; `src-tauri/tauri.macos.community.conf.json` maps it into the bundle. The workflow then checks the delivered app copied out of the DMG: the hashed runtime closure, arm64-only Mach-O files without Homebrew or build-directory references, `codesign --verify --deep --strict`, the libraries dyld actually loads, FFmpeg encodes and filters through Editkin's own argument builders, the bundled service's import, preview proxy, save/reopen and export, `npm run test:journey` with the bundled FFmpeg, and an app launch that must load the web UI (`EDITKIN_SMOKE=1`) and stay alive for 30 seconds. Read the run log for the actual results.

To build locally on an Apple Silicon Mac with Xcode command-line tools, cmake and Rust:

```sh
brew install pkgconf x264 x265 zimg libass dav1d
npm ci && npm run build
node scripts/build-desktop.mjs --community --with-mcp-and-remote
cargo build --release --locked --manifest-path native/hao-core/Cargo.toml
node scripts/stage-macos-community-runtime.mjs
npx tauri build --ci --ignore-version-mismatches --features community-desktop --bundles app,dmg \
  --config src-tauri/tauri.macos.community.conf.json \
  --config '{"bundle":{"macOS":{"minimumSystemVersion":"<minimumMacOS printed by the stager>"}}}' -- --locked
npx tsx scripts/macos-community-app-gate.ts src-tauri/target/release/bundle/macos/Editkin.app
```

`--ignore-version-mismatches` is needed because this repository pins the Rust `tauri` crate 2.12.0 with `@tauri-apps/api` 2.11.1, the same pair the Linux desktop job uses.

Limits of this build:

- Apple Silicon only. Homebrew bottles target the build runner's macOS version, so the workflow raises `LSMinimumSystemVersion` to the highest minimum declared by a bundled binary.
- Owner-only inputs stay absent, and their features fail closed: creative and personal packs, the Auto Roto product route (needs the owner's `BUILD-MANIFEST.json`), ACES 2 LUTs and GPU programs (generated products), and motion-composition v2 export (the generated faces differ from the owner's measured em-metric digests).
- No GPU compositor. `spikes/gpu-compositor` embeds the generated ACES 2 output LUTs and refuses to start unless their bytes match the owner's pinned SHA-256. Those LUTs are not in this repository, and running `scripts/generate-aces-luts.py` with the published PyOpenColorIO 2.5.2 wheel produced different bytes for every LUT that OCIO bakes (checked on Linux x86_64), so the workflow neither builds nor bundles the compositor rather than weakening that check. Scene-linear ACES 2 output and GPU preview are therefore unavailable; the default Rec.709 pipeline renders and exports through FFmpeg. The owner's `scripts/macos-bundle-runtime-gate.mjs` requires the compositor in its closed-world file set, so the workflow does not run it.
- Agent (MCP) setup is not expected to work. Activating an Agent generation requires the owner-only creative and personal pack directories and records a hash of the GPU compositor, which this build omits. The release launcher imports `mcp.mjs` as a `data:` URL without the material-color bridge context; loaded that way, the bundle throws `verified-data-bundle-context-required`.
- `hao-core` reports no physical audio output on macOS, so preview audio uses the WebView. Transcription quality, other Macs and a quarantined download are not covered by the workflow.
- FFmpeg here includes GPL components (libx264, libx265). Anyone who redistributes the app or DMG must comply with the GNU GPL, including offering the complete corresponding source of FFmpeg and every bundled library. Versions, source URLs and checksums are in `runtime/FFMPEG-PROVENANCE.json`; see `runtime/COMMUNITY-BUILD-NOTICE.txt`. Do not post the artifact as an official Editkin download.

## Source asset provenance

- `public/demo-source.mp4`, `public/editkin-demo-preview.mp4`, and the two benchmark MP4s were generated from FFmpeg `lavfi` test patterns for this source edition. See [FIXTURES.md](FIXTURES.md).
- `public/fonts/*.ttf` comes from the pinned Google Fonts commit and is licensed under each accompanying SIL OFL 1.1 notice. `public/fonts/editkin-open-fonts.json` records source URLs and hashes. Rendered static faces are intentionally absent.
- `public/color/aces2` contains the ACES config and upstream license; generated LUTs are absent.
- `src-tauri/icons` and `assets/editkin-icon.svg` are Editkin visual identity files covered by [TRADEMARKS.md](../TRADEMARKS.md).
