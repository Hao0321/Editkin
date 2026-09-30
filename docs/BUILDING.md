# Building Editkin from source

## Verified source path

Use Node.js 22.13+ and `npm ci`. Run `npm test` and `npm run build`; `npm run dev` starts the browser UI. The source repository includes neutral JSON presets, a neutral Wave 2 registry, a tiny community knowledge example, synthetic MP4 fixtures, and the five pinned OFL font sources. It contains no prebuilt FFmpeg, whisper.cpp, ONNX Runtime, model weights, owner music, or creative library. The owner visual grant is absent, and its claims fail closed in this edition.

`npm test` runs the suites that can execute from this source checkout. [source-test-exclusions.json](../source-test-exclusions.json) names retained integration suites that need external binaries, the separately installed video-autopilot skill, generated font/color products, or official artifact fixtures. The Windows Authenticode installer suite runs only on Windows. To attempt the other excluded suites after installing their prerequisites, set `EDITKIN_FULL_TESTS=1` and run `npm test`. A green default suite does not claim those excluded paths.

With an independently installed FFmpeg and ffprobe on `PATH`, run `npm run test:journey`. On Windows you may set `HAO_FFMPEG_PATH` and `HAO_FFPROBE_PATH` to their exact executable paths. This uses the synthetic MP4 to check import, EditGraph changes, preview state, atomic save/reopen, export, and a decoded preview frame. It writes evidence under ignored `.rd/` and does not test a delivered desktop installer.

`npm run source:verify:self-test` checks the source verifier's negative controls. `npm run source:verify` checks the exact initial publication snapshot and its hash manifest. `npm run source:scan` checks the current checkout, including pull requests, for private paths, unexpected binaries, key patterns, and the CI permission boundary while allowing ordinary text source changes. New binary assets need maintainer review and a refreshed rights record. These checks support maintainer review; they cannot decide whether arbitrary contributor code is malicious.

## Browser PWA build

`EDITKIN_PWA=1 npm run build` produces an installable, offline-capable variant of the browser build; the GitHub Pages workflow sets it. The default `npm run build`, which the desktop shells use, adds no manifest and no service worker and behaves as before.

The PWA build adds `manifest.webmanifest`, `sw.js`, `pwa-register.js`, and two icons under `icons/` (copies of files already reviewed in `src-tauri/icons`, so no new binary is introduced). `start_url` and `scope` are relative, so the app works under a Pages sub-path.

- **Cache policy:** the service worker precaches the app shell (HTML, JS, CSS, manifest, icons) under a version derived from the file set. Fonts are cached only after the app requests them. Demo videos, benchmarks, and user media are never cached.
- **Navigation:** network first, with the cached `index.html` as the offline fallback.
- **Updates:** a new worker waits and never replaces a running session. After a fresh page load it activates only if no other tab still uses the previous version, and it then deletes the old shell cache.
- **Offline limits:** the interface opens without a network, but the browser build still has no project persistence, no automatic editing, and no video export. The demo clip needs a network connection.

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

## Source asset provenance

- `public/demo-source.mp4`, `public/editkin-demo-preview.mp4`, and the two benchmark MP4s were generated from FFmpeg `lavfi` test patterns for this source edition. See [FIXTURES.md](FIXTURES.md).
- `public/fonts/*.ttf` comes from the pinned Google Fonts commit and is licensed under each accompanying SIL OFL 1.1 notice. `public/fonts/editkin-open-fonts.json` records source URLs and hashes. Rendered static faces are intentionally absent.
- `public/color/aces2` contains the ACES config and upstream license; generated LUTs are absent.
- `src-tauri/icons` and `assets/editkin-icon.svg` are Editkin visual identity files covered by [TRADEMARKS.md](../TRADEMARKS.md).
