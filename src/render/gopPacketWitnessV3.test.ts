import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { gopPacketWindowV3, verifyGopPacketCopyV3 } from "./gopPacketWitnessV3";
import type { GopSourcePacketV2 } from "./gopPacketWitnessV2";
const tb = { numerator: 1, denominator: 10 }, limits = { maxPrerollTicks: 100, maxPostrollTicks: 30, maxReorderTicks: 100, maxPendingPackets: 64, maxGopPackets: 8192 };
const packet = (pts: number, dts: number, key = false): GopSourcePacketV2 => ({ pts, dts, duration: 10, pos: 2 ** 32, size: 7, key, discard: false });
const witness = (p: GopSourcePacketV2, originalPts = p.pts) => ({ payloadSha256: createHash("sha256").update(String(originalPts)).digest("hex"), idr: p.key, nalCount: 1, bytes: 7 });
const order = [0, 30, 10, 20, 50, 40];
describe("bounded postroll GOP prefix", () => {
  it("keeps future reference for last B frame and verifies hidden postroll across timebases", () => {
    const source = gopPacketWindowV3(10, 30, tb, "source", limits), output = gopPacketWindowV3(0, 40, { numerator: 1, denominator: 20 }, "output", { ...limits, maxPostrollTicks: 60 });
    for (let i = 0; i < order.length; i++) {
      const p = packet(order[i], (i - 1) * 10, i === 0); source.accept(p, witness(p));
      if (i < 4) { const o = { ...p, pts: (p.pts - 10) * 2, dts: (p.dts - 10) * 2, duration: 20, discard: p.pts < 10 || p.pts >= 30 }; output.accept(o, witness(o, p.pts)); }
    }
    const s = source.finish(60), o = output.finish(40);
    expect(s).toMatchObject({ retainedPackets: 4, rawEndTicks: 40, postrollTicks: 10, presentationHeaderPatchRequired: true });
    expect(verifyGopPacketCopyV3(s, o)).toMatchObject({ copiedPackets: 4, rawGopPrefixAndPayloadExact: true, postrollTicks: 20 });
    expect(() => verifyGopPacketCopyV3(s, { ...o, payloadAndDecodeTimelineSha256: "0".repeat(64) })).toThrow("CHANGED");
    expect(() => verifyGopPacketCopyV3(s, { ...o, requestedDurationTime: "3/1" })).toThrow("CHANGED");
  });
  it("still chooses nearest preceding IDR and supports zero postroll", () => {
    const s = gopPacketWindowV3(70, 100, tb, "source", limits);
    for (let group = 0; group < 3; group++) for (let i = 0; i < order.length; i++) { const p = packet(group * 60 + order[i], group * 60 + (i - 1) * 10, i === 0); s.accept(p, witness(p)); }
    expect(s.finish(180)).toMatchObject({ rawStartTicks: 60, rawEndTicks: 100, retainedPackets: 4, prerollTicks: 10, postrollTicks: 0 });
  });
  it("refuses visible postroll or hidden presented frames, extra copied packets, and gaps", () => {
    const visible = gopPacketWindowV3(0, 30, tb, "output", limits); visible.accept(packet(0, -10, true), witness(packet(0, -10, true)));
    expect(() => visible.accept(packet(30, 0), witness(packet(30, 0)))).toThrow("DISCARD");
    const hidden = gopPacketWindowV3(0, 30, tb, "output", limits), first = { ...packet(0, -10, true), discard: true };
    expect(() => hidden.accept(first, witness(first))).toThrow("DISCARD");
    const extra = gopPacketWindowV3(0, 30, tb, "output", limits);
    for (let i = 0; i < 4; i++) { const p = { ...packet(order[i], (i - 1) * 10, i === 0), discard: order[i] >= 30 }; extra.accept(p, witness(p)); }
    expect(() => extra.accept(packet(50, 30), witness(packet(50, 30)))).toThrow("EXTRA");
    const gap = gopPacketWindowV3(0, 30, tb, "source", limits); gap.accept(packet(0, -10, true), witness(packet(0, -10, true))); gap.accept(packet(30, 0), witness(packet(30, 0)));
    expect(() => gap.finish(60)).toThrow("INCOMPLETE");
  });
  it("fails closed for mid-frame endpoint, postroll budget, fake IDR, and permanent failure", () => {
    const mid = gopPacketWindowV3(0, 25, tb, "source", limits);
    for (let i = 0; i < 3; i++) { const p = packet(order[i], (i - 1) * 10, i === 0); mid.accept(p, witness(p)); }
    expect(() => mid.accept(packet(20, 20), witness(packet(20, 20)))).toThrow("BOUNDARY");
    expect(() => mid.finish(60)).toThrow("BOUNDARY");
    const capped = gopPacketWindowV3(0, 30, tb, "source", { ...limits, maxPostrollTicks: 0 }); capped.accept(packet(0, -10, true), witness(packet(0, -10, true)));
    expect(() => capped.accept(packet(30, 0), witness(packet(30, 0)))).toThrow("POSTROLL_LIMIT");
    const fake = packet(0, -10, true); expect(() => gopPacketWindowV3(0, 30, tb, "source", limits).accept(fake, { ...witness(fake), idr: false })).toThrow("IDR");
  });
});
