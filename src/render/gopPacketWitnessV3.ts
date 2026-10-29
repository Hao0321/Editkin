import { createHash } from "node:crypto";
import { packetTimeKeyV1, type PacketTimebaseV1, type witnessAvcPacketV1 } from "./sourcePacketV1";
import type { GopSourcePacketV2, GopPacketLimitsV2 } from "./gopPacketWitnessV2";

export interface GopPacketLimitsV3 extends GopPacketLimitsV2 { maxPostrollTicks: number }

function coverage(anchor: number, limits: GopPacketLimitsV3) {
  let end = anchor, packets = 0, peak = 0;
  const pending = new Map<number, number>();
  return {
    accept(p: GopSourcePacketV2) {
      if (p.pts < end || pending.has(p.pts)) throw Error("GOP_PRESENTATION_DUPLICATE_OR_CROSS_ANCHOR");
      pending.set(p.pts, p.duration); peak = Math.max(peak, pending.size);
      if (peak > limits.maxPendingPackets || ++packets > limits.maxGopPackets) throw Error("GOP_REORDER_OR_PACKET_LIMIT");
      while (pending.has(end)) {
        const duration = pending.get(end)!; pending.delete(end); end += duration;
        if (!Number.isSafeInteger(end)) throw Error("GOP_PRESENTATION_TICKS_UNSAFE");
      }
    },
    finish(boundary: number) {
      if (pending.size || end !== boundary) throw Error("GOP_PRESENTATION_GAP_OR_INCOMPLETE_DEPENDENCY");
    },
    get end() { return end; }, get completePrefix() { return pending.size === 0; }, get peak() { return peak; },
  };
}

/** LV03: retain the shortest complete decode prefix including bounded future reference packets.
 * Raw identity alone does not admit the output: edit-list patch and decoded presentation proof are mandatory. */
export function gopPacketWindowV3(start: number, end: number, timebase: PacketTimebaseV1,
  mode: "source" | "output", limits: GopPacketLimitsV3) {
  if (![start, end, limits.maxPrerollTicks, limits.maxPostrollTicks, limits.maxReorderTicks, limits.maxPendingPackets, limits.maxGopPackets].every(Number.isSafeInteger)
    || start < 0 || end <= start || limits.maxPrerollTicks < 0 || limits.maxPostrollTicks < 0 || limits.maxReorderTicks < 1
    || limits.maxPendingPackets < 1 || limits.maxPendingPackets > 64 || limits.maxGopPackets < 1 || limits.maxGopPackets > 8192
    || !["source", "output"].includes(mode) || mode === "output" && start !== 0) throw Error("GOP_WINDOW_OR_LIMIT_INVALID");
  const tb = { ...timebase }, cap = { ...limits }; packetTimeKeyV1(0, tb);
  let cover: ReturnType<typeof coverage> | undefined, digest: ReturnType<typeof createHash> | undefined;
  let anchor: number | undefined, rawEnd: number | undefined, selected = 0, total = 0, peak = 0;
  let complete = false, startSeen = false, endSeen = false, lastDts: number | undefined, failure: unknown, finished = false;
  const guard = (run: () => void) => {
    if (failure !== undefined) throw failure;
    if (finished) throw Error("GOP_WITNESS_ALREADY_FINISHED");
    try { run(); } catch (e) { failure = e; throw e; }
  };
  return {
    accept(p: GopSourcePacketV2, w: Awaited<ReturnType<typeof witnessAvcPacketV1>>) {
      guard(() => {
        if (mode === "output" && complete) throw Error("GOP_EXTRA_PACKET_AFTER_COMPLETE_PREFIX");
        if (![p.pts, p.dts, p.duration, p.pos, p.size, p.pts + p.duration, p.pos + p.size, p.pts - p.dts].every(Number.isSafeInteger)
          || p.duration < 1 || p.pos < 0 || p.size < 1 || Math.abs(p.pts - p.dts) > cap.maxReorderTicks
          || lastDts !== undefined && p.dts <= lastDts) throw Error("GOP_PACKET_CLOCK_OR_RANGE_UNSUPPORTED");
        if (!/^[a-f0-9]{64}$/.test(w.payloadSha256) || w.bytes !== p.size || typeof w.idr !== "boolean" || p.key !== w.idr) throw Error("GOP_IDR_OR_PAYLOAD_WITNESS_MISMATCH");
        if (mode === "source" && (p.pts < 0 || p.discard)
          || mode === "output" && p.discard !== (p.pts < 0 || p.pts >= end)) throw Error("GOP_PACKET_PRESENTATION_DISCARD_UNKNOWN");
        lastDts = p.dts; if (!Number.isSafeInteger(++total)) throw Error("GOP_PACKET_COUNT_UNSAFE");
        if (w.idr) {
          cover?.finish(p.pts); peak = Math.max(peak, cover?.peak ?? 0);
          if (!cover && (mode === "source" ? p.pts !== 0 : p.pts > 0 || -p.pts > cap.maxPrerollTicks)) throw Error("GOP_SOURCE_ORIGIN_OR_PREROLL_UNKNOWN");
          cover = coverage(p.pts, cap);
          if (mode === "source" && p.pts <= start && !complete || mode === "output" && anchor === undefined) {
            anchor = p.pts; digest = createHash("sha256"); selected = 0; startSeen = false; endSeen = false;
          }
        } else if (!cover) throw Error("GOP_FIRST_PACKET_NOT_TRUE_IDR");
        cover!.accept(p); peak = Math.max(peak, cover!.peak);
        if (!complete) {
          if (anchor === undefined || !digest) throw Error("GOP_SELECTED_ANCHOR_MISSING");
          if (p.pts + p.duration - end > cap.maxPostrollTicks) throw Error("GOP_POSTROLL_LIMIT");
          digest.update([packetTimeKeyV1(p.pts - start, tb), packetTimeKeyV1(p.dts - start, tb), packetTimeKeyV1(p.duration, tb), p.size, p.key ? 1 : 0].join(",") + "\n");
          digest.update(w.payloadSha256 + "\n");
          if (!Number.isSafeInteger(++selected)) throw Error("GOP_PACKET_COUNT_UNSAFE");
          startSeen ||= p.pts === start; endSeen ||= p.pts + p.duration === end;
          if (cover!.end >= end && cover!.completePrefix) {
            if (!startSeen || !endSeen) throw Error("GOP_CUT_NOT_EXACT_PRESENTATION_BOUNDARY");
            if (start - anchor > cap.maxPrerollTicks) throw Error("GOP_PREROLL_LIMIT");
            if (cover!.end - end > cap.maxPostrollTicks) throw Error("GOP_POSTROLL_LIMIT");
            rawEnd = cover!.end; complete = true;
          }
        }
      });
    },
    finish(sourceEndTicks: number) {
      guard(() => {
        if (!Number.isSafeInteger(sourceEndTicks) || sourceEndTicks <= 0) throw Error("GOP_SOURCE_END_UNKNOWN");
        if (!complete || !selected || anchor === undefined || rawEnd === undefined || !digest) throw Error("GOP_SELECTED_DEPENDENCY_PREFIX_INCOMPLETE");
        if (mode === "output" && sourceEndTicks !== end) throw Error("GOP_OUTPUT_PRESENTATION_END_CHANGED");
        cover!.finish(mode === "source" ? sourceEndTicks : rawEnd);
      }); finished = true;
      return { rawStartTicks: anchor!, rawEndTicks: rawEnd!, requestedStartTicks: start, requestedEndTicks: end,
        retainedPackets: selected, sourcePackets: total, relativeRawStartTime: packetTimeKeyV1(anchor! - start, tb),
        relativeRawEndTime: packetTimeKeyV1(rawEnd! - start, tb), requestedDurationTime: packetTimeKeyV1(end - start, tb),
        prerollTicks: start - anchor!, postrollTicks: rawEnd! - end, maxPendingPacketsObserved: peak,
        payloadAndDecodeTimelineSha256: digest!.digest("hex"), rawPresentationCoverageComplete: true as const,
        decodedPresentationAndPixelIdentityStillRequired: true as const, presentationHeaderPatchRequired: rawEnd! > end };
    },
  };
}

export function verifyGopPacketCopyV3(source: ReturnType<ReturnType<typeof gopPacketWindowV3>["finish"]>,
  output: ReturnType<ReturnType<typeof gopPacketWindowV3>["finish"]>) {
  for (const w of [source, output]) {
    if (!w.rawPresentationCoverageComplete || !Number.isSafeInteger(w.retainedPackets) || w.retainedPackets < 1
      || !Number.isSafeInteger(w.sourcePackets) || w.sourcePackets < w.retainedPackets
      || !/^[a-f0-9]{64}$/.test(w.payloadAndDecodeTimelineSha256)
      || !/^(-?(0|[1-9]\d*))\/[1-9]\d*$/.test(w.relativeRawStartTime)
      || !/^([1-9]\d*)\/[1-9]\d*$/.test(w.relativeRawEndTime)
      || !/^([1-9]\d*)\/[1-9]\d*$/.test(w.requestedDurationTime)
      || !Number.isSafeInteger(w.postrollTicks) || w.postrollTicks < 0) throw Error("GOP_WITNESS_SHAPE_INVALID");
  }
  if (source.relativeRawStartTime !== output.relativeRawStartTime || source.relativeRawEndTime !== output.relativeRawEndTime
    || source.requestedDurationTime !== output.requestedDurationTime || source.retainedPackets !== output.retainedPackets
    || source.payloadAndDecodeTimelineSha256 !== output.payloadAndDecodeTimelineSha256) throw Error("GOP_COPIED_PAYLOAD_OR_DECODE_TIMELINE_CHANGED");
  return { rawGopPrefixAndPayloadExact: true, copiedPackets: output.retainedPackets, prerollTicks: output.prerollTicks,
    postrollTicks: output.postrollTicks, payloadAndDecodeTimelineSha256: output.payloadAndDecodeTimelineSha256,
    decodedPresentationAndPixelIdentityStillRequired: true, presentationHeaderPatchRequired: output.presentationHeaderPatchRequired };
}
