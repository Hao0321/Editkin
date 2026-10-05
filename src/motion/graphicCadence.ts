export const GRAPHIC_CADENCE_PROFILES = Object.freeze(["legacy", "brisk"] as const);
export type GraphicCadenceProfile = typeof GRAPHIC_CADENCE_PROFILES[number];

/** Saved brisk dependencies bind the actual coefficients, not just a profile name.
 * These authoring values do not change footage, VO, playback rate or reading minima. */
export const GRAPHIC_CADENCE_CONTRACT = Object.freeze({
  schema: "editkin.graphic-cadence/v1", profile: "brisk",
  entranceSeconds: .22, exitSeconds: .12, moveSeconds: .36,
  shortDelaySeconds: .06, followDelaySeconds: .12, itemStepSeconds: .18,
  strikeDelaySeconds: .24, ruleRevealSeconds: .22, subtitleDelaySeconds: .08,
  returnHoldSeconds: .65, characterStaggerSeconds: .04, maximumStaggerTailSeconds: .12,
  rounding: "nearest_integer_minimum_one; stagger_may_be_zero",
  readingPolicy: "unscaled_authored_reading_minimum",
} as const);
export const GRAPHIC_CADENCE_BRISK_CONTRACT = GRAPHIC_CADENCE_CONTRACT;

export interface GraphicCadenceFrames {
  readonly profile: GraphicCadenceProfile;
  readonly entranceFrames: number;
  readonly exitFrames: number;
  readonly moveFrames: number;
  readonly shortDelayFrames: number;
  readonly followDelayFrames: number;
  readonly itemStepFrames: number;
  readonly strikeDelayFrames: number;
  readonly ruleRevealFrames: number;
  readonly subtitleDelayFrames: number;
  readonly returnHoldFrames: number;
  /** Brisk caps the complete last-unit delay, rather than multiplying an
   * apparently small per-letter gap into a long queue. Zero is explicit. */
  readonly staggerFrames: (unitCount: number) => number;
}

/** Pure compilation into the existing integer-frame Motion v2 consumers.
 * Omitted/legacy uses exactly the prior seconds/speed rounding. */
export function compileGraphicCadence(fps: number, animationSpeed = 1,
  profile?: GraphicCadenceProfile): Readonly<GraphicCadenceFrames> {
  if (!Number.isFinite(fps) || fps <= 0 || fps > 240) throw new Error("Graphic cadence fps must be finite and in (0,240]");
  if (!Number.isFinite(animationSpeed) || animationSpeed < .5 || animationSpeed > 2) throw new Error("Graphic cadence animation speed must be in [.5,2]");
  if (profile !== undefined && !GRAPHIC_CADENCE_PROFILES.includes(profile)) throw new Error("Unknown graphic cadence profile");
  const selected = profile ?? "legacy", brisk = selected === "brisk", c = GRAPHIC_CADENCE_BRISK_CONTRACT;
  const frames = (seconds: number) => Math.max(1, Math.round(seconds * fps / animationSpeed));
  return Object.freeze({ profile: selected,
    entranceFrames: frames(brisk ? c.entranceSeconds : .32), exitFrames: frames(brisk ? c.exitSeconds : .18),
    moveFrames: frames(brisk ? c.moveSeconds : .6), shortDelayFrames: frames(brisk ? c.shortDelaySeconds : .12),
    followDelayFrames: frames(brisk ? c.followDelaySeconds : .26), itemStepFrames: frames(brisk ? c.itemStepSeconds : .3),
    strikeDelayFrames: frames(brisk ? c.strikeDelaySeconds : .45), ruleRevealFrames: frames(brisk ? c.ruleRevealSeconds : .4),
    subtitleDelayFrames: frames(brisk ? c.subtitleDelaySeconds : .18),
    returnHoldFrames: brisk ? Math.ceil(c.returnHoldSeconds * fps) : frames(.65),
    staggerFrames(unitCount: number): number {
      if (!Number.isInteger(unitCount) || unitCount < 1 || unitCount > 128) throw new Error("Graphic cadence unit count must be an integer in [1,128]");
      if (!brisk) return frames(.035);
      if (unitCount === 1) return 0;
      return Math.min(Math.round(c.characterStaggerSeconds * fps / animationSpeed),
        Math.floor(Math.floor(c.maximumStaggerTailSeconds * fps) / (unitCount - 1)));
    },
  });
}
