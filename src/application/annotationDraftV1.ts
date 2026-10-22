import * as z from "zod/v4";
import type { EditProject } from "../domain/types";
import { createEmptyProject } from "../domain/editGraph";
import { TRACK_LOCKED_MESSAGE } from "../domain/trackLock";
import { vectorTrackingV1Schema } from "../domain/vectorTrackingV1";
import { shapeBounds, motionVectorPaths } from "../motion/vectorGeometry";
import { motionGraphicV2LayoutReceipt, motionGraphicV2FrameReceipt } from "../motion/compositionV2";
import { prepareStrokeAnnotationV1, strokeAnnotationRequestV1Schema } from "./strokeAnnotationV1";

export type AnnotationKindV1 = "arrow" | "circle" | "underline";
export interface AnnotationPointV1 { x: number; y: number }
export const annotationStyleV1Schema = z.strictObject({ inkColor: z.string().regex(/^#[a-f0-9]{6}(?:[a-f0-9]{2})?$/iu),
  widthPixels: z.number().finite().min(.5).max(64), revealFrames: z.number().int().min(1).max(600),
  headLength: z.number().finite().min(1).max(256), headAngleDegrees: z.number().finite().min(15).max(80) });
/** Q-E17 candidate only: explicit host choice, never a certified/VA default. */
export const ANNOTATION_STYLE_PROPOSAL_V1 = Object.freeze({ inkColor: "#FFFFFF", widthPixels: 4, revealFrames: 8, headLength: 18, headAngleDegrees: 30 });
const targetSchema = z.strictObject({ clipId: z.string().min(1).max(160), frame: z.number().int().nonnegative(),
  range: z.strictObject({ startFrame: z.number().int().nonnegative(), endFrame: z.number().int().positive() }), style: annotationStyleV1Schema,
  purpose: z.string().trim().min(1).max(500), evidenceRefs: z.array(z.string().trim().min(1).max(160)).min(1).max(8),
  tracking: vectorTrackingV1Schema.omit({ referenceTime: true, schema: true }).optional() });
export type AnnotationTargetV1 = z.infer<typeof targetSchema>;
export type AnnotationRequestV1 = z.infer<typeof strokeAnnotationRequestV1Schema>;

/** Called on arm/commit, not per pointer move. Audio mute/solo never hides a picture. */
export function admitAnnotationTargetV1(project: EditProject, payload: unknown) {
  const target = targetSchema.parse(structuredClone(payload)), { range, frame, style } = target, fps = project.fps;
  if (!Number.isFinite(fps) || fps < 1 || fps > 240 || ![project.width, project.height].every(n => Number.isSafeInteger(n) && n >= 16 && n <= 4096)
    || range.endFrame / fps > 86400 || range.endFrame - range.startFrame < 2 || range.endFrame - range.startFrame > 1800
    || style.revealFrames > range.endFrame - range.startFrame || frame < range.startFrame || frame >= range.endFrame) throw Error("ANNOTATION_CLOCK_OR_CANVAS_BUDGET");
  const clips = project.tracks.flatMap(track => track.clips.filter(c => c.id === target.clipId).map(clip => ({ clip, track })));
  if (clips.length !== 1) throw Error("ANNOTATION_CLIP_MISSING_OR_AMBIGUOUS");
  const { clip, track } = clips[0], assets = project.assets.filter(a => a.id === clip.assetId);
  if (track.locked) throw Error(TRACK_LOCKED_MESSAGE);
  if (track.kind !== "video" || track.hidden || clip.layer?.enabled === false || assets.length !== 1 || assets[0].kind !== "video") throw Error("ANNOTATION_SOURCE_UNAVAILABLE");
  const start = clip.timelineStart * fps, end = (clip.timelineStart + clip.duration) * fps;
  if (!Number.isSafeInteger(Math.round(start)) || !Number.isSafeInteger(Math.round(end)) || Math.abs(start - Math.round(start)) > 1e-6 || Math.abs(end - Math.round(end)) > 1e-6
    || range.startFrame < Math.round(start) || range.endFrame > Math.round(end)) throw Error("ANNOTATION_OUTSIDE_SOURCE_CLIP");
  if (target.tracking) {
    const matches = project.motionTracks.filter(t => t.id === target.tracking!.trackId);
    if (matches.length !== 1 || matches[0].clipId !== clip.id) throw Error("ANNOTATION_TRACK_NOT_ON_SELECTED_CLIP");
  }
  return { target, referenceTime: frame / fps - clip.timelineStart };
}
export function annotationCanvasPointV1(point: AnnotationPointV1, width: number, height: number, clamp = false): AnnotationPointV1 {
  if (![point.x, point.y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) throw Error("ANNOTATION_POINTER_COORDINATES");
  if (!clamp && (point.x < 0 || point.y < 0 || point.x > width || point.y > height)) throw Error("ANNOTATION_POINTER_OUTSIDE_CANVAS");
  return { x: Math.max(0, Math.min(width, point.x)), y: Math.max(0, Math.min(height, point.y)) };
}
/** A tiny empty canvas keeps guide work independent of a ten-hour project's clip count.
 * Geometry, arrow wings, curve commands and stroke fill come from the unchanged compiler. */
export function buildAnnotationDraftV1(canvas: Pick<EditProject, "width" | "height" | "fps" | "revision">, target: AnnotationTargetV1,
  kind: AnnotationKindV1, start: AnnotationPointV1, end: AnnotationPointV1, id: string, name: string) {
  const a = annotationCanvasPointV1(start, canvas.width, canvas.height), b = annotationCanvasPointV1(end, canvas.width, canvas.height);
  if (kind === "circle" && (Math.abs(a.x - b.x) < 1 || Math.abs(a.y - b.y) < 1)) throw Error("ANNOTATION_DEGENERATE_CIRCLE");
  const geometry = kind === "circle" ? { kind, center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, radiusX: Math.abs(b.x - a.x) / 2, radiusY: Math.abs(b.y - a.y) / 2 }
    : kind === "arrow" ? { kind, start: a, end: b, headLength: target.style.headLength, headAngleDegrees: target.style.headAngleDegrees } : { kind, start: a, end: b };
  const miniature = createEmptyProject("Uncommitted annotation guide", { id: "annotation-guide", ...canvas }); miniature.revision = canvas.revision;
  const seed = { expectedRevision: canvas.revision, id, name, range: { startFrame: 0, endFrame: 30 },
    box: { x: 0, y: 0, width: canvas.width, height: canvas.height }, geometry, inkColor: target.style.inkColor, widthPixels: target.style.widthPixels,
    revealFrames: 1, purpose: target.purpose, evidenceRefs: target.evidenceRefs };
  const probe = prepareStrokeAnnotationV1(miniature, seed).command.graphic;
  if (probe.vectorV2?.kind !== "stroke") throw Error("ANNOTATION_ORIGINAL_STROKE_REQUIRED");
  const bounds = shapeBounds(probe.vectorV2.commands), margin = target.style.widthPixels / 2;
  let x = Math.floor(bounds.x0 - margin), right = Math.ceil(bounds.x1 + margin);
  if (right - x < 16) { const extra = 16 - right + x; x -= Math.floor(extra / 2); right = x + 16; }
  const y = Math.floor(bounds.y0 - margin), bottom = Math.ceil(bounds.y1 + margin);
  if (x < 0 || y < 0 || right > canvas.width || bottom > canvas.height) throw Error("ANNOTATION_INK_OUTSIDE_CANVAS");
  const local = geometry.kind === "circle" ? { ...geometry, center: { x: geometry.center.x - x, y: geometry.center.y - y } }
    : { ...geometry, start: { x: geometry.start.x - x, y: geometry.start.y - y }, end: { x: geometry.end.x - x, y: geometry.end.y - y } };
  const request = strokeAnnotationRequestV1Schema.parse({ ...seed, box: { x, y, width: right - x, height: bottom - y }, geometry: local,
    range: target.range, revealFrames: target.style.revealFrames });
  const graphic = prepareStrokeAnnotationV1(miniature, { ...request, range: { startFrame: 0, endFrame: 30 }, revealFrames: 1 }).command.graphic;
  const layout = motionGraphicV2LayoutReceipt(miniature, graphic), frame = motionGraphicV2FrameReceipt(miniature, graphic, 1, layout);
  const paths = motionVectorPaths(graphic, layout, frame); if (!paths.length) throw Error("ANNOTATION_GUIDE_NOT_DRAWN");
  return { request, start: a, end: b, guide: { box: request.box, paths, source: "original_unbound_full_reveal_authoring_guide" as const },
    qualityState: "ART_PENDING_CLAUDE" as const, defaultEnabled: false as const };
}
export type AnnotationDraftV1 = ReturnType<typeof buildAnnotationDraftV1>;
export function prepareAnnotationCommandV1(project: EditProject, target: AnnotationTargetV1, draft: AnnotationDraftV1) {
  const admitted = admitAnnotationTargetV1(project, target);
  const request = { ...structuredClone(draft.request), ...(target.tracking ? { tracking: { schema: "editkin.vector-tracking/v1" as const, ...target.tracking, referenceTime: admitted.referenceTime } } : {}) };
  return prepareStrokeAnnotationV1(project, request);
}
