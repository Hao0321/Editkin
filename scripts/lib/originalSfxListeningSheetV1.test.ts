import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, readdir, mkdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeProceduralSfxPackV1 } from "../../src/application/proceduralSfxPackV1";
import { createOriginalSfxListeningSheetV1 as create, sfxWaveformBinsV1 as bins } from "./originalSfxListeningSheetV1";
let root: string, pack: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "editkin-sfx-listening-unit-")); pack = join(root, "pack");
  const pins = await Promise.all(["Catalogue", "Synth"].map(async k => { const path = `src/application/proceduralSfx${k}V1.ts`, b = await readFile(path); return { path, bytes: b.length, sha256: createHash("sha256").update(b).digest("hex") }; }));
  await writeProceduralSfxPackV1(pack, pins);
});
afterAll(async () => { await writeFile(join(root, "TEST-OWNER.json"), JSON.stringify({ producer: "originalSfxListeningSheetV1.test.ts", root, terminal: true }), { flag: "wx" }); console.log("SFX_LISTENING_OWNED_UNIT=" + root); });
describe("original SFX waveform listening artifact", () => {
  it("covers every sample exactly once including an uneven final bin and signed extrema", () => {
    const a = Int16Array.of(-32768, 32767, 7, -2, 0, 100, -101); expect(bins(a, 3)).toEqual([
      { startSample: 0, endSample: 2, min: -32768, max: 32767 }, { startSample: 2, endSample: 4, min: -2, max: 7 }, { startSample: 4, endSample: 7, min: -101, max: 100 }]);
    expect(bins(Int16Array.of(1), 64)).toEqual([{ startSample: 0, endSample: 1, min: 1, max: 1 }]);
  });
  it.each([0, 1, 257, 2.5, NaN])("rejects waveform bin budget %s", n => { expect(() => bins(Int16Array.of(1, 2), n)).toThrow("WAVEFORM_BUDGET"); });
  it("rejects unbounded or wrong PCM buffers", () => { expect(() => bins(new Int16Array(48_001))).toThrow(); expect(() => bins(new Float32Array(2) as any)).toThrow(); });
  it("creates one private offline40sound artifact without approving or changing the pack", async () => {
    const before = await readFile(join(pack, "MANIFEST.json")), out = join(root, "sheet"), result = await create(pack, out);
    expect(result.sounds).toBe(40); expect(result.files).toHaveLength(3); expect(result.qualityApprovalGranted).toBe(false);
    expect((await readdir(out)).sort()).toEqual(["EMPTY_PREFERENCES.json", "SOURCE_BINDING.json", "index.html"]);
    const html = await readFile(join(out, "index.html"), "utf8"); expect(html.match(/<article data-sound-id=/g)).toHaveLength(40);
    expect(html).toContain("connect-src 'none'"); expect(html).not.toContain(root); expect(html).not.toContain(process.cwd());
    const empty = JSON.parse(await readFile(join(out, "EMPTY_PREFERENCES.json"), "utf8")); expect(empty.decisions).toEqual([]); expect(empty.defaultEnabled).toBe(false);
    expect(await readFile(join(pack, "MANIFEST.json"))).toEqual(before);
  }, 20000);
  it("refuses an existing output before source work and never overwrites it", async () => {
    const out = join(root, "existing"); await mkdir(out); await writeFile(join(out, "preserved.txt"), "preserved");
    await expect(create("not-a-pack", out)).rejects.toThrow("OUTPUT_EXISTS"); expect(await readFile(join(out, "preserved.txt"), "utf8")).toBe("preserved");
  });
  it("refuses a cancelled owner and invalid output budget without output", async () => {
    const owner = new AbortController(); owner.abort(); const out = join(root, "cancelled");
    await expect(create(pack, out, { signal: owner.signal })).rejects.toThrow(); await expect(access(out)).rejects.toThrow();
    await expect(create(pack, out, { maximumOutputBytes: 0 })).rejects.toThrow("OUTPUT_BUDGET");
  });
  it("refuses substituted physical original WAV bytes and retains the existing source", async () => {
    const path = join(pack, "whoosh-01.wav"), original = await readFile(path), altered = Buffer.from(original); altered[48] ^= 1;
    try { await writeFile(path, altered); await expect(create(pack, join(root, "bad-source"))).rejects.toThrow("ORIGINAL_CONTENT_MISMATCH"); }
    finally { await writeFile(path, original); }
    expect(await readFile(path)).toEqual(original);
  });
});
