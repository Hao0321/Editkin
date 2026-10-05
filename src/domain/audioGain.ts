/** Linear clip gain only. Existing EditGraph volume contract stays 0–2. */
export const MAX_CLIP_VOLUME = 2;
export const MIN_AUDIBLE_GAIN_DB = -60;
export const MAX_CLIP_GAIN_DB = 20 * Math.log10(MAX_CLIP_VOLUME);
export const PEAK_MEASUREMENT_GUARD_DB = 0.15;

export interface ClipAudioMeasurement {
  integratedLufs: number;
  truePeakDbtp: number;
  loudnessRangeLu: number;
}
export interface ClipAudioGainTarget { targetLufs: number; peakCeilingDbtp: number }

export function assertClipVolume(volume: number): void {
  if (!Number.isFinite(volume) || volume < 0 || volume > MAX_CLIP_VOLUME) throw new Error("片段音量必須介於 0–200%");
}
export function clipVolumeDb(volume: number): number | null {
  assertClipVolume(volume);
  return volume === 0 ? null : 20 * Math.log10(volume);
}
export function clipVolumeFromDb(db: number): number {
  if (!Number.isFinite(db) || db < MIN_AUDIBLE_GAIN_DB || db > MAX_CLIP_GAIN_DB + 1e-9) throw new Error("音量超出 -60 至 +6.02 dB 範圍");
  return Math.min(MAX_CLIP_VOLUME, 10 ** (db / 20));
}
export function assertAudioGainTarget(target: ClipAudioGainTarget): void {
  if (!Number.isFinite(target.targetLufs) || target.targetLufs < -32 || target.targetLufs > -9
    || !Number.isFinite(target.peakCeilingDbtp) || target.peakCeilingDbtp < -9 || target.peakCeilingDbtp > -1) {
    throw new Error("目標響度須在 -32 至 -9 LUFS，峰值上限須在 -9 至 -1 dBTP");
  }
}

export function planClipAudioGain(measurement: ClipAudioMeasurement, target: ClipAudioGainTarget, currentVolume: number) {
  assertAudioGainTarget(target); assertClipVolume(currentVolume);
  if (currentVolume === 0) throw new Error("片段已靜音，請先解除靜音再分析音量");
  if (!Number.isFinite(measurement.integratedLufs) || measurement.integratedLufs < -70 || measurement.integratedLufs > 10
    || !Number.isFinite(measurement.truePeakDbtp) || measurement.truePeakDbtp < -100 || measurement.truePeakDbtp > 40
    || !Number.isFinite(measurement.loudnessRangeLu) || measurement.loudnessRangeLu < 0 || measurement.loudnessRangeLu > 99) {
    throw new Error("音訊為靜音、低於可量測響度，或量測結果不合法");
  }
  const targetGainDb = target.targetLufs - measurement.integratedLufs;
  const peakGainLimitDb = target.peakCeilingDbtp - PEAK_MEASUREMENT_GUARD_DB - measurement.truePeakDbtp;
  const appliedGainDb = Math.min(targetGainDb, peakGainLimitDb, MAX_CLIP_GAIN_DB);
  if (appliedGainDb < MIN_AUDIBLE_GAIN_DB) throw new Error("需要低於 -60 dB 才能守住峰值；請先檢查來源音訊");
  const constrainedBy: Array<"true_peak" | "project_volume_limit"> = [];
  if (peakGainLimitDb < targetGainDb - 1e-8) constrainedBy.push("true_peak");
  if (MAX_CLIP_GAIN_DB < targetGainDb - 1e-8) constrainedBy.push("project_volume_limit");
  const predictedLufs = measurement.integratedLufs + appliedGainDb;
  return { volume: clipVolumeFromDb(appliedGainDb), appliedGainDb,
    changeFromCurrentDb: appliedGainDb - clipVolumeDb(currentVolume)!, targetGainDb, constrainedBy,
    predictedLufs, predictedTruePeakDbtp: measurement.truePeakDbtp + appliedGainDb,
    targetReached: Math.abs(predictedLufs - target.targetLufs) <= 1e-8,
    measurementGuardDb: PEAK_MEASUREMENT_GUARD_DB,
    scope: "constant_gain_on_measured_stereo_source_window_before_mix" as const };
}
