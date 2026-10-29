import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createSubjectOverlayFrameHashVerifierV1, subjectOverlayClockV1 } from "./subjectOverlayVerificationV1";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
function fixture() { const clock = subjectOverlayClockV1(24, 4, 5, 30), native = Array.from({ length: 5 }, (_, i) => sha(`native16-${i}`)), pixels = Array.from({ length: 30 }, (_, i) => sha(`rgba-${i}`));
  const text = "#hash: SHA256\n" + Array.from({ length: 30 }, (_, i) => `0, ${i}, ${i}, 1, 512, ${native[Math.floor(i / 6)]}\n1, ${i}, ${i}, 1, 2048, ${pixels[i]}\n`).join(""); return { clock, native, pixels, text }; }
describe("bounded two-stream native-floor and encoded-pixel conservation records", () => {
  it("handles fragmented/interleaved native16 and target pixels without losing a row", () => {
    const f = fixture(), v = createSubjectOverlayFrameHashVerifierV1(f.clock, f.native, 512, 2048), bytes = Buffer.from(f.text);
    for (let offset = 0; offset < bytes.length; offset += 17) v.write(bytes.subarray(offset, offset + 17)); const result = v.finish();
    expect(result.pixelDigests).toEqual(f.pixels); expect(result.mappedNativeFrames).toBe(30); expect(result.targetPixelFrames).toBe(30); expect(() => v.finish()).toThrow("CLOSED");
  });
  it.each(["floor", "size", "pts", "count", "header", "extra"])("rejects %s corruption with the same evaluator", mode => {
    const f = fixture(); let text = f.text;
    if (mode === "floor") text = text.replace(f.native[0], f.native[1]); if (mode === "size") text = text.replace(", 512,", ", 511,");
    if (mode === "pts") text = text.replace("0, 0, 0, 1", "0, 1, 1, 1"); if (mode === "count") text = text.slice(0, text.lastIndexOf("1, 29"));
    if (mode === "header") text = text.replace("SHA256", "MD5"); if (mode === "extra") text += `1,30,30,1,2048,${sha("extra")}\n`;
    const v = createSubjectOverlayFrameHashVerifierV1(f.clock, f.native, 512, 2048); expect(() => { v.write(Buffer.from(text)); v.finish(); }).toThrow();
  });
  it("keeps exact rational24-to30 NTSC native sampling and refuses uncovered duration", () => {
    expect(subjectOverlayClockV1(30000 / 1001, 24000 / 1001, 24, 30).frames).toBe(30);
    expect(() => subjectOverlayClockV1(24, 4, 5, 31)).toThrow("CLOCK"); expect(() => subjectOverlayClockV1(24, 4, 5, 28801)).toThrow("CLOCK");
  });
});
