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

Minor and patch updates are grouped into one PR per ecosystem. Major updates are separate PRs. Each update PR goes through the same checks as any other PR (Source CI, dependency review, CodeQL, CODEOWNERS review); Dependabot never merges anything.

`native/effect-test-plugin` has no registry crates and `spikes/gpu-compositor` is not part of the shipped product, so neither is listed.

## Accepted advisories

Status as recorded from `main` at 7a27566. `npm audit` reported 0 vulnerabilities. For Rust, OSV was queried for every registry crate in the four `Cargo.lock` files. `native/hao-core` had no advisories.

All entries below are **unmaintained-crate** notices, not known exploitable vulnerabilities. Each one is a transitive dependency; none is a direct dependency of this repository.

### `src-tauri`

| Crate | Version | Advisory | Pulled in by |
| --- | --- | --- | --- |
| `proc-macro-error` | 1.0.4 | RUSTSEC-2024-0370 | `glib-macros`, `gtk3-macros` (GTK3 bindings used by Tauri on Linux) |
| `unic-char-property` | 0.9.0 | RUSTSEC-2025-0075 | `unic-ucd-ident` <- `urlpattern` <- `tauri-utils` |
| `unic-char-range` | 0.9.0 | RUSTSEC-2025-0080 | `unic-char-property`, `unic-ucd-ident` |
| `unic-common` | 0.9.0 | RUSTSEC-2025-0081 | `unic-ucd-version` |
| `unic-ucd-ident` | 0.9.0 | RUSTSEC-2025-0098 | `urlpattern` |
| `unic-ucd-version` | 0.9.0 | RUSTSEC-2025-0100 | `unic-ucd-ident` |

**Status: accepted until the next Tauri bump.** They are compile-time helpers (procedural macros and Unicode tables) reached only through the Tauri stack; we do not depend on any of them directly, so they can only be dropped by an upstream change. `proc-macro-error` comes from the same GTK3 bindings as the `glib` advisory tracked in #19. Re-check this table whenever Dependabot proposes a `tauri`/`tauri-utils` bump: run `cargo tree -i <crate>` in `src-tauri` and remove the row if the crate is gone.

### `spikes/gpu-compositor`

| Crate | Version | Advisory | Pulled in by |
| --- | --- | --- | --- |
| `paste` | 1.0.15 | RUSTSEC-2024-0436 | `pulp` |
| `ttf-parser` | 0.25.1 | RUSTSEC-2026-0192 | `fontdue` |

**Status: accepted.** This directory is an experiment and is not built into the shipped product. Re-check if any of it is promoted into `src-tauri` or `native`.

## Not automated

There is no scheduled `cargo audit` or OSV job. `dependency-review` only runs on pull requests, so a new advisory against an already-locked Rust crate does not surface until a PR touches the lockfile. Until such a job exists, re-run the OSV query above before each release.
