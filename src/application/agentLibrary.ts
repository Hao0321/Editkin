// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 djguan-jpg (https://github.com/djguan-jpg)
// Agent contribution: urn:uuid:d366cab7-d5a4-44d8-b80d-4c7ce4daf65d. See AGENT-NOTICE.md.
/** Provider-neutral, local-only Agent library. Binding is a precondition, never a selectable scope. */
export const AGENT_LIBRARY_SCHEMA = "editkin.agent-library/v1" as const;
export const AGENT_EXTENSION_SCHEMA = "editkin.agent-extension/v1" as const;
export interface AgentLibrarySession { sessionId: string; title: string; updatedAt: string; model?: string }
export interface AgentLibraryEntry { id: number; kind: string; text: string; status?: string; createdAt: string; truncated?: boolean }
export interface AgentExtension {
  schema: typeof AGENT_EXTENSION_SCHEMA;
  id: string;
  kind: "skill" | "plugin";
  name: string;
  instructions: string;
  hooks: ["prompt-context"];
  enabled: boolean;
  visibility: "project" | "personal";
  sourceSessionId?: string;
}
export type AgentLibraryRequest = { schema: typeof AGENT_LIBRARY_SCHEMA; binding: string } & (
  | { action: "search"; query?: string; offset?: number }
  | { action: "read"; sessionId: string; offset?: number }
  | { action: "extensions" }
  | { action: "draft"; sessionId: string }
  | { action: "save-extension"; extension: AgentExtension }
);
export interface AgentLibraryReply {
  schema: typeof AGENT_LIBRARY_SCHEMA;
  sessions?: AgentLibrarySession[];
  entries?: AgentLibraryEntry[];
  extensions?: AgentExtension[];
  draft?: AgentExtension;
  nextOffset?: number;
}
