import type { EditorCommand } from "../../domain/commandTypes";
import { DEFAULT_CLIP_LAYER, DEFAULT_COLOR } from "../../domain/types";
import type { ClipKeyframe, ClipLayout, ClipMask, MediaAsset, TimelineClip } from "../../domain/types";
import { roundedRectPolygon } from "../components/insertLayouts";
import type { StyleJobTrack, StyleRenderJobV1 } from "../jobs";
import type { UiCardCompileResultV1, UiCardFrame, UiCardLayer } from "./compile";

/**
 * The S1 v2 card as ordinary Editkin commands (what the review renderer draws, bound for preview == export):
 * - the footage clip keeps its source and gets an identity layout; the slide-in span is split off with a static
 *   polygon mask (the window, inverse-mapped through its held framing) and pose keyframes;
 * - the body gets a fixed-window mask (editkin.fixed-template-window/v3: the card stays put while the transform
 *   keyframes move and zoom the screen recording behind it — the ROI follow and punch-ins);
 * - the tail that plays under the next card is a second clip of the same source on an alternate track;
 * - callouts are further clips of the same source with a rounded mask on the detail and pose keyframes;
 * - chrome stills, the backdrop and every overlay job bind as import_asset + add_clip, stills with pose keyframes.
 * Keyframes are linear and thinned within a sub-pixel tolerance of the per-frame states.
 */

export interface UiCardShotBinding {
  /** The footage clip id on the timeline (= the plan's shot id), its asset and display size. */
  readonly assetId: string;
  readonly source: { readonly width: number; readonly height: number };
}

export interface UiCardBinding {
  readonly shots: ReadonlyMap<string, UiCardShotBinding>;
  /** The track plan (uiCardTracks); its tracks must exist, in its order, around the footage track. */
  readonly tracks: UiCardTrackPlan;
}

export interface UiCardTrackPlan {
  /** Bottom → top. "footage" marks where the footage track (the card bodies) sits. */
  readonly order: ReadonlyArray<{ readonly id: string; readonly name: string } | "footage">;
  readonly jobTrack: ReadonlyMap<string, string>;
  readonly cardTail: string;
  readonly callouts: string;
}

const GROUP: Readonly<Record<string, string>> = { chapterChip: "chip", lowerThird: "lower", toolTag: "tag", promptBubble: "bubble", cursorClick: "cursor" };

/** Tracks for every job (clips on one track never overlap: overlapping jobs of a kind take lanes, newer above). */
export function uiCardTracks(compile: UiCardCompileResultV1, prefix = "style-ui"): UiCardTrackPlan {
  const lanes = new Map<string, number[]>();
  const jobTrack = new Map<string, string>();
  const used = new Map<string, number>();
  for (const job of [...compile.jobs].sort((a, b) => a.startFrame - b.startFrame)) {
    const group = job.track === "overlay" ? `overlay-${GROUP[job.component] ?? job.component}` : job.track;
    const ends = lanes.get(group) ?? [];
    let lane = ends.findIndex(end => end <= job.startFrame);
    if (lane < 0) { lane = ends.length; ends.push(0); }
    ends[lane] = job.startFrame + job.frameCount;
    lanes.set(group, ends);
    used.set(group, Math.max(used.get(group) ?? 0, lane + 1));
    jobTrack.set(job.id, `${prefix}-${group}-${lane}`);
  }
  const groups = (names: readonly string[]) => names.flatMap(group => Array.from({ length: used.get(group) ?? 0 }, (_, lane) => ({ id: `${prefix}-${group}-${lane}`, name: `${group} ${lane + 1}` })));
  const cardTail = `${prefix}-card-tail`, callouts = `${prefix}-callouts`;
  const order = [
    ...groups(["backdrop", "cardUnderTail"]), { id: cardTail, name: "card tail" }, ...groups(["cardOverTail", "cardUnder"]), "footage" as const,
    ...groups(["cardOver", "calloutUnder"]), { id: callouts, name: "callouts" }, ...groups(["calloutOver"]),
    ...groups(["overlay-chip", "overlay-bubble", "overlay-tag", "overlay-cursor", "overlay-lower"]),
  ];
  return { order, jobTrack, cardTail, callouts };
}

export interface RenderedUiJob { readonly assetId: string; readonly uri: string; readonly durationSeconds: number }

const IDENTITY_LAYOUT: ClipLayout = { crop: { x: 0, y: 0, width: 1, height: 1 }, viewport: { x: 0, y: 0, width: 1, height: 1 } };
const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits;

interface Pose { readonly x: number; readonly y: number; readonly scale: number; readonly opacity: number }

/** Clip transform (identity layout: the contain-fitted canvas scaled about the frame centre, then offset) for a layer state. */
export function layerTransform(layer: UiCardLayer, state: UiCardFrame, frame: { width: number; height: number }, source: { width: number; height: number }, pose = true): Pose {
  const f = Math.min(frame.width / source.width, frame.height / source.height);
  const r = layer.rect, rcx = r.x + r.w / 2, rcy = r.y + r.h / 2, vcx = frame.width / 2, vcy = frame.height / 2;
  const k = r.w / state.w, z0 = k / f;
  const t0x = rcx - vcx - k * (state.cx - source.width / 2), t0y = rcy - vcy - k * (state.cy - source.height / 2);
  if (!pose) return { x: t0x, y: t0y, scale: z0, opacity: 1 };
  const sigma = state.scale;
  return { x: sigma * t0x + (1 - sigma) * (rcx - vcx) + state.dx, y: sigma * t0y + (1 - sigma) * (rcy - vcy) + state.dy, scale: sigma * z0, opacity: state.opacity };
}

/** Output px → mask space (normalized fitted canvas) under an unposed transform. */
function toMaskSpace(point: readonly [number, number], transform: Pose, frame: { width: number; height: number }): { x: number; y: number } {
  const vcx = frame.width / 2, vcy = frame.height / 2;
  const qx = ((point[0] - transform.x - vcx) / transform.scale + vcx) / frame.width, qy = ((point[1] - transform.y - vcy) / transform.scale + vcy) / frame.height;
  return { x: round(Math.min(1, Math.max(0, qx)), 6), y: round(Math.min(1, Math.max(0, qy)), 6) };
}

function windowPolygon(layer: UiCardLayer): Array<[number, number]> {
  return roundedRectPolygon(layer.rect.w, layer.rect.h, layer.radius).map(([x, y]) => [layer.rect.x + x, layer.rect.y + y] as [number, number]);
}

function mask(id: string, path: Array<{ x: number; y: number }>, fixed: boolean): ClipMask {
  return {
    ...(fixed ? { fixedWindowV3: { schema: "editkin.fixed-template-window/v3" as const } } : {}),
    id, name: fixed ? "UI card window" : "UI card window (held)", kind: "polygon", mode: "add", enabled: true, inverted: false, opacity: 1, feather: 0, expansion: 0,
    path: path.map((point, index) => ({ id: `p${index + 1}`, ...point })), keyframes: [], refine: { edgeShift: 0, contrast: 0.5, chatterReduction: 0 },
  };
}

/** Linear keys within tolerance of every per-frame pose (greedy: extend each segment while all frames stay within it). */
export function thinPoses(poses: readonly Pose[], fps: number, tolerance = { xy: 0.25, scale: 0.0003, opacity: 0.004 }): Array<{ time: number; pose: Pose }> {
  if (!poses.length) return [];
  const keys = [0];
  let anchor = 0;
  const fits = (a: number, b: number) => {
    for (let i = a + 1; i < b; i += 1) {
      const u = (i - a) / (b - a), p = poses[a], q = poses[b], s = poses[i];
      if (Math.abs(p.x + (q.x - p.x) * u - s.x) > tolerance.xy || Math.abs(p.y + (q.y - p.y) * u - s.y) > tolerance.xy
        || Math.abs(p.scale + (q.scale - p.scale) * u - s.scale) > tolerance.scale || Math.abs(p.opacity + (q.opacity - p.opacity) * u - s.opacity) > tolerance.opacity) return false;
    }
    return true;
  };
  for (let i = 2; i < poses.length; i += 1) {
    if (!fits(anchor, i)) { keys.push(i - 1); anchor = i - 1; }
  }
  if (keys[keys.length - 1] !== poses.length - 1) keys.push(poses.length - 1);
  return keys.map(index => ({ time: round(index / fps, 6), pose: poses[index] }));
}

function keyframeCommands(clipId: string, keys: Array<{ time: number; pose: Pose }>): EditorCommand[] {
  return keys.map(({ time, pose }, index) => {
    const keyframe: ClipKeyframe = { id: `${clipId}-k${index}`, time, easing: "linear",
      transform: { x: round(pose.x, 3), y: round(pose.y, 3), scale: round(pose.scale, 6), rotation: 0, opacity: round(pose.opacity, 4) }, color: { ...DEFAULT_COLOR } };
    return { type: "add_keyframe" as const, clipId, keyframe };
  });
}

export function uiCardProductCommands(compile: UiCardCompileResultV1, binding: UiCardBinding): EditorCommand[] {
  const frame = { width: compile.frame.width, height: compile.frame.height }, fps = compile.frame.fps;
  const commands: EditorCommand[] = [];
  for (const layer of compile.layers) {
    const shot = binding.shots.get(layer.shotId);
    if (!shot) throw new Error(`UI card binding has no shot ${layer.shotId}`);
    const poses = layer.frames.map(state => layerTransform(layer, state, frame, shot.source));
    const polygon = windowPolygon(layer);
    if (layer.kind === "callout") {
      // A detail of the same recording: its region, rounded, with the pop-out pose.
      const id = `style-${layer.id}`;
      const rest = layerTransform(layer, layer.frames[0], frame, shot.source, false);
      const clip: TimelineClip = { id, assetId: shot.assetId, trackId: binding.tracks.callouts, timelineStart: round(layer.startFrame / fps, 6), sourceStart: round(layer.sourceStart, 6),
        duration: round(layer.frames.length / fps, 6), volume: 0, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, color: { ...DEFAULT_COLOR }, keyframes: [],
        layer: { ...DEFAULT_CLIP_LAYER }, layout: IDENTITY_LAYOUT };
      void rest;
      // The detail's region, rounded, in mask space (the pose keyframes carry it out of the card).
      const k = layer.rect.w / layer.frames[0].w, f = Math.min(frame.width / shot.source.width, frame.height / shot.source.height);
      const offX = (frame.width - shot.source.width * f) / 2, offY = (frame.height - shot.source.height * f) / 2;
      const s0 = layer.frames[0];
      const region = roundedRectPolygon(s0.w, s0.h, layer.radius / k).map(([x, y]) => ({
        x: round(Math.min(1, Math.max(0, ((s0.cx - s0.w / 2 + x) * f + offX) / frame.width)), 6), y: round(Math.min(1, Math.max(0, ((s0.cy - s0.h / 2 + y) * f + offY) / frame.height)), 6) }));
      commands.push({ type: "add_clip", clip }, { type: "add_clip_mask", clipId: id, mask: mask(`${id}-window`, region, false) },
        ...keyframeCommands(id, thinPoses(poses, fps)));
      continue;
    }
    const clipId = layer.shotId, spans = layer.spans ?? { entry: 0, body: layer.frames.length };
    commands.push({ type: "set_clip_layout", clipId, layout: IDENTITY_LAYOUT });
    let bodyId = clipId;
    if (spans.entry > 0) {
      // Slide-in: a static mask (the window under the held framing) moving with the pose.
      bodyId = `${clipId}-card`;
      commands.push({ type: "split_clip", clipId, at: round((layer.startFrame + spans.entry) / fps, 6), newClipId: bodyId });
      const held = layerTransform(layer, layer.frames[spans.entry], frame, shot.source, false);
      commands.push({ type: "add_clip_mask", clipId, mask: mask(`${clipId}-window`, polygon.map(point => toMaskSpace(point, held, frame)), false) },
        ...keyframeCommands(clipId, thinPoses(poses.slice(0, spans.entry + 1), fps)));
    }
    // Body: the fixed window; the keyframes move the recording behind it.
    commands.push({ type: "add_clip_mask", clipId: bodyId, mask: mask(`${bodyId}-fixed`, polygon.map(([x, y]) => ({ x: round(x / frame.width, 6), y: round(y / frame.height, 6) })), true) },
      ...keyframeCommands(bodyId, thinPoses(poses.slice(spans.entry, spans.body), fps)));
    if (layer.frames.length > spans.body) {
      // Tail under the next card: the same source continues on the alternate track.
      const tailId = `${clipId}-tail`;
      const held = layerTransform(layer, layer.frames[spans.body], frame, shot.source, false);
      const clip: TimelineClip = { id: tailId, assetId: shot.assetId, trackId: binding.tracks.cardTail, timelineStart: round((layer.startFrame + spans.body) / fps, 6),
        sourceStart: round(layer.sourceStart + spans.body / fps, 6), duration: round((layer.frames.length - spans.body) / fps, 6), volume: 0,
        transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, color: { ...DEFAULT_COLOR }, keyframes: [], layer: { ...DEFAULT_CLIP_LAYER }, layout: IDENTITY_LAYOUT };
      commands.push({ type: "add_clip", clip }, { type: "add_clip_mask", clipId: tailId, mask: mask(`${tailId}-window`, polygon.map(point => toMaskSpace(point, held, frame)), false) },
        ...keyframeCommands(tailId, thinPoses(poses.slice(spans.body), fps)));
    }
  }
  return commands;
}

/** import_asset + add_clip for a rendered UI job; stills with pose keys move like their card (scale about the job's pivot). */
export function bindUiCardJob(job: StyleRenderJobV1, rendered: RenderedUiJob, trackId: string, frame: { width: number; height: number }): EditorCommand[] {
  const still = job.output === "still";
  const asset: MediaAsset = { id: rendered.assetId, name: `Style ${job.id}`, kind: still ? "image" : "video", uri: rendered.uri,
    duration: rendered.durationSeconds, width: frame.width, height: frame.height, ...(job.output === "alpha" || still ? { alphaMode: "straight" as const } : {}),
    provenance: `editkin style template job ${job.key}`, license: "Editkin original", redistributable: true };
  const id = `style-${job.id}`;
  const clip: TimelineClip = { id, assetId: asset.id, trackId, timelineStart: job.timelineStart, sourceStart: 0, duration: round(job.frameCount / job.fps, 6), volume: 0,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, color: { ...DEFAULT_COLOR }, keyframes: [], layer: { ...DEFAULT_CLIP_LAYER } };
  const commands: EditorCommand[] = [{ type: "import_asset", asset }, { type: "add_clip", clip }];
  if (job.pose?.length && job.pivot) {
    const vcx = frame.width / 2, vcy = frame.height / 2, pivot = job.pivot;
    const poses = job.pose.map(key => ({ time: key.t, pose: { x: (1 - key.scale) * (pivot.x - vcx) + key.dx, y: (1 - key.scale) * (pivot.y - vcy) + key.dy, scale: key.scale, opacity: key.opacity } }));
    commands.push(...keyframeCommands(id, poses));
  }
  return commands;
}
