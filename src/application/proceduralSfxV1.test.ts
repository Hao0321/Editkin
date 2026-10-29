import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PROCEDURAL_SFX_CATALOGUE_V1 as catalogue, PROCEDURAL_SFX_RATE_V1, proceduralSfxRecipeV1 } from "./proceduralSfxCatalogueV1";
import { encodeProceduralSfxWavV1, synthesizeProceduralSfxV1 } from "./proceduralSfxSynthV1";
import { compileProceduralSfxHitPlanV1, compileProceduralSfxHookPlanV1, mixProceduralSfxChunkV1, proceduralSfxDuckGainV1 } from "./proceduralSfxHitPlanV1";
import { CORE_EDITORIAL_SFX } from "./coreSfx";

const duck = { floor: .5, attackSamples: 960, releaseSamples: 8640 };
const digest = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const hit = { frame: 30, kind: "tick" as const, variant: 1, gain: .5 };
describe("original procedural SFX candidates", () => {
  it("retains the original core four and keeps 40 independent candidates private/opt-in", () => {
    expect(CORE_EDITORIAL_SFX.map(s => s.assetId)).toEqual(["sfx:editkin-whoosh-01", "sfx:editkin-impact-01", "sfx:editkin-countdown-01", "sfx:editkin-reveal-01"]);
    expect(catalogue).toHaveLength(40);
    expect(new Set(catalogue.map(r => r.id)).size).toBe(40);
    expect(catalogue.every(r => r.distributionScope === "private-owner-only" && !r.defaultEnabled && r.certification === "AUDIO_PENDING_HAO_CLAUDE")).toBe(true);
  });
  it("independently scans all 40 RIFF files for sample clock, peak, silence edges, DC, duration and distinct reproducible bytes", () => {
    const hashes = new Set<string>();
    for (const r of catalogue) {
      const wav = encodeProceduralSfxWavV1(synthesizeProceduralSfxV1(r.id)), view = new DataView(wav.buffer);
      expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe("RIFF");
      expect(new TextDecoder().decode(wav.subarray(8, 12))).toBe("WAVE");
      expect(view.getUint32(4, true)).toBe(wav.length - 8);
      expect(view.getUint16(20, true)).toBe(1);
      expect(view.getUint16(22, true)).toBe(1);
      expect(view.getUint32(24, true)).toBe(48_000);
      expect(view.getUint16(34, true)).toBe(16);
      expect(view.getUint32(40, true)).toBe(r.durationSamples * 2);
      let peak = 0, sum = 0, squares = 0;
      for (let i = 44; i < wav.length; i += 2) { const s = view.getInt16(i, true); peak = Math.max(peak, Math.abs(s)); sum += s; squares += s * s; }
      expect(peak / 32768).toBeLessThan(.5012);
      expect(peak / 32768).toBeGreaterThan(.50);
      expect(Math.abs(sum / r.durationSamples / 32768)).toBeLessThan(.02);
      expect(squares).toBeGreaterThan(0);
      expect(view.getInt16(44, true)).toBe(0);
      expect(view.getInt16(wav.length - 2, true)).toBe(0);
      expect(r.durationSamples).toBeLessThanOrEqual(PROCEDURAL_SFX_RATE_V1);
      const hash = digest(wav); expect(digest(encodeProceduralSfxWavV1(synthesizeProceduralSfxV1(r.id)))).toBe(hash); hashes.add(hash);
    }
    expect(hashes.size).toBe(40);
  });
  it("rejects unknown IDs and unbounded PCM", () => {
    for (const id of ["../tick", "sfx:external", ""]) expect(() => proceduralSfxRecipeV1(id)).toThrow();
    expect(() => encodeProceduralSfxWavV1(new Int16Array(48_001))).toThrow("SFX_PCM_BUDGET");
  });
});
describe("frame-aligned SFX hit/duck PCM", () => {
  it("maps explicit V2 montage hooks through a caller energy gate without mutating unresolved soundAsset fields", () => {
    const hooks = [{ frame: 15, energy: .8, nominalTimeSeconds: .5, soundAsset: null }, { frame: 45, energy: .1, nominalTimeSeconds: 1.5, soundAsset: null }], before = JSON.stringify(hooks);
    const plan = compileProceduralSfxHookPlanV1(30, 90, hooks, { kind: "impact", variant: 2, gain: .5, minimumEnergy: .5 }, duck);
    expect(plan.hits.map(h => h.frame)).toEqual([15]);
    expect(plan.hits[0].assetId).toBe("sfx:editkin-procedural-v1-impact-02");
    expect(JSON.stringify(hooks)).toBe(before);
  });
  it("rejects fabricated, duplicate and misaligned hook evidence, including below-threshold hooks", () => {
    const selection = { kind: "tick" as const, variant: 1, gain: .5, minimumEnergy: .5 };
    for (const hooks of [[{ frame: 15, energy: NaN }], [{ frame: 15, energy: .1, nominalTimeSeconds: 2 }], [{ frame: 15, energy: .8 }, { frame: 15, energy: .8 }]]) {
      expect(() => compileProceduralSfxHookPlanV1(30, 90, hooks, selection, duck)).toThrow();
    }
    expect(() => compileProceduralSfxHookPlanV1(30, 90, [], { ...selection, variant: 6 }, duck)).toThrow();
  });
  it("keeps 20-hour sample clocks above signed 32-bit range valid with a bounded PCM chunk", () => {
    const frame = 20 * 3600 * 30, plan = compileProceduralSfxHitPlanV1(30, 24 * 3600 * 30, [{ ...hit, frame }], duck), h = plan.hits[0];
    expect(h.startSample).toBe(3_456_000_000);
    const buffer = synthesizeProceduralSfxV1(h.assetId), out = mixProceduralSfxChunkV1(plan, new Float32Array(512), h.startSample, new Map([[h.assetId, buffer]]));
    expect(out[200]).toBeCloseTo(buffer[200] / 32768 * .5, 6);
    expect(out.length).toBe(512);
  });
  it("uses actual frame clocks at integer and fractional fps; requests are not mutated", () => {
    for (const fps of [24, 25, 30, 60, 30000 / 1001, 24000 / 1001]) {
      const requests = [hit], before = JSON.stringify(requests), plan = compileProceduralSfxHitPlanV1(fps, 240, requests, duck);
      expect(Math.abs(plan.hits[0].startSample / 48_000 * fps - hit.frame)).toBeLessThanOrEqual(.5);
      expect(JSON.stringify(requests)).toBe(before); expect(Object.isFrozen(plan.hits[0])).toBe(true);
    }
  });
  it("checks independent envelope values and overlapping hits never attenuate below the floor", () => {
    const plan = compileProceduralSfxHitPlanV1(30, 180, [hit, { ...hit, frame: 31 }], duck), start = plan.hits[0].startSample;
    expect(proceduralSfxDuckGainV1(plan, start - 960)).toBe(1);
    expect(proceduralSfxDuckGainV1(plan, start - 480)).toBe(.75);
    expect(proceduralSfxDuckGainV1(plan, start)).toBe(.5);
    const end = Math.max(...plan.hits.map(h => h.endSample));
    expect(proceduralSfxDuckGainV1(plan, end + 4320)).toBe(.75);
    expect(proceduralSfxDuckGainV1(plan, end + 8640)).toBe(1);
    for (let n = start - 960; n < end + 8640; n += 97) expect(proceduralSfxDuckGainV1(plan, n)).toBeGreaterThanOrEqual(.5);
  });
  it("mixes actual original PCM at the exact hit sample across chunk boundaries without changing music", () => {
    const plan = compileProceduralSfxHitPlanV1(30, 180, [hit], duck), h = plan.hits[0], sound = synthesizeProceduralSfxV1(h.assetId), sounds = new Map([[h.assetId, sound]]);
    const music = new Float32Array(48_000).fill(.2), saved = music.slice(), start = 24_000;
    const mixed = mixProceduralSfxChunkV1(plan, music, start, sounds);
    expect(music).toEqual(saved);
    expect(mixed[0]).toBeCloseTo(.2, 6);
    expect(mixed[h.startSample - start]).toBeCloseTo(.1, 6);
    expect(mixed[h.startSample - start + 200]).toBeCloseTo(.1 + sound[200] / 32768 * .5, 6);
    const splitA = mixProceduralSfxChunkV1(plan, music.subarray(0, 24001), start, sounds), splitB = mixProceduralSfxChunkV1(plan, music.subarray(24001), start + 24001, sounds);
    expect([...splitA, ...splitB]).toEqual([...mixed]);
  });
  it("rejects invalid clocks/tails/roles/budgets instead of trimming or making default choices", () => {
    for (const request of [{ ...hit, frame: NaN }, { ...hit, frame: -1 }, { ...hit, frame: 179 }, { ...hit, gain: 2 }, { ...hit, variant: 6 }]) {
      expect(() => compileProceduralSfxHitPlanV1(30, 180, [request], duck)).toThrow();
    }
    expect(() => compileProceduralSfxHitPlanV1(30, 180, Array(257).fill(hit), duck)).toThrow();
    expect(() => compileProceduralSfxHitPlanV1(0, 180, [hit], duck)).toThrow();
  });
  it("rejects forged plans, wrong sound bytes, nonfinite music and inadequate headroom", () => {
    const plan = compileProceduralSfxHitPlanV1(30, 180, [hit], duck), h = plan.hits[0], sound = synthesizeProceduralSfxV1(h.assetId), sounds = new Map([[h.assetId, sound]]);
    expect(() => proceduralSfxDuckGainV1(JSON.parse(JSON.stringify(plan)), 0)).toThrow("SFX_COMPILED_PLAN_REQUIRED");
    expect(() => mixProceduralSfxChunkV1(plan, new Float32Array([NaN]), 0, sounds)).toThrow("SFX_MUSIC_PCM_INVALID");
    sound[200] += 1;
    expect(() => mixProceduralSfxChunkV1(plan, new Float32Array(2), 0, sounds)).toThrow("SFX_PCM_IDENTITY_REQUIRED");
    const hot = compileProceduralSfxHitPlanV1(30, 180, [{ ...hit, gain: 1 }], { ...duck, floor: 1 });
    expect(() => mixProceduralSfxChunkV1(hot, new Float32Array(48_000).fill(1), 24_000, new Map([[h.assetId, synthesizeProceduralSfxV1(h.assetId)]]))).toThrow("SFX_MIX_HEADROOM_REQUIRED");
  });
});
