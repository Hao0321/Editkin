import { createHash } from "node:crypto";
import { findAsset, findClip } from "../domain/editGraph";
import type { EditorCommand } from "../domain/commandTypes";
import type { EditProject, NormalizedRect } from "../domain/types";
import { TRACK_LOCKED_MESSAGE } from "../domain/trackLock";
import { canonicalJson } from "../shared/canonicalJson";
import type { ReframeObservationV1 } from "./autoReframeV1";
export interface SparseReframeInputV2 { clipId: string; outputWidth: number; outputHeight: number; maximumCommands?: number; maximumPositionErrorPixels?: number;
  deadZone?: number; maximumPanSpeed?: number; springFrequency?: number; expectedSourceSha256?: string; matteMaskId?: string }
const owners = new WeakMap<object, { project: string; input: string }>();
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const validRect = (r: NormalizedRect) => Object.values(r).every(Number.isFinite) && r.x >= 0 && r.y >= 0 && r.width > 0 && r.height > 0 && r.x + r.width <= 1 + 1e-9 && r.y + r.height <= 1 + 1e-9;
function axis(at: number, velocity: number, target: number, dt: number, omega: number, speedLimit: number) {
  const error = at - target, e = Math.exp(-omega * dt), term = velocity + omega * error, proposed = target + (error + term * dt) * e;
  const delta = clamp(proposed - at, -speedLimit * dt, speedLimit * dt);
  return { at: at + delta, velocity: delta === proposed - at ? (velocity - omega * term * dt) * e : delta / dt };
}
/** Online feasible-slope corridor. Every accepted source observation constrains the eventual linear segment. */
export function createAutoReframeSparseV2(project: EditProject, input: SparseReframeInputV2) {
  const clip = findClip(project, input.clipId), asset = findAsset(project, clip.assetId), track = project.tracks.find(t => t.clips.some(c => c.id === clip.id));
  if (track?.locked) throw Error(TRACK_LOCKED_MESSAGE);
  if (!track || track.kind !== "video" || asset.kind !== "video") throw Error("REFRAME_VIDEO_CLIP_REQUIRED");
  if (![input.outputWidth, input.outputHeight].every(v => Number.isSafeInteger(v) && v > 0 && v <= 16384) || !Number.isFinite(project.fps) || project.fps <= 0 || project.fps > 240) throw Error("REFRAME_GEOMETRY_INVALID");
  if (clip.keyframes.length || clip.transform.x !== 0 || clip.transform.y !== 0 || clip.transform.scale !== 1 || clip.transform.rotation !== 0 || clip.transform.flipX || clip.transform.flipY
    || clip.layout || clip.transform3d || clip.floatingFrame || Object.keys(clip.expressions ?? {}).length) throw Error("REFRAME_EXISTING_CAMERA_REQUIRES_MERGE");
  const resize = project.width !== input.outputWidth || project.height !== input.outputHeight;
  if (resize && (project.tracks.flatMap(t => t.clips).length !== 1 || project.captions.length || project.motionGraphics.length || project.motionScenes?.length || project.compositions?.length || project.referenceMotionInstances?.length)) throw Error("REFRAME_RESIZE_OTHER_CONTENT_REQUIRES_RECOMPOSITION");
  const frameCount = Math.round(clip.duration * project.fps), cap = input.maximumCommands ?? 4096, epsilon = input.maximumPositionErrorPixels ?? .25;
  const deadZone = input.deadZone ?? .08, pan = input.maximumPanSpeed ?? .6, omega = input.springFrequency ?? 8;
  if (!Number.isSafeInteger(frameCount) || frameCount < 1 || Math.abs(frameCount / project.fps - clip.duration) > 1e-8 || !Number.isSafeInteger(cap) || cap < 2 || cap > 4096
    || !Number.isFinite(epsilon) || epsilon < .01 || epsilon > .25 || !Number.isFinite(deadZone) || deadZone < 0 || deadZone > .3 || !Number.isFinite(pan) || pan <= 0 || pan > 2
    || !Number.isFinite(omega) || omega < 1 || omega > 30) throw Error("REFRAME_CLOCK_OR_BUDGET_INVALID");
  const commands: EditorCommand[] = resize ? [{ type: "set_project_resolution", width: input.outputWidth, height: input.outputHeight }] : [], digest = createHash("sha256");
  const trace: ReframeObservationV1[] = [], cameraTrace: { frame: number; centerX: number; centerY: number; sceneCut: boolean }[] = [];
  let initialized = false, finished = false, failed = false, sourceWidth = 0, sourceHeight = 0, count = 0, x = .5, y = .5, vx = 0, vy = 0;
  let cropWidth = 1, cropHeight = 1, renderedWidth = 0, renderedHeight = 0, scale = 1, maxX = 0, maxY = 0, speedX = 0, speedY = 0;
  let anchor: { frame: number; x: number; y: number } | undefined, previous: typeof anchor, loX = 0, hiX = 0, loY = 0, hiY = 0;
  let valid = 0, contained = 0, guaranteed = 0, scenes = 0, intersections = 0, maximumDiagnosticRows = 0;
  const keyframe = (point: NonNullable<typeof anchor>, hold = false) => {
    if (commands.length >= cap) throw Error("REFRAME_SPARSE_COMMAND_BUDGET_EXHAUSTED");
    commands.push({ type: "add_keyframe", clipId: clip.id, keyframe: { id: `reframe-v2-${clip.id}-${point.frame}`, time: point.frame / project.fps,
      transform: { ...clip.transform, scale, x: point.x, y: point.y }, color: { ...clip.color }, easing: hold ? "hold" : "linear" } });
  };
  const resetCorridor = () => { loX = -speedX; hiX = speedX; loY = -speedY; hiY = speedY; };
  const segmentEnd = () => {
    if (!previous || !anchor || previous.frame === anchor.frame) return;
    const dt = previous.frame - anchor.frame;
    const end = { frame: previous.frame, x: anchor.x + clamp((previous.x - anchor.x) / dt, loX, hiX) * dt, y: anchor.y + clamp((previous.y - anchor.y) / dt, loY, hiY) * dt };
    if (Math.abs(end.x - previous.x) > epsilon + 1e-8 || Math.abs(end.y - previous.y) > epsilon + 1e-8 || Math.abs(end.x) > maxX + 1e-8 || Math.abs(end.y) > maxY + 1e-8) throw Error("REFRAME_SPARSE_CORRIDOR_INVALID");
    keyframe(end); anchor = end; resetCorridor();
  };
  const acceptPoint = (point: NonNullable<typeof anchor>, cut: boolean) => {
    if (!anchor) { keyframe(point); anchor = point; previous = point; resetCorridor(); return; }
    if (cut) {
      segmentEnd(); const last = commands.at(-1); if (last?.type === "add_keyframe") last.keyframe.easing = "hold";
      keyframe(point); anchor = point; previous = point; resetCorridor(); return;
    }
    const intersect = () => {
      const dt = point.frame - anchor!.frame;
      if (dt <= 0) throw Error("REFRAME_SPARSE_FRAME_ORDER_INVALID");
      return { lx: Math.max(loX, (Math.max(-maxX, point.x - epsilon) - anchor!.x) / dt), hx: Math.min(hiX, (Math.min(maxX, point.x + epsilon) - anchor!.x) / dt),
        ly: Math.max(loY, (Math.max(-maxY, point.y - epsilon) - anchor!.y) / dt), hy: Math.min(hiY, (Math.min(maxY, point.y + epsilon) - anchor!.y) / dt) };
    };
    let corridor = intersect();
    if (corridor.lx > corridor.hx || corridor.ly > corridor.hy) { segmentEnd(); corridor = intersect(); }
    if (corridor.lx > corridor.hx + 1e-10 || corridor.ly > corridor.hy + 1e-10) throw Error("REFRAME_SPARSE_CORRIDOR_INVALID");
    loX = corridor.lx; hiX = Math.max(corridor.lx, corridor.hx); loY = corridor.ly; hiY = Math.max(corridor.ly, corridor.hy); intersections++; previous = point;
  };
  const api = {
    initialize(width: number, height: number) {
      if (initialized || finished || failed || ![width, height].every(v => Number.isSafeInteger(v) && v > 0 && v <= 16384)) throw Error("REFRAME_SPARSE_INITIALIZATION_INVALID");
      sourceWidth = width; sourceHeight = height; const sourceAspect = width / height, outputAspect = input.outputWidth / input.outputHeight;
      cropWidth = Math.min(1, outputAspect / sourceAspect); cropHeight = Math.min(1, sourceAspect / outputAspect); scale = Math.max(sourceAspect / outputAspect, outputAspect / sourceAspect);
      renderedWidth = input.outputWidth / cropWidth; renderedHeight = input.outputHeight / cropHeight; maxX = (.5 - cropWidth / 2) * renderedWidth; maxY = (.5 - cropHeight / 2) * renderedHeight;
      speedX = pan * renderedWidth / project.fps; speedY = pan * renderedHeight / project.fps; initialized = true;
    },
    consume(obs: ReframeObservationV1) {
      if (!initialized || finished || failed) throw Error("REFRAME_SPARSE_STATE_INVALID");
      try {
        if (count >= frameCount || obs.frame !== count || Math.abs(obs.time - count / project.fps) > 1e-8 || !/^[a-f0-9]{64}$/.test(obs.pixelSha256) || typeof obs.sceneCut !== "boolean"
          || obs.subject && (!validRect(obs.subject.rect) || !Number.isFinite(obs.subject.confidence) || obs.subject.confidence < 0 || obs.subject.confidence > 1 || !["matte", "saliency"].includes(obs.subject.origin))) throw Error("REFRAME_OBSERVATION_INVALID");
        const subject = obs.subject && obs.subject.confidence >= .5 ? obs.subject : undefined, cx = subject ? subject.rect.x + subject.rect.width / 2 : x, cy = subject ? subject.rect.y + subject.rect.height / 2 : y;
        const tx = clamp(Math.abs(cx - x) <= cropWidth * deadZone ? x : cx, cropWidth / 2, 1 - cropWidth / 2), ty = clamp(Math.abs(cy - y) <= cropHeight * deadZone ? y : cy, cropHeight / 2, 1 - cropHeight / 2);
        if (!count || obs.sceneCut) { x = tx; y = ty; vx = 0; vy = 0; scenes++; }
        else if (!subject) { vx = 0; vy = 0; }
        else { const sx = axis(x, vx, tx, 1 / project.fps, omega, pan), sy = axis(y, vy, ty, 1 / project.fps, omega, pan); x = clamp(sx.at, cropWidth / 2, 1 - cropWidth / 2); y = clamp(sy.at, cropHeight / 2, 1 - cropHeight / 2); vx = sx.velocity; vy = sy.velocity; }
        if (subject) { valid++; const dx = Math.abs(cx - x), dy = Math.abs(cy - y); if (dx <= cropWidth * .3 + 1e-9 && dy <= cropHeight * .3 + 1e-9) contained++;
          if (dx <= cropWidth * .3 - epsilon / renderedWidth && dy <= cropHeight * .3 - epsilon / renderedHeight) guaranteed++; }
        acceptPoint({ frame: count, x: (.5 - x) * renderedWidth, y: (.5 - y) * renderedHeight }, count > 0 && obs.sceneCut);
        digest.update(canonicalJson(obs)); digest.update("\n"); trace.push(structuredClone(obs)); cameraTrace.push({ frame: count, centerX: x, centerY: y, sceneCut: obs.sceneCut });
        if (trace.length > 8) trace.shift(); if (cameraTrace.length > 8) cameraTrace.shift(); maximumDiagnosticRows = Math.max(maximumDiagnosticRows, trace.length); count++;
      } catch (error) { failed = true; throw error; }
    },
    finish() {
      if (!initialized || finished || failed || count !== frameCount || !anchor || !previous) throw Error("REFRAME_SPARSE_INCOMPLETE_OR_STATE_INVALID");
      try { segmentEnd(); finished = true;
        return { schema: "editkin.auto-reframe-preparation/v2" as const, state: "DRAFT_CANDIDATE" as const, commands, frames: cameraTrace.slice(), observations: trace.slice(), crop: { width: cropWidth, height: cropHeight },
          source: { assetId: asset.id, clipId: clip.id, sourceStart: clip.sourceStart, duration: clip.duration, uri: asset.uri, width: sourceWidth, height: sourceHeight },
          projectSha256: createHash("sha256").update(canonicalJson(project)).digest("hex"), observationSha256: digest.digest("hex"),
          metrics: { observations: count, validSubjects: valid, central60Frames: contained, measuredCentral60Ratio: valid ? contained / valid : null, unknownFrames: count - valid,
            guaranteedCompressedCentral60Frames: guaranteed, guaranteedCompressedCentral60Ratio: valid ? guaranteed / valid : null, actualCompressedHumanCoverageCertified: false },
          camera: { deadZone, maximumPanSpeed: pan, springFrequency: omega, sceneCutReset: true }, compression: { method: "online_feasible_slope_corridor/v1", maximumPositionErrorPixels: epsilon,
            maximumCommands: cap, outputKeyframes: commands.filter(c => c.type === "add_keyframe").length, maximumDiagnosticRows, storedWholeObservationRows: 0, acceptedConstraints: intersections, sceneStarts: scenes },
          subjectQualityCertified: false, visualCertification: "ART_PENDING_CLAUDE", mutationPerformed: false };
      } catch (error) { failed = true; throw error; }
    },
  };
  owners.set(api, { project: canonicalJson(project), input: canonicalJson(input) }); return Object.freeze(api);
}
export type AutoReframeSparseSinkV2 = ReturnType<typeof createAutoReframeSparseV2>;
export function assertAutoReframeSparseSinkV2(value: AutoReframeSparseSinkV2, project: EditProject, input: SparseReframeInputV2) {
  const owner = owners.get(value); if (!owner || owner.project !== canonicalJson(project) || owner.input !== canonicalJson(input)) throw Error("REFRAME_SPARSE_OWNER_BINDING_CHANGED");
}
