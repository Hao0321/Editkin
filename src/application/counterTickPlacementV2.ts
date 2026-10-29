import { counterTickRequestV2Schema, deriveCounterVisualTicksV2, type CounterTickRuntimeV2 } from "./counterVisualTicksV2";
import { inspectReferenceMotionTemplateInstance } from "./referenceMotionTemplateInstances";
import { prepareProceduralSfxPlacementV1, type ProceduralSfxPlacementResolverV1 } from "./proceduralSfxPlacementV1";
import type { ProceduralSfxLibraryV1 } from "./proceduralSfxLibraryV1";
import type { ProjectSession } from "./projectSession";
import { canonicalJson } from "../shared/canonicalJson";

function boundedSource<T>(operation: () => Promise<T>, milliseconds: number, signals: (AbortSignal | undefined)[]): Promise<T> {
  return new Promise((resolve, reject) => {
    let done = false;
    const sources = [...new Set(signals.filter((s): s is AbortSignal => !!s))], listeners: { signal: AbortSignal; callback: () => void }[] = [];
    const finish = (action: () => void) => { if (done) return; done = true; clearTimeout(timer); for (const l of listeners) l.signal.removeEventListener("abort", l.callback); action(); };
    const timer = setTimeout(() => finish(() => reject(Error("COUNTER_V2_SOURCE_RESOLUTION_TIMEOUT"))), milliseconds);
    for (const signal of sources) { if (done) break; const callback = () => finish(() => reject(signal.reason)); listeners.push({ signal, callback }); signal.addEventListener("abort", callback, { once: true }); if (signal.aborted) callback(); }
    Promise.resolve().then(() => { for (const signal of sources) signal.throwIfAborted(); return operation(); })
      .then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
  });
}
/** New preparation only. The existing process-owned procedural placement packet remains
 * the sole apply/Undo owner. Its resolver also checks this full source graph before commit. */
export async function prepareCounterTickPlacementV2(session: ProjectSession, library: Pick<ProceduralSfxLibraryV1, "list"> & ProceduralSfxPlacementResolverV1,
  payload: unknown, signal?: AbortSignal, runtime: CounterTickRuntimeV2 = {}) {
  const request = counterTickRequestV2Schema.parse(structuredClone(payload)), settings = { ...runtime }, project = session.getSnapshot().history.present, task = session.beginTask(project), before = canonicalJson(project);
  const timeout = settings.timeoutMs ?? 10000, effectiveSignal = signal ?? settings.signal, host = { list: library.list.bind(library), resolve: library.resolve.bind(library) };
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 60000 || signal && settings.signal && settings.signal !== signal) throw Error("COUNTER_V2_SINGLE_LIFETIME_REQUIRED");
  const until = performance.now() + timeout, current = () => { effectiveSignal?.throwIfAborted();
    if (!task.isCurrent() || canonicalJson(session.getSnapshot().history.present) !== before) throw Error("COUNTER_PROJECT_CHANGED"); };
  const budget = () => { current(); const left = until - performance.now(); if (left <= 0) throw Error("COUNTER_V2_ANALYSIS_TIMEOUT"); return left; };
  budget();
  for (const binding of request.bindings) if (binding.source === "reference_instance") {
    const inspection = await boundedSource(() => inspectReferenceMotionTemplateInstance(project, binding.instanceId), budget(), [effectiveSignal]); budget();
    if (inspection.status !== "CURRENT") throw Error(`COUNTER_INSTANCE_${inspection.status}`);
  }
  const visual = await deriveCounterVisualTicksV2(project, request, { ...settings, signal: effectiveSignal, timeoutMs: budget() }); budget();
  if (!visual.selected.length) throw Error("COUNTER_NO_COMPLETE_SOUND_HITS");
  const page = await boundedSource(() => host.list({ kind: "tick", limit: 5 }, effectiveSignal), budget(), [effectiveSignal]); budget();
  const sound = page.entries.find(e => e.id === visual.soundId);
  if (!sound || sound.durationSamples !== visual.durationSamples) throw Error("COUNTER_TICK_SOURCE_MISSING");
  let preparation = true;
  const guarded: ProceduralSfxPlacementResolverV1 = { resolve: async (value, applySignal) => {
    current(); const resolved = await boundedSource(() => host.resolve(value, applySignal), preparation ? budget() : timeout, [effectiveSignal, applySignal]); current(); return resolved;
  } };
  const placement = await prepareProceduralSfxPlacementV1(session, guarded, { trackId: request.trackId, idPrefix: request.idPrefix,
    ...(request.newTrack ? { newTrack: request.newTrack } : {}), hits: visual.selected.map(h => ({ id: sound.id, sha256: sound.sha256, frame: h.frame, gain: request.sound.gain })) }, effectiveSignal);
  budget(); preparation = false; return { placement, visual, sourceSha256: sound.sourceSha256, wavSha256: sound.sha256,
    ducking: "existing_render_sound_effect_sidechain" as const, defaultEnabled: false as const, qualityState: "AUDIO_PENDING_HAO_CLAUDE" as const };
}
