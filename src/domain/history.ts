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
}

export function createHistory(project: EditProject): EditorHistory {
  return { past: [], present: project, future: [], journal: [] };
}

export function dispatchCommand(
  state: EditorHistory,
  command: EditorCommand,
  recordId = `cmd-${Date.now()}`,
  context?: EditorCommandContext,
): EditorHistory {
  const next = applyCommand(state.present, command, context);
  return {
    past: [...state.past.slice(-99), state.present],
    present: next,
    future: [],
    journal: [...state.journal, { id: recordId, command, appliedAt: next.updatedAt }],
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
): SafeDispatchResult {
  try {
    return { state: dispatchCommand(state, command, recordId, context) };
  } catch (error) {
    return { state, error: error instanceof Error ? error.message : "操作失敗" };
  }
}

export function undo(state: EditorHistory): EditorHistory {
  const previous = state.past.at(-1);
  if (!previous) return state;
  return {
    ...state,
    past: state.past.slice(0, -1),
    present: { ...previous, revision: state.present.revision },
    future: [state.present, ...state.future],
  };
}

export function redo(state: EditorHistory): EditorHistory {
  const next = state.future[0];
  if (!next) return state;
  return {
    ...state,
    past: [...state.past, state.present],
    present: { ...next, revision: state.present.revision },
    future: state.future.slice(1),
  };
}
