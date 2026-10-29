/** W4-6 / LONG-Q016. New opt-in candidates; never replaces the four certified core sounds. */
export const PROCEDURAL_SFX_RATE_V1 = 48_000;
export const PROCEDURAL_SFX_REVISION_V1 = "editkin.original-procedural-sfx/v1" as const;
export const PROCEDURAL_SFX_KINDS_V1 = ["whoosh", "pop", "ding", "riser", "impact", "tick", "cash", "glitch"] as const;
export type ProceduralSfxKindV1 = typeof PROCEDURAL_SFX_KINDS_V1[number];
export interface ProceduralSfxRecipeV1 {
  readonly id: string;
  readonly kind: ProceduralSfxKindV1;
  readonly variant: number;
  readonly seed: number;
  readonly durationSamples: number;
  readonly frequencyHz: number;
  readonly source: "local-original-mathematical-synthesis";
  readonly rightsBasis: "owner-authorized-local-generation";
  readonly distributionScope: "private-owner-only";
  readonly certification: "AUDIO_PENDING_HAO_CLAUDE";
  readonly defaultEnabled: false;
}
const durations = [.42, .16, .55, .70, .38, .10, .48, .24];
const frequencies = [420, 650, 880, 260, 90, 1400, 1100, 700];
export const PROCEDURAL_SFX_CATALOGUE_V1: readonly ProceduralSfxRecipeV1[] = Object.freeze(
  PROCEDURAL_SFX_KINDS_V1.flatMap((kind, k) => Array.from({ length: 5 }, (_, v) => Object.freeze({
    id: `sfx:editkin-procedural-v1-${kind}-${String(v + 1).padStart(2, "0")}`,
    kind, variant: v + 1, seed: (0x51f15e + k * 65537 + v * 8191) >>> 0,
    durationSamples: Math.round((durations[k] + v * .017) * PROCEDURAL_SFX_RATE_V1),
    frequencyHz: frequencies[k] * (1 + v * .065),
    source: "local-original-mathematical-synthesis" as const,
    rightsBasis: "owner-authorized-local-generation" as const,
    distributionScope: "private-owner-only" as const,
    certification: "AUDIO_PENDING_HAO_CLAUDE" as const, defaultEnabled: false as const,
  })))
);
export function proceduralSfxRecipeV1(id: string): ProceduralSfxRecipeV1 {
  const found = PROCEDURAL_SFX_CATALOGUE_V1.find(r => r.id === id);
  if (!found) throw new Error("SFX_ID_NOT_IN_OWNED_CATALOGUE");
  return found;
}
