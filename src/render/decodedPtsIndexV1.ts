import { readSync } from "node:fs";
import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { readDecodedFrameClocksV1 } from "./decodedFrameClockReaderV1";
import { readGopPacketsV2 } from "./gopPacketReaderV2";
import { packetByteSourceV1, witnessAvcPacketV1, type PacketTimebaseV1 } from "./sourcePacketV1";
import { assertRenderActive } from "./renderLifetime";

const RECORD_BYTES = 24, PAGE_BYTES = 16_320, MAX_PAGES = 4;
export interface DecodedPtsIndexV1 {
  timing: "vfr"; timeBase: PacketTimebaseV1; clockOrigin: { pts: 0; sourceSeconds: 0 };
  decodedFrameCount: number; lastFrameEndPts: number; metadataBytes: number; metadataSha256: string;
  ptsAt(index: number): number; seekIndexAt(index: number): number;
  assertIdentity(): Promise<void>; receipt: { pagesRead: number; cachedBytes: number; maximumCachedBytes: number; idrAnchors: number };
}
/** An owned small binary metadata index. No movie pixels and no movie-sized JS array. */
export async function buildDecodedPtsIndexV1(input: { ffprobePath: string; sourcePath: string; source: FileHandle; sourceBytes: number;
  metadata: FileHandle; timeBase: PacketTimebaseV1; h264FourByteNals: boolean; timeoutMs: number; maximumMetadataBytes?: number }) {
  const budget = input.maximumMetadataBytes ?? 512 * 1024 ** 2;
  if (!Number.isSafeInteger(budget) || budget < RECORD_BYTES || budget > 1024 ** 3
    || ![input.timeBase.numerator, input.timeBase.denominator].every(v => Number.isSafeInteger(v) && v > 0)) throw Error("PTS_INDEX_BUDGET_OR_CLOCK_INVALID");
  const idr = new Set<number>(), packetReceipts: unknown[] = [], frameReceipts: unknown[] = [];
  if (input.h264FourByteNals) {
    const bytes = packetByteSourceV1(input.source, input.sourceBytes);
    await readGopPacketsV2(input.ffprobePath, input.sourcePath, async p => {
      if (p.key) { const proof = await witnessAvcPacketV1(p, bytes); if (proof.idr) { if (p.pts < 0 || p.discard) throw Error("PTS_INDEX_IDR_ORIGIN_UNKNOWN"); idr.add(p.pts); if (idr.size > 1_000_000) throw Error("PTS_INDEX_IDR_BUDGET"); } }
    }, { timeoutMs: input.timeoutMs, onTerminal: r => packetReceipts.push(r) });
  }
  const buffer = Buffer.alloc(PAGE_BYTES), digest = createHash("sha256"); let used = 0, written = 0, count = 0, anchor = 0;
  let previous: { pts: number; duration: number; anchor: number } | undefined;
  const flush = async () => {
    if (!used) return; digest.update(buffer.subarray(0, used)); let at = 0;
    while (at < used) { assertRenderActive(); const r = await input.metadata.write(buffer, at, used - at, written + at); if (!r.bytesWritten) throw Error("PTS_INDEX_WRITE_STALLED"); at += r.bytesWritten; }
    written += used; used = 0;
  };
  const row = async (p: { pts: number; duration: number; anchor: number }, end: number) => {
    if (!Number.isSafeInteger(end) || end <= p.pts || written + used + RECORD_BYTES > budget) throw Error("PTS_INDEX_ORDER_OR_METADATA_BUDGET");
    if (used + RECORD_BYTES > buffer.length) await flush();
    buffer.writeBigInt64LE(BigInt(p.pts), used); buffer.writeBigInt64LE(BigInt(end - p.pts), used + 8); buffer.writeBigInt64LE(BigInt(p.anchor), used + 16); used += RECORD_BYTES;
  };
  await readDecodedFrameClocksV1(input.ffprobePath, input.sourcePath, async frame => {
    if (!previous && frame.pts !== 0) throw Error("PTS_INDEX_SOURCE_ORIGIN_REQUIRED");
    if (previous) await row(previous, frame.pts);
    if (idr.has(frame.pts)) anchor = count;
    previous = { pts: frame.pts, duration: frame.duration, anchor }; count++;
    if (!Number.isSafeInteger(count)) throw Error("PTS_INDEX_COUNT_UNSAFE");
  }, { timeoutMs: input.timeoutMs, onTerminal: r => frameReceipts.push(r) });
  if (!previous || !count) throw Error("PTS_INDEX_EMPTY"); const endPts = previous.pts + previous.duration; await row(previous, endPts); await flush(); await input.metadata.sync();
  const identity = await input.metadata.stat({ bigint: true }); if (identity.size !== BigInt(count * RECORD_BYTES)) throw Error("PTS_INDEX_SIZE_CHANGED");
  const pages = new Map<number, Buffer>(), receipt = { pagesRead: 0, cachedBytes: 0, maximumCachedBytes: 0, idrAnchors: idr.size };
  const number = (b: Buffer, at: number) => { const value = b.readBigInt64LE(at); const v = Number(value); if (!Number.isSafeInteger(v) || BigInt(v) !== value) throw Error("PTS_INDEX_INTEGER_UNSAFE"); return v; };
  const read = (index: number, field: number) => {
    assertRenderActive(); if (!Number.isSafeInteger(index) || index < 0 || index >= count) throw Error("PTS_INDEX_POSITION_INVALID");
    const position = index * RECORD_BYTES, start = Math.floor(position / PAGE_BYTES) * PAGE_BYTES; let page = pages.get(start);
    if (!page) {
      page = Buffer.alloc(Math.min(PAGE_BYTES, count * RECORD_BYTES - start)); let at = 0;
      while (at < page.length) { const n = readSync(input.metadata.fd, page, at, page.length - at, start + at); if (!n) throw Error("PTS_INDEX_READ_ENDED_EARLY"); at += n; }
      pages.set(start, page); receipt.pagesRead++; if (pages.size > MAX_PAGES) pages.delete(pages.keys().next().value!);
      receipt.cachedBytes = [...pages.values()].reduce((n, b) => n + b.length, 0); receipt.maximumCachedBytes = Math.max(receipt.maximumCachedBytes, receipt.cachedBytes);
    } else { pages.delete(start); pages.set(start, page); }
    return number(page, position - start + field);
  };
  const index: DecodedPtsIndexV1 = { timing: "vfr", timeBase: { ...input.timeBase }, clockOrigin: { pts: 0, sourceSeconds: 0 }, decodedFrameCount: count,
    lastFrameEndPts: endPts, metadataBytes: count * RECORD_BYTES, metadataSha256: digest.digest("hex"), ptsAt: n => read(n, 0),
    seekIndexAt: n => { const anchor = read(n, 16); if (anchor < 0 || anchor > n) throw Error("PTS_INDEX_SEEK_ANCHOR_INVALID"); return anchor; },
    async assertIdentity() { const s = await input.metadata.stat({ bigint: true }); if (s.dev !== identity.dev || s.ino !== identity.ino || s.size !== identity.size || s.mtimeNs !== identity.mtimeNs || s.ctimeNs !== identity.ctimeNs) throw Error("PTS_INDEX_IDENTITY_CHANGED"); }, receipt };
  idr.clear();
  return { index, packetReceipts, frameReceipts, metadataPixelsStaged: 0 };
}
