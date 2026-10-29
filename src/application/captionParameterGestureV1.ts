import { applyCommand } from "../domain/commands";
import type { EditorCommand } from "../domain/commandTypes";
import type { EditProject } from "../domain/types";
import type { GraphicEditingSelectionSnapshotV1 } from "./graphicEditingSelectionV1";
import { createTransientParameterGestureV1, type ParameterGestureHostV1, type ParameterGestureLeaseV1, type ParameterProjectPreviewV1 } from "./transientParameterGestureV1";
export interface CaptionParameterPreviewV1 extends ParameterProjectPreviewV1 { readonly captionId: string }
interface Host extends ParameterGestureHostV1 { onBegin?: () => void; setStatus?: (message: string) => void }
interface Begin<V> {
  project: EditProject; selection: GraphicEditingSelectionSnapshotV1; captionId: string; parameterId: string; initial: V;
  plan: (value: V) => { command?: EditorCommand } | undefined; commit: (value: V) => boolean;
  normalize?: (value: V) => V;
}
const scoped = (command: EditorCommand, id: string): boolean => command.type === "set_caption_style"
  || command.type === "update_caption" && command.captionId === id;
/** Caption adapter of the existing transient lifetime. A caption never pretends to be a media clip. */
export function createCaptionParameterGestureV1(host: Host) {
  const owner = createTransientParameterGestureV1<CaptionParameterPreviewV1>(host);
  let error: { project: EditProject; selection: GraphicEditingSelectionSnapshotV1; message: string } | undefined;
  return {
    ...owner,
    reportError: () => { if (error && host.session.getSnapshot().history.present === error.project && host.getSelectionSnapshot() === error.selection) host.setStatus?.(error.message); },
    begin: <V>(input: Begin<V>): (ParameterGestureLeaseV1<V> & { isCurrent: () => boolean }) | undefined => {
      try {
        const project = host.session.getSnapshot().history.present, selection = host.getSelectionSnapshot();
        if (project !== input.project || selection !== input.selection || !selection.active || selection.selection
          || selection.timelineSelection.primaryCaptionId !== input.captionId || selection.timelineSelection.primaryClipId !== undefined
          || !project.captions.some(c => c.id === input.captionId)) return undefined;
        const normalize = input.normalize ?? ((value: V): V => {
          if (typeof value !== typeof input.initial || typeof value !== "string" && (typeof value !== "number" || !Number.isFinite(value))) throw Error("Invalid caption parameter");
          return value;
        });
        const initial = normalize(input.initial), first = input.plan(initial);
        if (!first || first.command) return undefined; // Invalid or stale admission must not retire another gesture.
        error = undefined;
        const lease = owner.begin({ project, selection, initial, normalize, equal: (a, b) => JSON.stringify(a) === JSON.stringify(b), commit: input.commit,
          preview: value => {
            try {
              const plan = input.plan(value); if (!plan || plan.command && !scoped(plan.command, input.captionId)) return undefined;
              const next = plan.command ? applyCommand(project, plan.command) : project;
              error = undefined;
              return { baseProject: project, project: next === project ? project : { ...next, id: project.id, revision: project.revision, updatedAt: project.updatedAt }, captionId: input.captionId, parameterId: input.parameterId };
            } catch (e) { error = { project, selection, message: e instanceof Error ? e.message : String(e) }; return undefined; }
          } });
        if (!lease) return undefined;
        host.onBegin?.();
        let accepted = true;
        return {
          ...lease,
          update: value => { accepted = lease.update(value); return accepted; },
          commit: () => { if (!accepted) { lease.cancel(); return false; } return lease.commit(); },
          isCurrent: () => lease.isCurrent?.() === true,
        };
      } catch { return undefined; }
    },
  };
}
