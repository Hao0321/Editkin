# Source contribution and release security model

No automated verifier can prove that a pull request contains no malicious logic. The controls here make risky changes visible, limit what untrusted code can reach, and keep official release credentials separate.

1. **Source boundary:** a fresh, allowlisted snapshot carries a hash manifest. The source verifier rejects unmanifested files, unauthorized binaries, key material, private directories, unexpected credential patterns, and changes to the public default-pack identity. It runs self-tests with negative controls.
2. **Pull request boundary:** fork PR code runs with read-only repository permission and without signing or publication secrets. Actions are pinned by commit. Dependency review and CodeQL provide additional signals. Maintainers inspect every change and its dependency/asset provenance. A passing scan is never automatic merge approval.
3. **Protected main:** direct pushes and force pushes should be disabled, required checks must finish, CODEOWNERS review must be requested, and stale approvals should be dismissed after a new push. Owners should review workflow and security-path changes themselves. Enable private vulnerability reporting and GitHub secret scanning/push protection where available.
4. **Official release boundary:** release signing belongs in a separate protected environment with required reviewers and a manual trigger from a protected main commit. Rebuild, inspect, sign, attest, and verify the delivered binary before publication. A PR artifact is never an official download.
5. **Runtime boundary:** external Skills, plugins, models, and media are untrusted inputs. Review requested permissions, use explicit user installation, and keep private user files and credentials out of telemetry and logs. A repository badge or popularity does not grant trust.

The community source build currently has no signed installer claim. The 38 integration suites listed in [source-test-exclusions.json](../source-test-exclusions.json) need external runtimes or generated release products; the default CI result does not cover them. See [RELEASE.md](RELEASE.md) for the remaining official binary gate.
