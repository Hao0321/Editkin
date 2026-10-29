import { describeProblem, type PlainProblem, type ProblemAction } from "./plainProblems";

/** One button on a problem notice; the label is a zh-TW interface message key. */
export interface ProblemNoticeAction {
  label: string;
  run: () => void | Promise<unknown>;
  primary?: boolean;
}

export interface AppProblemNotice extends PlainProblem {
  key: ProblemAction;
  /** Changes on every report, so a repeated failure is announced again. */
  id: number;
  actions: readonly ProblemNoticeAction[];
}

// The window has one editor. File actions report here; the shell shows the notices under the toolbar.
// One notice per action: a newer failure of the same action replaces the older one.
const entries = new Map<ProblemAction, AppProblemNotice>();
const listeners = new Set<() => void>();
let snapshot: readonly AppProblemNotice[] = [];
let sequence = 0;

function emit(): void {
  snapshot = [...entries.values()];
  for (const listener of listeners) listener();
}

export function reportAppProblem(action: ProblemAction, error: unknown, actions: readonly ProblemNoticeAction[] = []): AppProblemNotice {
  const notice: AppProblemNotice = { ...describeProblem(action, error), key: action, id: ++sequence, actions };
  entries.set(action, notice);
  emit();
  return notice;
}

/** The action later succeeded (or its subject went away): its notice is no longer true. */
export function clearAppProblem(action: ProblemAction): void {
  if (entries.delete(action)) emit();
}

export function dismissAppProblem(key: ProblemAction, id?: number): void {
  const current = entries.get(key);
  if (!current || (id !== undefined && current.id !== id)) return;
  entries.delete(key);
  emit();
}

export function currentAppProblems(): readonly AppProblemNotice[] {
  return snapshot;
}

export function subscribeAppProblems(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Tests only. */
export function resetAppProblemsForTest(): void {
  entries.clear();
  sequence = 0;
  emit();
}
