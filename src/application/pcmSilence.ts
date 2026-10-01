export interface PcmSilenceOptions {
  thresholdDb: number;
  minSilence: number;
}

/** 10 ms RMS windows; all channels must be quiet, without downmix cancellation. */
export function detectPcmSilences(
  channels: readonly Float32Array[],
  sampleRate: number,
  options: PcmSilenceOptions,
): Array<{ start: number; end: number }> {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new Error("Smart Cut PCM 取樣率不合法");
  if (!channels.length || channels.some(channel => channel.length !== channels[0].length)) throw new Error("Smart Cut PCM 聲道不合法");
  if (!Number.isFinite(options.thresholdDb) || options.thresholdDb > 0
    || !Number.isFinite(options.minSilence) || options.minSilence < 0) throw new Error("Smart Cut 靜音參數不合法");
  const length = channels[0].length;
  const windowSamples = Math.max(1, Math.round(sampleRate * 0.01));
  const minSamples = Math.ceil(options.minSilence * sampleRate);
  const thresholdSquared = 10 ** (options.thresholdDb / 10);
  const ranges: Array<{ start: number; end: number }> = [];
  let silenceStart: number | undefined;
  for (let start = 0; start < length; start += windowSamples) {
    const end = Math.min(length, start + windowSamples);
    let quiet = true;
    for (const channel of channels) {
      let energy = 0;
      for (let index = start; index < end; index += 1) {
        const sample = channel[index];
        if (!Number.isFinite(sample)) throw new Error("Smart Cut PCM 樣本不合法");
        energy += sample * sample;
      }
      if (energy / (end - start) > thresholdSquared) quiet = false;
    }
    if (quiet) silenceStart ??= start;
    else if (silenceStart !== undefined) {
      if (start - silenceStart >= minSamples) ranges.push({ start: silenceStart / sampleRate, end: start / sampleRate });
      silenceStart = undefined;
    }
  }
  if (silenceStart !== undefined && length - silenceStart >= minSamples) {
    ranges.push({ start: silenceStart / sampleRate, end: length / sampleRate });
  }
  return ranges;
}
