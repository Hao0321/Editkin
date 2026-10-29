import type { EditProject, NativeEffectInstance } from "../domain/types";
import type { PluginRegistrySummary } from "../desktop/pluginTypes";
import type { GraphicEditingSelectionSnapshotV1 } from "./graphicEditingSelectionV1";
import { nativeEffectParameterViewV1, nativeEffectParameterValuesPatchV1 } from "./nativeEffectParametersV1";
import { createTransientParameterGestureV1, type ParameterGestureHostV1, type ParameterGestureLeaseV1 } from "./transientParameterGestureV1";

export interface NativeEffectParameterGestureLeaseV1 extends ParameterGestureLeaseV1 {}
export interface NativeEffectParameterPreviewV1 {
  readonly baseProject: EditProject; readonly project: EditProject; readonly clipId: string;
  readonly instanceId: string; readonly parameterId: string; readonly parameters: NativeEffectInstance["parameters"];
}
interface Host extends ParameterGestureHostV1 { getRegistry: () => PluginRegistrySummary | undefined }
interface Begin {
  clipId: string; expected: NativeEffectInstance; parameterId: string; selection: GraphicEditingSelectionSnapshotV1;
  commit: (values: NativeEffectInstance["parameters"]) => boolean;
}
/** Native adapter retains original parameter binding/validation; shared owner only governs transient lifetime. */
export function createNativeEffectParameterGestureV1(host: Host) {
  const owner = createTransientParameterGestureV1<NativeEffectParameterPreviewV1>(host);
  return {
    ...owner,
    begin: (input: Begin): NativeEffectParameterGestureLeaseV1 | undefined => {
      owner.cancel();
      try {
        const project = host.session.getSnapshot().history.present, selection = host.getSelectionSnapshot();
        if (selection !== input.selection || !selection.active || selection.selection
          || selection.timelineSelection.primaryClipId !== input.clipId || selection.timelineSelection.primaryCaptionId !== undefined) return undefined;
        const trackIndex = project.tracks.findIndex(track => track.clips.some(clip => clip.id === input.clipId));
        const track = project.tracks[trackIndex]; if (!track || track.locked) return undefined;
        const clipIndex = track.clips.findIndex(clip => clip.id === input.clipId), clip = track.clips[clipIndex];
        const effectIndex = clip.creative?.nativeEffectInstances?.findIndex(effect => effect.id === input.expected.id) ?? -1;
        const effect = clip.creative?.nativeEffectInstances?.[effectIndex];
        if (!effect || JSON.stringify(effect) !== JSON.stringify(input.expected)) return undefined;
        const row = nativeEffectParameterViewV1(effect, host.getRegistry()).rows.find(row => row.id === input.parameterId);
        if (row?.definition?.type !== "number" || typeof row.value !== "number") return undefined;
        return owner.begin({ project, selection, initial: row.value, commit: value => input.commit({ [input.parameterId]: value }),
          preview: value => {
            const view = nativeEffectParameterViewV1(effect, host.getRegistry());
            const parameters = nativeEffectParameterValuesPatchV1(effect, view.rows, { [input.parameterId]: value });
            if (!parameters) return undefined;
            const effects = [...clip.creative!.nativeEffectInstances!]; effects[effectIndex] = { ...effect, parameters };
            const clips = [...track.clips]; clips[clipIndex] = { ...clip, creative: { ...clip.creative!, nativeEffectInstances: effects } };
            const tracks = [...project.tracks]; tracks[trackIndex] = { ...track, clips };
            return { baseProject: project, project: { ...project, tracks }, clipId: input.clipId, instanceId: effect.id, parameterId: input.parameterId, parameters };
          } });
      } catch { return undefined; }
    },
  };
}
