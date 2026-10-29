import { createHash } from "node:crypto";
import type { PacketByteSourceV1 } from "./sourcePacketV1";
import { assertRenderActive } from "./renderLifetime";

export interface AacPacketV1 {
  pts: number; dts: number; duration: number; pos: number; size: number; discard: boolean;
  skip?: { samples: number; padding: number; skipReason: number; discardReason: number };
}
const prefix = "side_datum/skip_samples:";
const integer = (v: string) => {
  if (!/^-?(0|[1-9]\d*)$/.test(v) || !Number.isSafeInteger(Number(v))) throw Error("AAC_PACKET_INTEGER_UNKNOWN");
  return Number(v);
};
/** Pinned ffprobe8.1 compact fields, including negative preroll and Skip Samples metadata. */
export function parseAacPacketV1(line: string): AacPacketV1 {
  if (Buffer.byteLength(line) > 4096) throw Error("AAC_PACKET_LINE_LIMIT");
  const keys = ["pts", "dts", "duration", "pos", "size", "flags"], side = ["side_data_type", "skip_samples", "discard_padding", "skip_reason", "discard_reason"];
  const allowed = new Set([...keys, ...side.map(k => prefix + k)]), fields: Record<string, string> = Object.create(null);
  for (const item of line.replace(/\r$/, "").split("|")) {
    const at = item.indexOf("="), name = item.slice(0, at), value = item.slice(at + 1);
    if (at < 1 || !allowed.has(name) || Object.hasOwn(fields, name) || !value) throw Error("AAC_PACKET_FIELDS_UNKNOWN");
    fields[name] = value;
  }
  if (keys.some(k => !Object.hasOwn(fields, k)) || !/^[KD_]+$/.test(fields.flags) || !fields.flags.includes("K")) throw Error("AAC_PACKET_FIELDS_UNKNOWN");
  const packet: AacPacketV1 = { pts: integer(fields.pts), dts: integer(fields.dts), duration: integer(fields.duration),
    pos: integer(fields.pos), size: integer(fields.size), discard: fields.flags.includes("D") };
  if (packet.pos < 0 || packet.size < 1 || packet.size > 8192 || !Number.isSafeInteger(packet.pos + packet.size)) throw Error("AAC_PACKET_RANGE_UNSUPPORTED");
  if (side.some(k => Object.hasOwn(fields, prefix + k))) {
    if (side.some(k => !Object.hasOwn(fields, prefix + k)) || fields[prefix + "side_data_type"] !== "Skip Samples") throw Error("AAC_PACKET_SIDE_DATA_UNKNOWN");
    packet.skip = { samples: integer(fields[prefix + "skip_samples"]), padding: integer(fields[prefix + "discard_padding"]),
      skipReason: integer(fields[prefix + "skip_reason"]), discardReason: integer(fields[prefix + "discard_reason"]) };
    if (Object.values(packet.skip).some(v => v < 0)) throw Error("AAC_PACKET_SIDE_DATA_UNKNOWN");
  }
  return packet;
}
function validate(packet: AacPacketV1, previousEnd: number | undefined, allowTerminalShortDuration = false) {
  if (![packet.pts, packet.dts, packet.duration, packet.pos, packet.size].every(Number.isSafeInteger)
    || packet.duration < 1 || packet.duration > 1024 || (!allowTerminalShortDuration && packet.duration !== 1024) || packet.pts % 1024 || packet.dts !== packet.pts
    || packet.pos < 0 || packet.size < 1 || packet.size > 8192 || !Number.isSafeInteger(packet.pos + packet.size)
    || !Number.isSafeInteger(packet.pts + packet.duration) || packet.discard !== (packet.pts < 0)) throw Error("AAC_PACKET_SHAPE_UNSUPPORTED");
  if (previousEnd !== undefined && packet.pts !== previousEnd) throw Error("AAC_PACKET_GAP_OR_REORDER");
  if (packet.skip && (!Number.isSafeInteger(packet.skip.samples) || packet.skip.samples < 0 || packet.skip.padding !== 0
    || packet.skip.skipReason !== 0 || packet.skip.discardReason !== 0 || previousEnd !== undefined)) throw Error("AAC_PACKET_SKIP_OR_PADDING_UNSUPPORTED");
}
export async function aacPacketPayloadSha256V1(packet: AacPacketV1, source: PacketByteSourceV1) {
  if (packet.pos + packet.size > source.bytes) throw Error("AAC_PACKET_SOURCE_RANGE_INVALID");
  const digest = createHash("sha256"); let read = 0;
  while (read < packet.size) {
    assertRenderActive(); const chunk = await source.chunk(packet.pos + read, packet.size - read);
    if (!chunk.length || chunk.length > packet.size - read) throw Error("AAC_PACKET_SOURCE_ENDED_EARLY");
    digest.update(chunk); read += chunk.length;
  }
  return digest.digest("hex");
}
function add(digest: ReturnType<typeof createHash>, packet: AacPacketV1, start: number, payload: string) {
  if (!/^[a-f0-9]{64}$/.test(payload)) throw Error("AAC_PACKET_PAYLOAD_WITNESS_MISSING");
  digest.update(`${packet.pts - start},${packet.duration},${packet.size}\n`); digest.update(payload + "\n");
}
/** Output raw AAC extent includes decoder preroll; the presentation interval remains [0,N). */
export function aacOutputPacketWitnessV1(samples: number, maxPrerollSamples: number) {
  if (![samples, maxPrerollSamples].every(v => Number.isSafeInteger(v) && v > 0) || samples % 1024) throw Error("AAC_PACKET_WINDOW_INVALID");
  const digest = createHash("sha256"); let first: number | undefined, end: number | undefined, packets = 0, payloadBytes = 0;
  return { accept(packet: AacPacketV1, payloadSha256: string) {
    validate(packet, end);
    if (first === undefined) {
      first = packet.pts;
      if (first > 0 || -first > maxPrerollSamples) throw Error("AAC_PACKET_PREROLL_LIMIT_OR_SHIFT");
      if ((packet.skip?.samples ?? 0) !== -first) throw Error("AAC_PACKET_SKIP_DOES_NOT_MATCH_PREROLL");
    }
    end = packet.pts + packet.duration; if (end > samples) throw Error("AAC_PACKET_EXTRA_PRESENTATION_SAMPLES");
    add(digest, packet, first, payloadSha256); packets++; payloadBytes += packet.size;
    if (!Number.isSafeInteger(packets) || !Number.isSafeInteger(payloadBytes)) throw Error("AAC_PACKET_COUNT_UNSAFE");
  }, finish() {
    if (first === undefined || end !== samples || !packets) throw Error("AAC_PACKET_OUTPUT_EOF");
    return { rawStartSample: first, rawEndSample: end, packets, payloadBytes, prerollSamples: -first, prerollPackets: -first / 1024,
      presentationSamples: samples, skipSamples: -first, discardPadding: 0, payloadAndRelativeTimelineSha256: digest.digest("hex") };
  } };
}
/** Source metadata is streamed from origin; only selected raw payloads are read and hashed. */
export function aacSourcePacketWindowV1(start: number, end: number) {
  if (![start, end].every(Number.isSafeInteger) || start < -1024 || end <= Math.max(start, 0) || start % 1024 || end % 1024) throw Error("AAC_PACKET_WINDOW_INVALID");
  const digest = createHash("sha256"); let previousEnd: number | undefined, retained = 0, total = 0, payloadBytes = 0, selectedEnd: number | undefined, terminalShortDuration = 0;
  return { wantsPayload(packet: AacPacketV1) { return packet.pts >= start && packet.pts < end; }, accept(packet: AacPacketV1, payloadSha256?: string) {
    if (terminalShortDuration) throw Error("AAC_PACKET_AFTER_TERMINAL_SHORT_DURATION");
    // MP4 may bound only its final source packet to a partial presentation frame.
    // This is allowed outside the copied window; every retained/output duration stays1024.
    validate(packet, previousEnd, packet.pts >= end);
    if (packet.duration !== 1024) terminalShortDuration = packet.duration;
    if (previousEnd === undefined && (packet.pts > 0 || packet.pts < -1024 || (packet.skip?.samples ?? 0) !== -packet.pts)) throw Error("AAC_PACKET_SOURCE_ORIGIN_UNKNOWN");
    previousEnd = packet.pts + packet.duration; total++;
    if (!Number.isSafeInteger(total)) throw Error("AAC_PACKET_COUNT_UNSAFE");
    if (!this.wantsPayload(packet)) return;
    if (!retained && packet.pts !== start) throw Error("AAC_PACKET_SOURCE_WINDOW_START_MISSING");
    add(digest, packet, start, payloadSha256 ?? ""); retained++; payloadBytes += packet.size; selectedEnd = previousEnd;
    if (!Number.isSafeInteger(payloadBytes)) throw Error("AAC_PACKET_COUNT_UNSAFE");
  }, finish() {
    if (!retained || selectedEnd !== end || previousEnd === undefined || previousEnd < end) throw Error("AAC_PACKET_SOURCE_WINDOW_EOF");
    return { rawStartSample: start, rawEndSample: end, packets: retained, sourcePackets: total, payloadBytes, terminalSourcePartialDuration: terminalShortDuration,
      payloadAndRelativeTimelineSha256: digest.digest("hex") };
  } };
}
export function verifyCopiedAacPacketWindowV1(source: ReturnType<ReturnType<typeof aacSourcePacketWindowV1>["finish"]>,
  output: ReturnType<ReturnType<typeof aacOutputPacketWitnessV1>["finish"]>, requestedStartSample: number) {
  if (!Number.isSafeInteger(requestedStartSample) || requestedStartSample < 0 || source.rawStartSample !== requestedStartSample + output.rawStartSample
    || source.rawEndSample !== requestedStartSample + output.rawEndSample || source.packets !== output.packets || source.payloadBytes !== output.payloadBytes
    || source.payloadAndRelativeTimelineSha256 !== output.payloadAndRelativeTimelineSha256) throw Error("AAC_PACKET_PAYLOAD_OR_TIMELINE_CHANGED");
  return { rawPayloadAndTimelineExact: true, copiedPackets: output.packets, prerollPackets: output.prerollPackets, prerollSamples: output.prerollSamples,
    skipSamples: output.skipSamples, presentationSamples: output.presentationSamples, payloadBytes: output.payloadBytes,
    payloadAndRelativeTimelineSha256: output.payloadAndRelativeTimelineSha256, decodedSampleIdentityStillRequired: true, pnsAbsenceProven: false };
}
