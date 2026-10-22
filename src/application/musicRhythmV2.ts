import * as z from "zod/v4";

const bpm = z.number().finite().min(30).max(300), unit = z.number().finite().min(0).max(1);
export const musicRhythmSchemaV2 = z.strictObject({
  schema: z.literal("editkin.music-rhythm-refinement/v2"), policy: z.literal("prior-octave-four-beat-candidate/v2"),
  tempo: z.strictObject({ rawBpm: bpm.nullable(), bpm: bpm.nullable(), priorBpm: bpm.nullable(),
    octaveMultiplier: z.union([z.literal(.5), z.literal(1), z.literal(2)]),
    state: z.enum(["no-tempo", "no-prior", "unchanged", "prior-octave-corrected", "prior-incompatible"]), confidence: unit }),
  pulseRecipe: z.strictObject({ mode: z.enum(["unavailable", "native-observed", "decimate-by-two", "insert-midpoints"]), phase: z.number().int().min(0).max(1) }),
  bars: z.strictObject({ mode: z.enum(["unavailable", "native-downbeats", "inferred-four-beat-grid"]), beatsPerBar: z.literal(4),
    anchorSourceSeconds: z.number().finite().min(0).max(691200).nullable(), anchorNativeIndex: z.number().int().min(0).max(399999).nullable(),
    periodSeconds: z.number().finite().min(.8).max(8).nullable(), confidence: unit, inferred: z.boolean(),
    reason: z.enum(["insufficient-or-irregular-evidence", "native-accent-hypothesis", "weak-accent-first-beat-anchor", "octave-adjusted-meter-hypothesis"]) }),
  nativeBeatCount: z.number().int().min(0).max(400000), nativeDownbeatCount: z.number().int().min(0).max(400000), regularIntervalFraction: unit,
  humanQualityCertified: z.literal(false),
});
export type MusicRhythmV2 = z.infer<typeof musicRhythmSchemaV2>;
export interface MusicRhythmAnalysisV2 {
  sourceStartSeconds: number; durationSeconds: number; tempoBpm: number | null; tempoConfidence: number;
  beats: ReadonlyArray<{ timeSeconds: number; confidence: number; downbeat: boolean; downbeatConfidence: number }>;
  rhythmV2?: MusicRhythmV2;
}
const close = (a: number, b: number) => Math.abs(a - b) <= 1e-12;
/** The immutable native receipt remains authoritative; auxiliary metadata cannot rewrite it. */
export function validateMusicRhythmV2(value: unknown, analysis: MusicRhythmAnalysisV2, priorBpm?: number): MusicRhythmV2 {
  const r = musicRhythmSchemaV2.parse(value), beats = analysis.beats, prior = priorBpm ?? null;
  if (![analysis.sourceStartSeconds, analysis.durationSeconds, analysis.tempoConfidence].every(Number.isFinite)
    || analysis.sourceStartSeconds < 0 || analysis.sourceStartSeconds > 604800 || analysis.durationSeconds <= 0 || analysis.durationSeconds > 86400
    || analysis.tempoConfidence < 0 || analysis.tempoConfidence > 1 || beats.length > 400000
    || analysis.tempoBpm === null && (beats.length > 0 || analysis.tempoConfidence !== 0)) throw Error("MUSIC_RHYTHM_ANALYSIS_INVALID");
  let previous = -Infinity;
  for (const b of beats) {
    if (!Number.isFinite(b.timeSeconds) || b.timeSeconds <= previous || b.timeSeconds < analysis.sourceStartSeconds || b.timeSeconds >= analysis.sourceStartSeconds + analysis.durationSeconds
      || ![b.confidence, b.downbeatConfidence].every(v => Number.isFinite(v) && v >= 0 && v <= 1)) throw Error("MUSIC_RHYTHM_EVENT_CLOCK_INVALID"); previous = b.timeSeconds;
  }
  if (r.nativeBeatCount !== beats.length || r.nativeDownbeatCount !== beats.filter(b => b.downbeat).length
    || r.tempo.rawBpm !== analysis.tempoBpm || r.tempo.priorBpm !== prior || r.tempo.confidence > analysis.tempoConfidence) throw Error("MUSIC_RHYTHM_NATIVE_BINDING_MISMATCH");
  let multiplier = 1, state = analysis.tempoBpm === null ? "no-tempo" : prior === null ? "no-prior" : "unchanged";
  if (analysis.tempoBpm !== null && prior !== null && Math.abs(analysis.tempoBpm / prior - 1) > .1) {
    const raw = analysis.tempoBpm, candidates = [.5, 2].filter(m => raw * m >= 30 && raw * m <= 300).sort((a, b) => Math.abs(raw * a / prior - 1) - Math.abs(raw * b / prior - 1));
    if (candidates.length && Math.abs(raw * candidates[0] / prior - 1) <= .1) { multiplier = candidates[0]; state = "prior-octave-corrected"; }
    else state = "prior-incompatible";
  }
  const chosen = analysis.tempoBpm === null ? null : analysis.tempoBpm * multiplier;
  const confidence = multiplier === 1 ? analysis.tempoConfidence : Math.min(analysis.tempoConfidence, .5);
  if (r.tempo.octaveMultiplier !== multiplier || r.tempo.bpm !== chosen || r.tempo.state !== state || !close(r.tempo.confidence, confidence)) throw Error("MUSIC_RHYTHM_TEMPO_POLICY_MISMATCH");
  let supported = 0;
  if (analysis.tempoBpm !== null) for (let i = 1; i < beats.length; i++) {
    const ratio = (beats[i].timeSeconds - beats[i - 1].timeSeconds) / (60 / analysis.tempoBpm), multiple = Math.round(ratio);
    if (multiple >= 1 && multiple <= 4 && Math.abs(ratio - multiple) <= .15) supported++;
  }
  const regular = beats.length < 2 ? 0 : supported / (beats.length - 1), accentIndex = beats.findIndex(b => b.downbeat);
  const mode = chosen !== null && r.nativeDownbeatCount >= 2 && multiplier === 1 ? "native-downbeats"
    : chosen !== null && beats.length >= 8 && regular >= .8 && analysis.tempoConfidence >= .3 ? "inferred-four-beat-grid" : "unavailable";
  const anchorIndex = mode === "unavailable" ? null : accentIndex < 0 ? 0 : accentIndex;
  const barConfidence = mode === "native-downbeats" ? beats.filter(b => b.downbeat).reduce((n, b) => n + b.downbeatConfidence, 0) / r.nativeDownbeatCount
    : mode === "inferred-four-beat-grid" ? Math.min(.2, confidence * regular * .2) : 0;
  const reason = mode === "native-downbeats" ? "native-accent-hypothesis" : mode === "unavailable" ? "insufficient-or-irregular-evidence"
    : multiplier === 1 ? "weak-accent-first-beat-anchor" : "octave-adjusted-meter-hypothesis";
  const pulse = chosen === null ? "unavailable" : multiplier === .5 ? "decimate-by-two" : multiplier === 2 ? "insert-midpoints" : "native-observed";
  if (!close(r.regularIntervalFraction, regular) || r.pulseRecipe.mode !== pulse || r.pulseRecipe.phase !== (multiplier === .5 && accentIndex >= 0 ? accentIndex % 2 : 0)
    || r.bars.mode !== mode || r.bars.inferred !== (mode === "inferred-four-beat-grid") || r.bars.reason !== reason
    || r.bars.anchorNativeIndex !== anchorIndex || r.bars.anchorSourceSeconds !== (anchorIndex === null ? null : beats[anchorIndex].timeSeconds)
    || r.bars.periodSeconds !== (chosen === null ? null : 240 / chosen) || !close(r.bars.confidence, barConfidence)) throw Error("MUSIC_RHYTHM_GRID_POLICY_MISMATCH");
  return r;
}
export interface MusicRhythmEventV2 {
  timeSeconds: number; confidence: number; inferred: boolean; leftNativeIndex: number; rightNativeIndex: number | null;
}
/** Bounded window readout only; inferred pulses/bars carry their provenance. No marker/edit/default mutation. */
export function musicRhythmEventsInWindowV2(analysis: MusicRhythmAnalysisV2, options: {
  sourceStartSeconds: number; sourceEndSeconds: number; priorBpm?: number; maximumEvents?: number; include?: "pulses" | "bars" | "both";
}) {
  const r = validateMusicRhythmV2(analysis.rhythmV2, analysis, options.priorBpm), start = options.sourceStartSeconds, end = options.sourceEndSeconds, maximum = options.maximumEvents ?? 4096;
  if (![start, end].every(Number.isFinite) || start < analysis.sourceStartSeconds || end > analysis.sourceStartSeconds + analysis.durationSeconds
    || start >= end || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 4096) throw Error("MUSIC_RHYTHM_WINDOW_OR_BUDGET_INVALID");
  const include = options.include ?? "both"; if (!["pulses", "bars", "both"].includes(include)) throw Error("MUSIC_RHYTHM_WINDOW_OR_BUDGET_INVALID");
  const pulsesIncluded = include !== "bars", barsIncluded = include !== "pulses";
  const pulses: MusicRhythmEventV2[] = [], bars: MusicRhythmEventV2[] = [], beats = analysis.beats;
  const append = (target: MusicRhythmEventV2[], event: MusicRhythmEventV2) => {
    if (event.timeSeconds < start || event.timeSeconds >= end) return;
    if (pulses.length + bars.length >= maximum) throw Error("MUSIC_RHYTHM_WINDOW_EVENT_LIMIT"); target.push(event);
  };
  for (let i = 0; i < beats.length; i++) {
    const beat = beats[i];
    if (pulsesIncluded && r.pulseRecipe.mode !== "unavailable" && (r.pulseRecipe.mode !== "decimate-by-two" || i % 2 === r.pulseRecipe.phase))
      append(pulses, { timeSeconds: beat.timeSeconds, confidence: beat.confidence, inferred: false, leftNativeIndex: i, rightNativeIndex: null });
    if (pulsesIncluded && r.pulseRecipe.mode === "insert-midpoints" && i + 1 < beats.length && beats[i + 1].timeSeconds - beat.timeSeconds <= 1.5 * 60 / r.tempo.rawBpm!) {
      const middle = (beat.timeSeconds + beats[i + 1].timeSeconds) / 2;
      if (middle <= beat.timeSeconds || middle >= beats[i + 1].timeSeconds) throw Error("MUSIC_RHYTHM_SUBDIVISION_NOT_DISTINCT");
      append(pulses, { timeSeconds: middle, confidence: Math.min(.2, beat.confidence, beats[i + 1].confidence), inferred: true, leftNativeIndex: i, rightNativeIndex: i + 1 });
    }
    if (barsIncluded && r.bars.mode === "native-downbeats" && beat.downbeat) append(bars, { timeSeconds: beat.timeSeconds, confidence: beat.downbeatConfidence, inferred: false, leftNativeIndex: i, rightNativeIndex: null });
  }
  if (barsIncluded && r.bars.mode === "inferred-four-beat-grid") {
    const anchor = r.bars.anchorSourceSeconds!, period = r.bars.periodSeconds!, lo = Math.max(start, beats[0].timeSeconds), hi = Math.min(end, beats.at(-1)!.timeSeconds);
    for (let n = Math.ceil((lo - anchor) / period); ; n++) {
      const timeSeconds = anchor + n * period; if (timeSeconds > hi || timeSeconds >= end) break;
      append(bars, { timeSeconds, confidence: r.bars.confidence, inferred: true, leftNativeIndex: r.bars.anchorNativeIndex!, rightNativeIndex: null });
    }
  }
  return { schema: "editkin.music-rhythm-window/v2" as const, pulses, bars, tempo: r.tempo, sourceStartSeconds: start, sourceEndSeconds: end,
    humanQualityCertified: false as const, markerEditsApplied: false as const, vaDefaultEligible: false as const };
}
