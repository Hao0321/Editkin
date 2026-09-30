# Source contribution and release security model

No automated verifier can prove that a pull request contains no malicious logic. The controls here make risky changes visible, limit what untrusted code can reach, and keep official release credentials separate.

1. **Source boundary:** the initial allowlisted publication snapshot carries a hash manifest. Its exact verifier rejects changed or unmanifested files. Ongoing PR checks scan the current tree for unauthorized binaries, key material, private directories, unexpected credential patterns, and changes to the public default-pack identity. The verifier runs self-tests with negative controls.
2. **Pull request boundary:** fork PR code runs with read-only repository permission and without signing or publication secrets. Actions are pinned by commit. Dependency review and CodeQL provide additional signals. Maintainers inspect every change and its dependency/asset provenance. A passing scan is never automatic merge approval.
3. **Protected main:** contributors must use pull requests, pass the three platform checks, and receive a CODEOWNERS review; stale approvals are dismissed after a new push. Force pushes and branch deletion are disabled. The repository owner currently retains GitHub's administrator bypass for initial setup, so these rules do not technically stop the owner's own direct push. Security-path changes still need human review. Private vulnerability reporting and secret scanning/push protection are enabled.
4. **Official release boundary:** release signing belongs in a separate protected environment with required reviewers and a manual trigger from a protected main commit. Rebuild, inspect, sign, attest, and verify the delivered binary before publication. A PR artifact is never an official download.
5. **Runtime boundary:** external Skills, plugins, models, and media are untrusted inputs. Review requested permissions, use explicit user installation, and keep private user files and credentials out of telemetry and logs. A repository badge or popularity does not grant trust.

The community source build currently has no signed installer claim. The 39 integration suites listed in [source-test-exclusions.json](../source-test-exclusions.json) need external runtimes, the separate video-autopilot skill, or generated release products; the default CI result does not cover them. The Windows Authenticode installer suite runs only on Windows. See [RELEASE.md](RELEASE.md) for the remaining official binary gate.

## Desktop IPC path grants

The desktop shells (Tauri, and the legacy Electron shell) do not trust file paths that arrive from the renderer. The main process keeps two allow-lists for the session:

- **Project files:** the path the user picked in an open dialog, chose in a save dialog, or that a recovery snapshot records (recovery only stores granted paths). A regular save, and a recovery snapshot that names a project path, are refused for any other path. Project files must end in `.editkin.json` or `.haoedit.json`; `save_project` refuses other extensions and points the user to Save As.
- **Source media:** files the user imported through the picker or by dropping them on the window (the drop is recorded by the native window event, not reported by the webview), plus the media referenced by a project the user opened. Preview URLs, proxy/cache preparation and analysis commands (smart cut, captions, scene detection, motion tracking, Auto Roto) refuse an absolute source outside this list. A relative source may only resolve inside the bundled asset base, without `..` or a URL scheme.
- **Derived files:** proxy, thumbnail and waveform paths must be inside Editkin's `media-cache`.

Limits: a project file you open still names its own media, so opening a hostile project grants those paths (see the UNC path guard for the network-share case). `render_project` and `render_alpha_master` take their asset list from the renderer and are not yet bound to this list, and the browser MCP server keeps its own workspace boundary.
