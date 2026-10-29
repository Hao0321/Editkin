import { applyCommand, type EditorCommand, type EditorCommandContext } from "./commands";
import type { EditProject } from "./types";

export interface CommandRecord {
  id: string;
  command: EditorCommand;
  appliedAt: string;
}

export interface EditorHistory {
  past: EditProject[];
  present: EditProject;
  future: EditProject[];
  journal: CommandRecord[];
  /**
   * Set by a command that may merge with the next one of the same held gesture (a held Alt+← → nudge): while the next
   * command carries the same key and nothing else changed the project in between, it replaces the present instead of
   * adding an Undo step, so one Undo takes the whole gesture back.
   */
  coalesce?: { key: string; present: EditProject };
}

export function createHistory(project: EditProject): EditorHistory {
  return { past: [], present: project, future: [], journal: [] };
}

export function dispatchCommand(
  state: EditorHistory,
  command: EditorCommand,
  recordId = `cmd-${Date.now()}`,
  context?: EditorCommandContext,
  coalesceKey?: string,
): EditorHistory {
  const next = applyCommand(state.present, command, context);
  // The same held gesture continues: its first step already saved the state before it.
  const merge = coalesceKey !== undefined && state.coalesce?.key === coalesceKey && state.coalesce.present === state.present && state.past.length > 0;
  return {
    past: merge ? state.past : [...state.past.slice(-99), state.present],
    present: next,
    future: [],
    journal: [...state.journal, { id: recordId, command, appliedAt: next.updatedAt }],
    ...(coalesceKey !== undefined ? { coalesce: { key: coalesceKey, present: next } } : {}),
  };
}

export interface SafeDispatchResult {
  state: EditorHistory;
  error?: string;
}

export function dispatchCommandSafely(
  state: EditorHistory,
  command: EditorCommand,
  recordId = `cmd-${Date.now()}`,
  context?: EditorCommandContext,
  coalesceKey?: string,
): SafeDispatchResult {
  try {
    return { state: dispatchCommand(state, command, recordId, context, coalesceKey) };
  } catch (error) {
    return { state, error: error instanceof Error ? error.message : "操作失敗" };
  }
}

export function undo(state: EditorHistory): EditorHistory {
  const previous = state.past.at(-1);
  if (!previous) return state;
  // Undo ends a held gesture: a later step of it starts a new Undo step.
  const { coalesce: _ended, ...rest } = state;
  return {
    ...rest,
    past: state.past.slice(0, -1),
    present: { ...previous, revision: state.present.revision },
    future: [state.present, ...state.future],
  };
}

export function redo(state: EditorHistory): EditorHistory {
  const next = state.future[0];
  if (!next) return state;
  const { coalesce: _ended, ...rest } = state;
  return {
    ...rest,
    past: [...state.past, state.present],
    present: { ...next, revision: state.present.revision },
    future: state.future.slice(1),
  };
}
