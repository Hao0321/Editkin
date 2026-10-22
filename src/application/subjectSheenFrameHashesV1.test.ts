import { createHash } from "node:crypto";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { subjectSheenClockV1, subjectSheenSampleV1, expectedSubjectSheenFrameHashesV1, verifySubjectSheenFrameHashesV1 } from "./subjectSheenFrameHashesV1";
let root: string, path: string;
beforeAll(async () => { root = await mkdtemp(join(tmpdir(), "editkin-sheen16-clock-")); path = join(root, "alpha16.raw");
  await writeFile(path, Buffer.concat(Array.from({ length: 5 }, (_, i) => Buffer.alloc(512, i + 1)))); });
afterAll(async () => { if (root) { await writeFile(join(root, "TEST-OWNER.json"), JSON.stringify({ producer: "subjectSheenFrameHashesV1.test.ts", root, testsTerminal: true }), { flag: "wx" }); console.log(`SHEEN16_CLOCK_OWNED_FIXTURE=${root}`); } });
describe("exact existing alpha clock and bounded frame digests", () => {
  it("maps 4fps native samples to24fps with exact floor, including an offset interval", async () => {
    const clock = subjectSheenClockV1(24, 4, 5, 2, 28), expected = await expectedSubjectSheenFrameHashesV1(path, 512, clock, () => {}), bytes = await readFile(path);
    expect(expected.map(r => r.sourceSample)).toEqual(Array.from({ length: 28 }, (_, i) => Math.floor((i + 2) / 6)));
    for (const row of expected) expect(row.sha256).toBe(createHash("sha256").update(bytes.subarray(row.sourceSample * 512, (row.sourceSample + 1) * 512)).digest("hex"));
    const text = "#hash: SHA256\n" + expected.map(r => `0, ${r.frame}, ${r.frame}, 1, 512, ${r.sha256}`).join("\n");
    expect(verifySubjectSheenFrameHashesV1(text, expected, 512)).toHaveLength(28);
    expect(() => verifySubjectSheenFrameHashesV1(text.replace(expected[0].sha256, "0".repeat(64)), expected, 512)).toThrow("MISMATCH");
    expect(() => verifySubjectSheenFrameHashesV1(text + "\n0, 28, 28, 1, 512, " + "0".repeat(64), expected, 512)).toThrow("COUNT");
  });
  it("keeps the exact 24000/1001 to30000/1001 ratio without a floating-frame clock", () => {
    const c = subjectSheenClockV1(30000 / 1001, 24000 / 1001, 24, 0, 30);
    expect(Array.from({ length: 30 }, (_, i) => subjectSheenSampleV1(c, i))).toEqual(Array.from({ length: 30 }, (_, i) => Math.floor(i * 4 / 5)));
  });
  it.each([[24, 4, 5, 0, 31], [24, 4, 5, -1, 3], [24, 4, 5, 0, 2], [24, 4, 1441, 0, 3], [Infinity, 4, 5, 0, 3]])("refuses invalid source clock %j", (p, s, n, start, count) => {
    expect(() => subjectSheenClockV1(p, s, n, start, count)).toThrow();
  });
  it("refuses truncated/extra source bytes and closes a cancelled read", async () => {
    const c = subjectSheenClockV1(24, 4, 5, 0, 30), reason = Error("cancel-hash-read"); let calls = 0;
    await expect(expectedSubjectSheenFrameHashesV1(path, 512, c, () => { if (++calls === 5) throw reason; })).rejects.toBe(reason);
    await expect(expectedSubjectSheenFrameHashesV1(path, 513, c, () => {})).rejects.toThrow("SOURCE_BYTES");
    await expect(expectedSubjectSheenFrameHashesV1(path, 255, c, () => {})).rejects.toThrow("FRAME_BYTES");
    expect(() => subjectSheenSampleV1(c, 30)).toThrow("ORDER");
  });
});
