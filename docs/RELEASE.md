# Official binary release gate

The source repository does not publish an official installer. The maintainer must close these gates for the exact binary revision and payload before enabling an official download:

1. Build from a protected main commit with pinned dependencies and a recorded file manifest.
2. Verify every bundled third-party binary's license, notices, corresponding source, and exact hash. FFmpeg's statically linked external libraries need their actual source revisions and build information.
3. Complete install, edit, preview, save/reopen, and export tests against each platform's exact delivered artifact, including output inspection. Do not claim an untested platform.
4. Publish an SBOM, final SHA-256, corresponding source, and project-key-signed release metadata. Clearly label any artifact that lacks operating-system code signing. OS signing and macOS notarization are recommended when available, but their cost does not block the community source edition.
5. Keep any project or OS signing keys in a protected release environment. Attest and verify the exact final artifact before publication.
6. The current packaged Windows updater requires Authenticode. An unsigned build must leave automatic installer updates disabled until an independently reviewed project-key update design is implemented and tested against tampering, rollback, and a previous release. Never relax the current signature check merely to ship an unsigned installer.

Passing CI or a static scan cannot replace these checks. Contributions may be merged while official binary publication remains closed.

## Community desktop is not an official release

The explicit `community-desktop` Cargo feature embeds a generated schema 1 identity, scope `editkin.community-desktop-build/v1`, with `officialRelease: false`. Its service bundle is real, but it cannot satisfy the owner-only schema 2 formal product identity or the private product/runtime gates. An unflagged build fails when `.release-input-manifest.json` is absent, including with a spoofed ambient `CARGO_FEATURE_COMMUNITY_DESKTOP=1`; the feature boundary is compile-time.

The GTK 0.19 / GLib 0.22 migration uses immutable unreleased upstream PR revisions rather than a GLib 0.18 backport. Passing the dependency audit and the observed Ubuntu 26.04 aarch64 native caption/timing/undo/redo/recovery smoke is not an official release-ready claim. Compatible registry releases still need a reviewed upgrade and renewed verification.

The native screenshot showed the edited caption on the timeline and duration 5 in the inspector, but a native ffprobe missing-relative-path error card hid the preview; rendered preview captions and playback were not verified. CJK glyphs were tofu and private Creator Pack content was unavailable. Optional tray dependencies are locked but not enabled by the app or exercised by the smoke. No full rendering/playback, import/export, codecs/GPU, dialogs, delivered installer, signing, private model, Windows/macOS/Wayland, or Ubuntu 24.04/x86_64 result is claimed. See [BUILDING.md](BUILDING.md) for reproducible commands, system-library minimums, and measured scope. Official binary publication remains blocked until every gate above is met for the exact delivered artifact.

## Windows evidence command

Run `node scripts/release-evidence.mjs [evidence-path]` after provisioning the Windows release inputs. A source-only checkout reports `RELEASE_INPUTS_MISSING` with relative paths, writes the report when the destination is writable, and exits 1. Only `PUBLIC_RELEASE_GREEN` exits 0; internally green but publicly blocked evidence still exits 1.

The public gate requires the GREEN receipt from `scripts/tauri-delivered-smoke.mjs` at `../../.rd/benchmarks/editkin-delivered-journey-<version>-windows-x64.json`, bound to the current installer and extracted executable hashes. It also requires `EDITKIN_UPDATE_METADATA_FILE` and `EDITKIN_UPDATE_TRUST_POLICY_FILE`: an Ed25519 envelope and an independently reviewed project-key policy. Verification reuses `src/application/updateTrust.ts` via the existing `tsx` development dependency and checks the exact installer version, hash, size, Windows x86_64 MSVC target, compatibility, and configured `EDITKIN_UPDATE_MANIFEST_URL`. Missing or rejected metadata blocks publication; supplying a policy does not itself establish that its key was independently reviewed.

Evidence labels the distribution `unsigned-community-binary` if either the installer or its delivered executable lacks valid Authenticode. Automatic installer updates remain disabled unless both signatures and the project-key metadata gate pass. These engineering checks do not close the official-release issue or replace the maintainer's release review.

The installer and the executable extracted from it must each match the reviewed policy's exact Authenticode subject and certificate SHA-256. A valid signature from another publisher is insufficient. Missing policy, missing signer identity, or a mismatched certificate blocks both the public signature gates and automatic-update eligibility, even when signed metadata claims the expected publisher.
