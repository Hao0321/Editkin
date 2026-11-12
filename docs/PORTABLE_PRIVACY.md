# Portable preview privacy checks

`node scripts/community-portable-build.mjs` runs a local privacy gate before it
reports a completed build. The gate rejects local build identities, recognized
credential token patterns, credential store filenames, conversation logs,
Python bytecode, PDB files and symlinks. It reports categories and relative file
locations, never matched credential values, and does not open credential stores.

The portable Rust profile remaps source paths, omits debug information and
compiles the development checkout fallback out of the application. The normal
development profile retains its checkout behavior. Both Kit Python entry points
disable bytecode writing so using a preview does not add local source paths to
its bundled resources. Third-party executables remain pinned and unmodified;
their public upstream parser strings and build metadata are separate from local
user data. License notices must remain intact.

User API keys, account state, project data and conversations belong in local
application data or the selected workspace. They must never be copied into a
portable preview or a source submission. Public API endpoint URLs and protocol
definitions are part of the integration and are not credentials.

Before sharing, rerun the gate after native editing and Kit execution, review
the source snapshot and submission text, and audit outgoing Git objects and
commit author metadata. Use an approved public identity or GitHub's no-reply
email for new submissions. A clean source snapshot does not make old Git
history safe to push. Pattern checks cannot prove the absence of every possible
secret or private statement; review and release provenance remain necessary.
