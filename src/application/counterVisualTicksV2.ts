import * as z from "zod/v4";
import type { EditProject } from "../domain/types";
import { canonicalJson } from "../shared/canonicalJson";
import { counterTickRequestV1Schema, deriveCounterVisualTicksV1, type CounterVisualTickV1 } from "./counterVisualTicksV1";
import { selectCounterSoundHitsV1 } from "./counterSoundHitSelectionV1";
import { analyzeCompiledCounterFramesV3, compiledCounterSourceV3, type CompiledCounterRuntimeV3 } from "./counterCompiledFramesV3";

export const counterTickRequestV2Schema = counterTickRequestV1Schema.omit({ bindings: true }).extend({ schema: z.literal("editkin.counter-ticks/v2"),
  bindings: z.array(z.union([counterTickRequestV1Schema.shape.bindings.element,
    z.strictObject({ source: z.literal("compiled_v3_counter"), graphicId: z.string().trim().min(1).max(160) })])).min(1).max(8) });
export type CounterTickRequestV2 = z.infer<typeof counterTickRequestV2Schema>;
export interface CounterTickRuntimeV2 extends Omit<CompiledCounterRuntimeV3, "maximumFrames"> { maximumTotalFrames?: number; }
/** Explicit new route. Historical requests/outputs still use v1 unchanged. Hooks and full
 * WAV selection are shared, while only v3 gets cooperative compiled-frame analysis. */
export async function deriveCounterVisualTicksV2(project: EditProject, payload: unknown, runtime: CounterTickRuntimeV2 = {}) {
  const request = counterTickRequestV2Schema.parse(structuredClone(payload)), settings = { ...runtime };
  const before = canonicalJson(project), owned = structuredClone(project), maximum = settings.maximumTotalFrames ?? 72000, timeout = settings.timeoutMs ?? 10000;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 144000 || !Number.isFinite(timeout) || timeout <= 0 || timeout > 60000
    || !Number.isFinite(owned.fps) || owned.fps < 1 || owned.fps > 240 || request.durationFrames / owned.fps > 86400) throw Error("COUNTER_V2_ANALYSIS_BUDGET");
  const until = performance.now() + timeout, check = () => { settings.signal?.throwIfAborted(); if (performance.now() >= until) throw Error("COUNTER_V2_ANALYSIS_TIMEOUT");
    if (canonicalJson(project) !== before) throw Error("COUNTER_V2_PROJECT_CHANGED"); };
  check(); const modern = request.bindings.filter(b => b.source === "compiled_v3_counter"), legacy = request.bindings.filter(b => b.source !== "compiled_v3_counter");
  if (new Set(modern.map(b => b.graphicId)).size !== modern.length) throw Error("COUNTER_GRAPHIC_MISSING_OR_DUPLICATE");
  let required = 0;
  for (const binding of modern) { const s = compiledCounterSourceV3(owned, binding.graphicId); required += s.total;
    if (s.start + s.total > request.durationFrames) throw Error("COUNTER_GRAPHIC_OUTSIDE_TIMELINE"); }
  if (required > maximum) throw Error("COUNTER_V2_ANALYSIS_BUDGET");
  const { schema: _schema, bindings: _bindings, ...base } = request;
  const hooks: CounterVisualTickV1[] = legacy.length ? deriveCounterVisualTicksV1(owned, { ...base, bindings: legacy }).hooks : [];
  const used = new Set(hooks.map(h => h.graphicId)), analyses: Omit<Awaited<ReturnType<typeof analyzeCompiledCounterFramesV3>>, "hooks" | "diagnostics">[] = [];
  const diagnostics: { graphicId: string; frame: number; text: string | null; valueOps: number }[] = []; let frames = 0;
  for (const binding of modern) {
    if (used.has(binding.graphicId)) throw Error("COUNTER_GRAPHIC_MISSING_OR_DUPLICATE"); used.add(binding.graphicId); check();
    const analyzed = await analyzeCompiledCounterFramesV3(owned, binding.graphicId, { ...settings, timeoutMs: Math.max(1, until - performance.now()), maximumFrames: maximum - frames,
      onProgress: p => { settings.onProgress?.(p); check(); } }); check();
    frames += analyzed.analyzedFrames; if (hooks.length + analyzed.hooks.length > 256) throw Error("COUNTER_HOOK_BUDGET"); hooks.push(...analyzed.hooks);
    const { hooks: _hooks, diagnostics: tail, ...summary } = analyzed; analyses.push(summary);
    diagnostics.push(...tail.map(row => ({ graphicId: binding.graphicId, ...row }))); if (diagnostics.length > 8) diagnostics.splice(0, diagnostics.length - 8);
  }
  hooks.sort((a, b) => a.frame - b.frame || a.graphicId.localeCompare(b.graphicId));
  const selected = selectCounterSoundHitsV1(owned.fps, request, hooks); check();
  return { request, hooks, ...selected, analyses, diagnostics, maximumStoredDiagnostics: 8 as const, analyzedFrames: frames, storedWholeFrames: 0 as const,
    defaultEnabled: false as const, qualityState: "AUDIO_PENDING_HAO_CLAUDE" as const, editorialAuthority: "explicit_bound_onsets_and_compiled_v3_value_ops_only" as const,
    compositedPixelVisibilityCertified: false as const };
}
