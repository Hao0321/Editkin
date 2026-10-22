import { PROCEDURAL_SFX_CATALOGUE_V1, PROCEDURAL_SFX_RATE_V1 } from "../application/proceduralSfxCatalogueV1";
import type { SfxCue, SoundEvent, StyleTemplateV1 } from "./types";

/**
 * C9 sound cue map: style events (a keyword landing, a section, a click, a pin…) → the template's pick from the
 * existing original procedural SFX library (W4-6; no new files). Cues closer than the template's minimum gap are
 * thinned so the mix never chatters: the more important event wins (a punch card over a keyword pop).
 *
 * The output is placement data. The product applies it through the existing prepareProceduralSfxPlacementV1 path
 * (the library resolves each id to its owned WAV and sha256, ≤ 32 hits per request, one audio track per request).
 * The library stays opt-in: its sounds are AUDIO_PENDING_HAO_CLAUDE and defaultEnabled false.
 */

export interface StyleSfxPlacementV1 {
  readonly at: number;
  readonly frame: number;
  readonly event: SoundEvent;
  readonly sfxId: string;
  /** Linear gain (0..1], from the template's gainDb. */
  readonly gain: number;
  readonly durationSeconds: number;
  /** "auto": from a style event; "plan": an explicit sfx beat. */
  readonly source: "auto" | "plan";
  readonly beatIndex: number;
  /** Which of the style SFX lanes it goes on (hits on one lane never overlap). */
  readonly lane: number;
}

export interface StyleSoundEventInput { readonly at: number; readonly event: SoundEvent; readonly beatIndex: number; readonly source?: "auto" | "plan" }

/** Higher wins when two cues fall closer than the minimum gap. */
const PRIORITY: Readonly<Record<SoundEvent, number>> = {
  punchCard: 9, section: 8, insert: 7, stage: 7, click: 6, cards: 6, pin: 6, leak: 5, arrow: 5, type: 4, punchIn: 3, keyword: 2,
};

/** An explicit plan cue (pop / whoosh / click / riser / hit / ding) voices the matching style event. */
export const SFX_CUE_EVENT: Readonly<Record<SfxCue, SoundEvent>> = { pop: "keyword", whoosh: "leak", click: "click", riser: "section", hit: "punchCard", ding: "pin" };
const CUE_KIND: Readonly<Record<SfxCue, string>> = { pop: "pop", whoosh: "whoosh", click: "tick", riser: "riser", hit: "impact", ding: "ding" };

export function styleSfxDuration(id: string): number {
  const recipe = PROCEDURAL_SFX_CATALOGUE_V1.find(entry => entry.id === id);
  if (!recipe) throw new Error(`SFX ${id} is not in the owned procedural catalogue`);
  return recipe.durationSamples / PROCEDURAL_SFX_RATE_V1;
}

export function planStyleSound(template: StyleTemplateV1, events: readonly StyleSoundEventInput[], explicit: ReadonlyArray<{ at: number; cue: SfxCue; beatIndex: number }>,
  fps: number): StyleSfxPlacementV1[] {
  const sound = template.components.sound;
  if (!sound) {
    // No cue map: explicit plan cues still sound, at a quiet default.
    return lanes(explicit.map(cue => ({ at: cue.at, event: SFX_CUE_EVENT[cue.cue], beatIndex: cue.beatIndex, source: "plan" as const,
      sfxId: `sfx:editkin-procedural-v1-${CUE_KIND[cue.cue]}-01`, gainDb: -16 })), fps);
  }
  const auto = events.filter(event => sound.cues[event.event] !== undefined)
    .map(event => ({ ...event, source: "auto" as const, sfxId: sound.cues[event.event]!, gainDb: sound.gainDb }));
  // Thinning: accept by priority (then time), skipping cues within the minimum gap of an accepted one. Plan cues always stay.
  const planned = explicit.map(cue => ({ at: cue.at, event: SFX_CUE_EVENT[cue.cue], beatIndex: cue.beatIndex, source: "plan" as const,
    sfxId: sound.cues[SFX_CUE_EVENT[cue.cue]] ?? `sfx:editkin-procedural-v1-${CUE_KIND[cue.cue]}-01`, gainDb: sound.gainDb }));
  const accepted: Array<{ at: number; event: SoundEvent; beatIndex: number; source: "auto" | "plan"; sfxId: string; gainDb: number }> = [...planned];
  for (const candidate of [...auto].sort((a, b) => PRIORITY[b.event] - PRIORITY[a.event] || a.at - b.at)) {
    if (accepted.some(other => Math.abs(other.at - candidate.at) < sound.minGapSeconds - 1e-6)) continue;
    accepted.push(candidate);
  }
  return lanes(accepted, fps);
}

function lanes(cues: ReadonlyArray<{ at: number; event: SoundEvent; beatIndex: number; source: "auto" | "plan"; sfxId: string; gainDb: number }>, fps: number): StyleSfxPlacementV1[] {
  const ends: number[] = [];
  return [...cues].sort((a, b) => a.at - b.at || a.beatIndex - b.beatIndex).map(cue => {
    const frame = Math.max(0, Math.round(cue.at * fps)), at = frame / fps, durationSeconds = styleSfxDuration(cue.sfxId);
    let lane = ends.findIndex(end => end <= at + 1e-6);
    if (lane < 0) { lane = ends.length; ends.push(0); }
    ends[lane] = at + durationSeconds;
    return { at, frame, event: cue.event, sfxId: cue.sfxId, gain: Number(Math.min(1, 10 ** (cue.gainDb / 20)).toFixed(4)), durationSeconds,
      source: cue.source, beatIndex: cue.beatIndex, lane };
  });
}

/** prepareProceduralSfxPlacementV1 payloads (sha256 filled by the caller from the library entry), one per lane, ≤ 32 hits each. */
export function styleSfxPlacementRequests(placements: readonly StyleSfxPlacementV1[], trackPrefix = "style-sfx"):
  Array<{ trackId: string; idPrefix: string; newTrack: { name: string }; hits: Array<{ id: string; frame: number; gain: number }> }> {
  const out: Array<{ trackId: string; idPrefix: string; newTrack: { name: string }; hits: Array<{ id: string; frame: number; gain: number }> }> = [];
  const byLane = new Map<number, StyleSfxPlacementV1[]>();
  for (const placement of placements) byLane.set(placement.lane, [...(byLane.get(placement.lane) ?? []), placement]);
  for (const [lane, hits] of [...byLane.entries()].sort((a, b) => a[0] - b[0])) {
    for (let chunk = 0; chunk * 32 < hits.length; chunk += 1) {
      out.push({ trackId: `${trackPrefix}-${lane + 1}${chunk ? `-${chunk + 1}` : ""}`, idPrefix: `${trackPrefix}-${lane + 1}-${chunk + 1}`,
        newTrack: { name: `Style SFX ${lane + 1}${chunk ? `.${chunk + 1}` : ""}` },
        hits: hits.slice(chunk * 32, chunk * 32 + 32).map(hit => ({ id: hit.sfxId, frame: hit.frame, gain: hit.gain })) });
    }
  }
  return out;
}
