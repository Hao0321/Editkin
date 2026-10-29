import { describe, expect, it } from "vitest";
import { mediaFrameRateSchema } from "./mediaFrameRate";
import { editorCommandSchema } from "./schema";
import { createDemoProject } from "./demo";
import { decodeProjectBytes, encodeProjectBytes } from "../application/projectCodec";
import { sourceFrameRateFromProbe } from "../render/sourceFrameRateProbe";

describe("optional measured source average frame rate", () => {
  it.each(["30/1", "30000/1001", "24000/1001", "1000/1", "12345/678"])("retains the exact %s rational instead of guessing project cadence", value => {
    const [numerator, denominator] = value.split("/").map(Number);
    expect(sourceFrameRateFromProbe(value)).toEqual({ numerator, denominator });
  });
  it("keeps absent, zero, malformed and implausible probes unknown", () => {
    for (const value of [undefined, null, "", "N/A", "0/0", "0/1", "30/0", "-1/1", "23.976", " 30/1", "30/1 ", "1001/1", "9007199254740992/1000", 30]) {
      expect(sourceFrameRateFromProbe(value)).toBeUndefined();
    }
  });
  it("does not add optional probe observations to old project bytes", () => {
    const project = createDemoProject(), parsedOld = editorCommandSchema.parse({ type: "import_asset", asset: project.assets[0] });
    expect(parsedOld).toEqual({ type: "import_asset", asset: project.assets[0] });
    expect(Object.hasOwn(decodeProjectBytes(encodeProjectBytes(project)).assets[0], "frameRate")).toBe(false);
    const original = encodeProjectBytes(project); sourceFrameRateFromProbe("12345/678");
    expect(encodeProjectBytes(project)).toEqual(original);
  });
  it("rejects unsafe measured rational metadata", () => {
    for (const value of [{ numerator: 0, denominator: 1 }, { numerator: 30, denominator: -1 }, { numerator: 30.1, denominator: 1 },
      { numerator: 1001, denominator: 1 }, { numerator: 30, denominator: 1, guessed: true }]) expect(mediaFrameRateSchema.safeParse(value).success).toBe(false);
  });
});
