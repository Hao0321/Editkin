# CodeQL triage: first public `security-extended` findings

Tracks [#24](https://github.com/Hao0321/Editkin/issues/24). This is a triage record, not a security clearance. **The issue stays open** until every alert is fixed or has a reviewer-approved dismissal and the scan of current `main` has been read back on GitHub.

## Method and limits

- The upstream alert list could not be read: `GET code-scanning/alerts` returned HTTP 403 for a non-collaborator. So the upstream count (92) and alert numbers could not be matched one-to-one.
- To get a comparable list, CodeQL CLI 2.27.1 (bundle SHA-256 verified against the published checksum) analysed a clean checkout of `main` for `javascript-typescript` with the `javascript-security-extended` suite and `--build-mode=none`, which mirrors `.github/workflows/codeql.yml`. It reported **87** results (the difference from 92 is not explained; the CLI/query version and alert de-duplication may differ from the hosted run).
- The Rust and Actions analyses were not part of this triage.
- After the fixes below the same command reports **75** results. Reproduce with `codeql database create db --language=javascript-typescript --build-mode=none --source-root=.` then `codeql database analyze db codeql/javascript-queries:codeql-suites/javascript-security-extended.qls`.

| Category | Before | After |
| --- | --- | --- |
| Product paths (`src/`, `electron/`) | 22 | 10 |
| Developer scripts (`scripts/`) | 56 | 56 |
| Browser fixtures | 3 | 3 |
| Test files | 6 | 6 |

## Fixed: check-then-use file reads (`js/file-system-race`)

The common pattern was `stat(path)` (size/type check) followed by `readFile(path)` or `open(path)`: the path can be replaced between the check and the use. New `src/shared/boundedFile.ts` (`readBoundedFile`, `readBoundedFileSync`) reads through **one open handle**: type and size come from `fstat` on that handle, the read is bounded by that size, one extra byte is probed to detect growth, and the handle's identity is re-checked afterwards. By default a symlink final component is rejected (`lstat` plus `O_NOFOLLOW`, with a `dev`/`ino` match against the opened handle). Sites that previously followed symlinks pass `followSymlinks: true`, so their behaviour is unchanged. Existing error messages are preserved through the `messages` option.

| Site | Input reaching it | Change |
| --- | --- | --- |
| `electron/main.ts` `hao:read-color-asset` | Renderer-supplied relative path (already confined by `boundedColorAssetPath`) | Bounded handle read, 64 MiB |
| `src/application/recoveryFiles.ts` | Recovery snapshot on disk | Bounded handle read |
| `src/application/autoColorEvidence.ts` | Colour receipt from the cache | Bounded handle read, 1 MiB |
| `src/application/materialPreparationJobs.ts` | Job state file (still rejects symlinks) | Bounded handle read, 32 KiB |
| `src/application/nativeAudioPreview.ts` | PCM written by the decoder | Bounded by the computed maximum |
| `src/mcp/autopilotBatchTools.ts` | Batch/plan JSON | Bounded handle read |
| `src/render/autoRotoMatteIntegrity.ts` | Manifest, matte sequence, previews | Manifest and previews bounded; sequence size taken from the opened handle |
| `src/application/autoRotoNativeProduct.ts` | Matte sequence and previews | Same |
| `src/application/automaticCaptions.ts` `inspectWhisperModel` | Model file | Type/size taken from the hashed handle |
| `src/service/autoRotoServiceArtifact.ts` | Product manifest and executable attestation | Bounded sync handle read; the executable read is bounded by the manifest size |

Behaviour note: the preview-size envelope in the two Auto Roto files is now enforced while previews are read (minimum 32 bytes, per-file maximum, total maximum) instead of in a separate `stat` pass; the limits are unchanged and violations still fail closed.

## Reviewed, not changed: proposed dismissals (need reviewer approval)

These are **proposals**. I cannot dismiss alerts and no reviewer has approved them.

| Alert | Reaches untrusted input? | Existing invariant | Proposed disposition |
| --- | --- | --- | --- |
| `js/user-controlled-bypass` `src/remote/server.ts:315` | Yes, relay messages | The `pair` branch skips `authenticateRelayDevice` on purpose but `pairRelayDevice` requires `bootstrapAuthorized` (length check, `timingSafeEqual`, pairing expiry) and `pairRateAllowed` limits attempts; every other message type requires a device credential | False positive. No automated test covers a denied pairing; that should be added before approval |
| `js/http-to-file-access` `src/remote/server.ts:213` | Authenticated command text | Only authenticated, rate-limited commands reach the queue; length limited to 1000 characters; the file name is generated (`remote-<time>-<random>`), opened with `wx`, then renamed | Intended feature; needs reviewer sign-off |
| `js/file-access-to-http` `src/remote/server.ts:274` | Paired device | `sendRelay` carries status data; `previewPath` is stripped and `previewAvailable` is false | Intended feature; reviewer should confirm the status fields |
| `js/double-escaping` `src/render/captionAss.ts:186` | Project-controlled path | Deliberate two-stage FFmpeg escaping (option parser, then filtergraph parser); not shell escaping. Covered by "escapes Windows paths for both filtergraph and option parsing without shell quoting" | False positive |
| `js/file-system-race` `src/plugins/workflowProfileFileStore.ts:91` | Local profile file | Already opens a handle and compares `dev`/`ino` before and after; symlinks rejected (test: "rejects symlink profile files instead of following them") | Already mitigated; alert reflects the `lstat` then `open` shape |
| `js/file-system-race` `src/mcp/remoteOnboardingTools.ts:310` | Local remote config | Same handle-plus-identity pattern, size bound and symlink rejection | Already mitigated |
| `js/file-system-race` `src/application/updateCache.ts:182` | Update lock file the app created | Lock identity captured on creation, re-checked, token compared, deletion via identity-checked `unlinkOwned`; symlink/junction tests exist | Already mitigated; residual unlink window is inherent to POSIX/Win32 and is guarded by identity |
| `js/file-system-race` `src/render/fontRoot.ts:51` | Bundled font files | Bytes read are hashed and compared with the pinned SHA-256 (swap gives a mismatch and fails closed); size, mtime and ctime re-checked | Integrity is by content hash; residual window between verification and later FFmpeg use is inherent |
| `js/file-system-race` `src/application/autoRotoNativeProduct.ts:188` | Cache lock file | Lock removed only if the token read back matches ours; a replaced lock is not removed by mistake except in a tiny window between read and `rm` | Accepted risk to be reviewed; an identity-checked unlink would need a design |
| `js/file-system-race` `src/application/materialColorCodeIdentity.ts:25` | The running module's own file | Compared with the hash captured at load; an attacker who can rewrite the application bundle already controls the code | Low value; reviewer decision |

## Not reviewed individually (remain open)

- **Developer scripts (56):** 38 `file-system-race`, 9 `bad-code-sanitization`, 8 `http-to-file-access`, 1 `file-access-to-http`, in `scripts/`. They are maintainer tooling run on the maintainer's own build outputs and are not shipped, but the issue requires each to be reviewed and none has been dismissed. Keep production checks independent of this triage.
- **Browser fixtures (3):** `js/xss-through-dom` in `scripts/fixtures/*-browser.tsx`.
- **Test files (6):** `js/file-system-race` in `*.test.ts`.

## Verification

- `npx tsc --noEmit`: clean.
- `npm test`: 264 files passed, 1 skipped; 2003 tests passed, 4 skipped (includes 8 new tests for the bounded reader: exact-limit read and one byte over, empty file, directory rejection, symlink rejected by default and followed on request, async and sync).
- `esbuild` bundling of `src/service/cli.ts` as a smoke check.
- Not verified: the hosted CodeQL run on the merged result; `node scripts/build-desktop.mjs --community` does not exist on `main` (it arrives with the GTK migration pull request), so the packaged service was not rebuilt.
