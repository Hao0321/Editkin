import { describe, expect, it } from "vitest";
import { COMPOSITION_TEMPLATES } from "../modules/templateCatalog";
import { SHORTS_HYPE_V2_SLOT_SKELETON } from "./shortsHypeSlotsV2";

describe("shorts hype v2 nonvisual slot skeleton", () => {
  it("preserves existing semantic slot IDs, order, placements and cardinalities", () => {
    const legacy = COMPOSITION_TEMPLATES.find(t => t.id === "shorts.hype")!;
    const project = ({ id, placement, min, max }: Pick<typeof legacy.slots[number], "id" | "placement" | "min" | "max">) => ({ id, placement, min, max });
    expect(SHORTS_HYPE_V2_SLOT_SKELETON.slots.map(project)).toEqual(legacy.slots.map(project));
    expect(SHORTS_HYPE_V2_SLOT_SKELETON.slots.map(s => s.id)).toEqual(["hook", "impact", "question", "reaction", "payoff"]);
  });

  it("only names the unbound manual headline hook for opening and payoff", () => {
    expect(SHORTS_HYPE_V2_SLOT_SKELETON.slots.filter(s => s.executorHook !== null).map(s => s.id)).toEqual(["hook", "payoff"]);
    expect(new Set(SHORTS_HYPE_V2_SLOT_SKELETON.slots.flatMap(s => s.executorHook ? [s.executorHook] : []))).toEqual(new Set(["graphic.impact_headline"]));
  });

  it("contains no shot count, generated copy, timings, recipe defaults or executable bindings", () => {
    expect(SHORTS_HYPE_V2_SLOT_SKELETON).toMatchObject({ schema: "editkin.shorts-hype-slots/v2", version: "2.0.0", state: "skeleton", artStatus: "pending", defaultEligible: false, vaDefaultEligible: false, executor: null });
    for (const key of ["name", "formats", "base", "pacing", "fills", "commands", "look", "sceneCount", "durationSeconds"]) expect(SHORTS_HYPE_V2_SLOT_SKELETON).not.toHaveProperty(key);
    for (const slot of SHORTS_HYPE_V2_SLOT_SKELETON.slots) for (const key of ["text", "options", "defaults", "params", "frames"]) expect(slot).not.toHaveProperty(key);
  });

  it("is deeply frozen and independent of the legacy mutable template data", () => {
    const legacy = COMPOSITION_TEMPLATES.find(t => t.id === "shorts.hype")!;
    const before = JSON.stringify(legacy), data = JSON.stringify(SHORTS_HYPE_V2_SLOT_SKELETON);
    expect(Object.isFrozen(SHORTS_HYPE_V2_SLOT_SKELETON)).toBe(true);
    expect(Object.isFrozen(SHORTS_HYPE_V2_SLOT_SKELETON.slots)).toBe(true);
    for (const slot of SHORTS_HYPE_V2_SLOT_SKELETON.slots) expect(Object.isFrozen(slot)).toBe(true);
    expect(Reflect.set(SHORTS_HYPE_V2_SLOT_SKELETON.slots[0], "max", 999)).toBe(false);
    const copy = JSON.parse(data); copy.slots[0].max = 999;
    expect(JSON.stringify(SHORTS_HYPE_V2_SLOT_SKELETON)).toBe(data); expect(JSON.stringify(legacy)).toBe(before);
    expect(legacy.slots[0]).not.toBe(SHORTS_HYPE_V2_SLOT_SKELETON.slots[0]);
  });

  it("keeps the sole live shorts.hype template at v1 with its existing options", () => {
    const matches = COMPOSITION_TEMPLATES.filter(t => t.id === SHORTS_HYPE_V2_SLOT_SKELETON.templateId);
    expect(matches).toHaveLength(1); expect(matches[0].version).toBe("1.0.0");
    expect(matches[0].slots[0].options.every(o => o.moduleId !== "graphic.impact_headline")).toBe(true);
    expect(COMPOSITION_TEMPLATES).not.toContain(SHORTS_HYPE_V2_SLOT_SKELETON);
  });
});
