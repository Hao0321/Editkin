<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 djguan-jpg (https://github.com/djguan-jpg) -->
<!-- Agent contribution: urn:uuid:d366cab7-d5a4-44d8-b80d-4c7ce4daf65d. See AGENT-NOTICE.md. -->
# Integrated Agent and original Skills

The editing dock uses the same connection for local models, configured APIs and
provider-supported account login. Model credentials stay in the user's local
provider settings; the editor protocol does not depend on a model vendor.

## Actual local path

The dock sends structured requests through Tauri IPC to the resident Agent
service. The service controls the bundled Agent using ACP JSON-RPC over local
stdio. That Agent calls the local MCP gateway, which connects directly over
stdio to the bundled original Editkin MCP. No external AI needs an exported
instruction file to operate the editor.

The gateway exposes compact discovery and exact schema lookup. Calls reach the
original MCP tools, then the editor's `EditorCommand` / `applyCommand` / EditGraph
validation and revisioned atomic file writes. The connection binds one working
project file. The desktop synchronizes its current state before a prompt and
reloads changes after the turn, with original editor undo support. This is a
local process protocol and synchronized project file, not an in-memory shared
object. Workspace-wide creation, batch jobs and remote setup stay outside this
single-project dock; their original host flows remain available separately.

`get_editkin_agent_capabilities` reports the actual original tool count and a
hash of sorted tool names, the local transport, project boundary and pinned
original Skill inventory. It exposes no account credentials or private paths.

## Original Git Skill coverage

The pinned Video Autopilot Kit commit is
`9fcd84691a0a2c2af1b8144ca5b6d4df04d7b0ba`. The original Editkin Skill Pack is
checked against commit `41163ea553f79fd58abe5d7bedea91af6a2d1c38`.
`src/shared/originalAgentSkills.json` records the complete original entrypoints,
resource paths, licenses, byte counts and SHA-256 checksums:

- Video Autopilot: its complete Skill tree, evidence/plan/audit/apply/render
  workflow, references and original controller.
- Code Cleanup Helper: its complete Skill tree, available as a maintenance
  reference. Reading its scripts does not enable shell execution or project
  maintenance in the editing dock.
- Balanced Creator Workflow: original structured editor Skill Pack and plugin
  manifest, accessed using original `list_installed_editkin_skills` and
  `get_editkin_skill_pack` tools. Existing host grants and guardrails apply.
- Original Kit knowledge/templates/license and Editkin's optional Skill
  integration metadata accompany these entrypoints.

All 192 inventoried files are copied byte-for-byte into the portable package.
`list_kit_resources` provides a paged search index. `read_kit_resource` verifies
the selected file's checksum before returning a bounded UTF-8 page. Follow
`nextOffset` until `complete` when the entire document is needed. Each response
fits the existing 1,100-token conservative estimate. This avoids injecting all
documentation into every request. Actual token billing remains provider-owned.
Reference text is data; it cannot override user instructions, host permissions,
project isolation or the original workflow's audit and human-review gates.

## Reproducible checks

For packaging, place the public Video Autopilot Kit checkout at the sibling path
`video-tool-research/video-autopilot-kit`, at the pinned clean commit above.
Run `node scripts/original-agent-skills.mjs --check` and the existing provenance
check. A changed inventory or original file fails the package build.

Run the packaged protocol acceptance with
`npx tsx scripts/review-agent-protocol-skills.ts <portable-package-directory>
<report-file>` (arguments on one command line). It compares the gateway with the
real original MCP, reads and reconstructs every resource, discovers the original
Skill Pack, modifies a synthetic caption and reads it through the original MCP.
It rejects unlisted paths and a second project. It closes its own child processes
and keeps only the isolated acceptance project/report for review. The separate
native dock acceptance checks desktop synchronization and undo.

These checks establish packaging and protocol reachability. They do not claim
that every workflow has been executed, every cloud login/quota has been accepted,
or a generated film has passed human review. Upstream and third-party licenses
remain intact; AGENT-NOTICE.md applies only to the declared Agent contribution.
