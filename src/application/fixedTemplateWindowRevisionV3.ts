import type { EditorCommand } from "../domain/commandTypes";
import type { EditProject } from "../domain/types";
import type { ReferenceMotionInstanceRole, ReferenceMotionTemplateInstance } from "../domain/referenceMotionInstance";

/** The v3 revision can add/remove only its three camera roles on its own existing primary clip. */
export function fixedTemplateWindowKeyRevisionV3(project: EditProject, instance: ReferenceMotionTemplateInstance, compiled: EditProject,
  role: ReferenceMotionInstanceRole, action: "add" | "remove"): EditorCommand | undefined {
  if (role.kind !== "keyframe" || !/^source:0:clip:fixed-window-v3:(start|peak|return)$/.test(role.key)
    || role.parentId !== instance.input.clipId) return undefined;
  const ownClip = instance.roles.find(r => r.kind === "clip" && r.key === "source:0:clip" && r.id === role.parentId);
  if (!ownClip) return undefined;
  const graph = action === "add" ? compiled : project;
  const clip = graph.tracks.flatMap(t => t.clips).find(c => c.id === role.parentId);
  if (!clip || !clip.masks?.some(mask => mask.fixedWindowV3?.schema === "editkin.fixed-template-window/v3")) return undefined;
  if (action === "remove" && !instance.input.fixedWindowV3) return undefined;
  const keyframe = clip.keyframes.find(k => k.id === role.id);
  if (!keyframe) return undefined;
  return action === "remove" ? { type: "delete_keyframe", clipId: clip.id, keyframeId: role.id }
    : { type: "add_keyframe", clipId: clip.id, keyframe: structuredClone(keyframe) };
}
