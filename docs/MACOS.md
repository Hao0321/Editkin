# Install a local macOS community build

This is a source-build helper for your own Mac, not an official download or a
standalone redistributable installer. It builds the current Git checkout and
uses your installed Node and FFmpeg libraries. Keep those dependencies installed.
It does not change Gatekeeper, remove quarantine attributes, install signing
credentials, or create official release metadata.

## 1. Install prerequisites once

Install Apple's Command Line Tools (`xcode-select --install`) and
[Homebrew](https://brew.sh/) using their official instructions. Then:

```sh
brew install node@22 rust ffmpeg-full python@3.12
```

The helper discovers Homebrew's prefix on Apple Silicon and Intel Macs; it does
not assume one architecture. Node must be at least 22.13 and support `node:sqlite`,
Rust at least 1.92, and Python at least 3.9 with `venv`. FFmpeg must include the
`libx264` and `aac` encoders and the `ass`, `subtitles` and `drawtext` filters. Use a toolchain
that supports your macOS version. The minimum OS of the resulting app also depends
on these installed runtimes; the source project's 12.0 setting alone is not a
promise that a current Homebrew build runs on macOS 12.

## 2. Clone, then build and install

```sh
git clone https://github.com/Hao0321/Editkin.git
cd Editkin
bash scripts/install-macos-community.sh
```

Or open the cloned folder in Finder and double-click **Install-on-Mac.command**.
The `.command` file runs the same script and keeps the Terminal result visible.
The first build downloads npm packages, the pinned fontTools 4.60.2 Python wheel,
and locked Rust dependencies, generates the bundled OFL font faces, and compiles
the desktop shell. Allow time and disk space for a native Rust build.

Default destination: `~/Applications/Editkin Community.app`.
The installer does not launch the app. Open it in Finder after a successful build.
Do not run the installer with `sudo`.

To check prerequisites without downloads or writes, or choose another destination:

```sh
bash scripts/install-macos-community.sh --check
bash scripts/install-macos-community.sh --output "$HOME/Applications/Editkin Test.app"
```

An existing destination, including a symlink, is refused. For an update, build to
a new name, verify it, then replace your old copy yourself. Your video projects
are separate from the application bundle.

## What the helper does

- Copies Git-tracked working-tree files into a fresh `.rd/macos-community.*`
  directory. Ignored files, personal media, credentials and local caches are not
  copied. For development, stage newly added source files before testing the helper.
- Runs `npm ci`, creates an isolated Python virtual environment, generates the 43
  static font faces, and verifies them with the existing font gate. Generated
  manifests and metrics stay in the disposable source copy.
- Builds the web UI and real resident service with `--community`, then the Rust
  shell with `community-desktop,tauri/custom-protocol`. The macOS-only invocation
  sets `CARGO_PROFILE_RELEASE_PANIC=unwind` so the pinned objc2/Wry code can catch
  recoverable WebKit URL-scheme cancellation exceptions during media playback.
- Copies the local runtimes and public resources into the new app, applies an
  ad-hoc signature, and verifies the signature and bundled runtime launch probes.
  Homebrew shared libraries remain dependencies of this Mac; this is not a
  relocatable app for other computers.
- Records local community build identity and hashes, without private source paths.
  It leaves the original checkout, system security settings and existing apps alone.

The successful build path is printed. Rust compilation caches stay under
`.rd/macos-community-target` for subsequent runs. Its `.rd/macos-community.*` directory can
be removed after verification; retain the app and its Homebrew dependencies.
If a build fails, the same directory remains for diagnosis. Fix the reported
prerequisite and rerun; the next attempt uses a fresh directory.

## First use and verification

1. Add your own video, photo or audio through **加入影片開始剪**.
2. For an existing `.editkin.json`, click **開啟之前的專案** at the bottom of the
   home card. Inside the editor use **更多 → 專案與連線 → 開啟專案**. A project JSON
   is not a media asset; importing it through **加入素材** currently produces an
   OpenEXR manifest error. Finder project-file association is not provided here.
3. Check preview, pause/seek/replay, save/reopen, and export on your own Mac.
   Use the repository's synthetic `public/demo-source.mp4` for a shareable check.
4. Play the exported MP4 separately. A successful source build or package-signature
   check does not by itself prove correct preview, sound or rendering.

The community edition uses compatible preview. Private Creator Packs, speech
models, native GPU compositor, official updater identity and official Agent setup
are not included or certified by this helper. An unavailable Creator Pack message
does not mean the local installation failed. Advanced effects and scene-linear
ACES output need their separate prerequisites. See [BUILDING.md](BUILDING.md)
and [RELEASE.md](RELEASE.md) for source and release boundaries.

Only synthetic/public fixtures should accompany bug reports. Do not publish
project media, credentials, personal paths or unreviewed diagnostic logs.

## Contributor checks

```sh
bash -n scripts/install-macos-community.sh Install-on-Mac.command
python3 scripts/package-macos-community.test.py
python3 scripts/test_install_macos_community.py
npm run typecheck
npm test
npm run build
npm run source:scan
```

The helper is designed to discover both architectures. Report the exact machine,
OS and command actually tested; do not infer Intel or other macOS coverage from
an Apple Silicon run. Distribution of binaries still requires the separate
licensing, corresponding-source, signing and provenance review in RELEASE.md.
