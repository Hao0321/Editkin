import { expect, it } from "vitest";
import { shotGradeLocalRequestV1Schema } from "./shotGradeLocalContractV1";

const source = (clipId: string) => ({ clipId, samples: [{ id: "p", time: .2 }], regions: [] });
const request = () => ({ schema: "editkin.shot-grade-local-request/v1", expectedRevision: 0, mode: "shot_match",
  target: source("target"), reference: source("reference"), destination: { kind: "append", label: "對色" },
  roiBasis: "local-layer-raster-normalized", reason: "Explicit local reference" });
it("keeps optional empty marks visible rather than inventing skin/neutral semantics", () => {
  const parsed = shotGradeLocalRequestV1Schema.parse(request()); expect(parsed.target.regions).toEqual([]);
  expect(parsed).toMatchObject({ highBitDepth: false, maximumTimeMs: 20000, destination: { kind: "append", label: "對色" } });
});
it("accepts explicit per-sample declared regions and terminal replacement intent", () => {
  const value = { ...request(), target: { ...source("target"), regions: [{ sampleId: "p", role: "skin", x: 0, y: 0, width: .5, height: 1 }] } };
  const parsed = shotGradeLocalRequestV1Schema.parse({ ...value, destination: { kind: "replace", nodeId: "last", label: "平衡" } });
  expect(parsed.target.regions[0].role).toBe("skin"); expect(parsed.destination).toEqual({ kind: "replace", nodeId: "last", label: "平衡" });
});
it.each(["path", "assetId", "sourceSha256", "semanticReceiptSha256"])("does not accept caller-supplied source authority %s", key => {
  const value = request(); expect(() => shotGradeLocalRequestV1Schema.parse({ ...value, target: { ...value.target, [key]: "caller-value" } })).toThrow();
});
it.each([
  { name: "duplicate IDs", samples: [{ id: "p", time: .2 }, { id: "p", time: .4 }] },
  { name: "duplicate times", samples: [{ id: "p", time: .2 }, { id: "q", time: .2 }] },
  { name: "reversed times", samples: [{ id: "p", time: .4 }, { id: "q", time: .2 }] },
  { name: "invalid ID", samples: [{ id: "../p", time: .2 }] },
  { name: "negative time", samples: [{ id: "p", time: -1 }] },
  { name: "nonfinite time", samples: [{ id: "p", time: NaN }] },
  { name: "empty inventory", samples: [] },
])("refuses an ambiguous or invalid complete inventory: $name", ({ samples }) => {
  expect(Array.isArray(samples)).toBe(true);
  const value = request(); expect(() => shotGradeLocalRequestV1Schema.parse({ ...value, target: { ...value.target, samples } })).toThrow();
});
it("does not bind an ROI to an absent sampled frame", () => {
  const value = request(); expect(() => shotGradeLocalRequestV1Schema.parse({ ...value, target: { ...value.target,
    regions: [{ sampleId: "absent", role: "neutral", x: 0, y: 0, width: 1, height: 1 }] } })).toThrow(/REGION_SAMPLE/);
});
it("rejects a reference to the target itself", () => {
  const value = request(); expect(() => shotGradeLocalRequestV1Schema.parse({ ...value, reference: source("target") })).toThrow(/DISTINCT/);
});
it("keeps auto balance free of an invented reference clip", () => {
  const { reference, ...value } = request(); expect(shotGradeLocalRequestV1Schema.parse({ ...value, mode: "auto_balance" })).not.toHaveProperty("reference");
  expect(() => shotGradeLocalRequestV1Schema.parse({ ...value, mode: "auto_balance", reference })).toThrow();
});
it.each([0, -1, 60001, NaN, Infinity])("refuses invalid job budget %s", maximumTimeMs => {
  expect(() => shotGradeLocalRequestV1Schema.parse({ ...request(), maximumTimeMs })).toThrow();
});
it.each(["decoded-source-preview", "screen", "working_rgb_code"])("does not confuse ROI basis with %s", roiBasis => {
  expect(() => shotGradeLocalRequestV1Schema.parse({ ...request(), roiBasis })).toThrow();
});
