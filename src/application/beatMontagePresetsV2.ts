import * as z from "zod/v4";

export const beatMontageStyleSchemaV2 = z.enum(["travel", "food", "hype"]);
export type BeatMontageStyleV2 = z.infer<typeof beatMontageStyleSchemaV2>;
/** Explicit pace candidates for measured RMS/max-RMS levels. No look, text, automatic topic choice or certification. */
export const BEAT_MONTAGE_PRESETS_V2 = Object.freeze([
  { id: "travel" as const, lowThreshold: .65, highThreshold: .98, authoredFlashAllowed: false },
  { id: "food" as const, lowThreshold: .1, highThreshold: .9, authoredFlashAllowed: false },
  { id: "hype" as const, lowThreshold: .05, highThreshold: .5, authoredFlashAllowed: true },
].map(p => Object.freeze({ schema: "editkin.beat-montage-preset/v2" as const, revision: 1, ...p,
  qualityState: "ART_PENDING_CLAUDE" as const, defaultEnabled: false as const, vaDefaultEligible: false as const })));

export function getBeatMontagePresetV2(value: unknown) {
  const id = beatMontageStyleSchemaV2.parse(value);
  return BEAT_MONTAGE_PRESETS_V2.find(p => p.id === id)!;
}
