import { PROCEDURAL_SFX_RATE_V1, proceduralSfxRecipeV1 } from "./proceduralSfxCatalogueV1";

export const PROCEDURAL_SFX_PEAK_V1 = 10 ** (-6 / 20);
const tau = Math.PI * 2;

/** Seeded oscillators/noise only. No recordings, model, sample library, FFmpeg or network. */
export function synthesizeProceduralSfxV1(id: string): Int16Array {
  const r = proceduralSfxRecipeV1(id), count = r.durationSamples, pcm = new Float32Array(count);
  let state = r.seed, low = 0, phase = 0, peak = 0;
  const noise = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 2147483648 - 1; };
  for (let i = 0; i < count; i++) {
    const t = i / PROCEDURAL_SFX_RATE_V1, u = i / (count - 1), n = noise();
    low += .14 * (n - low);
    const f = r.frequencyHz;
    let value: number;
    switch (r.kind) {
      case "whoosh": value = (n - low) * Math.sin(Math.PI * u) ** 2 * (.6 + .4 * Math.sin(tau * f * t)); break;
      case "pop": value = Math.sin(tau * f * (t - .65 * t * t)) * Math.exp(-26 * t) + .12 * n * Math.exp(-65 * t); break;
      case "ding": value = (Math.sin(tau * f * t) + .3 * Math.sin(tau * f * 2.73 * t)) * Math.exp(-7 * t); break;
      case "riser": phase += tau * f * (1 + 8 * u * u) / PROCEDURAL_SFX_RATE_V1; value = (.6 * Math.sin(phase) + .4 * (n - low)) * u; break;
      case "impact": value = (.75 * Math.sin(tau * f * t * (1 - .7 * u)) + .25 * low) * Math.exp(-14 * t); break;
      case "tick": value = (Math.sin(tau * f * t) + .4 * n) * Math.exp(-70 * t); break;
      case "cash": {
        const pulse = Math.floor(t / .055), local = t - pulse * .055;
        value = pulse < 3 ? (Math.sin(tau * f * (1 + pulse * .28) * t) + .22 * Math.sin(tau * f * 3.11 * t)) * Math.exp(-48 * local) : 0;
        break;
      }
      case "glitch": value = (Math.round(n * 5) / 5 + .25 * Math.sin(tau * f * t)) * (Math.floor(t * 37) % 3 === 0 ? .25 : 1) * (1 - u); break;
    }
    // Two millisecond boundaries and a smooth tail prevent DC discontinuities at file edges.
    const fade = Math.min(1, i / 96, (count - 1 - i) / 192);
    pcm[i] = value * Math.sin(fade * Math.PI / 2) ** 2;
    peak = Math.max(peak, Math.abs(pcm[i]));
  }
  if (!(peak > 0) || !Number.isFinite(peak)) throw new Error("SFX_SYNTHESIS_INVALID");
  const result = new Int16Array(count), gain = PROCEDURAL_SFX_PEAK_V1 * 32767 / peak;
  for (let i = 0; i < count; i++) result[i] = Math.round(pcm[i] * gain);
  return result;
}

export function encodeProceduralSfxWavV1(samples: Int16Array): Uint8Array {
  if (!(samples instanceof Int16Array) || samples.length < 1 || samples.length > PROCEDURAL_SFX_RATE_V1) throw new Error("SFX_PCM_BUDGET");
  const bytes = new Uint8Array(44 + samples.length * 2), view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i); };
  text(0, "RIFF"); view.setUint32(4, bytes.length - 8, true); text(8, "WAVE"); text(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, PROCEDURAL_SFX_RATE_V1, true); view.setUint32(28, PROCEDURAL_SFX_RATE_V1 * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, "data"); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, samples[i], true);
  return bytes;
}
