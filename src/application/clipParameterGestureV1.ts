import { applyCommand } from "../domain/commands";
import type { EditorCommand } from "../domain/commandTypes";
import type { ColorGradeV2, LayerBlendMode } from "../domain/types";
import { assertColorGradeV2 } from "../domain/colorGradeV2Schema";
import { editorCommandSchema } from "../domain/schema";
import type { GraphicEditingSelectionSnapshotV1 } from "./graphicEditingSelectionV1";
import { createTransientParameterGestureV1, type ParameterGestureHostV1, type ParameterPreviewV1, type ParameterGestureLeaseV1 } from "./transientParameterGestureV1";

export interface ClipParameterPlanV1 { command?: EditorCommand }
interface Begin<V = number> {
  clipId: string; selection: GraphicEditingSelectionSnapshotV1; parameterId: string; initial: V;
  plan: (value: V) => ClipParameterPlanV1 | undefined;
  commit: (value: V) => boolean;
  isCurrent?: () => boolean;
}
const VALUE_COMMANDS: readonly EditorCommand["type"][] = ["update_clip_transform", "set_clip_color", "set_clip_volume", "set_clip_grade_v2", "add_keyframe", "update_keyframe"];
function scoped(command: EditorCommand, clipId: string, types: readonly EditorCommand["type"][] = VALUE_COMMANDS): boolean {
  return command.type === "batch" ? command.commands.every(value => scoped(value, clipId, types))
    : types.includes(command.type) && "clipId" in command && command.clipId === clipId;
}
/** Blend modes the project schema accepts (the domain's own list, not a copy). */
function blendMode(value: LayerBlendMode): LayerBlendMode {
  const parsed = editorCommandSchema.safeParse({ type: "set_clip_layer", clipId: "blend-mode-check", patch: { blendMode: value } });
  if (!parsed.success || parsed.data.type !== "set_clip_layer" || parsed.data.patch.blendMode !== value) throw new Error("Unknown blend mode");
  return value;
}
/** Only a view projection of a command planned by the original current-owner facade. */
export function createClipParameterGestureV1(host: ParameterGestureHostV1) {
  const owner = createTransientParameterGestureV1<ParameterPreviewV1>(host);
  const begin = <V>(input: Begin<V>, normalize?: (value: V) => V, equal?: (a: V, b: V) => boolean,
    types: readonly EditorCommand["type"][] = VALUE_COMMANDS): ParameterGestureLeaseV1<V> | undefined => {
      const project = host.session.getSnapshot().history.present, selection = host.getSelectionSnapshot();
      if (selection !== input.selection || !selection.active || selection.selection || selection.timelineSelection.primaryClipId !== input.clipId
        || selection.timelineSelection.primaryCaptionId !== undefined) return undefined;
      const track = project.tracks.find(track => track.clips.some(clip => clip.id === input.clipId));
      if (!track || track.locked) return undefined;
      owner.cancel();
      return owner.begin({ project, selection, initial: input.initial, isCurrent: input.isCurrent, commit: input.commit, normalize, equal,
        preview: value => {
          const plan = input.plan(value); if (!plan || plan.command && !scoped(plan.command, input.clipId, types)) return undefined;
          const projected = plan.command ? applyCommand(project, plan.command) : project;
          return { baseProject: project, project: projected === project ? project : { ...projected, id: project.id, revision: project.revision, updatedAt: project.updatedAt },
            clipId: input.clipId, parameterId: input.parameterId };
        } });
    };
  return {
    ...owner,
    begin: (input: Begin) => begin(input),
    beginGrade: (input: Begin<ColorGradeV2>) => {
      try {
        const project = host.session.getSnapshot().history.present;
        const clip = project.tracks.find(track => track.clips.some(clip => clip.id === input.clipId))?.clips.find(clip => clip.id === input.clipId);
        if (!clip) return undefined;
        const initial = assertColorGradeV2(input.initial), current = assertColorGradeV2(clip.gradeV2 ?? {schema: "editkin.color-grade/v2"});
        if (JSON.stringify(initial) !== JSON.stringify(current)) return undefined;
        return begin({...input, initial}, assertColorGradeV2, (a, b) => JSON.stringify(a) === JSON.stringify(b));
      } catch { return undefined; }
    },
    /**
     * The 混合 row's hover preview: each hovered blend mode is only a preview project (no history); commit runs the
     * original set_clip_layer command once, cancel restores. The plan may only touch this clip's layer state.
     */
    beginLayer: (input: Begin<LayerBlendMode>) => {
      try { return begin({ ...input, initial: blendMode(input.initial) }, blendMode, (a, b) => a === b, ["set_clip_layer"]); }
      catch { return undefined; }
    },
  };
}
