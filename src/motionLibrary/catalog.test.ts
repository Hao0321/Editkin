import { describe, expect, it } from "vitest";
import {
  MOTION_CATEGORY_THEMES, MOTION_LIBRARY_CATALOG, MOTION_LIBRARY_CATEGORIES, MOTION_LIBRARY_IMPLEMENTATION_IDS, MOTION_LIBRARY_KIND_COUNTS,
  findMotionLibraryItem, getMotionLibraryItem, listImplemented, listMotionLibraryItems,
} from "./catalog";
import { MOTION_ART_CERTIFICATIONS } from "./certifications";
import { textFace } from "./items/shared";
import { MOTION_PALETTES } from "./palettes";
import { relativeLuminance } from "./svg/color";
import { assertMotionText } from "./svg/glyphs";
import {
  MotionLibraryNotImplementedError, backgroundMotionParamsSchema, defineBackgroundMotion, defineTextMotion, defineTransitionMotion, textMotionParamsSchema,
  transitionMotionParamsSchema, type TextMotionItem,
} from "./types";

const ids = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => `${prefix}${String(index + 1).padStart(2, "0")}`);
const texts = () => listMotionLibraryItems({ kind: "text" }) as TextMotionItem[];

describe("motion library catalog", () => {
  it("gives every item an integer art revision (default 1) taken from its implementation", () => {
    for (const item of MOTION_LIBRARY_CATALOG) {
      expect(Number.isInteger(item.revision) && item.revision! >= 1, item.id).toBe(true);
      if (!item.implemented) expect(item.revision, item.id).toBe(1);
    }
    // T01: 1 Phase 1, 2 burst revision, 3 ART_DIRECTION §0 overhaul. X01: 2 = the reference planes (grey → accent tint → accent).
    expect([getMotionLibraryItem("T01").revision, getMotionLibraryItem("X01").revision, getMotionLibraryItem("B01").revision]).toEqual([3, 2, 4]); // B01 r2: §10 colours; r3: §10 reference recreation (expanding disc pulse); r4: travelling fronts (the disc becomes an expanding ring)
    const generate = () => "";
    expect(defineTextMotion("T99", generate).revision).toBe(1);
    expect(defineBackgroundMotion("B99", generate, { revision: 4 }).revision).toBe(4);
    expect(defineTransitionMotion("X99", () => ({ matte: "" }), { revision: 2, supportedDirections: ["left_to_right"] }))
      .toMatchObject({ revision: 2, supportedDirections: ["left_to_right"] });
    for (const revision of [0, -2, 1.5, Number.NaN, 2_000_000]) expect(() => defineTextMotion("T99", generate, { revision })).toThrow(/revision/);
  });
  it("registers T01–T80, X01–X40 and B01–B40 in order, checked per kind", () => {
    expect(MOTION_LIBRARY_KIND_COUNTS).toEqual({ text: 80, transition: 40, background: 40 });
    expect(MOTION_LIBRARY_CATALOG.map(item => item.id)).toEqual([...ids("T", 80), ...ids("X", 40), ...ids("B", 40)]);
    for (const kind of ["text", "transition", "background"] as const) {
      expect(listMotionLibraryItems({ kind })).toHaveLength(MOTION_LIBRARY_KIND_COUNTS[kind]);
    }
    expect(Object.isFrozen(MOTION_LIBRARY_CATALOG)).toBe(true);
  });
  it("has ten text groups (two reference sets) and five per transition and background, eight items each", () => {
    expect(MOTION_LIBRARY_CATEGORIES.filter(category => category.kind === "text").map(category => category.id))
      .toEqual(["impact", "flow", "depth", "switch", "style", "drama", "play", "physics", "rhythm", "mood"]);
    expect(MOTION_LIBRARY_CATEGORIES.filter(category => category.kind === "transition")).toHaveLength(5);
    expect(MOTION_LIBRARY_CATEGORIES.filter(category => category.kind === "background")).toHaveLength(5);
    expect(MOTION_LIBRARY_CATEGORIES.find(category => category.id === "drama")!.names).toEqual({ zh: "戲劇", ja: "ドラマ", en: "Drama" });
    expect(MOTION_LIBRARY_CATEGORIES.find(category => category.id === "mood")!.names).toEqual({ zh: "情緒", ja: "ムード", en: "Mood" });
    for (const category of MOTION_LIBRARY_CATEGORIES) {
      expect(listMotionLibraryItems({ kind: category.kind, category: category.id }), category.id).toHaveLength(8);
      expect(category.names.zh && category.names.ja && category.names.en).toBeTruthy();
    }
  });
  it("every item has names, tags, valid defaults and a revision-pinned art status", () => {
    for (const item of MOTION_LIBRARY_CATALOG) {
      expect(item.names.zh.trim(), item.id).not.toBe("");
      expect(item.names.ja.trim(), item.id).not.toBe("");
      expect(item.names.en.trim(), item.id).not.toBe("");
      expect(item.tags.length, item.id).toBeGreaterThan(1);
      expect(item.artStatus, item.id).toBe(item.implemented && MOTION_ART_CERTIFICATIONS[item.id] === item.revision ? "certified" : "pending");
      expect(item.defaultDurationSeconds).toBe(item.defaultParams.durationSeconds);
      const schema = item.kind === "text" ? textMotionParamsSchema : item.kind === "transition" ? transitionMotionParamsSchema : backgroundMotionParamsSchema;
      expect(schema.safeParse(item.defaultParams).success, item.id).toBe(true);
      expect(Object.values(MOTION_PALETTES)).toContainEqual(item.defaultParams.palette);
      if (item.kind === "background") expect(item.loopSeconds).toBe(item.defaultDurationSeconds);
      if (item.kind === "transition") expect(item.defaultDurationSeconds).toBe(0.5);
      if (item.kind === "text") {
        expect(item.previewText).toBe(item.defaultParams.lines.join(" / "));
        expect(item.defaultParams.plate).toBe("none");
      }
    }
    expect(new Set(MOTION_LIBRARY_CATALOG.map(item => item.names.zh)).size).toBe(MOTION_LIBRARY_CATALOG.length);
    expect(new Set(MOTION_LIBRARY_CATALOG.map(item => item.names.en)).size).toBe(MOTION_LIBRARY_CATALOG.length);
  });
  it("assigns showcase plates from the catalog notes (ART_DIRECTION §9)", () => {
    // T42 shows on bg: paper glyphs and the lime laser with a paper core (ART_DIRECTION §0).
    // T26 shows the CATALOG's dark cards on an accent background (Claude, p2d review 2026-10-16).
    const accent = ["T02", "T06", "T10", "T14", "T22", "T26", "T34", "T38", "T46", "T50", "T54", "T58", "T62", "T66", "T70", "T74", "T78"];
    // T35 shows its candy stripes on cream outside the type, as in its reference (Claude, p2e review).
    const paper = ["T03", "T07", "T19", "T35", "T43", "T47", "T51", "T55", "T59", "T63", "T67", "T71", "T75", "T79"];
    for (const item of texts()) {
      expect(item.showcasePlate, item.id).toBe(accent.includes(item.id) ? "accent" : paper.includes(item.id) ? "paper" : "bg");
    }
  });
  it("defaults every item to its category's reference palette (ART_DIRECTION §0) and keeps the T41–T80 rows", () => {
    const theme = (id: string) => Object.entries(MOTION_PALETTES).find(([, palette]) => palette === getMotionLibraryItem(id).defaultParams.palette
      || JSON.stringify(palette) === JSON.stringify(getMotionLibraryItem(id).defaultParams.palette))![0];
    const expected: Record<string, string> = {
      impact: "ref_red", flow: "ref_yellow", depth: "ref_aqua", switch: "ref_lavender", style: "ref_orange",
      drama: "ref_lime", play: "ref_coral", physics: "ref_violet", rhythm: "ref_teal", mood: "ref_gold",
      sweep: "ref_pink", shape: "ref_aqua", fluid_impact: "ref_yellow", panel: "ref_lavender", mosaic: "ref_orange",
      halftone: "ref_pink", grid: "ref_aqua", lines: "ref_yellow", shapes: "ref_lavender", minimal: "ref_orange",
    };
    expect(MOTION_CATEGORY_THEMES).toEqual(expected);
    for (const item of MOTION_LIBRARY_CATALOG) expect(theme(item.id), item.id).toBe(expected[item.category]);
    // One card set for every reference theme; accent2 is a deeper shade of the accent, never a second hue.
    for (const name of Object.values(expected)) {
      const palette = MOTION_PALETTES[name as keyof typeof MOTION_PALETTES];
      expect([palette.bg, palette.ink, palette.paper], name).toEqual(["#15191F", "#121214", "#F5F1E6"]);
      expect(relativeLuminance(palette.accent2), name).toBeLessThan(relativeLuminance(palette.accent) / 2);
    }
    expect(getMotionLibraryItem("T41")).toMatchObject({ category: "drama", names: { en: "Lightning Strike", zh: "雷擊登場" } });
    expect(getMotionLibraryItem("T63").defaultParams).toMatchObject({ font: "serif", lines: ["越來越粗"] });
    expect(getMotionLibraryItem("T80")).toMatchObject({ loopSeconds: 6, defaultDurationSeconds: 6 });
    expect(getMotionLibraryItem("T56").notes).toMatch(/T21/);
  });
  it("keeps the thick 3D ruling attached to T24", () => {
    const t24 = getMotionLibraryItem("T24");
    expect(t24.tags).toContain("no_va_default");
    expect(t24.notes).toMatch(/ART_REJECTED/);
  });
  it("default sample text is drawable in each text item's default face", () => {
    for (const item of texts()) {
      for (const line of item.defaultParams.lines) expect(() => assertMotionText(line, textFace(item.defaultParams.font, 900)), `${item.id} ${line}`).not.toThrow();
    }
  });
  it("lists exactly the registered implementations as implemented and refuses the rest clearly", () => {
    // The implemented set comes from IMPLEMENTATIONS (batches add to it), never from a hard-coded list.
    const registered = new Set(MOTION_LIBRARY_IMPLEMENTATION_IDS);
    expect(registered.size).toBe(MOTION_LIBRARY_IMPLEMENTATION_IDS.length);
    for (const id of ["T01", "X01", "B01"]) expect(registered.has(id), id).toBe(true); // the Phase 1 reference items
    for (const id of MOTION_LIBRARY_IMPLEMENTATION_IDS) {
      expect(findMotionLibraryItem(id), `${id} is registered`).toBeDefined();
      expect(getMotionLibraryItem(id).implemented, id).toBe(true);
    }
    expect(listImplemented().map(item => item.id)).toEqual(MOTION_LIBRARY_CATALOG.filter(item => registered.has(item.id)).map(item => item.id));
    for (const kind of ["text", "transition", "background"] as const) {
      expect(listImplemented(kind).every(item => item.kind === kind && registered.has(item.id)), kind).toBe(true);
    }
    expect(getMotionLibraryItem("X01")).toMatchObject({ implemented: true, kind: "transition" });
    for (const pending of MOTION_LIBRARY_CATALOG.filter(item => !registered.has(item.id))) {
      expect(pending.implemented, pending.id).toBe(false);
      const generate = () => (pending.generate as (params: unknown, t: number, size: { width: number; height: number }) => unknown)(
        pending.defaultParams, 0, { width: 1080, height: 1920 });
      expect(generate).toThrow(MotionLibraryNotImplementedError);
      expect(generate).toThrow(`${pending.id} is registered but not implemented`);
    }
    expect(findMotionLibraryItem("T81")).toBeUndefined();
    expect(findMotionLibraryItem("X41")).toBeUndefined();
    expect(() => getMotionLibraryItem("Z01")).toThrow(/Unknown motion library item/);
  });
});
