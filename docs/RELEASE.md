# Official binary release gate

The source repository does not publish an official installer. The maintainer must close these gates for the exact binary revision and payload before enabling an official download:

1. Build from a protected main commit with pinned dependencies and a recorded file manifest.
2. Verify every bundled third-party binary's license, notices, corresponding source, and exact hash. FFmpeg's statically linked external libraries need their actual source revisions and build information.
3. Complete Windows and macOS edit, preview, save/reopen, and export tests against delivered installers, including output inspection.
4. Sign Windows and macOS payloads with the official identity; notarize macOS; verify the delivered signatures and installer contents.
5. Keep signing secrets in the protected release environment. Attest the final artifact and publish its SHA-256 with release notes.
6. Test the immutable HTTPS update manifest from a previous signed version.

Passing CI or a static scan cannot replace these checks. Contributions may be merged while official binary publication remains closed.
