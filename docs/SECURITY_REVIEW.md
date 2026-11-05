# Independent security review path and bounded assessment

This document answers [#23](https://github.com/Hao0321/Editkin/issues/23). It records what was observed on 2026-09-30 against upstream `main` (`7a27566`), what could not be observed, and what remains a maintainer decision. **A green `source:scan` does not mean contributed code is safe.** The scanner is a tripwire for accidents (private paths, binaries, obvious keys), not a malicious-code detector; see the confirmed bypasses below.

**No reviewer is named or assigned.** The maintainer has not confirmed an exact GitHub account, so [CODEOWNERS](../.github/CODEOWNERS) still lists only `@Hao0321`. Until a second trusted reviewer exists, "second reviewer" below is a policy the maintainer cannot yet technically satisfy.

## 1. Trust boundaries

| Boundary | What crosses it | Where it is implemented | What a reviewer must check |
| --- | --- | --- | --- |
| External pull requests | Untrusted code runs in CI and can change the CI, scanner and policy files themselves | `.github/workflows/{source-ci,dependency-review,codeql}.yml`, `PULL_REQUEST_TEMPLATE.md` | Any change to workflows, scanner, manifest or exclusions; the PR's own CI result is produced by the PR's own scripts |
| Skills / plugins | Manifests, Skill JSON and **native libraries** become commands or executable code | `src/plugins/registry.ts`, `manifest.ts`, `skillPack.ts`; `native/hao-core/src/engine/plugin.rs` (`libloading::Library::new`) | Hash pinning proves identity, not safety or provenance. Native code loading has no OS sandbox |
| Local file access | Project/media paths from the renderer and dialogs | `electron/main.ts` (sender validation, sandbox, media protocol), `src-tauri/src/main.rs` (`read_project`/`write_project`), `src-tauri/tauri.conf.json` (CSP, empty asset scope) | Path traversal, symlink/junction escape, arbitrary `current_path`, renderer compromise |
| Process execution | Tool paths, arguments, worker processes, installers | `src/render/mediaProcess.ts` (`spawn(executable, args)`), `src-tauri/src/main.rs` (remote Node, audio process), `electron/updateIpc.ts` (PowerShell verifier, installer spawn) | Executable provenance, argument injection, inherited environment, process ownership |
| Update manifests | Network metadata selects an artifact and its claimed signer | `src-tauri/src/main.rs` (`start_update_job`), `electron/updateIpc.ts`, `src/service/cli.ts`, `scripts/update-channel.mjs` | The active updater derives the expected signer from the fetched manifest. `src/application/updateTrust.ts` (pinned Ed25519 policy) **is not wired into the active Tauri/Electron updaters**. Verification by the release-evidence script does not integrate runtime update trust |
| Dependency changes | Registry/git packages, lifecycle scripts, `build.rs`, proc macros | `package.json`, `package-lock.json`, `src-tauri/Cargo.{toml,lock}`, `src-tauri/build.rs`; CI runs `npm ci` without `--ignore-scripts` | Lockfile source URLs, `[patch]`/git sources, install scripts, build scripts |
| Release signing | Build output becomes a publisher-authenticated download | `docs/RELEASE.md`, `scripts/{signing-readiness,tauri-build,release-evidence}.mjs` | No release workflow, environment or release exists today; this is a future gate, not a provisioned pipeline |

## 2. Paths that require a second trusted reviewer

Changes touching these paths should not merge on the author's or a single owner's approval alone once a second reviewer exists:

- **CI and policy:** `.github/**` (including `CODEOWNERS`), `SECURITY.md`, `CONTRIBUTING.md`, `docs/SECURITY_MODEL.md`, `docs/RELEASE.md`, `docs/SECURITY_REVIEW.md`.
- **The scanner and its inputs:** `scripts/verify-public-source*`, `PUBLIC_SOURCE_MANIFEST.json`, `source-test-exclusions.json`, `package.json` scripts.
- **Build and dependency ingestion:** `src-tauri/build.rs`, all `Cargo.toml`/`Cargo.lock`, `package.json`, `package-lock.json`, `src-tauri/tauri*.conf.json`, build scripts under `scripts/`, any `.npmrc`/`.cargo/config*`.
- **Update and signing:** `src/application/update*.ts`, `electron/updateIpc.ts`, `scripts/update-channel*`, `scripts/signing-readiness.mjs`, `scripts/release-evidence.mjs`, `scripts/tauri-build.mjs`, `scripts/lib/authenticode.mjs`, update/install sections of `src-tauri/src/main.rs`.
- **Code and grants:** `plugins/**`, `src/plugins/**`, `native/hao-core/src/engine/plugin.rs`, `src/service/**`, `src/render/mediaProcess.ts`, `electron/**`, `src-tauri/src/**`.

Current `CODEOWNERS` covers `/.github/`, `/scripts/`, `/src-tauri/`, `/native/` and (via `*`) everything, all with the single owner. Adding a second owner requires the account rule below.

### Granting reviewer access

1. The maintainer confirms the exact GitHub login **and numeric account ID** through a channel they already trust, and asks the person to acknowledge from that account.
2. Review prior contributions, security competence and conflicts of interest.
3. Confirm two-factor authentication only through controls the maintainer can actually see; do not infer it from a public profile.
4. Grant the **least privilege** that the workflow needs. A pull-request review does not require write, and **never administrator access just for code review**. Grant write only if a CODEOWNERS workflow genuinely needs it.
5. Record the decision (who verified, how, when, what role).
6. Sensitive-path changes need an approval from someone other than the author, given after the latest security-relevant push (stale approvals dismissed).

## 3. Source scanner review

`scripts/verify-public-source.mjs --scan` (CI) and `--self-test` (15 negative controls) were reviewed by reading the code and by experiment. Method: copy the checkout to a throwaway directory (excluding `node_modules`, `.git`, build outputs), apply one change at a time, run `node scripts/verify-public-source.mjs --scan`, then revert. The baseline was GREEN and the self-test reported 15 controls. The real checkout was left unchanged.

Root-anchored `.gitignore` entries (`/release/`, `/dist/`, `/out/`, `/reports/`) do **not** ignore nested directories of the same name (`git check-ignore` returned no match), so these paths are committable.

### Confirmed bypasses (scan stayed GREEN)

Controls that were caught are listed at the end. Everything below returned `{"status":"GREEN"}` when it was reviewed. The **Status** column records the follow-up scanner hardening described after the table: **closed** means the reported repro now turns `--scan` RED, **narrowed** means only the stated part is now caught, and **open** means unchanged.

| # | Bypass | Minimal repro | Needs | Status |
| --- | --- | --- | --- | --- |
| B1 | Scanner skips directories named `.git`, `.rd`, `node_modules`, `dist`, `desktop-dist`, `.web-public`, `out`, `release`, `reports`, `target` at **any depth**, and `target-*`, `product-*`, `.web-public-*` | Put a PKCS#8 key or `evil.exe` in `src/release/` or `src/out/` | Move the skip list to explicit root-anchored paths matching `.gitignore` | **Closed** for nested names: only the root `.git` (a directory, or a file in a git worktree) and the root-anchored generated-output entries of `.gitignore` are skipped, and the scan fails if one of those entries leaves `.gitignore`. **Open:** a file force-added (`git add -f`) under one of those ignored root directories is still not scanned |
| B2 | Private-key check matches only the exact PKCS#8 marker; RSA/EC/OPENSSH markers pass | A file whose PEM header names an RSA private key | Add key-marker variants; consider a real secret scanner (push protection covers provider tokens on GitHub) | **Closed:** every `-----BEGIN <UPPERCASE WORDS> PRIVATE KEY-----` and `… PRIVATE KEY BLOCK-----` header (PKCS#1/#8, EC, DSA, OpenSSH, encrypted, PGP) is rejected. Other key formats still rely on review and secret scanning |
| B3 | Token patterns cover only GitHub and `sk-`; AWS `AKIA…`, Slack `xox…`, generic `PASSWORD=` pass | `// AKIA…`, `// xoxb-…` in a source file | Extend patterns or rely on GitHub secret scanning; human review for generic secrets | **Narrowed:** AWS access key IDs (`AKIA`/`ASIA` + 16 characters), Slack tokens (`xoxb-` and the other `xox?-` prefixes) and Google API keys (`AIza` + 35 characters) are rejected. **Open:** generic secrets such as `PASSWORD=` and other providers' tokens |
| B4 | Private-path check knows only a Windows user-profile path under drive C and one owner-specific drive D path; `/Users/name/…` and `/home/name/…` pass | `// /Users/someone/private/project` | Add POSIX home paths | **Closed:** `/Users/<name>/…` and `/home/<name>/…`, also after `file://`, are rejected unless `<name>` is a placeholder (`someone`, `name`, `user`, `username`, `example`, `runner`). The repro above uses the placeholder `someone`, so it stays allowed by design; any other name fails |
| B5 | Only `source-ci.yml` is inspected, with regexes. A **new workflow** with `pull_request_target`, `permissions: write` and `secrets.*` passes; so do job-level `permissions: contents: write`, `secrets['X']`, an unpinned action, and an added `curl … \| sh` step | New `.github/workflows/evil.yml` | Human review is mandatory for `.github/**`; automated check could parse every workflow as YAML (triggers, permissions, pins, secrets) | **Narrowed:** every file under `.github/workflows/` now fails on a `pull_request_target` or `workflow_run` trigger, any `secrets` reference (including `secrets: inherit`), `write-all`, `contents: write`, and a `uses:` that is neither local (`./`) nor pinned to a full 40-hex commit SHA. **Open:** other write scopes (such as `actions: write`, or `id-token: write` outside `source-ci.yml`), other privileged triggers such as `issue_comment`, `run:` steps such as `curl … \| sh`, and YAML forms the regex checks do not model |
| B6 | The scanner and the workflow that runs it come from the PR itself | Replace `scripts/verify-public-source.mjs` with a stub printing `{"status":"GREEN"}` | Cannot be fixed by the scanner. Requires a second reviewer on those paths and, ideally, running the scanner from the base branch (for example a separate `pull_request_target` job that checks out only trusted code — needs its own design review) | **Open** |
| B7 | Binary extensions (`.ttf`, `.mp4`, `.png`, …) are allowed by a `rights` string **the PR writes in `PUBLIC_SOURCE_MANIFEST.json`**; contents are not inspected in scan mode | Manifest row with `rights: "SIL-OFL-1.1"` for `public/fonts/evil.ttf` containing ELF bytes | Human review of any manifest or binary change; content sniffing (magic bytes) | **Open** |
| B8 | Module-boundary check covers only static `./` or `../` specifiers; `import(variable)` and absolute-path imports pass | `import x from '/etc/passwd'` | Low value as a security control; treat as a hygiene check | **Open** |
| B9 | Dependency and lifecycle changes are not scanned: `postinstall` in `package.json`, `github:` dependencies, `.npmrc` registry redirect, Cargo `[patch]` to a git URL | Edit `package.json` / `src-tauri/Cargo.toml` | Human review; CI could fail on non-registry lock sources and on new lifecycle scripts; consider `npm ci --ignore-scripts` where the build allows it. Note that pull request #29 legitimately introduces pinned git `[patch]` sources, so this rule needs an explicit allowlist rather than a blanket ban | **Open** |
| B10 | Text-only checks miss encoded payloads: a 200 KB base64 blob in `.ts`, a UTF-8-valid NUL-free binary named `.bin`, a bidi override character, hidden files such as `.env` with short secrets | See the corresponding scanner tries | Human review; size limits and bidi detection are possible additions | **Narrowed:** bidi override and isolate controls (U+202A–U+202E, U+2066–U+2069) are rejected in text files, file names and the manifest; U+200E/U+200F stay allowed. **Open:** encoded blobs, UTF-8-valid binaries with unlisted extensions, short secrets in hidden files |
| B11 | Case-variant of a forbidden directory (`Vendor/`) passes on case-insensitive filesystems | `Vendor/x.txt` | Compare directory names case-insensitively | **Closed:** forbidden directory and root file names are compared case-insensitively |

Caught by the scanner (controls that work): PKCS#8 marker, Windows user-profile paths, `.exe` outside skipped directories, relative imports leaving the root, symlinks, binaries containing NUL bytes with a text extension.

### Follow-up scanner hardening (2026-10-06)

`scripts/verify-public-source.mjs` implements the closed and narrowed rows above. Generated output is skipped only at the `.gitignore` entries `/.rd/`, `/node_modules/`, `/dist/`, `/desktop-dist/`, `/.web-public/`, `/.web-public-*/`, `/out/`, `/release/`, `/reports/`, `/native/**/target/`, `/src-tauri/target/`, `/src-tauri/target-*/` and `/src-tauri/product-*/`, plus the root `.git`. `spikes/gpu-compositor/target/` is not in `.gitignore`, so a local build of that crate is now scanned and reported. `--self-test` runs 69 negative controls and 21 positive controls (placeholder home paths, U+200E/U+200F, the skipped locations and their `.gitignore` entries, pinned and local actions, and the `pages`, `id-token` and `security-events` write scopes used by the current workflows). With the method above on a throwaway copy, the previous scanner stayed GREEN and the hardened scanner turned RED for `src/release/evil.key`, an RSA private-key header, a home path with a real user name, U+202E, `Vendor/x.txt`, an AWS-shaped key ID and a new workflow using `pull_request_target`, among other probes. The unmodified tree stays GREEN, including from a git worktree whose `.git` is a file.

### What this means

Every bypass above that is still open is reachable by an external contributor with an ordinary pull request, and B6 lets such a pull request replace the scanner itself. The scanner therefore cannot be the security boundary. The real boundary is human review of the sensitive paths in section 2, GitHub secret scanning and push protection, and the absence of secrets and release credentials in PR workflows.

## 4. Repository controls

Observed by read-only `gh api --method GET` calls. Permission-denied results are **unverified**, not "disabled". The upstream repository was queried as a non-collaborator (`pull` permission only).

| Control | Upstream `Hao0321/Editkin` | Note |
| --- | --- | --- |
| Branch `main` protected, required checks | **Verified:** protected; required checks `Source (ubuntu-latest)`, `Source (windows-latest)`, `Source (macos-latest)`; enforcement `non_admins` | Matches `docs/SECURITY_MODEL.md` for the three checks. The Linux GTK job added in PR #29 would not be required until the maintainer adds it |
| Required review, CODEOWNERS review, stale-approval dismissal, force-push/deletion, admin bypass | **Unverified:** `branches/main/protection` returned 404 | Do not report the documented claims as false or true |
| Rulesets | **Verified:** none | Classic protection is the only mechanism seen |
| Default `GITHUB_TOKEN` permission, fork-PR approval policy, allowed actions, SHA-pinning requirement | **Unverified:** HTTP 403 | The maintainer should record these. On the contributor's own fork the observed values were read-only default token, approval for first-time contributors only, all actions allowed, SHA pinning not required |
| Actions secrets and variables | **Unverified:** HTTP 403 | Workflow files reference no secrets |
| Environments (protected release environment) | **Verified:** none | No release environment exists |
| Releases | **Verified:** none published | |
| Collaborators / who has write or admin | **Unverified:** HTTP 403 | The maintainer should record the list |
| CODEOWNERS syntax | **Verified:** no errors | Valid syntax does not prove independent review; only one owner exists |
| Private vulnerability reporting | **Verified:** enabled | `SECURITY.md` points here |
| Secret scanning and push protection | **Unverified upstream** (field omitted) | Enabled on the contributor's fork only |
| Workflow permissions in files | **Verified:** `source-ci` and `dependency-review` use `contents: read`; **`codeql.yml` also declares `security-events: write`** | So not every workflow is read-only; `SECURITY_MODEL.md` should say so |
| Actions pinned by commit | **Verified** in all three workflow files | Repository enforcement was unverified from the contributor account; see the owner readback below |

### Maintainer readback, 2026-09-30

The maintainer queried the upstream repository with the owner account. These observations supplement the contributor's assessment; they do not imply that unobserved controls are enabled.

- `main` requires the three Source checks above with strict current-base checks, one approving review, CODEOWNERS review, stale-approval dismissal, latest-push approval and resolved conversations. Force pushes and deletion are disabled, and linear history is required. `enforce_admins` is false, so the owner can bypass these requirements; a bypass is not evidence of independent review.
- The default Actions token is read-only and Actions cannot approve pull requests. All external contributors require workflow approval. `allowed_actions` is `all`, with **`sha_pinning_required: true`**; commit pinning is enforced by repository policy.
- The verified collaborators are `Hao0321` (Admin) and `teddashh` (Write). The latter is not currently a CODEOWNER or an assigned second reviewer. A pending invitation grants no active access.
- Secret values were not read. Secret scanning, push protection and protected release credentials are not certified by this readback.
- The Linux GTK desktop check proposed in #29 still needs to complete before that dependency migration can merge. Its required-check configuration must be read back after any maintainer update.

### Documentation claims to reconcile

- "Read-only CI": true for `source-ci` and `dependency-review`; `codeql.yml` additionally has `security-events: write`.
- "CODEOWNERS review, stale approvals dismissed, force-push disabled": upstream detail is unverified; the maintainer should confirm and record it.
- "Secret scanning / push protection enabled": upstream is unverified from outside the repository.
- No release environment or release workflow exists; `docs/RELEASE.md` describes a future gate.

## 5. Rollback procedure (proposal)

No release exists today, so none has been revoked; the steps below are a runbook for a future incident.

1. **Contain.** Pause publication, withdraw update manifests and download links, keep the offending commit, artifact hashes, logs and signing evidence.
2. **Revert source through a reviewed PR.** Branch, `git revert` the offending commits (for a merge commit, choose the parent with `-m 1` only after checking the topology), pass the required checks and the sensitive-path review. Do not force-push or reset protected history.
3. **Revoke the release.** Mark it withdrawn, quarantine the installers, disable the update manifest, publish an advisory and a **higher-version** replacement built from known-good source after the `docs/RELEASE.md` exact-artifact gates. Reverting code does not withdraw cached binaries.
4. **Do not confuse recovery with revocation.** `src/application/updateManager.ts` can mark `rollback_required` and reuse a cached `previousInstaller`; that is availability recovery, not a signature or revocation mechanism. Verify a known-good installer independently and never weaken the Authenticode checks.
5. **Rotate credentials.** Revoke a compromised OS certificate through its issuer and replace signer inputs in a protected release environment, then re-sign and re-attest clean artifacts. No key-rotation runbook exists yet; `updateTrust.ts` has policy and key fields for future rotation but is not consumed by the active updater.

## 6. Follow-ups (recorded here; no issues were created)

1. Maintainer records the unverified upstream settings in section 4 (branch protection details, Actions policies, secrets, collaborators, secret scanning) — without secret values.
2. Confirm the second reviewer's exact GitHub account, then update `CODEOWNERS` and required review for the sensitive paths.
3. Scanner bypasses: B1, B2, B4 and B11 are closed and the cheap parts of B3, B5 and B10 are in place (section 3). Still open and needing human review or design: B6–B9; generic secrets (B3); other workflow write scopes, privileged triggers, `run:` steps and full YAML parsing (B5); encoded payloads and binary content (B10); and files force-added under ignored root directories (B1).
4. Integrate `updateTrust.ts` into the active updaters or remove the false impression that it is used (relates to #20).
5. Add a release and key-rotation runbook and a protected release environment before any signing (relates to #20).
6. Existing related issues: #19 (glib, PR #29), #20 (release gate, PR #30), #24 (CodeQL findings), #25 (remote relay).

## Limits of this assessment

Point-in-time, run by one contributor without upstream administrative access. It reviewed the source and the scanner and ran a bounded set of bypass experiments; it did not audit the whole codebase, dependencies, native plugin code or the Tauri/Electron IPC surface for vulnerabilities.
