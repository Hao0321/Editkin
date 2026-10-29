import { endianness } from "node:os";
import { LongRenderRefusalV1 } from "./longRenderContractsV1";

/** Bound decoder fan-in and Windows argv without discarding any source. DSP stays in the canonical window graph. */
export function prepareAudioInputGroupsV2<T, R>(items: readonly T[], prepare: (group: readonly T[]) => R): R[] {
  const result: R[] = [];
  const visit = (group: readonly T[]): void => {
    try { result.push(prepare(group)); }
    catch (error) {
      if (!(error instanceof LongRenderRefusalV1) || error.code !== "LONG_RENDER_ROUTE_NOT_AVAILABLE"
        || error.details.reason !== "audio-window-argument-budget" || group.length <= 1) throw error;
      const middle = Math.floor(group.length / 2);
      visit(group.slice(0, middle)); visit(group.slice(middle));
    }
  };
  if (!items.length) visit([]);
  for (let at = 0; at < items.length; at += 64) visit(items.slice(at, at + 64));
  return result;
}

/** The two disjoint views may share one allocation. All four lanes retain their positions and are never mastered here. */
export function addQuadPcmF32LeV2(target: Buffer, source: Uint8Array): void {
  if (endianness() !== "LE" || target.byteLength !== source.byteLength || target.byteLength % 16 !== 0
    || target.byteOffset % 4 !== 0 || source.byteOffset % 4 !== 0
    || target.buffer === source.buffer && target.byteOffset < source.byteOffset + source.byteLength
      && source.byteOffset < target.byteOffset + target.byteLength) throw Error("GLOBAL_AUDIO_PCM_VIEW_INVALID");
  const out = new Float32Array(target.buffer, target.byteOffset, target.byteLength / 4);
  const incoming = new Float32Array(source.buffer, source.byteOffset, source.byteLength / 4);
  for (let i = 0; i < out.length; i++) {
    const value = Math.fround(out[i] + incoming[i]);
    if (!Number.isFinite(value)) throw Error("GLOBAL_AUDIO_PCM_NONFINITE");
    out[i] = value;
  }
}
