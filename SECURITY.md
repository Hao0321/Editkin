# Security policy

Please report a suspected vulnerability privately through [GitHub private vulnerability reporting](https://github.com/Hao0321/Editkin/security/advisories/new). Include the affected version or commit, a minimal reproduction, the expected security boundary, and potential impact. Do not include live credentials or private user media. If private reporting is unavailable, open a public issue requesting a private contact without exploit details.

Pull requests are untrusted input. CI runs with read-only repository access and no release secrets. A successful scan is useful evidence, not a guarantee that code is harmless. Maintainers review new network behavior, file writes, process execution, dependencies, and build scripts before merging. Only the protected main branch may feed an official release, and signing credentials stay in a separately approved release environment.

Official binary downloads and update manifests will be identified in release notes once the binary release gate is complete. A source build or pull-request artifact is not an official binary.
