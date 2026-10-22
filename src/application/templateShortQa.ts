import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { applyCommand, type EditorCommand } from "../domain/commands";
import { animatedClipState } from "../domain/editGraph";
import type { EditProject, MotionGraphic } from "../domain/types";
import { motionGraphicV2FrameReceipt, prepareMotionGraphicV2FrameLayout, type MotionGraphicV2FrameReceipt, type MotionGraphicV2LayoutReceipt,
  type MotionGraphicV2SegmentFrame } from "../motion/compositionV2";
import { fullDecodeTimeoutMs } from "../render/renderLifetime";
import { AUTOPILOT_MAX_COMMANDS } from "./autopilotPlan";
import { TemplateShortBlockError } from "./templateShortBrief";
import { assertTemplateBeatCoverage, type TemplateShortBeat, type TemplateShortPacket } from "./templateShortPlan";

/** M1 one-tool Short, plan-time QA (design §6.1 Q3–Q11): runs on the compiled packet before anything beyond the bootstrap
 * is written. Product copies of the theme tests' Shorts v2 constants (referenceMotionDesignThemes.test.ts), so the run
 * and the tests judge with the same numbers. BLOCK findings stop the run; FLAG findings still deliver (NEEDS_FIX). */

/** VA R12 (Shorts/Reels 2026) readable-text box on a 1080x1920 canvas; glyph ink is measured in fractional pixels. */
export const SHORTS_TEXT_SAFE = { left: 40, right: 930, top: 260, bottom: 1660 } as const;
export const SHORTS_TEXT_SAFE_TOLERANCE = 0.5;
/** Phone reading floors in 1080-wide pixels (VA SHORTS_SAFE_ZONE.min_font_px = 60 for supporting lines). */
export const floorOf = (role: string) => /(^|:)subtitle(:claim)?(:\d+)?$|^hero:detail$/.test(role) ? 60 : /:detail$/.test(role) ? 40 : /:label$/.test(role) ? 40 : 32;
/** Two texts collide when their swept ink boxes overlap by more than this many pixels. */
export const TEXT_OVERLAP_INSET = 3;
/** Q10: the footage must cover at least this share of the canvas during the longest steady hold (r53 layout v2: 0.47). */
export const MIN_FOOTAGE_SHARE = 0.35;
/** Q11: the place and the brand may stay this long when the hook beat itself is shorter (ROADMAP 1.8: 2–2.5 s). */
export const HOOK_PLACE_SECONDS = 2.5;
const ANNOTATION = /strike|underline|highlight|emphasis|:wave|scribble/;
/** Parts of one composite text (accent runs, split layers, a counting number and its unit) move together. */
export const roleGroup = (role: string) => role.replace(/:split/g, "").replace(/(:count)?:\d+$/, "").replace(/:(unit|count)$/, "");

export interface TemplateShortQaFinding {
  id: "Q3_safe_area" | "Q4_text_size" | "Q5_beats" | "Q6_caps" | "Q7_text_overlap" | "Q8_stall" | "Q9_first_frame" | "Q10_footage_share" | "Q11_hook_only"
    | "R2_first_frame" | "R3_stall" | "R4_jump" | "R5_text_column";
  severity: "BLOCK" | "FLAG";
  role?: string;
  frames?: number[];
  /** Hao 2026-10-09: an art flag names the second(s) to fix. */
  seconds?: number[];
  detail: string;
}
/** What the analysis reads from a prepared template (prepare_reference_motion_template keeps all of it in memory). */
export interface TemplateShortQaPacket extends Pick<TemplateShortPacket, "instance" | "commands"> {
  layouts: readonly MotionGraphicV2LayoutReceipt[];
  phases: ReadonlyArray<{ role: string; startFrame: number; endFrame: number }>;
}

type Box = { left: number; right: number; top: number; bottom: number };
const meets = (a: Box, b: Box, inset = TEXT_OVERLAP_INSET) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > inset
  && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > inset;
const graphicsOf = (packet: Pick<TemplateShortQaPacket, "commands">) => packet.commands.flatMap(command => command.type === "add_motion_graphic" ? [command.graphic] : []);
const frameOf = (seconds: number, fps: number) => Math.round(seconds * fps);
const rolesOf = (packet: Pick<TemplateShortQaPacket, "instance">) => new Map(packet.instance.roles.map(role => [role.id, role.key]));

/** Settled glyph ink of each text graphic, in canvas pixels. */
export function inkBoxes(packet: Pick<TemplateShortQaPacket, "instance" | "commands" | "layouts">) {
  const roles = rolesOf(packet);
  return graphicsOf(packet).flatMap(graphic => {
    const segments = (packet.layouts.find(row => row.graphicId === graphic.id)?.segments ?? []).filter(segment => segment.outline?.ink);
    if (!graphic.text || !segments.length) return [];
    return [{ graphic, role: roles.get(graphic.id) ?? graphic.id, left: Math.min(...segments.map(s => s.x + s.outline!.ink!.xMin)),
      right: Math.max(...segments.map(s => s.x + s.outline!.ink!.xMax)), top: Math.min(...segments.map(s => s.y + s.outline!.ink!.yMin)),
      bottom: Math.max(...segments.map(s => s.y + s.outline!.ink!.yMax)) }];
  });
}

/** Q7: one text never sits on another while both are on screen, including the path an entering or leaving line sweeps
 * (unless clipped to its own line window); a handoff (one leaving while the next arrives in its place) is a crossfade.
 * A drawn line never crosses a glyph except annotations meant to (strikes, underlines, highlights). */
export function textOverlapFindings(packet: Pick<TemplateShortQaPacket, "instance" | "commands" | "layouts">, fps: number, scale = 1): TemplateShortQaFinding[] {
  const findings: TemplateShortQaFinding[] = [];
  const boxes = inkBoxes(packet).map(box => {
    const motion = box.graphic.motionV2!, start = frameOf(box.graphic.timelineStart, fps), stop = frameOf(box.graphic.timelineStart + box.graphic.duration, fps);
    const clipped = !!(box.graphic as MotionGraphic & { clipRegion?: unknown }).clipRegion, units = Math.max(1, [...box.graphic.text].length);
    const enterFrames = motion.entrance.durationFrames + (motion.sequence.unit === "all" ? 0 : (units - 1) * motion.sequence.staggerFrames);
    const at = (f: number): Box => {
      let dx = 0, dy = 0;
      if (!clipped && f < start + enterFrames) { const left = 1 - (f - start) / Math.max(1, enterFrames); dx = motion.entrance.offsetXPixels * left; dy = motion.entrance.offsetYPixels * left; }
      else if (!clipped && f >= stop - motion.exit.durationFrames) { const done = (f - (stop - motion.exit.durationFrames)) / Math.max(1, motion.exit.durationFrames); dx = motion.exit.offsetXPixels * done; dy = motion.exit.offsetYPixels * done; }
      return { left: box.left + dx, right: box.right + dx, top: box.top + dy, bottom: box.bottom + dy };
    };
    return { ...box, start, stop, at, entering: (f: number) => f < start + enterFrames, leaving: (f: number) => f >= stop - motion.exit.durationFrames, group: roleGroup(box.role) };
  });
  for (const [index, a] of boxes.entries()) for (const b of boxes.slice(index + 1)) {
    if (a.group === b.group || a.group.startsWith(`${b.group}:`) || b.group.startsWith(`${a.group}:`)) continue;
    for (let f = Math.max(a.start, b.start); f < Math.min(a.stop, b.stop); f++) {
      if (meets(a.at(f), b.at(f), TEXT_OVERLAP_INSET * scale) && !((a.leaving(f) && b.entering(f)) || (b.leaving(f) && a.entering(f)))) {
        findings.push({ id: "Q7_text_overlap", severity: "FLAG", role: a.role, frames: [f],
          detail: `「${a.graphic.text.slice(0, 8)}」(${a.role}) 壓到「${b.graphic.text.slice(0, 8)}」(${b.role})` });
        break;
      }
    }
  }
  const roles = rolesOf(packet);
  for (const line of graphicsOf(packet)) {
    const vector = line.vectorV2 as { kind?: string; stack?: string; commands?: Array<{ type: string; x?: number; y?: number }>; widthPixels?: number } | undefined;
    const role = roles.get(line.id) ?? "";
    if (vector?.kind !== "stroke" || vector.stack === "under_media" || ANNOTATION.test(role)) continue;
    const width = packet.layouts.find(row => row.graphicId === line.id)?.projectWidth ?? 1080, height = packet.layouts.find(row => row.graphicId === line.id)?.projectHeight ?? 1920;
    const ox = line.x * width, oy = line.y * height, half = (vector.widthPixels ?? 2) / 2;
    const points = (vector.commands ?? []).filter(command => command.x !== undefined).map(command => [ox + command.x!, oy + command.y!] as const);
    const start = frameOf(line.timelineStart, fps), stop = frameOf(line.timelineStart + line.duration, fps);
    for (const box of boxes) {
      if (Math.max(start, box.start) >= Math.min(stop, box.stop)) continue;
      const hit = points.some(([x, y], k) => {
        if (!k) return false;
        const [px, py] = points[k - 1];
        for (let t = 0; t <= 1; t += .05) {
          const sx = px + (x - px) * t, sy = py + (y - py) * t;
          if (sx > box.left - half && sx < box.right + half && sy > box.top - half && sy < box.bottom + half) return true;
        }
        return false;
      });
      if (hit) findings.push({ id: "Q7_text_overlap", severity: "FLAG", role, frames: [Math.max(start, box.start)], detail: `線條 ${role} 穿過「${box.graphic.text.slice(0, 8)}」(${box.role})` });
    }
  }
  return findings;
}

type Pose = Pick<MotionGraphicV2SegmentFrame, "opacity" | "scale" | "translateXPixels" | "translateYPixels">;
/** Largest visible change between two frame receipts of one graphic: Δopacity×100 + |Δx| + |Δy| px + Δscale×100. A part
 * that is not drawn on one side counts only its opacity; positions of an invisible part are not seen. */
function poseDelta(a: MotionGraphicV2FrameReceipt, b: MotionGraphicV2FrameReceipt): number {
  const parts = (receipt: MotionGraphicV2FrameReceipt) => new Map<string, Pose>(receipt.visible
    ? [...receipt.segments.map(segment => [segment.segmentId, segment] as const), ...(receipt.vectorState ? [["vector", receipt.vectorState] as const] : [])] : []);
  const left = parts(a), right = parts(b);
  let largest = 0;
  for (const key of new Set([...left.keys(), ...right.keys()])) {
    const x = left.get(key), y = right.get(key);
    const delta = x && y
      ? (x.opacity <= .004 && y.opacity <= .004 ? 0 : Math.abs(x.opacity - y.opacity) * 100 + Math.abs(x.translateXPixels - y.translateXPixels)
        + Math.abs(x.translateYPixels - y.translateYPixels) + Math.abs(x.scale - y.scale) * 100)
      : (x ?? y)!.opacity * 100;
    largest = Math.max(largest, delta);
  }
  return largest;
}
/** Q8: a role group whose authored motion moves, holds one frame and moves on (d > 0.5, ≤ 0.01, > 0.5) inside an
 * entrance or exit window: the one-frame stall the r53 art review found by eye. Evaluated with the v2 frame evaluator. */
export function authoredStallFindings(project: EditProject, packet: Pick<TemplateShortQaPacket, "instance" | "commands" | "layouts">): TemplateShortQaFinding[] {
  const roles = rolesOf(packet), fps = project.fps, members = new Map<string, Array<{ graphic: MotionGraphic; layout: MotionGraphicV2LayoutReceipt }>>();
  for (const graphic of graphicsOf(packet)) {
    const layout = packet.layouts.find(row => row.graphicId === graphic.id);
    if (graphic.schema !== "hao.motion-composition/v2" || !layout) continue;
    const group = roleGroup(roles.get(graphic.id) ?? graphic.id);
    members.set(group, [...members.get(group) ?? [], { graphic, layout: prepareMotionGraphicV2FrameLayout(project, graphic, layout) }]);
  }
  const findings: TemplateShortQaFinding[] = [];
  for (const [group, list] of members) {
    const windows = list.flatMap(({ graphic, layout }) => {
      const motion = graphic.motionV2!, start = frameOf(graphic.timelineStart, fps), stop = start + Math.max(1, frameOf(graphic.duration, fps));
      const units = Math.max(1, layout.unitCount), exitStagger = motion.sequence.exitStaggerFrames ?? motion.sequence.staggerFrames;
      return [[start, start + motion.entrance.durationFrames + (units - 1) * motion.sequence.staggerFrames],
        [stop - motion.exit.durationFrames - (units - 1) * exitStagger, stop]] as Array<[number, number]>;
    });
    const frames = [...new Set(windows.flatMap(([from, to]) => Array.from({ length: Math.max(0, to - from) }, (_, offset) => from + offset)))].sort((a, b) => a - b);
    const receipts = new Map<number, MotionGraphicV2FrameReceipt[]>();
    const at = (frame: number) => {
      if (!receipts.has(frame)) receipts.set(frame, list.map(({ graphic, layout }) => motionGraphicV2FrameReceipt(project, graphic, frame, layout)));
      return receipts.get(frame)!;
    };
    const d = (from: number) => Math.max(0, ...at(from).map((receipt, index) => poseDelta(receipt, at(from + 1)[index])));
    const stalls = frames.filter(f => f >= 1 && d(f - 1) > .5 && d(f) <= .01 && d(f + 1) > .5);
    if (stalls.length) findings.push({ id: "Q8_stall", severity: "FLAG", role: group, frames: stalls, detail: `${group} 在動作中停了一格` });
  }
  return findings;
}

/** Visible-window share of the canvas for the primary clip at one frame: layout viewport under the clip transform,
 * cut to the canvas and to its enabled additive mask bounds. A clip without a layout fills the canvas. */
export function footageShare(project: EditProject, clipId: string, frame: number): number {
  const clip = project.tracks.flatMap(track => track.clips).find(candidate => candidate.id === clipId);
  if (!clip) return 0;
  const W = project.width, H = project.height, viewport = clip.layout?.viewport ?? { x: 0, y: 0, width: 1, height: 1 };
  const { transform } = animatedClipState(clip, frame / project.fps - clip.timelineStart, project.fps);
  const scale = transform.scale ?? 1, cx = (viewport.x + viewport.width / 2) * W + (transform.x ?? 0), cy = (viewport.y + viewport.height / 2) * H + (transform.y ?? 0);
  const halfW = scale * viewport.width * W / 2, halfH = scale * viewport.height * H / 2;
  const width = Math.max(0, Math.min(W, cx + halfW) - Math.max(0, cx - halfW)), height = Math.max(0, Math.min(H, cy + halfH) - Math.max(0, cy - halfH));
  const crop = clip.layout?.crop ?? { x: 0, y: 0, width: 1, height: 1 };
  const masks = (clip.masks ?? []).filter(mask => mask.enabled && !mask.inverted && mask.mode === "add" && mask.path.length >= 3);
  const kept = masks.length ? Math.max(...masks.map(mask => {
    const xs = mask.path.map(point => point.x), ys = mask.path.map(point => point.y);
    const w = Math.max(0, Math.min(crop.x + crop.width, Math.max(...xs)) - Math.max(crop.x, Math.min(...xs)));
    const h = Math.max(0, Math.min(crop.y + crop.height, Math.max(...ys)) - Math.max(crop.y, Math.min(...ys)));
    return (w * h) / (crop.width * crop.height);
  })) : 1;
  return (width * height * Math.min(1, kept)) / (W * H);
}

/** Q3 (every text ink box inside the safe area, ±0.5 px) and Q4 (font size at or above its role's reading floor). */
export function textPlacementFindings(packet: Pick<TemplateShortQaPacket, "instance" | "commands" | "layouts">, project: Pick<EditProject, "width" | "height">): TemplateShortQaFinding[] {
  const sx = project.width / 1080, sy = project.height / 1920, unit = Math.min(project.width, project.height) / 1080, findings: TemplateShortQaFinding[] = [];
  for (const box of inkBoxes(packet)) {
    const where = `${box.role}「${box.graphic.text.slice(0, 12)}」`;
    if (box.left < SHORTS_TEXT_SAFE.left * sx - SHORTS_TEXT_SAFE_TOLERANCE || box.right > SHORTS_TEXT_SAFE.right * sx + SHORTS_TEXT_SAFE_TOLERANCE
      || box.top < SHORTS_TEXT_SAFE.top * sy - SHORTS_TEXT_SAFE_TOLERANCE || box.bottom > SHORTS_TEXT_SAFE.bottom * sy + SHORTS_TEXT_SAFE_TOLERANCE) {
      findings.push({ id: "Q3_safe_area", severity: "BLOCK", role: box.role,
        detail: `${where} 超出 Shorts 安全區：x${Math.round(box.left)}–${Math.round(box.right)} y${Math.round(box.top)}–${Math.round(box.bottom)}；請縮短文案` });
    }
    if (box.graphic.fontSize < floorOf(box.role) * unit) findings.push({ id: "Q4_text_size", severity: "BLOCK", role: box.role, detail: `${where} ${box.graphic.fontSize}px 小於 ${floorOf(box.role)}px 閱讀下限` });
  }
  return findings;
}

/** Plan-time QA over a compiled template and its beats (Q3–Q11). Q6 here is the command count only; the byte cap and
 * the full v4 parse run when the plan is composed (composeTemplateShortPlan). */
export function analyzeCompiledTemplate(packet: TemplateShortQaPacket, beats: readonly TemplateShortBeat[], project: EditProject) {
  const fps = project.fps, unit = Math.min(project.width, project.height) / 1080;
  const seconds = (frames: number[]) => frames.map(frame => Math.round(frame / fps * 100) / 100);
  const blocks: TemplateShortQaFinding[] = [], flags: TemplateShortQaFinding[] = [];
  const add = (finding: TemplateShortQaFinding) => {
    const complete = finding.frames ? { ...finding, frames: finding.frames.slice(0, 12), seconds: seconds(finding.frames.slice(0, 12)) } : finding;
    (complete.severity === "BLOCK" ? blocks : flags).push({ ...complete, detail: complete.detail.slice(0, 300) });
  };
  for (const finding of textPlacementFindings(packet, project)) add(finding);
  try { assertTemplateBeatCoverage(packet, beats); }
  catch (error) {
    if (!(error instanceof TemplateShortBlockError)) throw error;
    add({ id: "Q5_beats", severity: "BLOCK", detail: error.detail });
  }
  if (packet.commands.length + 1 > AUTOPILOT_MAX_COMMANDS) add({ id: "Q6_caps", severity: "BLOCK", detail: `模板 ${packet.commands.length} 個命令加上美感設定超過 ${AUTOPILOT_MAX_COMMANDS}` });
  for (const finding of textOverlapFindings(packet, fps, unit)) add(finding);
  for (const finding of authoredStallFindings(project, packet)) add(finding);
  // Clip state only: the compiled clip layout, masks and keyframes (the instance metadata command is not needed here).
  const roles = rolesOf(packet), input = packet.instance.input;
  const current = applyCommand(project, { type: "batch", commands: packet.commands.filter(command => command.type !== "upsert_reference_motion_instance") as EditorCommand[] });
  // Q9: frame 0 is the feed card. The hook's largest text is readable (full opacity, rest scale, at most a poster settle
  // of a few pixels still to travel) and the source window is on screen.
  const hook = beats[0], hookTexts = graphicsOf(packet).filter(graphic => graphic.text && hook && hook.roleKeys.includes(roles.get(graphic.id) ?? ""));
  if (hookTexts.length) {
    const size = Math.max(...hookTexts.map(graphic => graphic.fontSize));
    const headline = hookTexts.filter(graphic => graphic.fontSize === size), layouts = new Map(packet.layouts.map(row => [row.graphicId, row]));
    for (const graphic of headline) {
      const layout = layouts.get(graphic.id), receipt = layout && motionGraphicV2FrameReceipt(project, graphic, input.startFrame, prepareMotionGraphicV2FrameLayout(project, graphic, layout));
      const ready = receipt?.visible && receipt.segments.length > 0 && receipt.segments.every(segment => segment.opacity >= .99 && Math.abs(segment.scale - 1) <= .02
        && Math.abs(segment.translateXPixels) <= 8 * unit && Math.abs(segment.translateYPixels) <= 8 * unit);
      if (!ready) add({ id: "Q9_first_frame", severity: "FLAG", role: roles.get(graphic.id), frames: [input.startFrame], detail: `第一格的主標「${graphic.text.slice(0, 12)}」還沒完整出現` });
    }
  }
  const primary = current.tracks.flatMap(track => track.clips).find(clip => clip.id === input.clipId);
  if (primary && animatedClipState(primary, input.startFrame / fps - primary.timelineStart, fps).transform.opacity < .9) {
    add({ id: "Q9_first_frame", severity: "FLAG", role: roles.get(primary.id), frames: [input.startFrame], detail: "第一格的實拍畫面還沒出現" });
  }
  // Q10: during the longest steady hold the footage keeps its share of the canvas.
  const holds = packet.phases.filter(phase => phase.role === "hold" && phase.endFrame > phase.startFrame).sort((a, b) => (b.endFrame - b.startFrame) - (a.endFrame - a.startFrame));
  const middle = holds.length ? Math.floor((holds[0].startFrame + holds[0].endFrame) / 2) : input.startFrame + Math.floor(input.durationFrames / 2);
  const share = footageShare(current, input.clipId, middle);
  if (share < MIN_FOOTAGE_SHARE) add({ id: "Q10_footage_share", severity: "FLAG", role: roles.get(input.clipId), frames: [middle],
    detail: `實拍只佔畫面 ${Math.round(share * 100)}%（至少 ${Math.round(MIN_FOOTAGE_SHARE * 100)}%）` });
  // Q11 (ROADMAP 1.8, Hao's rule: the place only briefly in the hook, no permanent brand capsule): place and brand leave
  // by the end of the hook, or after HOOK_PLACE_SECONDS when the hook beat is shorter (the trip_pop default reading time),
  // with their own exit. FLAG while families without the 1.8 exit remain; BLOCK once every family has it.
  if (hook) for (const graphic of graphicsOf(packet)) {
    const role = roles.get(graphic.id) ?? "";
    if (!/^design:(kicker|brand)/.test(role)) continue;
    const stop = frameOf(graphic.timelineStart + graphic.duration, fps);
    const until = Math.max(hook.endFrame, input.startFrame + Math.round(HOOK_PLACE_SECONDS * fps)) + (graphic.motionV2?.exit.durationFrames ?? 0);
    if (stop > until) add({ id: "Q11_hook_only", severity: "FLAG", role, frames: [until], detail: `${role} 在開場段落後仍然可見（到第 ${stop} 格）` });
  }
  return { blocks, flags };
}

/** The R1 part a container probe can answer (design §6.2): one video and one audio stream, the exact Shorts raster and the
 * template's frame count within two frames. The batch runtime has already fully decoded the candidate with -xerror; the
 * frame-exact count, frame rate and pixel checks (R1 framecrc, R2–R5) belong to the wave-3 pixel gate. */
export function renderedShortProbeChecks(probe: { duration: number; width?: number; height?: number; hasVideo: boolean; hasAudio: boolean },
  expected: { width: number; height: number; durationFrames: number; fps: number }) {
  const seconds = expected.durationFrames / expected.fps, tolerance = 2 / expected.fps;
  const checks = [
    { id: "R1_video_stream", pass: probe.hasVideo, detail: probe.hasVideo ? "有影像串流" : "沒有影像串流" },
    { id: "R1_audio_stream", pass: probe.hasAudio, detail: probe.hasAudio ? "有音訊串流" : "沒有音訊串流" },
    { id: "R1_raster", pass: probe.width === expected.width && probe.height === expected.height, detail: `${probe.width ?? "?"}×${probe.height ?? "?"}（應為 ${expected.width}×${expected.height}）` },
    { id: "R1_duration", pass: Number.isFinite(probe.duration) && Math.abs(probe.duration - seconds) <= tolerance + 1e-9,
      detail: `${Number.isFinite(probe.duration) ? probe.duration.toFixed(3) : "?"} 秒（應為 ${seconds.toFixed(3)} ± ${tolerance.toFixed(3)}）` },
  ];
  return { pass: checks.every(check => check.pass), checks };
}

export type TemplateShortRunStatus = "BLOCK_TEMPLATE_QA" | "RENDER_FAILED_PROJECT_APPLIED" | "NEEDS_FIX" | "REVIEW_REQUIRED" | "SPOT_CHECK_DUE" | "READY";
/** Run status (design §6.3, Hao 2026-10-09): an art FLAG still delivers the mp4 as NEEDS_FIX with the seconds to fix;
 * a technical failure (broken file, a missing required audio stream) never delivers. */
export function templateShortStatus(input: { blocks: readonly TemplateShortQaFinding[]; technical: { pass: boolean; failures?: readonly string[] };
  flags: readonly TemplateShortQaFinding[]; statusCeiling: "READY" | "REVIEW_REQUIRED"; policyMode: "human" | "agent_reference_comparison";
  frameObservedNumbers: boolean; spotCheckDrawn: boolean }): { status: TemplateShortRunStatus; deliver: boolean; fixSeconds: number[] } {
  if (input.blocks.length) return { status: "BLOCK_TEMPLATE_QA", deliver: false, fixSeconds: [] };
  if (!input.technical.pass) return { status: "RENDER_FAILED_PROJECT_APPLIED", deliver: false, fixSeconds: [] };
  if (input.flags.length) {
    return { status: "NEEDS_FIX", deliver: true, fixSeconds: [...new Set(input.flags.flatMap(flag => flag.seconds ?? []))].sort((a, b) => a - b) };
  }
  if (input.statusCeiling === "REVIEW_REQUIRED" || input.policyMode === "human" || input.frameObservedNumbers) return { status: "REVIEW_REQUIRED", deliver: true, fixSeconds: [] };
  return { status: input.spotCheckDrawn ? "SPOT_CHECK_DUE" : "READY", deliver: true, fixSeconds: [] };
}

// ---- Render-time pixel gate (design §6.2; M1 wave 3) -------------------------------------------------------------------------
// What the template will draw is known before the render: every glyph unit's ink box and how far it should move into each
// frame (the v2 frame evaluator the ASS and native renderers consume). The gate decodes the candidate once to small gray
// frames and compares what changed inside each unit's band with what was authored: a unit that should move but whose
// pixels hold for one frame between moving neighbours is a stall (R3, the r53 T01 f111 tag), and a step much larger than
// both neighbours where the authored motion is smooth is an abrupt jump (R4). R1 is technical (stream, raster, frame rate,
// frame-exact count, clean decode, bytes unchanged) and stops delivery; R2–R5 are art flags (the mp4 is still delivered).

/** R5: the design grid's text column (margins 90 and 930 on 1080 wide) inside VA R12's top and bottom (260–1660 on 1920),
 * scaled per axis. Q3 checks settled ink against the wider VA box; R5 checks the ink drawn on every frame. */
export const SHORTS_TEXT_COLUMN = { left: 90, right: 930, top: 260, bottom: 1660 } as const;
/** Every frame is decoded to 8-bit gray this wide (270×480 for 9:16), the raster the r53 art reviews measured on. */
export const RENDER_QA_WIDTH = 270;
/** R3 (design §6.2): mean absolute gray difference inside a band. A held frame (≤ held) between two moving ones (> neighbour)
 * while the unit's authored step into it is visible (≥ expected px-equivalents and ≥ expectedShare of its neighbours). */
export const R3_STALL = { neighbour: 5, held: 0.05, expected: 0.5, expectedShare: 0.2 } as const;
/** R4: a rendered step ≥ minimum and ≥ ratio × both neighbours, where the authored motion of everything in the band has no
 * step ≥ authoredRatio × its neighbours (an authored cut or flash is a design choice, not a render jump). */
export const R4_JUMP = { minimum: 8, ratio: 2.5, authoredRatio: 1.6 } as const;
/** R2: frame 0 whose gray standard deviation is at or below these is black or blank (whole frame / where its text is). */
export const R2_FIRST_FRAME = { frameSigma: 10, textSigma: 6 } as const;
/** R5 counts ink a viewer can see: a glyph faded below this opacity is not text in the platform's overlay zone yet. */
export const R5_VISIBLE_OPACITY = 0.1;
/** R5: resting ink must sit inside the column (±0.5 px); a glyph that is still bouncing into place may brush past it by at
 * most this many pixels (on 1080 wide) for the frames it moves. R5 measures each glyph's upright body (moved and scaled):
 * a turn about its own centre (the trip title's −10° entrance swings a corner ~5 px) does not carry the glyph anywhere. */
export const R5_MOTION_TOLERANCE = 4;
export const TEMPLATE_SHORT_RENDER_EXPECTATIONS_SCHEMA = "editkin.template-short-render-expectations/v1" as const;
export const TEMPLATE_SHORT_RENDER_QA_SCHEMA = "editkin.template-short-render-qa/v1" as const;

/** [left, top, right, bottom] in canvas pixels. */
export type TemplateShortRect = [number, number, number, number];
/** One glyph unit (a character of a cascading line, or a whole line that moves as one). */
export interface TemplateShortRenderBand {
  id: string;
  role: string;
  group: string;
  text: string;
  /** Every pixel the unit's ink covers over its life (moved, scaled, rotated, cut by its window), on the canvas. */
  box: TemplateShortRect;
  /** Authored visible change into frame f (px moved + opacity × 100) as runs [firstFrame, values]; frames not listed are still. */
  motion: Array<[number, number[]]>;
}
export interface TemplateShortRenderExpectations {
  schema: typeof TEMPLATE_SHORT_RENDER_EXPECTATIONS_SCHEMA;
  width: number;
  height: number;
  fps: number;
  startFrame: number;
  durationFrames: number;
  bands: TemplateShortRenderBand[];
  /** Ink that is readable on frame 0 (R2's text region); absent when the first frame shows no text. */
  firstFrameText?: TemplateShortRect;
  /** R5 on every frame of the evaluated layout, one finding per role group. */
  textColumn: TemplateShortQaFinding[];
}

/** `box`: every pixel the unit can touch on that frame (rotation included; bands and motion). `upright`: its translated,
 * scaled ink before any turn about its own centre (R5: a glyph swinging about its centre does not move its body). */
type UnitView = { box?: TemplateShortRect; upright?: TemplateShortRect; opacity: number };
const unionRect = (a: TemplateShortRect | undefined, b: TemplateShortRect): TemplateShortRect =>
  a ? [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])] : [...b];
const cutRect = (a: TemplateShortRect, b: TemplateShortRect): TemplateShortRect | undefined => {
  const cut: TemplateShortRect = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
  return cut[2] > cut[0] && cut[3] > cut[1] ? cut : undefined;
};
const sameView = (a: UnitView, b: UnitView) => !!a.box && !!b.box && Math.abs(a.opacity - b.opacity) <= .02 && a.box.every((value, index) => Math.abs(value - b.box![index]) <= 1);
/** Visible change between two views of one unit: half the summed edge travel (a translation of t px counts t) plus the
 * opacity change × 100; appearing or vanishing counts the opacity that appears or vanishes. */
function viewDelta(a: UnitView, b: UnitView): number {
  if (!a.box && !b.box) return 0;
  if (!a.box || !b.box) return (a.box ? a.opacity : b.opacity) * 100;
  return (Math.abs(a.box[0] - b.box[0]) + Math.abs(a.box[1] - b.box[1]) + Math.abs(a.box[2] - b.box[2]) + Math.abs(a.box[3] - b.box[3])) / 2
    + Math.abs(a.opacity - b.opacity) * 100;
}
const round3 = (value: number) => Math.round(value * 1000) / 1000;

/** What a compiled template will draw, frame by frame, for the render-time gate (computed at compose time and sealed with the
 * attempt). Units are evaluated with the same v2 frame evaluator and physical layouts the renderers use; ink is placed the way
 * the ASS adapter places it (origin + translate, scale about the origin, rotation about the scaled segment centre, cut by
 * the graphic's window). A unit that vanishes exactly where an identical copy appears on the same frame (a held lead copy
 * handing over to its moving piece, a glide handing over to the struck claim) is one continuous glyph, not a change. */
export function templateShortRenderExpectations(packet: Pick<TemplateShortQaPacket, "instance" | "commands" | "layouts">,
  project: EditProject): TemplateShortRenderExpectations {
  const W = project.width, H = project.height, fps = project.fps, input = packet.instance.input;
  const firstFrame = input.startFrame, endFrame = input.startFrame + input.durationFrames;
  const column: TemplateShortRect = [SHORTS_TEXT_COLUMN.left * W / 1080, SHORTS_TEXT_COLUMN.top * H / 1920, SHORTS_TEXT_COLUMN.right * W / 1080,
    SHORTS_TEXT_COLUMN.bottom * H / 1920];
  const roles = rolesOf(packet), layouts = new Map(packet.layouts.map(row => [row.graphicId, row]));
  const units: Array<{ id: string; role: string; group: string; text: string; start: number; views: UnitView[] }> = [];
  for (const graphic of graphicsOf(packet)) {
    const supplied = layouts.get(graphic.id);
    if (!graphic.text || graphic.schema !== "hao.motion-composition/v2" || !supplied) continue;
    const layout = prepareMotionGraphicV2FrameLayout(project, graphic, supplied);
    const inked = layout.segments.filter(segment => segment.outline?.ink);
    if (!inked.length) continue;
    const role = roles.get(graphic.id) ?? graphic.id, group = roleGroup(role), region = graphic.clipRegion;
    const clip: TemplateShortRect | undefined = region && [region.x * W, region.y * H, (region.x + region.width) * W, (region.y + region.height) * H];
    const start = frameOf(graphic.timelineStart, fps), stop = start + Math.max(1, frameOf(graphic.duration, fps));
    const members = new Map<number, typeof inked>();
    for (const segment of inked) members.set(segment.unitIndex, [...members.get(segment.unitIndex) ?? [], segment]);
    const tracks = [...members.keys()].sort((a, b) => a - b).map(unit => ({ unit, views: [] as UnitView[] }));
    // One frame before the graphic starts and the frame it ends: its appearance and its disappearance are changes too.
    for (let frame = start - 1; frame <= stop; frame++) {
      const receipt = frame >= start && frame < stop ? motionGraphicV2FrameReceipt(project, graphic, frame, layout) : undefined;
      const poses = new Map(receipt?.visible ? receipt.segments.map(pose => [pose.segmentId, pose]) : []);
      for (const track of tracks) {
        let box: TemplateShortRect | undefined, upright: TemplateShortRect | undefined, opacity = 0;
        for (const segment of members.get(track.unit)!) {
          const pose = poses.get(segment.id);
          if (!pose || pose.opacity <= .001) continue;
          const ink = segment.outline!.ink!, s = pose.scale, x = segment.x + pose.translateXPixels, y = segment.y + pose.translateYPixels;
          const placed: TemplateShortRect = [x + s * ink.xMin, y + s * ink.yMin, x + s * ink.xMax, y + s * ink.yMax];
          let drawn = placed;
          if (pose.rotationDegrees) {
            // libass \frz(−deg) about the scaled segment centre: clockwise on screen for a positive pose angle.
            const px = x + segment.width * s / 2, py = y + segment.height * s / 2, angle = pose.rotationDegrees * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle);
            const corners = ([[placed[0], placed[1]], [placed[2], placed[1]], [placed[0], placed[3]], [placed[2], placed[3]]] as Array<[number, number]>)
              .map(([cx, cy]) => [px + (cx - px) * cos - (cy - py) * sin, py + (cx - px) * sin + (cy - py) * cos]);
            drawn = [Math.min(...corners.map(c => c[0])), Math.min(...corners.map(c => c[1])), Math.max(...corners.map(c => c[0])), Math.max(...corners.map(c => c[1]))];
          }
          const visible = clip ? cutRect(drawn, clip) : drawn, seated = clip ? cutRect(placed, clip) : placed;
          if (!visible) continue;
          box = unionRect(box, visible); opacity = Math.max(opacity, pose.opacity);
          if (seated) upright = unionRect(upright, seated);
        }
        track.views.push(box ? { box, opacity, ...(upright ? { upright } : {}) } : { opacity: 0 });
      }
    }
    for (const track of tracks) {
      units.push({ id: `${role}#${track.unit}`, role, group, start: start - 1, views: track.views,
        text: members.get(track.unit)!.map(segment => segment.text).join("").slice(0, 12) });
    }
  }
  // Authored deltas, with seamless handoffs (a unit vanishing where an identical one appears on the same frame) removed.
  const viewAt = (unit: (typeof units)[number], frame: number): UnitView => unit.views[frame - unit.start] ?? { opacity: 0 };
  const appearing = new Map<number, Array<(typeof units)[number]>>(), vanishing = new Map<number, Array<(typeof units)[number]>>();
  for (const unit of units) unit.views.forEach((view, index) => {
    if (!index) return;
    const frame = unit.start + index, before = unit.views[index - 1];
    if (view.box && !before.box) appearing.set(frame, [...appearing.get(frame) ?? [], unit]);
    if (!view.box && before.box) vanishing.set(frame, [...vanishing.get(frame) ?? [], unit]);
  });
  const handed = new Set<string>();
  for (const [frame, gone] of vanishing) for (const unit of gone) {
    const twin = (appearing.get(frame) ?? []).find(other => other !== unit && !handed.has(`${other.id}@${frame}`) && sameView(viewAt(unit, frame - 1), viewAt(other, frame)));
    if (twin) { handed.add(`${unit.id}@${frame}`); handed.add(`${twin.id}@${frame}`); }
  }
  const bands: TemplateShortRenderBand[] = [];
  const outside = new Map<string, { frames: number[]; worst: TemplateShortRect; text: string; role: string }>();
  let firstFrameText: TemplateShortRect | undefined;
  const overshoot = (box: TemplateShortRect) => Math.max(column[0] - box[0], column[1] - box[1], box[2] - column[2], box[3] - column[3]);
  for (const unit of units) {
    let swept: TemplateShortRect | undefined;
    const runs: Array<[number, number[]]> = [];
    unit.views.forEach((view, index) => {
      const frame = unit.start + index;
      if (view.box) {
        swept = unionRect(swept, view.box);
        if (frame === firstFrame && view.opacity >= .5) firstFrameText = unionRect(firstFrameText, view.box);
        const moving = (index > 0 && viewDelta(unit.views[index - 1], view) > .01) || (index + 1 < unit.views.length && viewDelta(view, unit.views[index + 1]) > .01);
        const tolerance = moving ? R5_MOTION_TOLERANCE * W / 1080 : SHORTS_TEXT_SAFE_TOLERANCE, body = view.upright;
        if (body && frame >= firstFrame && frame < endFrame && view.opacity >= R5_VISIBLE_OPACITY && overshoot(body) > tolerance) {
          const row = outside.get(unit.group) ?? { frames: [], worst: body, text: unit.text, role: unit.role };
          row.frames.push(frame);
          if (overshoot(body) > overshoot(row.worst)) { row.worst = body; row.text = unit.text; row.role = unit.role; }
          outside.set(unit.group, row);
        }
      }
      if (!index || frame < firstFrame || frame >= endFrame) return;
      const delta = handed.has(`${unit.id}@${frame}`) ? 0 : round3(viewDelta(unit.views[index - 1], view));
      if (delta <= 0) return;
      const last = runs.at(-1);
      if (last && last[0] + last[1].length === frame) last[1].push(delta); else runs.push([frame, [delta]]);
    });
    const box = swept && cutRect([swept[0] - 1, swept[1] - 1, swept[2] + 1, swept[3] + 1], [0, 0, W, H]);
    if (!box) continue;
    bands.push({ id: unit.id, role: unit.role, group: unit.group, text: unit.text, box: box.map(round3) as TemplateShortRect, motion: runs });
  }
  const seconds = (frames: number[]) => frames.map(frame => Math.round(frame / fps * 100) / 100);
  const textColumn: TemplateShortQaFinding[] = [...outside.entries()].map(([group, row]) => {
    const frames = [...new Set(row.frames)].sort((a, b) => a - b).slice(0, 12);
    return { id: "R5_text_column", severity: "FLAG", role: group, frames, seconds: seconds(frames),
      detail: `「${row.text}」(${row.role}) 的字墨超出文字欄 x${Math.round(column[0])}–${Math.round(column[2])} y${Math.round(column[1])}–${Math.round(column[3])}：`
        + `x${Math.round(row.worst[0])}–${Math.round(row.worst[2])} y${Math.round(row.worst[1])}–${Math.round(row.worst[3])}，共 ${new Set(row.frames).size} 格` };
  });
  return { schema: TEMPLATE_SHORT_RENDER_EXPECTATIONS_SCHEMA, width: W, height: H, fps, startFrame: firstFrame, durationFrames: input.durationFrames, bands,
    ...(firstFrameText ? { firstFrameText: firstFrameText.map(round3) as TemplateShortRect } : {}), textColumn };
}

/** The frame-by-frame changes the gate measured: d[f] is the mean absolute gray difference inside a band from frame f − 1
 * to frame f (d[0] = 0), on the RENDER_QA_WIDTH raster. */
export interface TemplateShortRenderedSeries {
  frames: number;
  raster: [number, number];
  firstFrame: { sigma: number; textSigma?: number };
  bands: Record<string, number[]>;
}
const denseMotion = (band: Pick<TemplateShortRenderBand, "motion">, frames: number) => {
  const values = new Array<number>(frames).fill(0);
  for (const [first, run] of band.motion) run.forEach((value, index) => { if (first + index >= 0 && first + index < frames) values[first + index] = value; });
  return values;
};
/** R3 and R4 over measured band changes. Frames are timeline frames of the rendered file (the template starts at its own
 * startFrame inside it). A jump right after a stall is that stall's double step and is reported once, as the stall. */
export function detectRenderedMotion(expectations: Pick<TemplateShortRenderExpectations, "bands" | "fps">, series: Pick<TemplateShortRenderedSeries, "frames" | "bands">) {
  const frames = series.frames, seconds = (list: number[]) => list.map(frame => Math.round(frame / expectations.fps * 100) / 100);
  const authored = new Map(expectations.bands.map(band => [band.id, denseMotion(band, frames)]));
  const meets = (a: TemplateShortRect, b: TemplateShortRect) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
  const stalls = new Map<string, { band: TemplateShortRenderBand; frames: number[] }>(), jumps = new Map<string, { band: TemplateShortRenderBand; frames: number[] }>();
  for (const band of expectations.bands) {
    const d = series.bands[band.id], a = authored.get(band.id)!;
    if (!d || d.length !== frames) continue;
    // Everything authored to change inside this band (neighbouring glyphs and lines sweep through it too).
    const near = expectations.bands.filter(other => meets(other.box, band.box)).map(other => authored.get(other.id)!);
    const c = a.map((_, frame) => Math.max(...near.map(values => values[frame])));
    const held = new Set<number>();
    for (let frame = 2; frame < frames - 1; frame++) {
      const expected = a[frame], around = Math.max(a[frame - 1], a[frame + 1]);
      if (expected >= R3_STALL.expected && expected >= R3_STALL.expectedShare * around && d[frame] <= R3_STALL.held
        && d[frame - 1] > R3_STALL.neighbour && d[frame + 1] > R3_STALL.neighbour) held.add(frame);
    }
    for (let frame = 2; frame < frames - 1; frame++) {
      if (held.has(frame - 1) || c[frame - 1] + c[frame] + c[frame + 1] <= 0) continue;
      const step = d[frame], around = Math.max(d[frame - 1], d[frame + 1]), authoredAround = Math.max(c[frame - 1], c[frame + 1]);
      if (step >= R4_JUMP.minimum && step >= R4_JUMP.ratio * around && !(c[frame] >= R4_JUMP.authoredRatio * authoredAround)) {
        const row = jumps.get(band.group) ?? { band, frames: [] }; row.frames.push(frame); jumps.set(band.group, row);
      }
    }
    if (held.size) { const row = stalls.get(band.group) ?? { band, frames: [] }; row.frames.push(...held); stalls.set(band.group, row); }
  }
  const finding = (id: "R3_stall" | "R4_jump", what: string) => ([group, row]: [string, { band: TemplateShortRenderBand; frames: number[] }]): TemplateShortQaFinding => {
    const list = [...new Set(row.frames)].sort((x, y) => x - y);
    return { id, severity: "FLAG", role: group, frames: list.slice(0, 12), seconds: seconds(list.slice(0, 12)),
      detail: `「${row.band.text}」(${row.band.role}) 在第 ${list.slice(0, 6).join("、")} 格${what}` };
  };
  return { stalls: [...stalls.entries()].map(finding("R3_stall", "停了一格（前後都在動）")), jumps: [...jumps.entries()].map(finding("R4_jump", "突然跳了一大步")) };
}

/** FFmpeg for the gate: HAO_FFMPEG_PATH (the binary render and audit use), else the app's vendored build. */
export function templateShortQaTools(environment: NodeJS.ProcessEnv = process.env) {
  const vendored = resolve(import.meta.dirname, "../../vendor/ffmpeg/win32-x64/ffmpeg.exe");
  const ffmpeg = environment.HAO_FFMPEG_PATH || environment.EDITKIN_FFMPEG_PATH || vendored;
  const sibling = join(dirname(ffmpeg), basename(ffmpeg).replace(/ffmpeg/i, "ffprobe"));
  return { ffmpeg, ffprobe: environment.HAO_FFPROBE_PATH || environment.EDITKIN_FFPROBE_PATH || sibling };
}
function runTool(executable: string, args: string[], options: { timeoutMs: number; label: string; signal?: AbortSignal;
  onStdout?: (chunk: Buffer) => void; maximumStdout?: number }): Promise<{ stdout: string; stderr: string }> {
  options.signal?.throwIfAborted();
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", failure: Error | undefined;
    const stop = (error: Error) => { failure ??= error; child.kill(); };
    const abort = () => stop(Object.assign(new Error(`${options.label}已取消`), { name: "AbortError" }));
    const timer = setTimeout(() => stop(new Error(`${options.label}逾時`)), options.timeoutMs);
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      if (options.onStdout) { try { options.onStdout(chunk); } catch (error) { stop(error as Error); } return; }
      stdout += chunk.toString("utf8");
      if (stdout.length > (options.maximumStdout ?? 1_000_000)) stop(new Error(`${options.label} 輸出超過預算`));
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-20_000); });
    child.on("error", error => { failure ??= error; });
    child.on("close", code => {
      clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`${options.label}失敗 (exit ${code})：${stderr.trim().slice(-1500)}`));
      else resolvePromise({ stdout, stderr });
    });
  });
}
async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256"), handle = await open(path, "r");
  try { for await (const chunk of handle.createReadStream()) hash.update(chunk as Buffer); } finally { await handle.close().catch(() => undefined); }
  return hash.digest("hex");
}
/** Decodes the candidate's first video stream to gray frames once and measures every band (and frame 0's spread). */
export async function measureRenderedShort(candidate: string, expectations: Pick<TemplateShortRenderExpectations, "width" | "height" | "bands" | "firstFrameText">,
  options: { ffmpeg: string; timeoutMs: number; signal?: AbortSignal }): Promise<TemplateShortRenderedSeries & { decodeStderr: string }> {
  const width = RENDER_QA_WIDTH, height = Math.max(2, Math.round(RENDER_QA_WIDTH * expectations.height / expectations.width / 2) * 2), size = width * height;
  const scale = width / expectations.width;
  const toRaster = (box: TemplateShortRect) => {
    const x0 = Math.max(0, Math.floor(box[0] * scale)), y0 = Math.max(0, Math.floor(box[1] * scale));
    const x1 = Math.min(width, Math.ceil(box[2] * scale)), y1 = Math.min(height, Math.ceil(box[3] * scale));
    return x1 > x0 && y1 > y0 ? [x0, y0, x1, y1] as const : undefined;
  };
  const regions = expectations.bands.flatMap(band => { const r = toRaster(band.box); return r ? [{ id: band.id, r }] : []; });
  const textRegion = expectations.firstFrameText && toRaster(expectations.firstFrameText);
  const diffs = new Map(regions.map(region => [region.id, [0] as number[]]));
  let previous = Buffer.alloc(size), current = Buffer.alloc(size), filled = 0, frames = 0;
  const firstFrame: TemplateShortRenderedSeries["firstFrame"] = { sigma: 0 };
  const spread = (frame: Buffer, region: readonly [number, number, number, number]) => {
    let sum = 0, squares = 0, count = 0;
    for (let y = region[1]; y < region[3]; y++) for (let x = region[0], at = y * width + region[0]; x < region[2]; x++, at++) { sum += frame[at]; squares += frame[at] * frame[at]; count++; }
    return count ? Math.sqrt(Math.max(0, squares / count - (sum / count) ** 2)) : 0;
  };
  const frameDone = () => {
    if (frames === 0) {
      firstFrame.sigma = round3(spread(current, [0, 0, width, height]));
      if (textRegion) firstFrame.textSigma = round3(spread(current, textRegion));
    } else {
      for (const { id, r } of regions) {
        let sum = 0;
        for (let y = r[1]; y < r[3]; y++) for (let at = y * width + r[0], end = y * width + r[2]; at < end; at++) sum += Math.abs(current[at] - previous[at]);
        diffs.get(id)!.push(round3(sum / ((r[2] - r[0]) * (r[3] - r[1]))));
      }
    }
    [previous, current] = [current, previous]; filled = 0; frames++;
  };
  const decoded = await runTool(options.ffmpeg, ["-v", "error", "-nostdin", "-i", candidate, "-map", "0:v:0", "-vf", `scale=${width}:${height}:flags=area,format=gray`,
    "-f", "rawvideo", "-pix_fmt", "gray", "-"], { timeoutMs: options.timeoutMs, label: "像素檢查解碼", signal: options.signal, onStdout: chunk => {
    for (let offset = 0; offset < chunk.length;) {
      const take = Math.min(size - filled, chunk.length - offset);
      chunk.copy(current, filled, offset, offset + take); filled += take; offset += take;
      if (filled === size) frameDone();
    }
  } });
  return { frames, raster: [width, height], firstFrame, bands: Object.fromEntries(diffs), decodeStderr: decoded.stderr.trim() };
}

export interface RenderedShortAnalysis {
  schema: typeof TEMPLATE_SHORT_RENDER_QA_SCHEMA;
  candidateSha256: string;
  technical: { pass: boolean; checks: Array<{ id: string; pass: boolean; detail: string }> };
  flags: TemplateShortQaFinding[];
  measured: { frames: number; raster: [number, number]; bands: number; firstFrameSigma: number; firstFrameTextSigma?: number;
    method: { R3_R4: string; R5: string } };
  sheets: string[];
  timingsMs: Record<string, number>;
}
/** The render-time gate (design §6.2): R1 technical checks, R2 first frame, R3 one-frame stalls, R4 abrupt jumps, R5 text
 * column, plus 10×6 contact sheets when asked. With `qaPath` it also writes QA.json bound to the candidate's SHA-256 (the
 * bytes are hashed before and after; a change during QA fails R1). Never throws for a QA finding: a technical failure is
 * `technical.pass: false`, which the run treats as "do not deliver". */
export async function analyzeRenderedShort(candidate: string, expectations: TemplateShortRenderExpectations, expectedFrames: number,
  options: { ffmpeg?: string; ffprobe?: string; candidateSha256?: string; requireAudio?: boolean; sheetsDir?: string; qaPath?: string;
    report?: Record<string, unknown>; signal?: AbortSignal } = {}): Promise<RenderedShortAnalysis> {
  const tools = templateShortQaTools(), ffmpeg = options.ffmpeg ?? tools.ffmpeg, ffprobe = options.ffprobe ?? tools.ffprobe;
  const timings: Record<string, number> = {}, checks: RenderedShortAnalysis["technical"]["checks"] = [], flags: TemplateShortQaFinding[] = [];
  const timed = async <T>(name: string, work: () => Promise<T>) => { const started = Date.now(); try { return await work(); } finally { timings[name] = Date.now() - started; } };
  const before = options.candidateSha256 ?? await timed("sha", () => fileSha256(candidate));
  const fps = expectations.fps, seconds = expectedFrames / fps;
  // R1: streams, raster and frame rate from the container.
  try {
    const probe = JSON.parse((await timed("probe", () => runTool(ffprobe, ["-v", "error", "-show_entries", "stream=codec_type,width,height,r_frame_rate:format=duration", "-of", "json", candidate],
      { timeoutMs: 60_000, label: "成片探測", signal: options.signal }))).stdout) as { streams?: Array<{ codec_type?: string; width?: number; height?: number; r_frame_rate?: string }>; format?: { duration?: string } };
    const video = (probe.streams ?? []).filter(stream => stream.codec_type === "video"), audio = (probe.streams ?? []).filter(stream => stream.codec_type === "audio");
    const duration = Number(probe.format?.duration);
    checks.push({ id: "R1_streams", pass: video.length === 1 && (options.requireAudio === false ? audio.length <= 1 : audio.length === 1),
      detail: `${video.length} 個影像、${audio.length} 個音訊串流（應為 1 與 ${options.requireAudio === false ? "0–1" : "1"}）` });
    checks.push({ id: "R1_raster", pass: video[0]?.width === expectations.width && video[0]?.height === expectations.height,
      detail: `${video[0]?.width ?? "?"}×${video[0]?.height ?? "?"}（應為 ${expectations.width}×${expectations.height}）` });
    checks.push({ id: "R1_frame_rate", pass: video[0]?.r_frame_rate === `${fps}/1`, detail: `${video[0]?.r_frame_rate ?? "?"}（應為 ${fps}/1）` });
    checks.push({ id: "R1_duration", pass: Number.isFinite(duration) && Math.abs(duration - seconds) <= 2 / fps + 1e-9,
      detail: `${Number.isFinite(duration) ? duration.toFixed(3) : "?"} 秒（應為 ${seconds.toFixed(3)} ± ${(2 / fps).toFixed(3)}）` });
  } catch (error) {
    checks.push({ id: "R1_probe", pass: false, detail: (error instanceof Error ? error.message : String(error)).slice(0, 300) });
  }
  // One decode for R1's frame count and R2–R4.
  let measured: Awaited<ReturnType<typeof measureRenderedShort>> | undefined;
  try {
    measured = await timed("decode", () => measureRenderedShort(candidate, expectations, { ffmpeg, timeoutMs: fullDecodeTimeoutMs(seconds), signal: options.signal }));
    checks.push({ id: "R1_frames", pass: measured.frames === expectedFrames, detail: `解碼 ${measured.frames} 格（應為 ${expectedFrames}）` });
    checks.push({ id: "R1_decode", pass: measured.decodeStderr === "", detail: measured.decodeStderr ? measured.decodeStderr.slice(0, 300) : "完整解碼無錯誤" });
  } catch (error) {
    checks.push({ id: "R1_decode", pass: false, detail: (error instanceof Error ? error.message : String(error)).slice(0, 300) });
  }
  if (measured) {
    const sigma = measured.firstFrame.sigma, textSigma = measured.firstFrame.textSigma;
    if (sigma <= R2_FIRST_FRAME.frameSigma || (textSigma !== undefined && textSigma <= R2_FIRST_FRAME.textSigma)) {
      flags.push({ id: "R2_first_frame", severity: "FLAG", frames: [0], seconds: [0],
        detail: `第一格是黑的或空白：整格灰階標準差 ${sigma}${textSigma !== undefined ? `、文字區 ${textSigma}` : ""}（需大於 ${R2_FIRST_FRAME.frameSigma}／${R2_FIRST_FRAME.textSigma}）` });
    }
    const motion = detectRenderedMotion(expectations, measured);
    flags.push(...motion.stalls, ...motion.jumps);
  }
  flags.push(...expectations.textColumn);
  let sheets: string[] = [];
  if (options.sheetsDir && measured) {
    try { sheets = await timed("sheets", () => writeContactSheets(candidate, options.sheetsDir!, ffmpeg, expectations, options.signal)); }
    catch (error) { checks.push({ id: "R1_contact_sheets", pass: true, detail: `接觸表未產生（不影響交付）：${(error instanceof Error ? error.message : String(error)).slice(0, 200)}` }); }
  }
  const after = await timed("shaAfter", () => fileSha256(candidate));
  checks.push({ id: "R1_bytes_unchanged", pass: after === before, detail: after === before ? `SHA-256 ${before.slice(0, 16)}… 檢查前後一致` : "檢查期間檔案內容改變" });
  const analysis: RenderedShortAnalysis = { schema: TEMPLATE_SHORT_RENDER_QA_SCHEMA, candidateSha256: before, technical: { pass: checks.every(check => check.pass), checks },
    flags: flags.map(flag => ({ ...flag, detail: flag.detail.slice(0, 300) })),
    measured: { frames: measured?.frames ?? 0, raster: measured?.raster ?? [RENDER_QA_WIDTH, 0], bands: expectations.bands.length, firstFrameSigma: measured?.firstFrame.sigma ?? 0,
      ...(measured?.firstFrame.textSigma !== undefined ? { firstFrameTextSigma: measured.firstFrame.textSigma } : {}),
      method: { R3_R4: `decoded gray ${measured?.raster.join("×") ?? "?"}, per glyph-unit band vs the v2 frame evaluator`, R5: "v2 frame evaluator ink of every frame (physical layouts)" } },
    sheets, timingsMs: timings };
  if (options.qaPath) await writeQaJson(options.qaPath, { schema: "editkin.template-short-qa/v1", candidateSha256: before, ...options.report, technical: analysis.technical,
    renderedFlags: analysis.flags, pixelGate: { schema: analysis.schema, measured: analysis.measured, sheets, timingsMs: timings } });
  return analysis;
}
async function writeQaJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`, handle = await open(temporary, "wx");
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path);
}
/** 10×6 tiles at 144 px wide with the frame number in each tile (the r53 media_qa layout), as JPEG to spare the disk. */
async function writeContactSheets(candidate: string, directory: string, ffmpeg: string, expectations: Pick<TemplateShortRenderExpectations, "width" | "height" | "durationFrames" | "fps">,
  signal?: AbortSignal): Promise<string[]> {
  await mkdir(directory, { recursive: true });
  for (const name of await readdir(directory)) if (/^sheet_\d+\.(png|jpg)$/.test(name)) await rm(join(directory, name), { force: true });
  const tileHeight = Math.max(2, Math.round(144 * expectations.height / expectations.width / 2) * 2), font = "C:/Windows/Fonts/arial.ttf";
  const label = existsSync(font) ? `,drawtext=fontfile='C\\:/Windows/Fonts/arial.ttf':text='%{n}':x=4:y=4:fontsize=18:fontcolor=yellow:box=1:boxcolor=black@0.6` : "";
  await runTool(ffmpeg, ["-v", "error", "-nostdin", "-i", candidate, "-map", "0:v:0", "-vf", `scale=144:${tileHeight}:flags=area${label},tile=10x6`, "-q:v", "4",
    join(directory, "sheet_%02d.jpg")], { timeoutMs: fullDecodeTimeoutMs(expectations.durationFrames / expectations.fps), label: "接觸表", signal });
  return (await readdir(directory)).filter(name => /^sheet_\d+\.jpg$/.test(name)).sort();
}
/** Reads a sealed render-expectations file (bounded) and checks its schema. */
export async function readTemplateShortRenderExpectations(path: string): Promise<TemplateShortRenderExpectations> {
  const text = await readFile(path, "utf8");
  if (text.length > 2 * 1024 * 1024) throw new Error("render-expectations.json 超出有界大小");
  const value = JSON.parse(text) as TemplateShortRenderExpectations;
  if (value.schema !== TEMPLATE_SHORT_RENDER_EXPECTATIONS_SCHEMA || !Array.isArray(value.bands)) throw new Error("render-expectations.json 格式不符");
  return value;
}
