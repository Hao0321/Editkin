import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { assertRenderActive } from "./renderLifetime";

export interface SourcePacketV1 { pts: number; dts: number; duration: number; pos: number; size: number; key: boolean }
const integer = (text: string) => {
  if (!/^-?(0|[1-9]\d*)$/.test(text)) throw Error("PACKET_INTEGER_UNKNOWN");
  const value = Number(text); if (!Number.isSafeInteger(value)) throw Error("PACKET_INTEGER_UNSAFE"); return value;
};
/** Exact compact ffprobe fields; line metadata, not an allocation of all packets. */
export function parseSourcePacketV1(line: string): SourcePacketV1 {
  if (Buffer.byteLength(line) > 4096) throw Error("PACKET_LINE_LIMIT");
  const fields: Record<string, string> = Object.create(null), allowed = new Set(["pts", "dts", "duration", "pos", "size", "flags"]);
  for (const item of line.replace(/\r$/, "").split("|")) {
    const at = item.indexOf("="), name = item.slice(0, at), value = item.slice(at + 1);
    if (at < 1 || !allowed.has(name) || Object.hasOwn(fields, name) || !value) throw Error("PACKET_FIELDS_UNKNOWN");
    fields[name] = value;
  }
  if (Object.keys(fields).length !== 6 || !/^[K_]+$/.test(fields.flags)) throw Error("PACKET_FIELDS_UNKNOWN");
  const packet = { pts: integer(fields.pts), dts: integer(fields.dts), duration: integer(fields.duration),
    pos: integer(fields.pos), size: integer(fields.size), key: fields.flags.includes("K") };
  if (packet.duration <= 0 || packet.pos < 0 || packet.size < 1 || !Number.isSafeInteger(packet.pos + packet.size)) throw Error("PACKET_RANGE_INVALID");
  return packet;
}
/** FFprobe hex dump has a double-space separator before its ASCII presentation. */
export function avcConfigurationV1(text: unknown, expectedBytes: unknown) {
  if (typeof text !== "string" || !Number.isSafeInteger(expectedBytes) || Number(expectedBytes) < 7 || Number(expectedBytes) > 65536) throw Error("AVC_CONFIG_UNKNOWN");
  const chunks: Buffer[] = []; let offset = 0;
  for (const line of text.split(/\r?\n/).filter(v => v.trim())) {
    const match = /^([0-9a-fA-F]{8}):[ \t](.*)$/.exec(line);
    if (!match || parseInt(match[1], 16) !== offset) throw Error("AVC_CONFIG_DUMP_INVALID");
    const hex = match[2].split("  ")[0].trim();
    if (!/^[0-9a-fA-F]{2,4}(?:[ \t]+[0-9a-fA-F]{2,4})*$/.test(hex)) throw Error("AVC_CONFIG_DUMP_INVALID");
    const compact = hex.replace(/[ \t]/g, ""); if (compact.length % 2) throw Error("AVC_CONFIG_DUMP_INVALID");
    const bytes = Buffer.from(compact, "hex"); offset += bytes.length; if (offset > Number(expectedBytes)) throw Error("AVC_CONFIG_DUMP_INVALID"); chunks.push(bytes);
  }
  const data = Buffer.concat(chunks); if (data.length !== expectedBytes || data[0] !== 1 || data[1] !== 66 || (data[4] & 3) !== 3) throw Error("AVC_CONFIG_UNSUPPORTED");
  let position = 6; const sps = data[5] & 31;
  const readParameters = (count: number, nalType: number) => {
    if (!count) throw Error("AVC_CONFIG_PARAMETERS_MISSING");
    for (let i = 0; i < count; i++) {
      if (position + 2 > data.length) throw Error("AVC_CONFIG_PARAMETERS_INVALID");
      const size = data.readUInt16BE(position); position += 2;
      if (!size || position + size > data.length || (data[position] & 31) !== nalType) throw Error("AVC_CONFIG_PARAMETERS_INVALID");
      position += size;
    }
  };
  readParameters(sps, 7); if (position >= data.length) throw Error("AVC_CONFIG_PARAMETERS_MISSING");
  readParameters(data[position++], 8); if (position !== data.length) throw Error("AVC_CONFIG_EXTRA_DATA_UNSUPPORTED");
  return { sha256: createHash("sha256").update(data).digest("hex"), bytes: data.length, profileIdc: 66, nalLengthBytes: 4 as const };
}
export interface PacketByteSourceV1 { bytes: number; chunk(position: number, length: number): Promise<Buffer> }
/** One cache, at most1MiB, reused across packets and reads. No duration-sized index. */
export function packetByteSourceV1(handle: FileHandle, bytes: number): PacketByteSourceV1 {
  if (!Number.isSafeInteger(bytes) || bytes < 1) throw Error("PACKET_SOURCE_SIZE_INVALID");
  const buffer = Buffer.allocUnsafe(1024 ** 2); let base = -1, filled = 0;
  return { bytes, async chunk(position, length) {
    assertRenderActive();
    if (!Number.isSafeInteger(position) || !Number.isSafeInteger(length) || position < 0 || length < 1 || position + length > bytes) throw Error("PACKET_SOURCE_RANGE_INVALID");
    if (position < base || position >= base + filled) {
      base = Math.floor(position / buffer.length) * buffer.length; filled = 0;
      const expected = Math.min(buffer.length, bytes - base);
      while (filled < expected) {
        const read = await handle.read(buffer, filled, expected - filled, base + filled);
        if (!read.bytesRead) throw Error("PACKET_SOURCE_ENDED_EARLY"); filled += read.bytesRead; assertRenderActive();
      }
    }
    return buffer.subarray(position - base, position - base + Math.min(length, filled - (position - base)));
  } };
}
/** Parse length-prefixed NAL headers while hashing the same bytes; no packet-sized buffer. */
export async function witnessAvcPacketV1(packet: SourcePacketV1, source: PacketByteSourceV1) {
  if (packet.pos + packet.size > source.bytes) throw Error("PACKET_SOURCE_RANGE_INVALID");
  const digest = createHash("sha256"), prefix = Buffer.allocUnsafe(5); let read = 0, prefixBytes = 0, remaining = 0, nals = 0, idr = 0, nonIdr = 0;
  while (read < packet.size) {
    assertRenderActive(); const chunk = await source.chunk(packet.pos + read, packet.size - read);
    if (!chunk.length || chunk.length > packet.size - read) throw Error("PACKET_SOURCE_ENDED_EARLY");
    digest.update(chunk); let offset = 0;
    while (offset < chunk.length) {
      if (remaining) { const skip = Math.min(remaining, chunk.length - offset); remaining -= skip; offset += skip; continue; }
      const take = Math.min(5 - prefixBytes, chunk.length - offset); chunk.copy(prefix, prefixBytes, offset, offset + take); prefixBytes += take; offset += take;
      if (prefixBytes !== 5) continue;
      const size = prefix.readUInt32BE(0), type = prefix[4] & 31, available = packet.size - (read + offset - 1);
      if (!size || size > available || (prefix[4] & 128) || ++nals > 16384) throw Error("AVC_PACKET_NAL_INVALID");
      if (![1, 5, 6, 9, 12].includes(type)) throw Error("AVC_INBAND_CONFIG_OR_NAL_UNSUPPORTED");
      if (type === 5) idr++; if (type === 1) nonIdr++;
      remaining = size - 1; prefixBytes = 0;
    }
    read += chunk.length;
  }
  if (remaining || prefixBytes || (!idr && !nonIdr) || (idr && nonIdr)) throw Error("AVC_PACKET_PICTURE_INVALID");
  return { payloadSha256: digest.digest("hex"), idr: idr > 0, nalCount: nals, bytes: read };
}
export interface PacketTimebaseV1 { numerator: number; denominator: number }
export function packetTimeKeyV1(ticks: number, timebase: PacketTimebaseV1) {
  if (!Number.isSafeInteger(ticks) || ![timebase.numerator, timebase.denominator].every(v => Number.isSafeInteger(v) && v > 0)) throw Error("PACKET_TIME_UNSAFE");
  let numerator = BigInt(ticks) * BigInt(timebase.numerator), denominator = BigInt(timebase.denominator), a = numerator < 0n ? -numerator : numerator, b = denominator;
  while (b) { const remainder = a % b; a = b; b = remainder; }
  numerator /= a; denominator /= a; return `${numerator}/${denominator}`;
}
/** Constant-state witness of one exact no-reorder video window. */
export function exactPacketWindowV1(start: number, end: number, timebase: PacketTimebaseV1) {
  if (![start, end].every(Number.isSafeInteger) || start < 0 || end <= start) throw Error("PACKET_WINDOW_INVALID");
  const digest = createHash("sha256"); let previousEnd = 0, total = 0, retained = 0, started = false;
  return { accept(packet: SourcePacketV1, witness: Awaited<ReturnType<typeof witnessAvcPacketV1>>) {
    if (packet.pts !== packet.dts || packet.pts !== previousEnd || !Number.isSafeInteger(packet.pts + packet.duration)) throw Error("PACKET_TIMELINE_GAP_OR_REORDER");
    previousEnd = packet.pts + packet.duration; total++; if (!Number.isSafeInteger(total)) throw Error("PACKET_COUNT_UNSAFE");
    if (packet.pts < start || packet.pts >= end) return;
    if (!started) { if (packet.pts !== start || !packet.key || !witness.idr) throw Error("PACKET_START_NOT_EXACT_IDR"); started = true; }
    if (previousEnd > end) throw Error("PACKET_END_NOT_EXACT_FRAME");
    const clock = [packetTimeKeyV1(packet.pts - start, timebase), packetTimeKeyV1(packet.dts - start, timebase), packetTimeKeyV1(packet.duration, timebase), packet.size].join(",");
    digest.update(clock + "\n"); digest.update(witness.payloadSha256 + "\n"); retained++;
  }, finish() {
    if (!started || !retained || previousEnd < end) throw Error("PACKET_WINDOW_SOURCE_EOF");
    return { retainedPackets: retained, sourcePackets: total, payloadAndTimelineSha256: digest.digest("hex"), startTicks: start, endTicks: end, duration: packetTimeKeyV1(end - start, timebase) };
  } };
}
