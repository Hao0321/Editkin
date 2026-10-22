import { createHash } from "node:crypto";
import { findAsset, findClip } from "../domain/editGraph";
import type { EditorCommand } from "../domain/commandTypes";
import type { EditProject, NormalizedRect } from "../domain/types";
import { TRACK_LOCKED_MESSAGE } from "../domain/trackLock";
import { canonicalJson } from "../shared/canonicalJson";

export interface ReframeSubjectV1 { rect: NormalizedRect; confidence: number; origin: "matte" | "saliency" }
export interface ReframeObservationV1 { frame: number; time: number; subject?: ReframeSubjectV1; sceneCut: boolean; pixelSha256: string }
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const validRect = (r: NormalizedRect) => Object.values(r).every(Number.isFinite) && r.x >= 0 && r.y >= 0 && r.width > 0 && r.height > 0 && r.x + r.width <= 1 + 1e-9 && r.y + r.height <= 1 + 1e-9;
/** Bounded source-pixel heuristic. It locates visual contrast, not people or semantic subjects. */
export function observeReframePixelsV1(input: { rgba: Uint8Array; width: number; height: number; alpha?: Uint8Array; alphaWidth?: number; alphaHeight?: number }) {
  const { width, height, rgba } = input;
  if (![width, height].every(v => Number.isSafeInteger(v) && v > 0) || width * height * 4 !== rgba.length || rgba.length > 64 * 1024 ** 2) throw Error("REFRAME_PIXEL_SHAPE_INVALID");
  const gw = Math.min(48, width), gh = Math.min(48, height), grid = new Float64Array(gw * gh * 3), histogram = new Float64Array(48), average = [0, 0, 0];
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    const src = (Math.min(height - 1, Math.floor((y + .5) * height / gh)) * width + Math.min(width - 1, Math.floor((x + .5) * width / gw))) * 4, dst = (y * gw + x) * 3;
    for (let c = 0; c < 3; c++) { const value = rgba[src + c] / 255; grid[dst + c] = value; average[c] += value; histogram[c * 16 + Math.min(15, Math.floor(value * 16))]++; }
  }
  for (let c = 0; c < 3; c++) average[c] /= gw * gh;
  for (let i = 0; i < histogram.length; i++) histogram[i] /= gw * gh * 3;
  let subject: ReframeSubjectV1 | undefined;
  if (input.alpha) {
    const aw = input.alphaWidth!, ah = input.alphaHeight!;
    if (![aw, ah].every(v => Number.isSafeInteger(v) && v > 0) || aw * ah !== input.alpha.length || input.alpha.length > 16 * 1024 ** 2) throw Error("REFRAME_MATTE_SHAPE_INVALID");
    let left = aw, top = ah, right = -1, bottom = -1, count = 0;
    for (let y = 0; y < ah; y++) for (let x = 0; x < aw; x++) if (input.alpha[y * aw + x] >= 128) { left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); count++; }
    if (count >= aw * ah * .002 && count <= aw * ah * .8) subject = { rect: { x: left / aw, y: top / ah, width: (right - left + 1) / aw, height: (bottom - top + 1) / ah }, confidence: 1, origin: "matte" };
  }
  if (!subject) {
    const scores = new Float64Array(gw * gh); let maximum = 0, total = 0;
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      const at = (y * gw + x) * 3; let energy = 0;
      for (let c = 0; c < 3; c++) { const value = grid[at + c]; energy += (value - average[c]) ** 2;
        if (x) energy += .25 * (value - grid[at - 3 + c]) ** 2; if (y) energy += .25 * (value - grid[at - gw * 3 + c]) ** 2; }
      scores[y * gw + x] = energy; maximum = Math.max(maximum, energy); total += energy;
    }
    if (maximum > .003 && maximum > total / (gw * gh) * 2) {
      let left = gw, top = gh, right = -1, bottom = -1, mass = 0;
      for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) if (scores[y * gw + x] >= maximum * .25) { left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); mass += scores[y * gw + x]; }
      const rect = { x: left / gw, y: top / gh, width: (right - left + 1) / gw, height: (bottom - top + 1) / gh };
      if (validRect(rect) && rect.width * rect.height <= .8 && mass / total >= .3) subject = { rect, confidence: clamp(mass / total, 0, 1), origin: "saliency" };
    }
  }
  return { subject, histogram, gridCells: gw * gh, pixelSha256: createHash("sha256").update(rgba).digest("hex") };
}
export function reframeSceneChangeV1(previous: Float64Array | undefined, current: Float64Array) {
  if (!previous) return true;
  if (previous.length !== 48 || current.length !== 48) throw Error("REFRAME_SCENE_SHAPE_INVALID");
  let distance = 0; for (let i = 0; i < 48; i++) distance += Math.abs(previous[i] - current[i]); return distance / 2 > .4;
}
/** Exact critically damped step, with a strict velocity cap applied to the resulting displacement. */
function cameraAxis(at: number, velocity: number, target: number, dt: number, omega: number, speedLimit: number) {
  const error = at - target, e = Math.exp(-omega * dt), term = velocity + omega * error, proposed = target + (error + term * dt) * e;
  const delta = clamp(proposed - at, -speedLimit * dt, speedLimit * dt);
  return { at: at + delta, velocity: delta === proposed - at ? (velocity - omega * term * dt) * e : delta / dt };
}
export function compileAutoReframeV1(project: EditProject, input: { clipId: string; sourceWidth: number; sourceHeight: number; outputWidth: number; outputHeight: number;
  observations: readonly ReframeObservationV1[]; maximumCommands?: number; deadZone?: number; maximumPanSpeed?: number; springFrequency?: number }) {
  const clip = findClip(project, input.clipId), asset = findAsset(project, clip.assetId), track = project.tracks.find(t => t.clips.some(c => c.id === clip.id));
  if (track?.locked) throw Error(TRACK_LOCKED_MESSAGE);
  if (!track || track.kind !== "video" || asset.kind !== "video") throw Error("REFRAME_VIDEO_CLIP_REQUIRED");
  const dimensions = [input.sourceWidth, input.sourceHeight, input.outputWidth, input.outputHeight];
  if (!dimensions.every(v => Number.isSafeInteger(v) && v > 0 && v <= 16384) || !Number.isFinite(project.fps) || project.fps <= 0 || project.fps > 240) throw Error("REFRAME_GEOMETRY_INVALID");
  if (clip.keyframes.length || clip.transform.x !== 0 || clip.transform.y !== 0 || clip.transform.scale !== 1 || clip.transform.rotation !== 0 || clip.transform.flipX || clip.transform.flipY
    || clip.layout || clip.transform3d || clip.floatingFrame || Object.keys(clip.expressions ?? {}).length) throw Error("REFRAME_EXISTING_CAMERA_REQUIRES_MERGE");
  const resize = project.width !== input.outputWidth || project.height !== input.outputHeight;
  if (resize && (project.tracks.flatMap(t => t.clips).length !== 1 || project.captions.length || project.motionGraphics.length || project.motionScenes?.length || project.compositions?.length || project.referenceMotionInstances?.length)) throw Error("REFRAME_RESIZE_OTHER_CONTENT_REQUIRES_RECOMPOSITION");
  const frameCount = Math.round(clip.duration * project.fps), cap = input.maximumCommands ?? 4096;
  const deadZone = input.deadZone ?? .08, pan = input.maximumPanSpeed ?? .6, omega = input.springFrequency ?? 8;
  if (!Number.isSafeInteger(cap) || cap < 2 || cap > 4096 || frameCount < 1 || Math.abs(frameCount / project.fps - clip.duration) > 1e-8 || input.observations.length !== frameCount || frameCount + (resize ? 1 : 0) > cap
    || !Number.isFinite(deadZone) || deadZone < 0 || deadZone > .3 || !Number.isFinite(pan) || pan <= 0 || pan > 2 || !Number.isFinite(omega) || omega < 1 || omega > 30) throw Error("REFRAME_CLOCK_OR_BUDGET_INVALID");
  const sourceAspect = input.sourceWidth / input.sourceHeight, outputAspect = input.outputWidth / input.outputHeight;
  const cropWidth = Math.min(1, outputAspect / sourceAspect), cropHeight = Math.min(1, sourceAspect / outputAspect);
  const scale = Math.max(sourceAspect / outputAspect, outputAspect / sourceAspect), renderedWidth = input.outputWidth / cropWidth, renderedHeight = input.outputHeight / cropHeight;
  const commands: EditorCommand[] = resize ? [{ type: "set_project_resolution", width: input.outputWidth, height: input.outputHeight }] : [];
  const frames: { frame: number; centerX: number; centerY: number; sceneCut: boolean; subject?: ReframeSubjectV1; subjectInsideCentral60: boolean }[] = [];
  let x = .5, y = .5, vx = 0, vy = 0, valid = 0, contained = 0;
  for (let frame = 0; frame < frameCount; frame++) {
    const obs = input.observations[frame];
    if (obs.frame !== frame || Math.abs(obs.time - frame / project.fps) > 1e-8 || !/^[a-f0-9]{64}$/.test(obs.pixelSha256) || typeof obs.sceneCut !== "boolean"
      || obs.subject && (!validRect(obs.subject.rect) || !Number.isFinite(obs.subject.confidence) || obs.subject.confidence < 0 || obs.subject.confidence > 1 || !["matte", "saliency"].includes(obs.subject.origin))) throw Error("REFRAME_OBSERVATION_INVALID");
    const subject = obs.subject && obs.subject.confidence >= .5 ? obs.subject : undefined;
    const cx = subject ? subject.rect.x + subject.rect.width / 2 : x, cy = subject ? subject.rect.y + subject.rect.height / 2 : y;
    const tx = clamp(Math.abs(cx - x) <= cropWidth * deadZone ? x : cx, cropWidth / 2, 1 - cropWidth / 2), ty = clamp(Math.abs(cy - y) <= cropHeight * deadZone ? y : cy, cropHeight / 2, 1 - cropHeight / 2);
    if (!frame || obs.sceneCut) { x = tx; y = ty; vx = 0; vy = 0; if (frame && commands.at(-1)?.type === "add_keyframe") (commands.at(-1) as Extract<EditorCommand, { type: "add_keyframe" }>).keyframe.easing = "hold"; }
    else { const sx = cameraAxis(x, vx, tx, 1 / project.fps, omega, pan), sy = cameraAxis(y, vy, ty, 1 / project.fps, omega, pan); x = clamp(sx.at, cropWidth / 2, 1 - cropWidth / 2); y = clamp(sy.at, cropHeight / 2, 1 - cropHeight / 2); vx = sx.velocity; vy = sy.velocity; }
    const safe = !!subject && Math.abs(cx - x) <= cropWidth * .3 + 1e-9 && Math.abs(cy - y) <= cropHeight * .3 + 1e-9;
    if (subject) { valid++; if (safe) contained++; }
    frames.push({ frame, centerX: x, centerY: y, sceneCut: obs.sceneCut, subject, subjectInsideCentral60: safe });
    commands.push({ type: "add_keyframe", clipId: clip.id, keyframe: { id: `reframe-v1-${clip.id}-${frame}`, time: frame / project.fps,
      transform: { ...clip.transform, scale, x: (.5 - x) * renderedWidth, y: (.5 - y) * renderedHeight }, color: { ...clip.color }, easing: "linear" } });
  }
  return { schema: "editkin.auto-reframe-preparation/v1" as const, state: "DRAFT_CANDIDATE" as const, commands, frames, crop: { width: cropWidth, height: cropHeight },
    source: { assetId: asset.id, clipId: clip.id, sourceStart: clip.sourceStart, duration: clip.duration, uri: asset.uri }, projectSha256: createHash("sha256").update(canonicalJson(project)).digest("hex"),
    metrics: { observations: frameCount, validSubjects: valid, central60Frames: contained, measuredCentral60Ratio: valid ? contained / valid : null, unknownFrames: frameCount - valid },
    camera: { deadZone, maximumPanSpeed: pan, springFrequency: omega, sceneCutReset: true }, subjectQualityCertified: false, visualCertification: "ART_PENDING_CLAUDE", mutationPerformed: false };
}
