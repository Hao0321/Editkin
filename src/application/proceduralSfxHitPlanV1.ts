import { PROCEDURAL_SFX_CATALOGUE_V1, PROCEDURAL_SFX_RATE_V1, proceduralSfxRecipeV1, type ProceduralSfxKindV1 } from "./proceduralSfxCatalogueV1";
import { synthesizeProceduralSfxV1 } from "./proceduralSfxSynthV1";

export interface SfxHitRequestV1 { frame: number; kind: ProceduralSfxKindV1; variant: number; gain: number }
export interface SfxAudioHitHookV1 { frame: number; energy: number; nominalTimeSeconds?: number }
export interface SfxHitPlanV1 {
  fps: number; durationFrames: number;
  hits: { frame: number; assetId: string; startSample: number; endSample: number; gain: number }[];
  duck: { floor: number; attackSamples: number; releaseSamples: number };
  defaultEnabled: false; qualityState: "AUDIO_PENDING_HAO_CLAUDE";
}
const compiledPlans = new WeakSet<SfxHitPlanV1>();
function assertCompiledPlan(plan: SfxHitPlanV1) {
  if (!compiledPlans.has(plan)) throw new Error("SFX_COMPILED_PLAN_REQUIRED");
}
/** W2 V2 audioHitHooks and W4 counter/tick hooks may feed this explicit opt-in adapter. */
export function compileProceduralSfxHookPlanV1(fps: number, durationFrames: number, hooks: readonly SfxAudioHitHookV1[],
  selection: { kind: ProceduralSfxKindV1; variant: number; gain: number; minimumEnergy: number }, duck: SfxHitPlanV1["duck"]): SfxHitPlanV1 {
  if (hooks.length > 256 || !Number.isFinite(selection.minimumEnergy) || selection.minimumEnergy < 0 || selection.minimumEnergy > 1
    || new Set(hooks.map(h => h.frame)).size !== hooks.length) throw new Error("SFX_HOOK_BUDGET_OR_DUPLICATE");
  for (const h of hooks) if (!Number.isFinite(h.energy) || h.energy < 0 || h.energy > 1
    || !Number.isSafeInteger(h.frame) || h.frame < 0 || h.frame >= durationFrames
    || h.nominalTimeSeconds !== undefined && (!Number.isFinite(h.nominalTimeSeconds) || h.nominalTimeSeconds < 0
      || Math.abs(h.frame - h.nominalTimeSeconds * fps) > .5 + 1e-7)) throw new Error("SFX_HOOK_EVIDENCE_INVALID");
  // Validate the explicit selection even when the energy gate suppresses all hooks.
  if (!PROCEDURAL_SFX_CATALOGUE_V1.some(r => r.kind === selection.kind && r.variant === selection.variant)
    || !Number.isFinite(selection.gain) || selection.gain <= 0 || selection.gain > 1) throw new Error("SFX_HOOK_SELECTION_INVALID");
  return compileProceduralSfxHitPlanV1(fps, durationFrames, hooks.filter(h => h.energy >= selection.minimumEnergy)
    .map(h => ({ frame: h.frame, kind: selection.kind, variant: selection.variant, gain: selection.gain })), duck);
}
/** Explicit visual hit frames only. No automatic choices for old templates, travel, food or VA. */
export function compileProceduralSfxHitPlanV1(fps: number, durationFrames: number, requests: readonly SfxHitRequestV1[], duck: SfxHitPlanV1["duck"]): SfxHitPlanV1 {
  if (!Number.isFinite(fps) || fps < 1 || fps > 240 || !Number.isSafeInteger(durationFrames) || durationFrames < 1 || durationFrames / fps > 86_400
    || requests.length > 256 || !Number.isFinite(duck.floor) || duck.floor < .1 || duck.floor > 1
    || !Number.isSafeInteger(duck.attackSamples) || duck.attackSamples < 1 || duck.attackSamples > 48_000
    || !Number.isSafeInteger(duck.releaseSamples) || duck.releaseSamples < 1 || duck.releaseSamples > 48_000) throw new Error("SFX_HIT_PLAN_BUDGET");
  const hits = requests.map(r => {
    if (!Number.isSafeInteger(r.frame) || r.frame < 0 || r.frame >= durationFrames || !Number.isFinite(r.gain) || r.gain <= 0 || r.gain > 1) throw new Error("SFX_HIT_REQUEST_INVALID");
    const recipe = PROCEDURAL_SFX_CATALOGUE_V1.find(c => c.kind === r.kind && c.variant === r.variant);
    if (!recipe) throw new Error("SFX_ID_NOT_IN_OWNED_CATALOGUE");
    const startSample = Math.round(r.frame * PROCEDURAL_SFX_RATE_V1 / fps);
    const endSample = startSample + recipe.durationSamples;
    if (endSample > Math.round(durationFrames * PROCEDURAL_SFX_RATE_V1 / fps)) throw new Error("SFX_HIT_TAIL_OUTSIDE_TIMELINE");
    return { frame: r.frame, assetId: recipe.id, startSample, endSample, gain: r.gain };
  }).sort((a, b) => a.startSample - b.startSample || a.assetId.localeCompare(b.assetId));
  for (const hit of hits) Object.freeze(hit);
  Object.freeze(hits);
  const plan: SfxHitPlanV1 = Object.freeze({ fps, durationFrames, hits, duck: Object.freeze({ ...duck }), defaultEnabled: false, qualityState: "AUDIO_PENDING_HAO_CLAUDE" });
  compiledPlans.add(plan);
  return plan;
}
export function proceduralSfxDuckGainV1(plan: SfxHitPlanV1, sample: number): number {
  assertCompiledPlan(plan);
  if (!Number.isSafeInteger(sample) || sample < 0) throw new Error("SFX_SAMPLE_CLOCK_INVALID");
  let gain = 1;
  for (const hit of plan.hits) {
    const a = hit.startSample - plan.duck.attackSamples, b = hit.endSample + plan.duck.releaseSamples;
    if (sample < a || sample > b) continue;
    const weight = sample < hit.startSample ? (sample - a) / plan.duck.attackSamples
      : sample <= hit.endSample ? 1 : (b - sample) / plan.duck.releaseSamples;
    gain = Math.min(gain, 1 - (1 - plan.duck.floor) * weight); // overlap never compounds below floor
  }
  return gain;
}
/** One second PCM working set. An explicit headroom failure avoids silently clipping existing music. */
export function mixProceduralSfxChunkV1(plan: SfxHitPlanV1, music: Float32Array, startSample: number, sounds: ReadonlyMap<string, Int16Array>): Float32Array {
  assertCompiledPlan(plan);
  if (!Number.isSafeInteger(startSample) || startSample < 0 || !(music instanceof Float32Array) || music.length > PROCEDURAL_SFX_RATE_V1
    || startSample + music.length > Math.round(plan.durationFrames * PROCEDURAL_SFX_RATE_V1 / plan.fps)) throw new Error("SFX_MIX_CHUNK_BUDGET");
  for (const hit of plan.hits.filter((hit, i, all) => all.findIndex(h => h.assetId === hit.assetId) === i)) {
    const buffer = sounds.get(hit.assetId), recipe = proceduralSfxRecipeV1(hit.assetId);
    if (!buffer || buffer.length !== recipe.durationSamples || !(buffer instanceof Int16Array)) throw new Error("SFX_PCM_IDENTITY_REQUIRED");
    const expected = synthesizeProceduralSfxV1(hit.assetId);
    if (buffer.some((sample, i) => sample !== expected[i])) throw new Error("SFX_PCM_IDENTITY_REQUIRED");
  }
  const out = new Float32Array(music.length);
  for (let i = 0; i < music.length; i++) {
    if (!Number.isFinite(music[i]) || Math.abs(music[i]) > 1) throw new Error("SFX_MUSIC_PCM_INVALID");
    const clock = startSample + i;
    let value = music[i] * proceduralSfxDuckGainV1(plan, clock);
    for (const hit of plan.hits) if (clock >= hit.startSample && clock < hit.endSample) value += sounds.get(hit.assetId)![clock - hit.startSample] / 32768 * hit.gain;
    if (!Number.isFinite(value) || Math.abs(value) > .999) throw new Error("SFX_MIX_HEADROOM_REQUIRED");
    out[i] = value;
  }
  return out;
}
