import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../motionLibrary/catalog";
import { generateAnyMotionFrame } from "../motionLibrary/frames";
import { resolveMotionLibraryParams } from "../motionLibrary/params";
import { MOTION_LIBRARY_ENGINE_VERSION } from "../motionLibrary/types";
import { IMPACT_HEADLINE_ITEM_IDS_V1, prepareImpactHeadlineHookV1 } from "./impactHeadlineHookV1";

function fixture(itemId = "T24") {
  const item = getMotionLibraryItem(itemId);
  if (item.kind !== "text") throw new Error("test fixture requires text");
  return {
    schema: "editkin.impact-headline-request/v1",
    itemId,
    params: { ...structuredClone(item.defaultParams), lines: ["Editkin", "動起來"], seed: 321, plate: "none" },
  };
}

describe("impact headline manual data hook", () => {
  it.each(IMPACT_HEADLINE_ITEM_IDS_V1)("%s forwards explicit input to the existing generator unchanged", id => {
    const input = fixture(id), hook = prepareImpactHeadlineHookV1(input), item = getMotionLibraryItem(id);
    if (item.kind !== "text") throw new Error("expected text");
    const direct = resolveMotionLibraryParams(item, input.params);
    expect(hook.motionLibrary).toEqual({ itemId: id, itemRevision: item.revision, engineVersion: MOTION_LIBRARY_ENGINE_VERSION, params: direct });
    for (const t of [0, 0.6, 1.3]) {
      expect(generateAnyMotionFrame(item, hook.motionLibrary.params, t, { width: 320, height: 180 }))
        .toEqual(generateAnyMotionFrame(item, direct, t, { width: 320, height: 180 }));
    }
  });

  it("returns pending manual metadata without executable authority", () => {
    const hook = prepareImpactHeadlineHookV1(fixture());
    expect(hook).toMatchObject({ moduleId: "graphic.impact_headline", artStatus: "pending", manualOnly: true, defaultEligible: false, vaDefaultEligible: false, executor: null, executionState: "waiting_motion_library_clip_commands" });
    const plain = JSON.parse(JSON.stringify(hook));
    for (const key of ["commands", "project", "projectPath", "cacheKey", "cachePath", "apply", "preparedPacket", "certified"]) expect(plain).not.toHaveProperty(key);
    expect(plain).toEqual(hook);
  });

  it("owns a deep frozen snapshot without freezing or rewriting the caller's object", () => {
    const input = fixture(), before = structuredClone(input), hook = prepareImpactHeadlineHookV1(input);
    expect(input).toEqual(before); expect(Object.isFrozen(input.params)).toBe(false);
    input.params.lines[0] = "changed"; input.params.palette.accent = "#000000";
    expect(hook.motionLibrary.params.lines).toEqual(before.params.lines);
    expect(hook.motionLibrary.params.palette).toEqual(before.params.palette);
    for (const value of [hook, hook.motionLibrary, hook.motionLibrary.params, hook.motionLibrary.params.palette, hook.motionLibrary.params.lines]) expect(Object.isFrozen(value)).toBe(true);
    expect(Reflect.set(hook.motionLibrary, "itemRevision", 999)).toBe(false);
    expect(() => hook.motionLibrary.params.lines.push("late mutation")).toThrow();
  });

  it.each(["T09", "T34", "T99", "X21", "B01", "t24"])("refuses unsupported or non-impact item %s without falling back", itemId => {
    expect(() => prepareImpactHeadlineHookV1({ ...fixture(), itemId })).toThrow();
  });

  it.each(["palette", "energy", "seed", "lines", "font", "durationSeconds", "plate"])("requires explicit %s instead of choosing artwork defaults", key => {
    const input = fixture(); Reflect.deleteProperty(input.params, key);
    expect(() => prepareImpactHeadlineHookV1(input)).toThrow();
  });

  it.each([
    { seed: -1 }, { seed: 2_147_483_648 }, { seed: Number.NaN },
    { durationSeconds: 0.1 }, { durationSeconds: 31 }, { durationSeconds: Infinity },
    { lines: [] }, { lines: [" "] }, { lines: ["line\nbreak"] }, { lines: ["x".repeat(49)] },
    { font: "unknown" }, { energy: "unknown" }, { plate: "transparent" },
    { depth: 10 }, { extrudeOffsets: 100 }, { geometry: { mesh: true } },
  ])("refuses invalid or invented parameter controls %j", patch => {
    const input = fixture(); expect(() => prepareImpactHeadlineHookV1({ ...input, params: { ...input.params, ...patch } })).toThrow();
  });

  it("refuses incomplete palettes and unknown top-level fields", () => {
    const input = fixture(); Reflect.deleteProperty(input.params.palette, "paper");
    expect(() => prepareImpactHeadlineHookV1(input)).toThrow();
    expect(() => prepareImpactHeadlineHookV1({ ...fixture(), certified: true })).toThrow();
    expect(() => prepareImpactHeadlineHookV1({ ...fixture(), schema: "editkin.template-invocation/v1" })).toThrow();
  });
});
