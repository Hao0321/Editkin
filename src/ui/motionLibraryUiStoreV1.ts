import type { MotionLibraryCutRefV1 } from "./motionLibraryCutsV1";

/**
 * Interface state of the Motion Library GUI: which tab and filters the panel shows, the cut it is focused on, the
 * selected timeline transition, the last transition used (for Ctrl+T) and the running render jobs (progress + cancel).
 * Interface state only: nothing here is part of the project or its history.
 */

export type MotionLibraryTabV1 = "text" | "transition" | "background";

/** A transition the GUI can apply: the two built-in kernels, or a Motion Library matte item with its params. */
export type MotionLibraryTransitionPresetV1 =
  | { readonly kind: "dissolve" }
  | { readonly kind: "dip" }
  | { readonly kind: "matte"; readonly itemId: string; readonly params?: Readonly<Record<string, unknown>> };

export type MotionLibraryJobTargetV1 =
  | { readonly kind: "card"; readonly itemId: string }
  | { readonly kind: "clip"; readonly clipId: string }
  | { readonly kind: "cut"; readonly cut: MotionLibraryCutRefV1 };

export interface MotionLibraryJobV1 {
  readonly id: string;
  readonly label: string;
  readonly itemId?: string;
  readonly target: MotionLibraryJobTargetV1;
  /** 0–1 of the real render (cache lookup, frame generation, encode, verify). */
  readonly fraction: number;
  readonly phase: string;
  readonly cancel: () => void;
}

export interface MotionLibraryUiStateV1 {
  readonly tab: MotionLibraryTabV1;
  readonly category: Readonly<Partial<Record<MotionLibraryTabV1, string>>>;
  readonly query: string;
  readonly selectedItemId?: string;
  /** The panel's 轉場 tab applies to this cut (opened from a cut's transition button). */
  readonly focusCut?: MotionLibraryCutRefV1;
  readonly selectedTransitionId?: string;
  readonly lastTransition: MotionLibraryTransitionPresetV1;
  readonly jobs: readonly MotionLibraryJobV1[];
  /** Increments whenever something asks the panel to show itself (MediaBin switches to its tab). */
  readonly panelRequest: number;
}

interface PreferenceStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
export const MOTION_LIBRARY_LAST_TRANSITION_KEY_V1 = "editkin.motion-library.last-transition.v1";
const ITEM_ID = /^X(?:0[1-9]|[1-3][0-9]|40)$/;

export function parseTransitionPresetV1(value: unknown): MotionLibraryTransitionPresetV1 | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (record.kind === "dissolve" || record.kind === "dip") return { kind: record.kind };
  if (record.kind !== "matte" || typeof record.itemId !== "string" || !ITEM_ID.test(record.itemId)) return undefined;
  const params = record.params && typeof record.params === "object" && !Array.isArray(record.params) ? record.params as Record<string, unknown> : undefined;
  return { kind: "matte", itemId: record.itemId, ...(params ? { params } : {}) };
}

function readLastTransition(storage: PreferenceStorage | undefined): MotionLibraryTransitionPresetV1 {
  try { return parseTransitionPresetV1(JSON.parse(storage?.getItem(MOTION_LIBRARY_LAST_TRANSITION_KEY_V1) ?? "null")) ?? { kind: "dissolve" }; }
  catch { return { kind: "dissolve" }; }
}

export function createMotionLibraryUiStoreV1(options: { storage?: PreferenceStorage } = {}) {
  let state: MotionLibraryUiStateV1 = { tab: "text", category: {}, query: "", lastTransition: readLastTransition(options.storage), jobs: [], panelRequest: 0 };
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<MotionLibraryUiStateV1>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setTab: (tab: MotionLibraryTabV1) => { if (tab !== state.tab) publish({ tab, selectedItemId: undefined }); },
    setCategory: (tab: MotionLibraryTabV1, category: string | undefined) => publish({ category: { ...state.category, [tab]: category } }),
    setQuery: (query: string) => { if (query !== state.query) publish({ query }); },
    selectItem: (itemId: string | undefined) => { if (itemId !== state.selectedItemId) publish({ selectedItemId: itemId }); },
    /** Show the panel (optionally on a tab and focused on a cut). */
    openPanel(request: { tab?: MotionLibraryTabV1; focusCut?: MotionLibraryCutRefV1 } = {}) {
      publish({ panelRequest: state.panelRequest + 1, ...(request.tab ? { tab: request.tab } : {}),
        ...(request.tab && request.tab !== state.tab ? { selectedItemId: undefined } : {}),
        ...(request.focusCut ? { focusCut: request.focusCut } : {}) });
    },
    setFocusCut: (cut: MotionLibraryCutRefV1 | undefined) => publish({ focusCut: cut }),
    selectTransition: (transitionId: string | undefined) => { if (transitionId !== state.selectedTransitionId) publish({ selectedTransitionId: transitionId }); },
    rememberTransition(preset: MotionLibraryTransitionPresetV1) {
      publish({ lastTransition: preset });
      try { options.storage?.setItem(MOTION_LIBRARY_LAST_TRANSITION_KEY_V1, JSON.stringify(preset)); } catch { /* Memory still holds it. */ }
    },
    addJob: (job: MotionLibraryJobV1) => publish({ jobs: [...state.jobs, job] }),
    updateJob(id: string, patch: Pick<MotionLibraryJobV1, "fraction" | "phase">) {
      if (state.jobs.some(job => job.id === id)) publish({ jobs: state.jobs.map(job => job.id === id ? { ...job, ...patch } : job) });
    },
    removeJob: (id: string) => { if (state.jobs.some(job => job.id === id)) publish({ jobs: state.jobs.filter(job => job.id !== id) }); },
  };
}

export type MotionLibraryUiStoreV1 = ReturnType<typeof createMotionLibraryUiStoreV1>;

export function browserPreferenceStorageV1(): PreferenceStorage | undefined {
  try { return typeof window !== "undefined" ? window.localStorage : undefined; } catch { return undefined; }
}
