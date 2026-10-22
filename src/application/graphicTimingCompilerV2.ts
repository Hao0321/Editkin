import type { EditorCommand } from "../domain/commandTypes";
import { applyCommand } from "../domain/commands";
import { motionPresetOverridesSchema } from "../domain/schema";
import { graphicTimingV2Schema, GRAPHIC_TIMING_V2_CONTRACT } from "../domain/graphicTimingV2";
import { motionGraphicV2ExitStaggerFrames } from "../domain/motionCompositionV2Contract";
import type { EditProject, MotionGraphic } from "../domain/types";
import { compileGraphicCadence } from "../motion/graphicCadence";
import { motionGraphicV2LayoutReceipt, prepareMotionGraphicV2FrameLayout } from "../motion/compositionV2";
import type { ReferenceMotionTemplateInput } from "../motion/referenceMotionTemplates";
import type { ReferenceMotionGraphicBinding, ReferenceMotionTemplateBeat, ReferenceMotionTemplateCompileOptions } from "./referenceMotionTemplateCommands";

type Phase = { role: "reveal" | "hold" | "focus" | "return"; startFrame: number; endFrame: number };
interface Packet { commands: EditorCommand[]; bindings: ReferenceMotionGraphicBinding[];
  layouts: ReturnType<typeof motionGraphicV2LayoutReceipt>[]; phases: Phase[]; beats?: ReferenceMotionTemplateBeat[] }
interface Segment { from: number; to: number; length: number; hold: boolean; sourceTail?: true }
const reading = (text: string, fps: number) => Math.ceil((.65 + [...text].length / 8) * fps);
const timingError = (code: string, message: string) => Object.assign(new Error(message), { code });
const phaseMoves = (p: NonNullable<MotionGraphic["motionV2"]>["entrance"]) =>
  p.opacity !== 1 || p.scale !== 1 || p.offsetXPixels !== 0 || p.offsetYPixels !== 0 || !!p.rotationDegrees || !!p.blurPixels;

/** A separate, unaccepted graphical compiler. It never edits a source/audio window.
 * Whole reading holds are replaced, rather than scaling playback or all three controls together.
 * Physical layout is re-bound to every final graphic before emitting commands and variants. */
export function compileGraphicTimingPacketV2<T extends Packet>(project: EditProject, input: ReferenceMotionTemplateInput,
  original: T, options: ReferenceMotionTemplateCompileOptions): T {
  const timing = graphicTimingV2Schema.parse(input.graphicTimingV2), fps = project.fps;
  const first = input.startFrame, last = first + input.durationFrames;
  const base = structuredClone(original), themed = input.designSystem !== undefined;
  const activeEnd = Math.max(first, ...base.bindings.map(b=>b.endFrame), ...base.commands.flatMap(c=>
    c.type === "add_keyframe" ? [first + Math.round(c.keyframe.time * fps)] : []));
  const legacy = compileGraphicCadence(fps, input.style?.animationSpeed ?? 1, "legacy");
  const selected = compileGraphicCadence(fps, input.style?.animationSpeed ?? 1, input.graphicCadence);
  const enterRatio = (themed ? selected.entranceFrames / legacy.entranceFrames : 1) / timing.entranceSpeed;
  const exitRatio = (themed ? selected.exitFrames / legacy.exitFrames : 1) / timing.exitSpeed;
  const holds = base.phases.filter(p => p.role === "hold" && p.endFrame > p.startFrame)
    .map(p => ({ from: Math.max(first, p.startFrame), to: Math.min(activeEnd, p.endFrame) })).sort((a, b) => a.from - b.from);
  if (!holds.length) {
    // A recipe without narrative markers still has actual, physically measured text envelopes.
    for (const binding of base.bindings) {
      const g = binding.graphic, layout = base.layouts.find(l => l.graphicId === g.id)!;
      if (!g.text || g.vectorV2 || binding.endFrame - binding.startFrame < reading(g.text, fps)) continue;
      const count = Math.max(0, layout.unitCount - 1), m = g.motionV2!;
      holds.push({ from: binding.startFrame + m.entrance.durationFrames + count * m.sequence.staggerFrames,
        to: binding.endFrame - m.exit.durationFrames - count * motionGraphicV2ExitStaggerFrames(m) });
    }
    holds.sort((a, b) => a.from - b.from);
  }
  const merged: typeof holds = [];
  for (const h of holds) {
    if (h.to <= h.from) continue;
    const previous = merged.at(-1);
    if (previous && h.from <= previous.to) previous.to = Math.max(previous.to, h.to);
    else merged.push({ ...h });
  }
  if (!merged.length) throw timingError("GRAPHIC_TIMING_NO_HOLD", "模板沒有可調整的完整停留段。");
  const segments: Segment[] = [];
  let cursor = first;
  for (const h of merged) {
    if (h.from > cursor) segments.push({ from: cursor, to: h.from, length: Math.max(1, Math.round((h.from - cursor) * enterRatio)), hold: false });
    segments.push({ ...h, length: Math.ceil(timing.holdSeconds * fps), hold: true });
    cursor = h.to;
  }
  if (cursor < activeEnd) segments.push({ from: cursor, to: activeEnd, length: Math.max(1, Math.round((activeEnd - cursor) * exitRatio)), hold: false });
  if (activeEnd < last) segments.push({ from: activeEnd, to: last, length: last-activeEnd, hold: false, sourceTail: true });
  function clock(frame: number): number {
    if (!Number.isFinite(frame) || frame < first - 1e-7 || frame > last + 1e-7) throw timingError("GRAPHIC_TIMING_RANGE", "模板動畫超出片段範圍。");
    let target = first;
    for (const s of segments) {
      const length = s.sourceTail ? Math.max(0,last-target) : s.length;
      if (frame <= s.to) return target + Math.round((Math.max(s.from, frame) - s.from) / (s.to - s.from) * length);
      target += length;
    }
    return target;
  }
  const timed = new Map<string, MotionGraphic>();
  const constraints: Array<{ binding: ReferenceMotionGraphicBinding; frames: number; fixedFrames: number; driftFrames?: number }> = [];
  for (const b of base.bindings) {
    const g = b.graphic, m = g.motionV2!, layout = base.layouts.find(l => l.graphicId === g.id)!;
    const n = Math.max(0, layout.unitCount - 1), wasFlash = !!g.text && b.endFrame - b.startFrame < reading(g.text, fps);
    const entrance = { ...m.entrance, durationFrames: phaseMoves(m.entrance) ? Math.max(1, Math.round(m.entrance.durationFrames * enterRatio)) : 1 };
    const terminal = b.endFrame === last && !!g.text && !wasFlash;
    const exit = { ...m.exit, ...(terminal ? { opacity: 0 } : {}),
      durationFrames: terminal ? Math.max(1, Math.round(selected.exitFrames / timing.exitSpeed))
        : phaseMoves(m.exit) ? Math.max(1, Math.round(m.exit.durationFrames * exitRatio)) : 1 };
    const sequence = { ...m.sequence, staggerFrames: Math.max(0, Math.round(m.sequence.staggerFrames * enterRatio)),
      ...(m.sequence.exitStaggerFrames !== undefined ? { exitStaggerFrames: Math.max(0, Math.round(m.sequence.exitStaggerFrames * exitRatio)) } : {}) };
    g.motionV2 = { ...m, entrance, exit, sequence };
    if (g.vectorV2) g.vectorV2.revealFrames = Math.max(1, Math.round(g.vectorV2.revealFrames * enterRatio));
    timed.set(g.id, g);
    const readFrames = g.text && !g.vectorV2 && !wasFlash ? reading(g.text, fps) : 0;
    const fixedFrames = Math.max(entrance.durationFrames + n * sequence.staggerFrames, g.vectorV2?.revealFrames ?? 1)
      + readFrames + n * motionGraphicV2ExitStaggerFrames(g.motionV2);
    constraints.push({ binding: b, frames: fixedFrames + exit.durationFrames, fixedFrames,
      ...(!terminal && m.exit.opacity === 1 && phaseMoves(m.exit) && m.exit.durationFrames > fps ? { driftFrames: m.exit.durationFrames } : {}) });
  }
  // Reserve all envelopes, including passing count values and short vector flashes. A continuous hold drift follows
  // the new scene clock; it is not mistaken for an exit lasting the original scene's full duration.
  let settled = false;
  for (let pass = 0; pass < 64 && !settled; pass++) {
    settled = true;
    for (const constraint of constraints) {
    const b = constraint.binding;
    if (constraint.driftFrames !== undefined) {
      b.graphic.motionV2!.exit.durationFrames = Math.max(1, Math.round((clock(b.endFrame)
        - clock(Math.max(b.startFrame,b.endFrame-constraint.driftFrames))) / timing.exitSpeed));
      constraint.frames = constraint.fixedFrames + b.graphic.motionV2!.exit.durationFrames;
    }
    const frames = constraint.frames;
    const deficit = frames - (clock(b.endFrame) - clock(b.startFrame));
    if (deficit <= 0) continue;
    settled = false;
    const intersections = segments.filter(s => Math.min(s.to, b.endFrame) > Math.max(s.from, b.startFrame));
    const chosen = intersections.sort((a, b2) =>
      (Math.min(b2.to, b.endFrame) - Math.max(b2.from, b.startFrame)) / (b2.to - b2.from)
      - (Math.min(a.to, b.endFrame) - Math.max(a.from, b.startFrame)) / (a.to - a.from)
      || Number(b2.hold) - Number(a.hold))[0];
    if (!chosen) throw timingError("GRAPHIC_TIMING_READING", "模板缺少完整閱讀停留；請延長片段。");
    const fraction = (Math.min(chosen.to, b.endFrame) - Math.max(chosen.from, b.startFrame)) / (chosen.to - chosen.from);
    chosen.length += Math.max(1, Math.ceil(deficit / fraction));
    }
  }
  if (!settled) throw timingError("GRAPHIC_TIMING_READING", "進場與停留放不下完整影格；請延長片段。");
  if (clock(last) > last) throw Object.assign(timingError("GRAPHIC_TIMING_TOO_LONG", "片段放不下進場、閱讀停留與退場；請延長片段或調快速度。"),
    { timingCapacityV2: { requiredFrames: clock(last)-first, availableFrames: input.durationFrames, segments,
      constraints: constraints.map(c=>({name:c.binding.graphic.name,text:c.binding.graphic.text,start:c.binding.startFrame,end:c.binding.endFrame,needed:c.frames,drift:c.driftFrames})) } });
  base.layouts = [];
  for (const b of base.bindings) {
    const g = b.graphic, start = clock(b.startFrame), end = clock(b.endFrame);
    if (end <= start) throw timingError("GRAPHIC_TIMING_COLLAPSE", "動態縮短後有元素不足一影格；請調慢速度。");
    g.timelineStart = start / fps; g.duration = (end - start) / fps;
    if (g.vectorV2?.kind === "connection_field") {
      const v = g.vectorV2, at = (frame: number) => clock(b.startFrame + frame) - start;
      const burstEnd = at(v.burstFrames), gatherStart = at(v.gatherStartFrame), gatherEnd = at(v.gatherStartFrame + v.gatherFrames),
        connectStart = at(v.connectStartFrame), connectEnd = at(v.connectStartFrame + v.connectFrames);
      v.burstFrames = Math.max(1, burstEnd); v.gatherStartFrame = Math.max(v.burstFrames, gatherStart);
      v.gatherFrames = Math.max(1, gatherEnd - v.gatherStartFrame);
      v.connectStartFrame = Math.max(v.gatherStartFrame + v.gatherFrames, connectStart);
      v.connectFrames = Math.max(1, connectEnd - v.connectStartFrame);
    }
    const supplied = g.vectorV2 ? motionGraphicV2LayoutReceipt(project, g) : options.layoutForGraphic(g);
    const layout = prepareMotionGraphicV2FrameLayout(project, g, supplied);
    options.rememberPreparedLayout?.(supplied, layout); base.layouts.push(layout);
    b.startFrame = start; b.endFrame = end;
    b.overrides = motionPresetOverridesSchema.parse({ ...b.overrides, motionV2: structuredClone(g.motionV2), ...(g.vectorV2 ? { vectorV2: structuredClone(g.vectorV2) } : {}) });
  }
  for (const { binding: b, frames } of constraints) if (b.endFrame - b.startFrame < frames) throw timingError("GRAPHIC_TIMING_READING", "模板缺少完整閱讀停留；請延長片段。");
  for (const command of base.commands) {
    if (command.type === "add_motion_graphic") command.graphic = timed.get(command.graphic.id)!;
    // Move only the compiler's owned visual poses. The footage clock, source start, duration and sound stay exact.
    else if (command.type === "add_keyframe") command.keyframe.time = (clock(first + command.keyframe.time * fps) - first) / fps;
  }
  base.phases = base.phases.map(p => ({ ...p, startFrame: clock(p.startFrame), endFrame: clock(p.endFrame) }));
  if (base.beats) base.beats = base.beats.map(b => ({ ...b, startFrame: clock(b.startFrame), endFrame: clock(b.endFrame) }));
  applyCommand(project, { type: "batch", commands: base.commands });
  return { ...base, graphicCadence: input.graphicCadence ?? "legacy", graphicTimingV2: {
    contract: GRAPHIC_TIMING_V2_CONTRACT, requested: timing,
    holds: segments.filter(s => s.hold).map(s => ({ originalStartFrame: s.from, originalEndFrame: s.to, durationFrames: s.length })),
    graphicsEndFrame: clock(activeEnd), sourceEndFrame: last, artStatus: "ART_PENDING_CLAUDE",
  } };
}
