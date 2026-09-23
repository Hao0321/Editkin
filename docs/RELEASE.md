# Official binary release gate

The source repository does not publish an official installer. The maintainer must close these gates for the exact binary revision and payload before enabling an official download:

1. Build from a protected main commit with pinned dependencies and a recorded file manifest.
2. Verify every bundled third-party binary's license, notices, corresponding source, and exact hash. FFmpeg's statically linked external libraries need their actual source revisions and build information.
3. Complete install, edit, preview, save/reopen, and export tests against each platform's exact delivered artifact, including output inspection. Do not claim an untested platform.
4. Publish an SBOM, final SHA-256, corresponding source, and project-key-signed release metadata. Clearly label any artifact that lacks operating-system code signing. OS signing and macOS notarization are recommended when available, but their cost does not block the community source edition.
5. Keep any project or OS signing keys in a protected release environment. Attest and verify the exact final artifact before publication.
6. The current packaged Windows updater requires Authenticode. An unsigned build must leave automatic installer updates disabled until an independently reviewed project-key update design is implemented and tested against tampering, rollback, and a previous release. Never relax the current signature check merely to ship an unsigned installer.

Passing CI or a static scan cannot replace these checks. Contributions may be merged while official binary publication remains closed.
