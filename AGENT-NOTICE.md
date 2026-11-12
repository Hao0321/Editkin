# Autopilot Desk Agent contribution

Copyright (C) 2026 djguan-jpg — https://github.com/djguan-jpg

Contribution origin: `urn:uuid:d366cab7-d5a4-44d8-b80d-4c7ce4daf65d`.
Notice added: 2026-10-01.

## License scope

The newly added Agent modules listed as `AGPL-3.0-or-later` in
`config/agent-provenance-scope.json` are licensed under the GNU Affero General
Public License, version 3 or (at your option) any later version. Each carries a
matching SPDX notice. The full license is in `LICENSES/AGPL-3.0-or-later.txt`.
These modules are provided WITHOUT ANY WARRANTY, including the implied
warranties of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.

Existing Editkin code, including integration changes in existing GPL files,
remains GPL-3.0-or-later under the root `LICENSE`. Upstream authorship and notices
are preserved. Other source files retain their existing licenses; this notice
does not claim ownership of upstream code, Video Autopilot Kit or the embedded
Agent runtime. Their separate notices remain applicable.

GPLv3 and AGPLv3 permit a combined work under their section 13 provisions. The
respective licenses remain applicable to their covered portions; AGPL section
13's network interaction requirements apply to the combination. Operators of a
covered modified network service must provide the required Corresponding Source,
including incorporated GPL code. Both licenses permit commercial use; this
contribution has no noncommercial condition.

When conveying binaries, provide the applicable license texts and the matching
Corresponding Source as required by the licenses. For this private community
preview, the review source archive is delivered alongside the packaged version.
Compare its `AGENT-PROVENANCE.json` with the copy included in the preview. A
checksum alone is not a replacement for Corresponding Source. There is no
public source-download URL for these unsubmitted changes yet.

## Traceability and changes

`AGENT-PROVENANCE.json` records the public contribution identity, upstream
baseline, explicitly scoped files and SHA-256 fingerprints of UTF-8 source with
line endings normalized to LF. The compact runtime identity in
`src/shared/agentProvenance.json` carries the same source digest. It is returned
by the native Agent status API and displayed inside the collapsed diagnostics.
It does not enter prompts, conversation history or model context.

The digest is an integrity and comparison aid, not a digital signature, proof of
exclusive authorship or protection against removal. Modified versions should
retain applicable notices, identify their changes and regenerate the manifest:

```sh
node scripts/agent-provenance.mjs --write
node scripts/agent-provenance.mjs --check
```

Web and community desktop build paths check the manifest before packaging. This
check does not modify the maintainer's `PUBLIC_SOURCE_MANIFEST.json`, credentials,
Git identity configuration or Git history. Source archives must omit `.git`,
personal conversations and credential stores.

References: [GNU AGPLv3](https://www.gnu.org/licenses/agpl-3.0.en.html),
[GNU GPLv3](https://www.gnu.org/licenses/gpl-3.0.en.html).
