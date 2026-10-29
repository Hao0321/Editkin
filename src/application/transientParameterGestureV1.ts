import type { EditProject } from "../domain/types";
import type { ProjectSession } from "./projectSession";
import type { GraphicEditingSelectionSnapshotV1 } from "./graphicEditingSelectionV1";

export interface ParameterGestureLeaseV1<V = number> { update: (value: V) => boolean; commit: () => boolean; cancel: () => void; isCurrent?: () => boolean }
export interface ParameterProjectPreviewV1 { readonly baseProject: EditProject; readonly project: EditProject; readonly parameterId: string }
export interface ParameterPreviewV1 extends ParameterProjectPreviewV1 { readonly clipId: string }
export interface ParameterGestureHostV1 {
  session: ProjectSession;
  getSelectionSnapshot: () => GraphicEditingSelectionSnapshotV1;
  subscribeSelection: (listener: () => void) => () => void;
}
interface Begin<P, V> {
  project: EditProject; selection: GraphicEditingSelectionSnapshotV1; initial: V;
  preview: (value: V) => P | undefined; commit: (value: V) => boolean; isCurrent?: () => boolean;
  /** Adapters retain domain validation and take ownership of mutable payloads before preview or commit. */
  normalize?: (value: V) => V; equal?: (a: V, b: V) => boolean;
}
/** Shared lifetime only; adapters retain their own validators/planners and the original command/history owner. */
export function createTransientParameterGestureV1<P extends ParameterProjectPreviewV1>(host: ParameterGestureHostV1) {
  type Gesture = { start: ReturnType<ProjectSession["getSnapshot"]>; input: Pick<Begin<P, unknown>, "project" | "selection" | "isCurrent"> };
  let active: Gesture | undefined;
  let snapshot: { readonly epoch: number; readonly preview?: P } = { epoch: 0 };
  const listeners = new Set<() => void>();
  let detach: (() => void) | undefined, notifiedEpoch = 0;
  const publish = (preview?: P) => { snapshot = { epoch: snapshot.epoch + 1, ...(preview ? { preview } : {}) }; };
  const notify = () => { notifiedEpoch = snapshot.epoch; for (const listener of [...listeners]) listener(); };
  const current = (g: Gesture) => {
    const live = host.session.getSnapshot(), selection = host.getSelectionSnapshot();
    return live.sessionId === g.start.sessionId && live.contentOwner === g.start.contentOwner
      && live.history.present === g.input.project && selection === g.input.selection && selection.active
      && (g.input.isCurrent?.() ?? true);
  };
  const clear = () => { active = undefined; if (snapshot.preview) publish(); };
  const reconcile = () => { if (active && !current(active)) clear(); };
  const changed = () => { reconcile(); if (snapshot.epoch !== notifiedEpoch) notify(); };
  const cancel = () => { clear(); if (snapshot.epoch !== notifiedEpoch) notify(); };
  return {
    getSnapshot: () => { reconcile(); return snapshot; },
    subscribe: (listener: () => void) => {
      let subscribed = true;
      const entry = () => { if (subscribed) listener(); };
      listeners.add(entry);
      if (!detach) { const a = host.session.subscribe(changed), b = host.subscribeSelection(changed); detach = () => { a(); b(); }; }
      changed();
      return () => { if (!subscribed) return; subscribed = false; listeners.delete(entry); if (!listeners.size) { detach?.(); detach = undefined; clear(); } };
    },
    cancel,
    begin: <V = number>(input: Begin<P, V>): ParameterGestureLeaseV1<V> | undefined => {
      cancel();
      try {
        const normalize = input.normalize ?? ((value: V): V => {
          if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Finite parameter required");
          return value;
        });
        const equal = input.equal ?? ((a: V, b: V) => a === b);
        const initial = normalize(input.initial); let value = initial;
        const g: Gesture = { start: host.session.getSnapshot(), input };
        if (!listeners.size || !current(g)) return undefined;
        active = g;
        const valid = () => { reconcile(); return active === g && current(g); };
        return {
          isCurrent: valid,
          update: next => {
            try {
              if (!valid() || !input.normalize && (typeof next !== "number" || !Number.isFinite(next))) return false;
              const accepted = normalize(next), preview = input.preview(accepted);
              if (!preview || !valid()) return false;
              if (equal(value, accepted)) return true;
              value = accepted; publish(preview); notify(); return valid();
            } catch { if (active === g) cancel(); return false; }
          },
          commit: () => {
            try {
              if (!valid()) return false;
              const accepted = value; clear(); if (snapshot.epoch !== notifiedEpoch) notify();
              return current(g) && (equal(accepted, initial) || input.commit(accepted) === true);
            } catch { if (active === g) cancel(); return false; }
          },
          cancel: () => { if (active === g) cancel(); },
        };
      } catch { return undefined; }
    },
  };
}
