# Dependency advisories

This file records the dependency advisories that are known and accepted, and how dependency updates are proposed. It complements the controls in [SECURITY_MODEL.md](SECURITY_MODEL.md).

## Automated updates

[`.github/dependabot.yml`](../.github/dependabot.yml) opens weekly update PRs for:

| Ecosystem | Directory | Why |
| --- | --- | --- |
| `github-actions` | `/` | Actions are pinned by commit SHA, so they never move without a PR. |
| `npm` | `/` | `package-lock.json`. |
| `cargo` | `/src-tauri` | Desktop shell, the largest Rust dependency tree. |
| `cargo` | `/native/hao-core` | Native core. |
| `cargo` | `/spikes/gpu-compositor` | GPU compositor runtime. `scripts/build-gpu-compositor.mjs` builds it and the Windows and macOS bundles ship it as `editkin-gpu-compositor`. |

Minor and patch updates are grouped into one PR per ecosystem. Major updates are separate PRs. Each update PR goes through the same checks as any other PR (Source CI, dependency review, CodeQL, CODEOWNERS review); Dependabot never merges anything.

`native/effect-test-plugin` has no registry crates, so it is not listed.

## Accepted advisories

The contributor's historical assessment used `main` at 7a27566 and reported no npm advisories and no advisories for `native/hao-core` after querying OSV for registry crates in the four lockfiles. This is an assessment of that revision, not a current dependency scan. The advisory identifiers below were checked against the official RustSec entries on 2026-09-30. Re-scan the actual release lockfiles before accepting a release.

The listed RustSec entries are classified as **unmaintained-crate** notices. That classification does not prove that a crate is free of vulnerabilities. They were transitive dependencies in the assessed revision.

### `src-tauri`

| Crate | Version | Advisory | Pulled in by |
| --- | --- | --- | --- |
| `proc-macro-error` | 1.0.4 | [RUSTSEC-2024-0370](https://rustsec.org/advisories/RUSTSEC-2024-0370.html) | `glib-macros`, `gtk3-macros` (GTK3 bindings used by Tauri on Linux) |
| `unic-char-property` | 0.9.0 | [RUSTSEC-2025-0081](https://rustsec.org/advisories/RUSTSEC-2025-0081.html) | `unic-ucd-ident` <- `urlpattern` <- `tauri-utils` |
| `unic-char-range` | 0.9.0 | [RUSTSEC-2025-0075](https://rustsec.org/advisories/RUSTSEC-2025-0075.html) | `unic-char-property`, `unic-ucd-ident` |
| `unic-common` | 0.9.0 | [RUSTSEC-2025-0080](https://rustsec.org/advisories/RUSTSEC-2025-0080.html) | `unic-ucd-version` |
| `unic-ucd-ident` | 0.9.0 | [RUSTSEC-2025-0100](https://rustsec.org/advisories/RUSTSEC-2025-0100.html) | `urlpattern` |
| `unic-ucd-version` | 0.9.0 | [RUSTSEC-2025-0098](https://rustsec.org/advisories/RUSTSEC-2025-0098.html) | `unic-ucd-ident` |

**Status: recorded maintenance exceptions, subject to release revalidation.** `proc-macro-error` is a procedural-macro helper; the Unicode crates also provide code and tables used at runtime by URL-pattern dependencies. Reachability and impact must be assessed separately. Re-check this table after changes to Tauri or its GTK dependency overrides: run `cargo tree -i <crate>` in `src-tauri` and remove the row if the crate is gone. This document adds no scanner exclusions and does not waive an exploitable or unsoundness advisory.

### `spikes/gpu-compositor`

| Crate | Version | Advisory | Pulled in by |
| --- | --- | --- | --- |
| `paste` | 1.0.15 | [RUSTSEC-2024-0436](https://rustsec.org/advisories/RUSTSEC-2024-0436.html) | `pulp` |
| `ttf-parser` | 0.25.1 | [RUSTSEC-2026-0192](https://rustsec.org/advisories/RUSTSEC-2026-0192.html) | `fontdue` |

**Status: recorded maintenance exceptions, subject to release revalidation.** Despite the `spikes/` path, this crate ships: `scripts/build-gpu-compositor.mjs` runs `cargo build --release --locked` on it, and `src-tauri/tauri.windows.conf.json` and `src-tauri/tauri.macos.conf.json` bundle the resulting `editkin-gpu-compositor` runtime. `ttf-parser` parses font files at runtime through `fontdue` (`src/caption.rs`). Both entries are unmaintained-crate notices, not known vulnerabilities; re-check them with `cargo tree -i <crate>` before each release and prefer replacing the dependency over renewing the exception.

## Not automated

There is no scheduled `cargo audit` or OSV job. `dependency-review` only runs on pull requests, so a new advisory against an already-locked Rust crate does not surface until a PR touches the lockfile. Until such a job exists, re-run the OSV query above before each release.
