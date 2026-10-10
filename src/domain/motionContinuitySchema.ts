import * as z from "zod/v4";

const coordinate = z.number().finite().min(0).max(4096);
export const springTargetTrackSchema = z.strictObject({
  fps: z.number().finite().min(1).max(240),
  initialPosition: coordinate,
  initialVelocity: z.number().finite().min(-32768).max(32768),
  initialTarget: coordinate,
  spring: z.strictObject({ stiffness: z.number().finite().min(1).max(1000), damping: z.number().finite().min(0).max(100), mass: z.number().finite().min(.05).max(10) }),
  events: z.array(z.strictObject({ frame: z.number().int().min(0).max(1799), target: coordinate })).max(32),
}).superRefine((track, ctx) => {
  if (track.events.some((event, index) => index > 0 && event.frame <= track.events[index - 1].frame)) {
    ctx.addIssue({ code: "custom", message: "Spring targets need strictly ascending integer frames", path: ["events"] });
  }
});
export const springGeometryTrackSchema = z.strictObject({
  localId: z.string().trim().min(1).max(80),
  envelope: z.strictObject({ x: z.literal(0), y: z.literal(0), width: z.number().finite().min(16).max(4096), height: z.number().finite().min(1).max(4096) }),
  left: springTargetTrackSchema, top: springTargetTrackSchema, right: springTargetTrackSchema,
  bottom: springTargetTrackSchema, cornerRadius: springTargetTrackSchema,
}).superRefine((geometry, ctx) => {
  const tracks = [geometry.left, geometry.top, geometry.right, geometry.bottom, geometry.cornerRadius];
  if (tracks.some(track => track.fps !== geometry.left.fps)) ctx.addIssue({ code: "custom", message: "Geometry tracks require matching fps" });
  if (tracks.reduce((total, track) => total + track.events.length, 0) > 32) ctx.addIssue({ code: "custom", message: "Geometry supports at most 32 total events" });
});
export const continuityVectorSchema = z.strictObject({
  schema: z.literal("editkin.motion-vector-continuity/v1"), kind: z.literal("spring_panel"),
  heightPixels: z.number().finite().min(1).max(4096), revealFrames: z.literal(1), geometry: springGeometryTrackSchema,
});
