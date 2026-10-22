import { applyCommand } from "../domain/commands";
import type { EditProject, MotionGraphic } from "../domain/types";
import type { EditorCommand } from "../domain/commandTypes";
import type { GraphicEditingSelectionSnapshotV1 } from "./graphicEditingSelectionV1";
import type { MotionGraphicEditPlanV1 } from "./motionGraphicEditActionsV1";
import { GRAPHIC_EDIT_INVALID_V1 } from "./motionGraphicEditActionsV1";
import { createTransientParameterGestureV1, type ParameterGestureHostV1, type ParameterGestureLeaseV1, type ParameterProjectPreviewV1 } from "./transientParameterGestureV1";
export interface GraphicParameterPreviewV1 extends ParameterProjectPreviewV1 { readonly graphicId: string }
interface Host extends ParameterGestureHostV1 { onBegin?: () => void; setStatus?: (message: string) => void }
export interface GraphicNumberEditRequestV1 {
  parameterId: string; initial: number; normalize?: (value: number) => number;
  patch: (value: number) => Partial<Pick<MotionGraphic, "fontSize" | "x" | "y" | "vectorV2">>;
}
export type GraphicNumberGestureStartV1 = (graphicId: string, request: GraphicNumberEditRequestV1) => ParameterGestureLeaseV1 | undefined;
interface Begin<V> {
  project: EditProject; selection: GraphicEditingSelectionSnapshotV1; graphicId: string; clipId?: string; initial: V; parameterId?: string;
  normalize?: (value: V) => V;
  plan: (value: V) => MotionGraphicEditPlanV1 | undefined; commit: (value: V) => boolean;
}
/** Text and numbers share the existing lifetime and original canonical graphic planner. */
export function createGraphicParameterGestureV1(host: Host) {
  const owner = createTransientParameterGestureV1<GraphicParameterPreviewV1>(host);
  let error: { project: EditProject; selection: GraphicEditingSelectionSnapshotV1; message: string } | undefined;
  function start<V extends string | number>(input: Begin<V>, numeric: boolean): (ParameterGestureLeaseV1<V> & { isCurrent: () => boolean }) | undefined {
      try {
        const project = host.session.getSnapshot().history.present, selected = host.getSelectionSnapshot();
        const graphic = project.motionGraphics.find(item => item.id === input.graphicId);
        if (project !== input.project || selected !== input.selection || !selected.active || selected.timelineSelection.primaryCaptionId !== undefined
          || (input.clipId ? selected.selection !== undefined || selected.timelineSelection.primaryClipId !== input.clipId
            : selected.selection?.id !== input.graphicId || selected.timelineSelection.primaryClipId !== undefined)
          || !graphic || !numeric && graphic.text !== input.initial || numeric && !input.parameterId?.trim()) return undefined;
        const normalize = (value: V): V => {
          if (typeof value !== (numeric ? "number" : "string")) throw Error(GRAPHIC_EDIT_INVALID_V1);
          const next = input.normalize ? input.normalize(value) : value;
          if (typeof next !== (numeric ? "number" : "string") || numeric && !Number.isFinite(next)) throw Error(GRAPHIC_EDIT_INVALID_V1);
          return next;
        };
        const initial = normalize(input.initial), first = input.plan(initial); if (!first || first.command) return undefined;
        error = undefined;
        const allowed = (command: EditorCommand, value: V) => {
          if (command.type !== "update_motion_graphic" || command.graphicId !== input.graphicId) return false;
          const keys = Object.keys(command.patch);
          return numeric ? keys.length > 0 && keys.every(key => ["fontSize", "x", "y", "vectorV2"].includes(key))
            : keys.length === 1 && command.patch.text === value;
        };
        const lease = owner.begin({ project, selection: selected, initial, normalize,
          commit: input.commit, preview: value => {
            try {
              const plan = input.plan(value); if (!plan) return undefined;
              if (plan.command && !allowed(plan.command, value)) return undefined;
              const next = plan.command ? applyCommand(project, plan.command) : project;
              error = undefined;
              return { baseProject: project, project: next === project ? project : { ...next, id: project.id, revision: project.revision, updatedAt: project.updatedAt }, graphicId: input.graphicId, parameterId: input.parameterId ?? "graphic.text" };
            } catch (e) { error = { project, selection: selected, message: e instanceof Error ? e.message : GRAPHIC_EDIT_INVALID_V1 }; return undefined; }
          } });
        if (!lease) return undefined;
        host.onBegin?.(); let accepted = true;
        return { ...lease, update: value => { accepted = lease.update(value); return accepted; },
          commit: () => { if (!accepted) { lease.cancel(); return false; } return lease.commit(); }, isCurrent: () => lease.isCurrent?.() === true };
      } catch { return undefined; }
  }
  return {
    ...owner,
    reportError: () => { if (error && host.session.getSnapshot().history.present === error.project && host.getSelectionSnapshot() === error.selection) host.setStatus?.(error.message); },
    begin: (input: Begin<string>) => start(input, false),
    beginNumber: (input: Begin<number>) => start(input, true),
  };
}
