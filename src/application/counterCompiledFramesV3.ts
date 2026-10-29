import type { EditProject } from "../domain/types";
import { motionGraphicV3Frame, motionGraphicV3Layout } from "../motion/compositionV3";
import { parseValue, formatValue } from "../motion/v3/templates/data";
import { canonicalJson } from "../shared/canonicalJson";
import type { CounterVisualTickV1 } from "./counterVisualTicksV1";

export interface CompiledCounterRuntimeV3 {
  signal?: AbortSignal; timeoutMs?: number; maximumFrames?: number;
  onProgress?(progress: { graphicId: string; completed: number; total: number }): void;
}
type CounterProject = Pick<EditProject, "width" | "height" | "fps" | "motionGraphics">;
export function compiledCounterSourceV3(project: CounterProject, graphicId: string) {
  const all = project.motionGraphics.filter(g => g.id === graphicId), graphic = all[0];
  if (all.length !== 1 || graphic.schema !== "hao.motion-composition/v3" || graphic.designV3?.template !== "stat_counter") throw Error("COUNTER_V3_STAT_COUNTER_REQUIRED");
  const fps = project.fps, start = Math.round(graphic.timelineStart * fps), total = Math.round(graphic.duration * fps);
  if (![project.width, project.height].every(n => Number.isSafeInteger(n) && n > 0 && n <= 16384) || !Number.isFinite(fps) || fps < 1 || fps > 240
    || !Number.isSafeInteger(start) || start < 0 || Math.abs(start / fps - graphic.timelineStart) > 1e-8 || !Number.isSafeInteger(total) || total < 1 || total > 18000
    || Math.abs(total / fps - graphic.duration) > 1e-8 || !Number.isSafeInteger(start + total)) throw Error("COUNTER_V3_CLOCK_BUDGET");
  return { graphic, start, total };
}
/** Actual frozen renderer text decisions, never a second numeric interpolator. This is
 * local draw-op evidence; it does not certify composited occlusion, pixels or human legibility. */
export async function analyzeCompiledCounterFramesV3(project: CounterProject, graphicId: string, runtime: CompiledCounterRuntimeV3 = {}) {
  const { graphic: original, start, total } = compiledCounterSourceV3(project, graphicId), settings = { ...runtime };
  const timeout = settings.timeoutMs ?? 10000, cap = settings.maximumFrames ?? 18000;
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 60000 || !Number.isSafeInteger(cap) || cap < 1 || cap > 144000 || total > cap) throw Error("COUNTER_V3_ANALYSIS_BUDGET");
  const projection = () => { const s = compiledCounterSourceV3(project, graphicId); return canonicalJson({ width: project.width, height: project.height, fps: project.fps, graphic: s.graphic }); };
  const before = projection(), graphic = structuredClone(original), canvas = { width: project.width, height: project.height, fps: project.fps };
  const until = performance.now() + timeout, check = () => { settings.signal?.throwIfAborted(); if (performance.now() >= until) throw Error("COUNTER_V3_ANALYSIS_TIMEOUT"); };
  check(); const layout = motionGraphicV3Layout(canvas, graphic), parsed = parseValue(layout.context.lines[0]);
  if (!parsed || /\d/u.test(parsed.prefix + parsed.suffix)) throw Error("COUNTER_V3_SINGLE_NUMERIC_VALUE_REQUIRED");
  const target = `${parsed.prefix}${formatValue(parsed, parsed.value)}${parsed.suffix}`, hooks: CounterVisualTickV1[] = [];
  const diagnostic: { frame: number; text: string | null; valueOps: number }[] = []; let lastText: string | undefined, finalFrame: number | undefined, frames = 0;
  const emit = () => { settings.onProgress?.({ graphicId, completed: frames, total }); check(); };
  emit();
  for (let local = 0; local < total; local++) {
    check(); const receipt = motionGraphicV3Frame(canvas, graphic, start + local, layout);
    const valueOps = receipt.ops.filter(op => op.kind === "text" && /^value:(?:0|[1-9]\d*)$/u.test(op.id))
      .sort((a, b) => Number(a.id.slice(6)) - Number(b.id.slice(6)));
    const text = valueOps.map(op => op.kind === "text" ? op.text : "").join("");
    if (text && text !== lastText) {
      if (hooks.length >= 256) throw Error("COUNTER_HOOK_BUDGET");
      const final = text === target;
      if (finalFrame !== undefined && !final) throw Error("COUNTER_V3_FINAL_NOT_HELD");
      hooks.push({ graphicId, role: "compiled_v3:stat_counter:value", frame: receipt.timelineFrame, text, phase: final ? "final" : "count" });
      if (final) finalFrame = receipt.timelineFrame; lastText = text;
    }
    diagnostic.push({ frame: receipt.timelineFrame, text: text || null, valueOps: valueOps.length }); if (diagnostic.length > 8) diagnostic.shift(); frames++;
    if (frames % 64 === 0 || frames === total) {
      emit(); await new Promise<void>(resolve => setTimeout(resolve, 0)); check();
      if (projection() !== before) throw Error("COUNTER_V3_SOURCE_CHANGED");
    }
  }
  check(); if (projection() !== before) throw Error("COUNTER_V3_SOURCE_CHANGED");
  if (finalFrame === undefined || lastText !== target) throw Error("COUNTER_V3_FINAL_VALUE_NOT_DRAWN");
  return { schema: "editkin.compiled-counter-hooks/v3" as const, graphicId, hooks, finalFrame, finalText: target, analyzedFrames: frames,
    diagnostics: diagnostic, maximumStoredDiagnostics: 8 as const, storedWholeFrames: 0 as const, renderedValueSource: "frozen_stat_counter_draw_ops" as const,
    compositedPixelVisibilityCertified: false as const, qualityState: "AUDIO_PENDING_HAO_CLAUDE" as const, defaultEnabled: false as const };
}
