/** Experimental shared stereo phase/nearest-peak locking with bounded isolated attack packets. Caller owns PCM/encoder lifetime.
 * Tonal phase locking follows Laroche/Dolson (1999) III-C; transient packet transport is independently implemented.
 * Tested on short generated signals only: speech, mixed percussion, source edges, extreme ratios and long jobs remain unverified. */
export function fftPlanV1(size: number) {
  if (!Number.isSafeInteger(size) || size < 8 || size > 8192 || (size & (size - 1))) throw Error("STRETCH_FFT_SIZE_INVALID");
  const reverse = new Uint32Array(size), cos = new Float64Array(size / 2), sin = new Float64Array(size / 2);
  const bits = Math.log2(size);
  for (let n = 0; n < size; n++) { let value = n, out = 0; for (let b = 0; b < bits; b++) { out = (out << 1) | (value & 1); value >>= 1; } reverse[n] = out; }
  for (let n = 0; n < size / 2; n++) { cos[n] = Math.cos(2 * Math.PI * n / size); sin[n] = Math.sin(2 * Math.PI * n / size); }
  return {
    bytes: reverse.byteLength + cos.byteLength + sin.byteLength,
    transform(real: Float64Array, imag: Float64Array, inverse = false) {
      if (real.length !== size || imag.length !== size) throw Error("STRETCH_FFT_SHAPE_INVALID");
      for (let n = 0; n < size; n++) { const other = reverse[n]; if (n < other) { const r = real[n], i = imag[n]; real[n] = real[other]; imag[n] = imag[other]; real[other] = r; imag[other] = i; } }
      for (let block = 2; block <= size; block *= 2) {
        const half = block / 2, stride = size / block;
        for (let base = 0; base < size; base += block) for (let at = 0; at < half; at++) {
          const tw = at * stride, c = cos[tw], s = inverse ? sin[tw] : -sin[tw], upper = base + at, lower = upper + half;
          const r = real[lower] * c - imag[lower] * s, i = real[lower] * s + imag[lower] * c, oldR = real[upper], oldI = imag[upper];
          real[upper] = oldR + r; imag[upper] = oldI + i; real[lower] = oldR - r; imag[lower] = oldI - i;
        }
      }
      if (inverse) for (let n = 0; n < size; n++) { real[n] /= size; imag[n] /= size; }
    },
  };
}
const wrap = (phase: number) => phase - 2 * Math.PI * Math.round(phase / (2 * Math.PI));
export function createPhaseCoherentStretchV1(input: {
  sampleRate: number; channels: 1 | 2; speed: number; sourceSamples: number; outputSamples: number; fftSize?: number;
  readSourceWindow(startSample: number, length: number): Promise<readonly Float64Array[]>; signal?: AbortSignal;
}) {
  if (!Number.isSafeInteger(input.sampleRate) || input.sampleRate < 8000 || input.sampleRate > 192000 || (input.channels !== 1 && input.channels !== 2)
    || !Number.isFinite(input.speed) || input.speed < 1 / 64 || input.speed > 64 || !Number.isSafeInteger(input.sourceSamples) || input.sourceSamples < 1
    || !Number.isSafeInteger(input.outputSamples) || input.outputSamples < 1 || Math.abs(input.sourceSamples - input.outputSamples * input.speed) > 2) throw Error("STRETCH_REQUEST_INVALID");
  const n = input.fftSize ?? 4096, fft = fftPlanV1(n), hop = n / 16; if (!Number.isSafeInteger(hop) || hop < 32) throw Error("STRETCH_HOP_INVALID");
  const bins = n / 2 + 1, window = Float64Array.from({ length: n }, (_, at) => .5 - .5 * Math.cos(2 * Math.PI * at / n));
  const complex = () => Array.from({ length: input.channels }, () => ({ real: new Float64Array(n), imag: new Float64Array(n) }));
  let first = { frame: -1, channels: complex() }, second = { frame: -1, channels: complex() };
  const synthesis = complex(), phases = new Float64Array(bins), references = new Uint8Array(bins), ringSize = n + hop;
  const analysisPhases = Array.from({length:input.channels},()=>new Float64Array(bins));
  const magnitudes = Array.from({length:input.channels},()=>new Float64Array(bins));
  const energies = new Float64Array(bins), locked = new Float64Array(bins), peaks = new Uint32Array(bins);
  const overlap = Array.from({ length: input.channels }, () => new Float64Array(ringSize)), weights = new Float64Array(ringSize), pcm = new Float32Array(hop * input.channels);
  let synthesisFrame = 0, emitted = 0, busy = false, closed = false;
  const pulseLimit=4, pulseHalf=n/8;
  const pulses: {center:number; start:number; samples:Float64Array[]}[]=[];
  let detectedPulses=0;
  const receipt = { algorithm: "shared_bin_phase_vocoder_v1" as const, implementationRevision: 2, detectedPulses: 0, pulseCapacity: pulseLimit, fftSize: n, hopSamples: hop, synthesizedFrames: 0, sourceFftFrames: 0,
    outputSamples: 0, channels: input.channels, sourceMovieArrayBytes: 0, maximumWorkingBytes: fft.bytes + window.byteLength + phases.byteLength + references.byteLength + weights.byteLength + pcm.byteLength
      + input.channels * (6 * n * 8 + ringSize * 8) + input.channels * bins * 16 + bins * 20 + pulseLimit * pulseHalf * 2 * input.channels * 8 };
  const analyze = async (frame: number, cache: typeof first) => {
    if (cache.frame === frame) return;
    const data = await input.readSourceWindow(frame * hop - n / 2, n);
    if (data.length !== input.channels || data.some(a => a.length !== n)) throw Error("STRETCH_SOURCE_WINDOW_SHAPE_INVALID");
    let total=0, moment=0, squareMoment=0, maximum=0, maximumIndex=0;
    for(let at=0;at<n;at++) {
      let energy=0;for(let c=0;c<input.channels;c++){const value=data[c][at];if(!Number.isFinite(value))throw Error("STRETCH_SOURCE_WINDOW_NONFINITE");energy+=value*value;}
      total+=energy;moment+=energy*at;squareMoment+=energy*at*at;
      if(energy>maximum){maximum=energy;maximumIndex=at;}
    }
    const centroid=total>1e-12?moment/total:0, variance=total>1e-12?squareMoment/total-centroid*centroid:Infinity;
    const windowStart=frame*hop-n/2, center=windowStart+maximumIndex;
    for(let i=pulses.length-1;i>=0;i--)if((pulses[i].center/input.speed+pulseHalf)<emitted)pulses.splice(i,1);
    if(total>1e-10 && variance<(n/32)**2 && maximumIndex>=n/4 && maximumIndex<3*n/4
      && !pulses.some(p=>Math.abs(p.center-center)<pulseHalf)) {
      if(pulses.length>=pulseLimit)throw Error("STRETCH_TRANSIENT_CAPACITY");
      const start=center-pulseHalf, samples=Array.from({length:input.channels},()=>new Float64Array(pulseHalf*2));
      for(let c=0;c<input.channels;c++)for(let j=0;j<pulseHalf*2;j++)samples[c][j]=data[c][maximumIndex-pulseHalf+j];
      pulses.push({center,start,samples});detectedPulses++;
    }
    for (let c = 0; c < input.channels; c++) {
      const target = cache.channels[c]; target.imag.fill(0);
      for (let at = 0; at < n; at++) { const value = data[c][at]; if (!Number.isFinite(value)) throw Error("STRETCH_SOURCE_WINDOW_NONFINITE"); let residual=value;
        for(const pulse of pulses){const index=windowStart+at-pulse.start;if(index>=0&&index<pulseHalf*2)residual-=pulse.samples[c][index];}
        target.real[at] = residual * window[at]; }
      fft.transform(target.real, target.imag);
    }
    cache.frame = frame; receipt.sourceFftFrames++;
  };
  const processFrame = async () => {
    input.signal?.throwIfAborted(); const position = synthesisFrame * input.speed, sourceFrame = Math.floor(position), mix = position - sourceFrame;
    if (second.frame === sourceFrame) { const swap = first; first = second; second = swap; }
    await analyze(sourceFrame, first); await analyze(sourceFrame + 1, second);
    for (let bin = 0; bin < bins; bin++) {
      let reference = references[bin], energy = -1;
      for (let c = 0; c < input.channels; c++) { const a = first.channels[c], b = second.channels[c], e = a.real[bin] ** 2 + a.imag[bin] ** 2 + b.real[bin] ** 2 + b.imag[bin] ** 2;
        if (e > energy) { energy = e; reference = c; } }
      const a = first.channels[reference], b = second.channels[reference], phase0 = Math.atan2(a.imag[bin], a.real[bin]), phase1 = Math.atan2(b.imag[bin], b.real[bin]);
      const nominal = 2 * Math.PI * bin * hop / n, advance = nominal + wrap(phase1 - phase0 - nominal);
      if (!synthesisFrame) phases[bin] = phase0 + mix * advance;
      else {
        if (reference !== references[bin]) { const old = first.channels[references[bin]]; phases[bin] += wrap(phase0 - Math.atan2(old.imag[bin], old.real[bin])); }
        phases[bin] += advance;
      }
      references[bin] = reference; phases[bin] = wrap(phases[bin]); energies[bin] = 0;
      for (let c = 0; c < input.channels; c++) {
        const ca = first.channels[c], cb = second.channels[c], magnitude = Math.hypot(ca.real[bin], ca.imag[bin]) * (1 - mix) + Math.hypot(cb.real[bin], cb.imag[bin]) * mix;
        const cPhase0 = Math.atan2(ca.imag[bin], ca.real[bin]), cPhase1 = Math.atan2(cb.imag[bin], cb.real[bin]);
        const relative0 = wrap(cPhase0 - phase0), relative1 = wrap(cPhase1 - phase1);
        const relative = relative0 + mix * wrap(relative1 - relative0), phase = phases[bin] + relative;
        analysisPhases[c][bin] = phase0 + mix * advance + relative;
        magnitudes[c][bin] = magnitude; energies[bin] += magnitude * magnitude;
        const real = magnitude * Math.cos(phase), imag = (bin === 0 || bin === n / 2) ? 0 : magnitude * Math.sin(phase), out = synthesis[c];
        out.real[bin] = real; out.imag[bin] = imag;
        if (bin > 0 && bin < n / 2) { out.real[n - bin] = real; out.imag[n - bin] = -imag; }
      }
    }
    let count = 0;
    for (let bin = 0; bin < bins; bin++) {
      const e = energies[bin];
      if (e > 1e-16 && (bin === 0 || e > energies[bin - 1]) && (bin === bins - 1 || e >= energies[bin + 1])) peaks[count++] = bin;
    }
    if (count) {
      let owner = 0;
      for (let bin = 0; bin < bins; bin++) {
        while (owner + 1 < count && bin > (peaks[owner] + peaks[owner + 1]) / 2) owner++;
        const peak = peaks[owner], referencePhase = analysisPhases[references[peak]][peak];
        locked[bin] = wrap(phases[peak] + analysisPhases[references[bin]][bin] - referencePhase);
        for (let c = 0; c < input.channels; c++) {
          const phase = phases[peak] + analysisPhases[c][bin] - referencePhase;
          const real = magnitudes[c][bin] * Math.cos(phase), imag = bin === 0 || bin === n / 2 ? 0 : magnitudes[c][bin] * Math.sin(phase), out = synthesis[c];
          out.real[bin] = real; out.imag[bin] = imag;
          if (bin > 0 && bin < n / 2) { out.real[n - bin] = real; out.imag[n - bin] = -imag; }
        }
      }
      phases.set(locked);
    }
    for (const c of synthesis) fft.transform(c.real, c.imag, true);
    const start = synthesisFrame * hop - n / 2;
    for (let at = 0; at < n; at++) {
      const sample = start + at; if (sample < emitted || sample < 0 || sample >= input.outputSamples) continue;
      const slot = sample % ringSize; weights[slot] += window[at] ** 2;
      for (let c = 0; c < input.channels; c++) overlap[c][slot] += synthesis[c].real[at] * window[at];
    }
    synthesisFrame++; receipt.synthesizedFrames++;
  };
  return {
    receipt,
    /** Borrowed interleaved PCM is valid until the next call. Caller must finish writing it first. */
    async next() {
      input.signal?.throwIfAborted(); if (closed || busy) throw Error("STRETCH_STATE_INVALID"); if (emitted >= input.outputSamples) return null; busy = true;
      try {
        const count = Math.min(hop, input.outputSamples - emitted), end = emitted + count;
        while (synthesisFrame * hop - n / 2 < end) { if (synthesisFrame > Math.ceil((input.outputSamples + n / 2) / hop) + 2) throw Error("STRETCH_FRAME_BUDGET"); await processFrame(); }
        for (let at = 0; at < count; at++) {
          const slot = (emitted + at) % ringSize, weight = weights[slot]; if (weight <= 1e-12) throw Error("STRETCH_OVERLAP_GAP");
          for (let c = 0; c < input.channels; c++) { let value = overlap[c][slot] / weight;
            for(const pulse of pulses){const start=Math.round(pulse.center/input.speed)-pulseHalf, index=emitted+at-start;if(index>=0&&index<pulseHalf*2)value+=pulse.samples[c][index];}
            if (!Number.isFinite(value)) throw Error("STRETCH_OUTPUT_NONFINITE"); pcm[at * input.channels + c] = value; overlap[c][slot] = 0; }
          weights[slot] = 0;
        }
        emitted = end; receipt.outputSamples = emitted; receipt.detectedPulses=detectedPulses; return { samples: count, pcm: pcm.subarray(0, count * input.channels) };
      } finally { busy = false; }
    },
    close() { if (busy) throw Error("STRETCH_BUSY"); closed = true; },
  };
}
