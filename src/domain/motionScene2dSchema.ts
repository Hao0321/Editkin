import * as z from "zod/v4";

// Saved scene payloads are strict: unknown camera fields cannot disappear on reopen.
const coordinate = z.number().finite().min(-100000).max(100000);
const zoom = z.number().finite().min(.05).max(20);
const spring = z.strictObject({ stiffness: z.number().finite().min(1).max(1000), damping: z.number().finite().min(0).max(100), mass: z.number().finite().min(.05).max(10) });
const targetTrack = (position: typeof coordinate, velocity: number) => z.strictObject({
  fps: z.number().finite().min(1).max(240), initialPosition: position,
  initialTarget: position, initialVelocity: z.number().finite().min(-velocity).max(velocity), spring,
  events: z.array(z.strictObject({ frame: z.number().int().min(0).max(1799), target: position })).max(32),
}).superRefine((track, ctx) => {
  if (track.events.some((event, i) => i > 0 && event.frame <= track.events[i - 1].frame)) ctx.addIssue({ code: "custom", message: "Camera target frames must ascend strictly" });
});
const identity = z.string().min(1).max(80).refine(value => value === value.trim(), "Identity must not contain outer whitespace");
export const motionScene2dSchema = z.strictObject({
  schema: z.literal("editkin.motion-scene-2d/v1"), id: identity,
  startFrame: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  durationFrames: z.number().int().min(2).max(1800), fps: z.number().finite().min(1).max(240),
  graphicIds: z.array(identity).min(1).max(32),
  camera: z.strictObject({ centerX: targetTrack(coordinate, 32768), centerY: targetTrack(coordinate, 32768), zoom: targetTrack(zoom, 100) }),
  safeArea: z.strictObject({ left: z.number().finite().nonnegative(), right: z.number().finite().nonnegative(), top: z.number().finite().nonnegative(), bottom: z.number().finite().nonnegative() }),
  semanticCues: z.array(z.strictObject({
    id: identity, frame: z.number().int().min(0).max(1799), purpose: z.string().trim().min(1).max(480),
    graphicIds: z.array(identity).min(1).max(32), evidenceRefs: z.array(z.string().trim().min(1).max(320)).min(1).max(32),
  })).min(1).max(32),
}).superRefine((scene, ctx) => {
  if (!Number.isSafeInteger(scene.startFrame + scene.durationFrames)) ctx.addIssue({ code: "custom", message: "Scene end frame exceeds safe integers" });
  if (new Set(scene.graphicIds).size !== scene.graphicIds.length) ctx.addIssue({ code: "custom", message: "Scene object identities must be unique" });
  if (new Set(scene.semanticCues.map(cue => cue.id)).size !== scene.semanticCues.length) ctx.addIssue({ code: "custom", message: "Scene cue identities must be unique" });
  for (const track of Object.values(scene.camera)) {
    if (track.fps !== scene.fps || track.events.some(event => event.frame >= scene.durationFrames)) ctx.addIssue({ code: "custom", message: "Camera tracks must match scene fps/range" });
  }
  for (const cue of scene.semanticCues) {
    if (cue.frame >= scene.durationFrames || cue.graphicIds.some(id => !scene.graphicIds.includes(id)) || new Set(cue.graphicIds).size !== cue.graphicIds.length) ctx.addIssue({ code: "custom", message: "Cue must bind scene objects within its frame range" });
  }
});
