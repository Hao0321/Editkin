# Local Agent conversations and personal extensions

The Agent dock uses one conversation surface for local models, provider APIs and provider login. Its local library is independent of the selected provider. It is private application data, never a release resource, source artifact or cleanup cache.

## Storage and isolation

The desktop service stores `agent-library/v1/history.sqlite` under its application data directory using the bundled Node SQLite runtime. No new package or background service is required. Records survive restarting the application. They contain displayed user/assistant text, plan and tool summaries, turn status and model metadata. The library does not store account files, attachment bytes, hidden reasoning or raw tool arguments/results. Known credential patterns and OAuth URL parameters are redacted before writing. This is a local, unencrypted database protected by the operating system account; it is not an encrypted vault or a guarantee that every possible secret can be recognized in free text.

Isolation is keyed to the canonical bound project file, including Windows case normalization. Two project files in the same directory have separate library scopes and separate native Agent conversation workspaces. The editing MCP still receives the real project directory and enforces its existing project and Kit boundaries. Changing provider/model preserves the conversation. Renaming/moving a project file creates a different scope. A future explicit migration can move history; the application does not silently join those scopes.

The history control searches titles and displayed conversation content locally, with 20 conversations/entries per page. It does not incur a model call. Read-only history cannot execute a tool. Continuing a conversation is a separate action and requires ownership in the current project library; ownership checks do not depend on the first 80 list results. Loading native history does not append replayed events to the library. The transcript retains its 500-entry display bound. Archive text has a one-million-character bound per entry and marks truncation; the reader displays at most 100,000 characters per entry. Attachments and raw tool outputs remain outside this summary library.

Recording begins with this version. Older native conversations are retained in their original local runtime store and are not automatically imported into a project whose ownership cannot be proven. User history and personal extensions must never be pruned as stale test/build artifacts.

## Versioned desktop/service interface

`window.haoDesktop.agentLibrary(request)` routes through the native `opencode_agent_library` command and resident `agent_acp_library` operation. Requests use `editkin.agent-library/v1`, with the current snapshot's opaque `libraryBinding` as a precondition. It must equal the service's current bound scope, so a queued request cannot write into a newly switched project. Callers cannot provide a filesystem path or select another scope. Unknown fields, unsupported versions, invalid pagination and foreign session IDs are rejected.

Actions are `search` (query/offset), `read` (sessionId/offset), `draft` (sessionId), `extensions`, and `save-extension` (manifest). Read/search/draft are local operations and never prompt a model. A failed archive write is surfaced in the dock and blocks another prompt until reconnect; it must not be reported as successfully recorded. The archive is not exposed to model MCP tools, which prevents silent cross-conversation context acquisition.

## Skills and plugins

Personal manifests use `editkin.agent-extension/v1`: UUID `id`, `kind` (`skill` or `plugin`), name, instructions (maximum 2,400 characters), `hooks: ["prompt-context"]`, enabled flag, visibility (`project` or `personal`), and optional sourceSessionId. The creator project owns editing; `personal` is an explicit permission to reuse the rewritten rules across projects, not to read the source conversation.

A history-derived skill starts as a disabled local draft with excerpts from the last four displayed user/assistant messages. It must be rewritten before activation. There is no automatic training, self-modification or cloud summarization. The editor explains that enabled rules are sent with the next prompt to the selected provider. Original history is not automatically sent.

Both skills and declarative plugins implement the same provider-neutral `prompt-context` hook, with at most four active manifests and a total 3,200-character prompt budget. Oversized active rules are rejected instead of silently cutting an instruction in half. A plugin cannot grant tool permissions, execute shell/code, add a provider or access other conversations. Those unsupported hooks and manifest fields are rejected. Editing still goes through the existing Editkin MCP command schemas, project guards and audit/apply/render/review flow.

This interface supports personal guidance plugins today. It does not install arbitrary executable Agent plugins. Existing video-effect/plugin SDKs are a separate interface; executable Agent plugins require a separately reviewed capability and sandbox contract before support can be claimed.

## Verification

Synthetic tests cover service restart, same-folder project isolation, stale bindings, more than 80 conversations, paged read/search, streaming updates, known credential redaction, disabled skill drafts, explicit sharing, source ownership, unsupported plugin hooks and prompt budgets. Packaged acceptance should also exercise the native bridge, history UI, resume, skill editing and the common provider window. The portable privacy gate rejects local library directories and SQLite files in release resources.
