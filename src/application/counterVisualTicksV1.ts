import * as z from "zod/v4";
import type { EditProject, MotionGraphic } from "../domain/types";
import { selectCounterSoundHitsV1 } from "./counterSoundHitSelectionV1";

const id = z.string().min(1).max(160);
export const counterTickRequestV1Schema = z.strictObject({
  enabled: z.literal(true), durationFrames: z.number().int().positive().max(20_736_000),
  trackId: id, idPrefix: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  newTrack: z.strictObject({ name: z.string().trim().min(1).max(120) }).optional(),
  bindings: z.array(z.discriminatedUnion("source", [
    z.strictObject({ source: z.literal("reference_instance"), instanceId: id }),
    z.strictObject({ source: z.literal("editorial_states"), role: z.enum(["challenge_ledger", "scale_ladder"]), graphicIds: z.array(id).min(1).max(32) }),
  ])).min(1).max(8),
  sound: z.strictObject({ variant: z.number().int().min(1).max(5), gain: z.number().finite().positive().max(1) }),
});
export type CounterTickRequestV1 = z.infer<typeof counterTickRequestV1Schema>;
export interface CounterVisualTickV1 {
  graphicId: string; role: string; frame: number; text: string; phase: "count" | "final" | "state";
}
const onFrame = (seconds: number, fps: number) => {
  const value = seconds * fps, frame = Math.round(value);
  if (!Number.isFinite(value) || !Number.isSafeInteger(frame) || frame < 0 || Math.abs(value - frame) > 1e-6) throw new Error("COUNTER_GRAPHIC_CLOCK_INVALID");
  return frame;
};

/** Reads existing rendered count roles; no number interpolation, artwork or certified default changes. */
export function deriveCounterVisualTicksV1(project: EditProject, payload: unknown) {
  const request = counterTickRequestV1Schema.parse(payload);
  if (!Number.isFinite(project.fps) || project.fps < 1 || project.fps > 240 || request.durationFrames / project.fps > 86_400) throw new Error("COUNTER_CLOCK_BUDGET");
  const hooks: CounterVisualTickV1[] = [], used = new Set<string>();
  const graphics = new Map(project.motionGraphics.map(g => [g.id, g]));
  if (graphics.size !== project.motionGraphics.length) throw new Error("COUNTER_GRAPHIC_ID_AMBIGUOUS");
  const add = (graphic: MotionGraphic | undefined, role: string, phase: CounterVisualTickV1["phase"]) => {
    if (!graphic || !graphic.text.trim() || used.has(graphic.id)) throw new Error("COUNTER_GRAPHIC_MISSING_OR_DUPLICATE");
    // V3 may change its text every rendered frame; an onset must not pretend to attest those internal ticks.
    if (graphic.schema === "hao.motion-composition/v3") throw new Error("COUNTER_DYNAMIC_V3_TICKS_UNSUPPORTED");
    const frame = onFrame(graphic.timelineStart, project.fps), end = onFrame(graphic.timelineStart + graphic.duration, project.fps);
    if (end <= frame || end > request.durationFrames) throw new Error("COUNTER_GRAPHIC_OUTSIDE_TIMELINE");
    used.add(graphic.id); hooks.push({ graphicId: graphic.id, role, frame, text: graphic.text, phase });
    if (hooks.length > 256) throw new Error("COUNTER_HOOK_BUDGET");
  };
  const instances = new Set<string>();
  for (const binding of request.bindings) {
    if (binding.source === "editorial_states") {
      for (const graphicId of binding.graphicIds) add(graphics.get(graphicId), binding.role, "state");
      continue;
    }
    if (instances.has(binding.instanceId)) throw new Error("COUNTER_INSTANCE_DUPLICATE");
    instances.add(binding.instanceId);
    const instance = project.referenceMotionInstances?.find(i => i.id === binding.instanceId);
    if (!instance || !["stat_reveal", "stat_cycle"].includes(instance.input.templateId)) throw new Error("COUNTER_INSTANCE_FAMILY_UNSUPPORTED");
    const roles = instance.roles.filter(r => r.kind === "graphic");
    if (new Set(roles.map(r => r.key)).size !== roles.length || new Set(roles.map(r => r.id)).size !== roles.length) throw new Error("COUNTER_ROLE_AMBIGUOUS");
    const counts = roles.filter(r => /:count:\d+$/.test(r.key));
    if (!counts.length) throw new Error("COUNTER_NO_RENDERED_COUNT_ROLES");
    for (const stem of new Set(counts.map(r => r.key.replace(/:count:\d+$/, "")))) {
      const sequence = counts.filter(r => r.key.startsWith(`${stem}:count:`)).map(r => ({ role: r, graphic: graphics.get(r.id) }));
      sequence.sort((a, b) => (a.graphic?.timelineStart ?? 0) - (b.graphic?.timelineStart ?? 0));
      const final = roles.find(r => r.key === stem), finalGraphic = final && graphics.get(final.id);
      if (!finalGraphic) throw new Error("COUNTER_FINAL_ROLE_MISSING");
      for (let i = 0; i < sequence.length; i++) {
        const { role, graphic } = sequence[i], next = sequence[i + 1]?.graphic ?? finalGraphic;
        if (!graphic || !next || Math.abs(graphic.timelineStart + graphic.duration - next.timelineStart) > 1e-7) throw new Error("COUNTER_COUNT_SEQUENCE_EDITED");
        add(graphic, role.key, "count");
      }
      add(finalGraphic, final!.key, "final");
    }
  }
  hooks.sort((a, b) => a.frame - b.frame || a.graphicId.localeCompare(b.graphicId));
  const selection = selectCounterSoundHitsV1(project.fps, request, hooks);
  return { request, hooks, ...selection,
    defaultEnabled: false as const, qualityState: "AUDIO_PENDING_HAO_CLAUDE" as const,
    editorialAuthority: "explicit_caller_bound_graphic_onsets_only" as const };
}
