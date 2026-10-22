import { proceduralSfxRecipeV1, PROCEDURAL_SFX_RATE_V1 } from "./proceduralSfxCatalogueV1";
import type { CounterVisualTickV1, CounterTickRequestV1 } from "./counterVisualTicksV1";

/** One exact complete-WAV priority/seconds/sample-overlap owner, shared by v1 and explicit v2. */
export function selectCounterSoundHitsV1(fps: number, request: Pick<CounterTickRequestV1, "durationFrames" | "sound">, hooks: CounterVisualTickV1[]) {
  const recipe = proceduralSfxRecipeV1(`sfx:editkin-procedural-v1-tick-${String(request.sound.variant).padStart(2, "0")}`);
  const endSample = Math.round(request.durationFrames * PROCEDURAL_SFX_RATE_V1 / fps);
  const selected: CounterVisualTickV1[] = [], suppressed: { hook: CounterVisualTickV1; reason: "full_sound_tail" | "sound_overlap" | "hit_budget" }[] = [];
  const sample = (h: CounterVisualTickV1) => Math.round(h.frame * PROCEDURAL_SFX_RATE_V1 / fps);
  // Final/state changes win over dense intermediate values. Never truncate a WAV or shift a visual hit.
  const priority = [...hooks].sort((a, b) => Number(a.phase === "count") - Number(b.phase === "count") || a.frame - b.frame || a.graphicId.localeCompare(b.graphicId));
  for (const hook of priority) {
    const start = sample(hook), end = start + recipe.durationSamples;
    const time = hook.frame / fps, tail = time + recipe.durationSamples / PROCEDURAL_SFX_RATE_V1;
    // The editable clip uses seconds while native DSP uses rounded sample indices. Both must fit.
    const reason = end > endSample || tail > request.durationFrames / fps + 1e-8 ? "full_sound_tail" : selected.some(h =>
      start < sample(h) + recipe.durationSamples && end > sample(h)
      || time < h.frame / fps + recipe.durationSamples / PROCEDURAL_SFX_RATE_V1 - 1e-8 && tail > h.frame / fps + 1e-8)
      ? "sound_overlap" : selected.length >= 32 ? "hit_budget" : undefined;
    if (reason) suppressed.push({ hook, reason }); else selected.push(hook);
  }
  selected.sort((a, b) => a.frame - b.frame || a.graphicId.localeCompare(b.graphicId));
  return { selected, suppressed, soundId: recipe.id, durationSamples: recipe.durationSamples };
}
