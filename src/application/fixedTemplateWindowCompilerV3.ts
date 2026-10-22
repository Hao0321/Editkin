import type { EditorCommand } from "../domain/commandTypes";
import { applyCommand } from "../domain/commands";
import { fixedTemplateWindowV3Schema } from "../domain/fixedTemplateWindowV3";
import { fixedTemplateWindowSamplesV3 } from "../domain/fixedTemplateWindowPathV3";
import { DEFAULT_TRANSFORM, type EditProject } from "../domain/types";
import type { ReferenceMotionTemplateInput } from "../motion/referenceMotionTemplates";
import type { ReferenceMotionTemplateBeat, ReferenceMotionTemplateCompileOptions, ReferenceMotionTemplateRole } from "./referenceMotionTemplateCommands";

interface Packet { commands: EditorCommand[]; roles?: ReferenceMotionTemplateRole[];
  phases: Array<{ role: string; startFrame: number; endFrame: number }>; beats?: ReferenceMotionTemplateBeat[] }
const fail = () => Object.assign(new Error("固定影像窗需要模板自有的靜態多邊形遮罩。"), { code: "FIXED_TEMPLATE_WINDOW_MASK" });

/** New unaccepted version only. Existing source windows/audio and authored artwork stay intact. */
export function compileFixedTemplateWindowPacketV3<T extends Packet>(project: EditProject, input: ReferenceMotionTemplateInput,
  original: T, idFactory: (prefix: string) => string, options: ReferenceMotionTemplateCompileOptions): T {
  const choice = fixedTemplateWindowV3Schema.parse(input.fixedWindowV3), packet = structuredClone(original);
  const clipId = input.clipId, clipRole = packet.roles?.find(role => role.kind === "clip" && role.id === clipId);
  const maskRole = packet.roles?.find(role => role.kind === "mask" && role.parentId === clipId);
  const maskCommand = packet.commands.find(c => c.type === "add_clip_mask" && c.clipId === clipId && c.mask.id === maskRole?.id);
  if (!clipRole || !maskRole || maskCommand?.type !== "add_clip_mask") throw fail();
  // Keep every existing entrance role/ID: disabling v3 restores the same saved V1 graph.
  const base = applyCommand(project, { type: "batch", commands: packet.commands });
  const clip = base.tracks.flatMap(track => track.clips).find(candidate => candidate.id === clipId)!;
  if (!clip.keyframes.length || clip.expressions && Object.keys(clip.expressions).length) throw fail();
  const hold = packet.phases.find(phase => phase.role === "hold" && phase.endFrame - phase.startFrame >= 4);
  if (!hold) throw fail();
  const start = Math.max(0, hold.startFrame - input.startFrame), end = Math.min(input.durationFrames - 1, hold.endFrame - input.startFrame - 1);
  if (end - start < 2) throw fail();
  if (clip.keyframes.some(key => Math.round(key.time * project.fps) > start)) throw fail();
  const peak = start + Math.floor((end - start) / 2);
  const poses = [...(start > 0 ? [{ key: "start", frame: start, scale: 1 }] : []),
    { key: "peak", frame: peak, scale: choice.peakScale }, { key: "return", frame: end, scale: 1 }];
  for (const pose of poses) {
    const role = { key: `${clipRole.key}:fixed-window-v3:${pose.key}`, kind: "keyframe" as const, parentId: clipId };
    const id = options.allocateRoleId?.(role, "motion-window-v3-key") ?? idFactory("motion-window-v3-key");
    packet.roles!.push({ ...role, id });
    packet.commands.push({ type: "add_keyframe", clipId, keyframe: { id, time: pose.frame / project.fps,
      transform: { ...DEFAULT_TRANSFORM, scale: pose.scale }, color: structuredClone(clip.color), easing: "ease_in_out" } });
    const beat = packet.beats?.find(beat => input.startFrame + pose.frame >= beat.startFrame && input.startFrame + pose.frame < beat.endFrame);
    if (packet.beats?.length && !beat) throw fail();
    beat?.roleKeys.push(role.key);
  }
  const animated = applyCommand(project, { type: "batch", commands: packet.commands });
  const candidate = animated.tracks.flatMap(track => track.clips).find(c => c.id === clipId)!;
  // Validate every output frame now, but store only the version marker in the project/plan.
  const compactMask = { ...structuredClone(maskCommand.mask), fixedWindowV3: { schema: choice.schema, fromFrame: start, toFrame: end } };
  fixedTemplateWindowSamplesV3(animated, candidate, compactMask);
  packet.commands = packet.commands.map(c => c.type === "add_clip_mask" && c.clipId === clipId && c.mask.id === compactMask.id
    ? { ...c, mask: compactMask } : c);
  applyCommand(project, { type: "batch", commands: packet.commands });
  return packet;
}
