# Building Editkin from source

## Verified source path

Use Node.js 22.13+ and `npm ci`. Run `npm test` and `npm run build`; `npm run dev` starts the browser UI. The source repository includes neutral JSON presets, a tiny community knowledge example, synthetic MP4 fixtures, and the five pinned OFL font sources. It contains no prebuilt FFmpeg, whisper.cpp, ONNX Runtime, model weights, owner music, or creative library.

`npm test` runs the suites that can execute from this source checkout. [source-test-exclusions.json](../source-test-exclusions.json) names every retained integration suite that needs external binaries, generated font/color products, or official artifact fixtures. To attempt those suites after installing their prerequisites, set `EDITKIN_FULL_TESTS=1` and run `npm test`. A green default suite does not claim those excluded paths.

With an independently installed FFmpeg and ffprobe on `PATH`, run `npm run test:journey`. On Windows you may set `HAO_FFMPEG_PATH` and `HAO_FFPROBE_PATH` to their exact executable paths. This uses the synthetic MP4 to check import, EditGraph changes, preview state, atomic save/reopen, export, and a decoded preview frame. It writes evidence under ignored `.rd/` and does not test a delivered desktop installer.

`npm run source:verify:self-test` checks the source verifier's negative controls. `npm run source:verify` checks the exact initial publication snapshot and its hash manifest. `npm run source:scan` checks the current checkout, including pull requests, for private paths, unexpected binaries, key patterns, and the CI permission boundary while allowing ordinary text source changes. New binary assets need maintainer review and a refreshed rights record. These checks support maintainer review; they cannot decide whether arbitrary contributor code is malicious.

## Desktop and release path

The Rust and Tauri source is included for development. The desktop media pipeline needs platform-specific runtimes and generated color/font products. A developer must fetch or build those from their upstream sources and comply with their licenses. The existing internal release scripts may expect owner-only creative packs or signing inputs; their failure in this community checkout is an explicit limitation, not a request to obtain the maintainer's private files.

Do not distribute a binary as an official Editkin release based solely on a passing web build or source test. A public installer needs a fresh, exact-artifact review: third-party corresponding source and notices (especially FFmpeg), platform-specific build and edit/export testing, code signing, update-channel verification, and provenance attestation. [RELEASE.md](RELEASE.md) tracks that work.

## Source asset provenance

- `public/demo-source.mp4`, `public/editkin-demo-preview.mp4`, and the two benchmark MP4s were generated from FFmpeg `lavfi` test patterns for this source edition. See [FIXTURES.md](FIXTURES.md).
- `public/fonts/*.ttf` comes from the pinned Google Fonts commit and is licensed under each accompanying SIL OFL 1.1 notice. `public/fonts/editkin-open-fonts.json` records source URLs and hashes. Rendered static faces are intentionally absent.
- `public/color/aces2` contains the ACES config and upstream license; generated LUTs are absent.
- `src-tauri/icons` and `assets/editkin-icon.svg` are Editkin visual identity files covered by [TRADEMARKS.md](../TRADEMARKS.md).
