import type { EditProject, MotionGraphic } from "./types";
import { assertSpringGeometryTrack, sampleSpringGeometryTrack } from "../motion/springGeometryTrack";

/** Structural guard is cheap enough for random frame evaluation. */
export function assertContinuityVectorContract(graphic: MotionGraphic, fps: number): void {
  const vector = graphic.vectorV2;
  if (vector?.kind !== "spring_panel") return;
  if (vector.schema !== "editkin.motion-vector-continuity/v1" || vector.revealFrames !== 1) throw new Error("Spring panel requires its continuity version and one-frame reveal");
  if (graphic.compositeLayer === "background") throw new Error("Spring panel requires foreground composition");
  const geometry = vector.geometry;
  assertSpringGeometryTrack(geometry);
  if (geometry.localId !== graphic.id || geometry.localId !== geometry.localId.trim()) throw new Error("Spring geometry localId must match its graphic identity without outer whitespace");
  const envelope = geometry.envelope;
  if (envelope.x !== 0 || envelope.y !== 0 || envelope.width < 16 || envelope.width > 4096 || envelope.height < 1 || envelope.height > 4096
    || envelope.height !== vector.heightPixels) throw new Error("Spring geometry needs a fixed local pixel envelope");
  const frames = Math.round(graphic.duration * fps);
  if (!Number.isFinite(fps) || fps < 1 || fps > 240 || !Number.isSafeInteger(frames) || frames < 2 || frames > 1800) throw new Error("Spring geometry duration supports 2 to 1800 project frames");
  if (!Number.isFinite(graphic.timelineStart) || graphic.timelineStart < 0 || !Number.isSafeInteger(Math.round(graphic.timelineStart * fps))
    || Math.abs(graphic.timelineStart * fps - Math.round(graphic.timelineStart * fps)) > .000001
    || Math.abs(graphic.duration * fps - frames) > .000001) throw new Error("Spring geometry range must align to integer project frames");
  const tracks = [geometry.left, geometry.top, geometry.right, geometry.bottom, geometry.cornerRadius];
  if (tracks.reduce((total, track) => total + track.events.length, 0) > 32) throw new Error("Spring geometry supports at most 32 total target events");
  for (const track of tracks) {
    if (track.fps !== fps) throw new Error("Spring geometry fps must match the project");
    if ([track.initialPosition, track.initialTarget, ...track.events.map(event => event.target)].some(value => value < 0 || value > 4096)
      || Math.abs(track.initialVelocity) > 32768) throw new Error("Spring geometry target/velocity exceeds project bounds");
    if (track.events.some(event => event.frame >= frames)) throw new Error("Spring geometry target is outside the admitted frame range");
  }
}

/** Commit-time preflight: inspect every admitted output frame, never clamp. */
export function assertContinuityVectorFrameRange(graphic: MotionGraphic, fps: number): void {
  if (graphic.vectorV2?.kind !== "spring_panel") return;
  assertContinuityVectorContract(graphic, fps);
  for (let frame = 0, frames = Math.round(graphic.duration * fps); frame < frames; frame++) {
    const { geometry } = sampleSpringGeometryTrack(graphic.vectorV2.geometry, frame);
    const outline = graphic.outlineWidth ?? 0;
    if (!Number.isFinite(outline) || outline < 0 || outline > Math.min(geometry.width, geometry.height) / 2) throw new Error(`Spring geometry outline exceeds frame ${frame} bounds`);
  }
}

/** An authored envelope must fit without implicit shrinking or repositioning. */
export function assertContinuityVectorLayout(project: Pick<EditProject, "width" | "height">, graphic: MotionGraphic): void {
  if (graphic.vectorV2?.kind !== "spring_panel") return;
  const safe = graphic.layoutV2?.safeArea;
  if (!safe) throw new Error("Spring geometry needs a fixed layout");
  const { envelope } = graphic.vectorV2.geometry;
  const x = graphic.x * project.width, y = graphic.y * project.height, width = graphic.width * project.width;
  if (![x, y, width, project.width, project.height].every(Number.isFinite) || Math.abs(width - envelope.width) > .001
    || x < safe.left * project.width || y < safe.top * project.height
    || x + width > (1 - safe.right) * project.width || y + envelope.height > (1 - safe.bottom) * project.height) {
    throw new Error("Spring geometry fixed envelope must fit the authored safe-area without truncation or repositioning");
  }
}
