import { describe, expect, it } from "vitest";
import { REFERENCE_MOTION_DESIGN_THEMES, REFERENCE_MOTION_VIDEO_TYPES, referenceMotionDesignSystems, referenceMotionTemplateInputSchema,
  type ReferenceMotionDesignSystem } from "../motion/referenceMotionTemplates";
import { TEMPLATE_SHORT_CERTIFICATIONS, drawTemplateShortSpotCheck, type TemplateShortCertification } from "../motion/templateFamilyCertification";
import { TEMPLATE_SHORT_FAMILIES, TemplateShortBlockError, type TemplateShortCopy } from "./templateShortBrief";
import { TEMPLATE_SHORT_GENRES, selectTemplateShortFamily, toTemplateInput } from "./templateShortCatalog";

// T01's actual creator copy (live-r53b/011-template input) and T04's step copy.
const STRIKE: TemplateShortCopy = { hook: "來看蝙蝠", payoff: "其實是來看水簾", accent: "水簾", proof: "名字叫蝙蝠洞，但現在已經沒有蝙蝠",
  place: "桃園復興｜三民蝙蝠洞", tag: "天然大岩洞" };
const CONTEXT: TemplateShortCopy = { payoff: "越走越懸空", accent: "懸空", place: "桃園復興｜小烏來",
  points: [{ label: "先走樹林步道" }, { label: "站上和平橋", detail: "往下看瀑布" }, { label: "瀑布正上方" }] };
const SEMANTIC = `material:${"5".repeat(64)}:semantic:${"d".repeat(64)}`;
const context = (designSystem: ReferenceMotionDesignSystem) => ({ clipId: "clip-batcave", durationFrames: 330, designSystem,
  shortId: "ts-20261009-batcave-3f9a1c", semanticRef: SEMANTIC, factRefs: ["creator:notes/價目.md#06"], brandMark: "Hao0321 Studio",
  focus: { x: 0, y: 0.12, w: 1, h: 0.62 } });
const blocked = (run: () => unknown) => {
  try { run(); } catch (error) { if (error instanceof TemplateShortBlockError) return error; throw error; }
  throw new Error("expected a TemplateShortBlockError");
};

describe("template short catalog: genre table", () => {
  it("maps each genre to the create_project profile and the first theme of its video type", () => {
    expect(Object.keys(TEMPLATE_SHORT_GENRES).sort()).toEqual(Object.keys(REFERENCE_MOTION_VIDEO_TYPES).sort());
    expect(TEMPLATE_SHORT_GENRES.travel).toMatchObject({ profile: "travel", designSystem: "trip_pop_v1" });
    expect(TEMPLATE_SHORT_GENRES.food).toMatchObject({ profile: "food", designSystem: "trip_pop_v1" });
    expect(TEMPLATE_SHORT_GENRES.game).toMatchObject({ profile: "gaming", designSystem: "game_hud_v1" });
    for (const genre of ["teaching", "podcast", "unboxing", "product", "brand", "knowledge"] as const) {
      expect(TEMPLATE_SHORT_GENRES[genre]).toMatchObject({ profile: "auto", designSystem: REFERENCE_MOTION_VIDEO_TYPES[genre].styles[0] });
    }
  });
});

describe("template short catalog: adapter", () => {
  const cases = TEMPLATE_SHORT_FAMILIES.flatMap(family => referenceMotionDesignSystems.map(theme => [family, theme] as const));
  it.each(cases)("%s × %s passes referenceMotionTemplateInputSchema and never carries a textRegion", (family, theme) => {
    const input = toTemplateInput(family, family === "strike_reframe" ? STRIKE : CONTEXT, context(theme));
    const parsed = referenceMotionTemplateInputSchema.parse(input);
    expect(parsed).toMatchObject({ templateId: family, designSystem: theme, graphicCadence: "kinetic", intent: "shortform", startFrame: 0,
      style: REFERENCE_MOTION_DESIGN_THEMES[theme].defaultStyle, brandMark: "Hao0321 Studio" });
    expect("textRegion" in parsed).toBe(false);
    expect(parsed.evidenceRefs).toEqual([SEMANTIC, "creator:notes/價目.md#06", "creator:template-short-brief#ts-20261009-batcave-3f9a1c"]);
    expect(parsed.evidenceRefs.some(ref => ref.includes(":viewed-"))).toBe(false);
    // A design-theme input with a textRegion is rejected by the template schema itself (design §0.3 item 4).
    expect(referenceMotionTemplateInputSchema.safeParse({ ...input, textRegion: { x: 0, y: 0, width: 1, height: .2 } }).success).toBe(false);
  });

  it("maps T01's copy to the slots the r53b author used", () => {
    const input = toTemplateInput("strike_reframe", STRIKE, context("trip_pop_v1"));
    expect(input).toMatchObject({ title: "其實是來看水簾", accentText: "水簾", previousText: "來看蝙蝠", subtitle: "名字叫蝙蝠洞，但現在已經沒有蝙蝠",
      kicker: "桃園復興｜三民蝙蝠洞", tag: "天然大岩洞", focusRegion: { x: 0, y: 0.12, width: 1, height: 0.62 },
      purpose: "旅遊手帳：來看蝙蝠→其實是來看水簾" });
    expect(toTemplateInput("context_stack", CONTEXT, context("trip_pop_v1"))).toMatchObject({ title: "越走越懸空", kicker: "桃園復興｜小烏來",
      items: [{ label: "先走樹林步道" }, { label: "站上和平橋", detail: "往下看瀑布" }, { label: "瀑布正上方" }], purpose: "旅遊手帳：越走越懸空" });
  });
});

describe("template short catalog: family selection", () => {
  it("selects strike_reframe for a hook even though the travel scene list lacks it (design §0.3 item 3)", () => {
    expect(REFERENCE_MOTION_VIDEO_TYPES.travel.scenes).not.toContain("strike_reframe");
    expect(selectTemplateShortFamily({ copy: STRIKE }, "travel", [])).toEqual({ family: "strike_reframe", designSystem: "trip_pop_v1", statusCeiling: "REVIEW_REQUIRED" });
    expect(selectTemplateShortFamily({ copy: CONTEXT }, "food")).toMatchObject({ family: "context_stack", designSystem: "trip_pop_v1" });
  });

  it("blocks copy of neither shape, and copy that does not fit the chosen family", () => {
    expect(blocked(() => selectTemplateShortFamily({ copy: { payoff: "其實是來看水簾" } }, "travel"))).toMatchObject({ code: "BLOCK_BRIEF",
      detail: "v1 需要『原本以為→其實是』或 2–4 個重點" });
    expect(blocked(() => selectTemplateShortFamily({ copy: { ...STRIKE, points: CONTEXT.points } }, "travel")).field).toBe("copy.points");
    expect(blocked(() => selectTemplateShortFamily({ copy: STRIKE, family: "context_stack" }, "travel")).field).toBe("copy.hook");
  });

  it("is REVIEW_REQUIRED until the family × theme is certified, then READY at best", () => {
    // Wave 3 certified the two v1 families on the travel/food theme (ROADMAP 1.5); every other pair stays REVIEW_REQUIRED.
    expect(TEMPLATE_SHORT_CERTIFICATIONS.map(row => `${row.family}/${row.designSystem}`)).toEqual(["strike_reframe/trip_pop_v1", "context_stack/trip_pop_v1"]);
    expect(Object.isFrozen(TEMPLATE_SHORT_CERTIFICATIONS)).toBe(true);
    expect(selectTemplateShortFamily({ copy: STRIKE }, "travel")).toMatchObject({ family: "strike_reframe", designSystem: "trip_pop_v1", statusCeiling: "READY",
      certification: { certifiedBy: "claude", status: "certified" } });
    expect(selectTemplateShortFamily({ copy: CONTEXT }, "food").statusCeiling).toBe("READY");
    expect(selectTemplateShortFamily({ copy: STRIKE }, "game")).toMatchObject({ designSystem: "game_hud_v1", statusCeiling: "REVIEW_REQUIRED" });
    expect(selectTemplateShortFamily({ copy: STRIKE }, "teaching").statusCeiling).toBe("REVIEW_REQUIRED");
    const certified: TemplateShortCertification = { family: "strike_reframe", designSystem: "trip_pop_v1", status: "certified", certifiedBy: "claude",
      certifiedAt: "2026-10-10T00:00:00Z", evidence: { path: "evidence.json", sha256: "e".repeat(64) }, fixtureCompileSha256: "f".repeat(64) };
    expect(selectTemplateShortFamily({ copy: STRIKE }, "travel", [certified])).toEqual({ family: "strike_reframe", designSystem: "trip_pop_v1",
      certification: certified, statusCeiling: "READY" });
    expect(selectTemplateShortFamily({ copy: STRIKE }, "game", [certified]).statusCeiling).toBe("REVIEW_REQUIRED");
  });
});

describe("template short spot-check draw (Hao 2026-10-09)", () => {
  const pair = { family: "strike_reframe", designSystem: "trip_pop_v1" } as const;
  it("always reviews the first run of a family × theme, then draws about one run in five from the output bytes", () => {
    expect(drawTemplateShortSpotCheck({ ...pair, outputSha256: "1".repeat(64), priorRuns: [] })).toEqual({ drawn: true, reason: "first_run" });
    expect(drawTemplateShortSpotCheck({ ...pair, outputSha256: "1".repeat(64), priorRuns: [{ family: "context_stack", designSystem: "trip_pop_v1" }] }).reason).toBe("first_run");
    expect(drawTemplateShortSpotCheck({ ...pair, outputSha256: `0000000a${"0".repeat(56)}`, priorRuns: [pair] })).toEqual({ drawn: true, reason: "sampled" });
    expect(drawTemplateShortSpotCheck({ ...pair, outputSha256: `0000000b${"0".repeat(56)}`, priorRuns: [pair] })).toEqual({ drawn: false, reason: "not_drawn" });
    const drawn = Array.from({ length: 1000 }, (_, index) => drawTemplateShortSpotCheck({ ...pair, priorRuns: [pair],
      outputSha256: (index * 2654435761 >>> 0).toString(16).padStart(8, "0") + "0".repeat(56) }).drawn).filter(Boolean).length;
    expect(drawn).toBeGreaterThan(150); expect(drawn).toBeLessThan(250);
    expect(() => drawTemplateShortSpotCheck({ ...pair, outputSha256: "not-a-sha", priorRuns: [] })).toThrow();
  });
});
