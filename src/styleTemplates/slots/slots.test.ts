import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { STYLE_JOB_PALETTE_ROLES_V1 } from "../../domain/styleJobFieldsV1";
import { styleJobCacheKeyV1 } from "../../domain/styleJobV1";
import { STYLE_PALETTE_ROLES, styleTemplateSchemaV1 } from "../types";
import { compileStyleTemplateClipV1, StyleTemplateClipRefusalV1 } from "./compileClip";
import { implementedComponentTableV1, styleClipComponentV1 } from "./components";
import { styleTemplateClipRightsV1 } from "./renderTemplateClip";
import { styleSlotTemplatesV1 } from "./slotCatalog";
import { styleSlotsSchema, styleTemplateStubSchemaV1, StyleSlotRefusalV1, styleSlotTextLength, validateStyleSlotValuesV1 } from "./slotSchema";
import { imagePlacement, slotImageTargetSize, svgImageElement } from "./svgImage";

const template = () => styleSlotTemplatesV1().get("S1_explainer_ui")!;
const code = (run: () => unknown) => { try { run(); } catch (error) { return (error as { code?: string }).code ?? (error as Error).message; } return "accepted"; };
const s1Json = () => JSON.parse(readFileSync(resolve("src/styleTemplates/templates/S1_explainer_ui.json"), "utf8"));
const stubJson = (name: string) => JSON.parse(readFileSync(resolve(`src/styleTemplates/templates/${name}.slots.json`), "utf8"));
const IMAGE = { sha256: "a".repeat(64), width: 1600, height: 900, mime: "image/jpeg" as const };
const frame = { width: 1080, height: 1920, fps: 30 };
const s1Slots = (keyword = "角色立繪", extra: Record<string, unknown> = {}) => ({ text: { chapterNumber: "01", chapterLabel: "用 AI 做遊戲", lead: "還有", keyword, tag: "GPT" }, color: {}, image: {}, ...extra });

describe("slot schema (editkin.style-template/v1, additive)", () => {
  it("parses S1 with slots and clip, and every stub, and pins the palette roles to the template schema", () => {
    expect(STYLE_JOB_PALETTE_ROLES_V1).toEqual(STYLE_PALETTE_ROLES);
    const catalogue = styleSlotTemplatesV1();
    expect([...catalogue.keys()]).toEqual(["S1_explainer_ui", "S4_motion_promo_3d", "S5_vox_collage", "S7_kinetic_lyric_3d"]);
    expect(template()).toMatchObject({ implemented: true, stub: false, artStatus: "pending", clip: { component: { id: "uiCardScene", renderer: "svg" }, output: "opaque" } });
    for (const id of ["S4_motion_promo_3d", "S7_kinetic_lyric_3d"]) {
      const stub = catalogue.get(id)!;
      expect(stub).toMatchObject({ stub: false, implemented: true, artStatus: "certified", clip: { component: { renderer: "mesh3d" } } });
      // Renderer-agnostic: 3D templates bind the same slot kinds to mesh textures, extruded/banded text and material/light colours
      // (S7's frames show no pictures, so it declares no image slot).
      if (id === "S4_motion_promo_3d") expect(stub.slots.image.flatMap(slot => slot.bind.map(bind => bind.as))).toContain("mesh_texture");
      else expect(stub.slots.image).toEqual([]);
      expect(stub.slots.text.flatMap(slot => slot.bind.map(bind => bind.as))).toContain("mesh_text_extruded");
      expect(stub.slots.color.flatMap(slot => slot.bind.map(bind => bind.as))).toEqual(expect.arrayContaining(["material_color", "light_color"]));
    }
    expect(catalogue.get("S7_kinetic_lyric_3d")!.slots.text.flatMap(slot => slot.bind.map(bind => bind.as))).toContain("mesh_text_band");
    // S2/S3 declare no slots and stay out of the slot catalogue; the Phase A parse of all three is unchanged.
    for (const name of ["S2_story_illustrated", "S3_lifestyle_promo"]) {
      expect(styleTemplateSchemaV1.parse(JSON.parse(readFileSync(resolve(`src/styleTemplates/templates/${name}.json`), "utf8"))).slots).toBeUndefined();
    }
    // Every slot label exists in the five UI languages.
    for (const entry of catalogue.values()) {
      for (const slot of [...entry.slots.text, ...entry.slots.color, ...entry.slots.image]) expect(Object.keys(slot.label).sort()).toEqual(["en", "es", "ja", "ko", "zh-TW"]);
    }
  });

  it("refuses malformed declarations: unknown consumer, binding to a foreign component, duplicate ids, slots without a clip, a missing locale", () => {
    const bad = (mutate: (json: Record<string, any>) => void, schema: { safeParse: (value: unknown) => { success: boolean } } = styleTemplateSchemaV1) => {
      const json = s1Json(); mutate(json); return schema.safeParse(json).success;
    };
    expect(bad(() => undefined)).toBe(true);
    expect(bad(json => { json.slots.text[0].bind[0].as = "canvas_text"; })).toBe(false);
    expect(bad(json => { json.slots.text[0].bind[0].component = "mesh3dDeviceScreen"; })).toBe(false);
    expect(bad(json => { json.slots.image[0].id = "lead"; })).toBe(false);
    expect(bad(json => { json.slots.color.push(json.slots.color[0]); })).toBe(false);
    expect(bad(json => { delete json.clip; })).toBe(false);
    expect(bad(json => { delete json.slots.text[0].label.ko; })).toBe(false);
    expect(bad(json => { json.slots.text[0].maxLength = 0; })).toBe(false);
    expect(bad(json => { json.clip.seconds = { default: 1, min: 2, max: 3 }; })).toBe(false);
    expect(bad(json => { json.slots.image[0].unknown = true; })).toBe(false);
    const built = stubJson("S4_motion_promo_3d");
    expect(built).toMatchObject({ stub: false, artStatus: "certified" });
    expect(styleTemplateStubSchemaV1.safeParse(built).success).toBe(true);
    expect(styleTemplateStubSchemaV1.safeParse({ ...built, artStatus: "pending" }).success).toBe(true);
    expect(styleTemplateStubSchemaV1.safeParse({ ...built, artStatus: "approved" }).success).toBe(false);
    // A stub (slots declared ahead of the art) is always pending: it can never be certified.
    const stub = { ...built, stub: true, artStatus: "pending" };
    expect(styleTemplateStubSchemaV1.safeParse(stub).success).toBe(true);
    expect(styleTemplateStubSchemaV1.safeParse({ ...stub, artStatus: "certified" }).success).toBe(false);
    expect(styleTemplateStubSchemaV1.safeParse({ ...built, clip: { ...built.clip, parts: [] } }).success).toBe(false);
    expect(styleSlotsSchema.safeParse({ text: [], color: [], image: [] }).success).toBe(true);
  });
});

describe("slot values against declarations", () => {
  it("accepts and canonicalizes valid values", () => {
    const value = validateStyleSlotValuesV1(template(), { text: { keyword: " 角色立繪 ", tag: "" }, color: { accent: "#fcc834" },
      image: { card: { source: { kind: "still", assetId: "a", time: 1.5 }, fit: "contain", focal: [0.3, 0.6] } } });
    expect(value).toEqual({ text: { keyword: "角色立繪" }, color: { accent: "#FCC834" }, image: { card: { source: { kind: "still", assetId: "a", time: 1.5 }, fit: "contain", focal: [0.3, 0.6] } } });
  });

  it("refuses unknown slots, over-long text, missing required text, invalid colours and invalid framing", () => {
    const t = template();
    expect(code(() => validateStyleSlotValuesV1(t, { text: { keyword: "a", subtitle: "x" } }))).toBe("STYLE_SLOT_UNKNOWN");
    expect(code(() => validateStyleSlotValuesV1(t, { text: { keyword: "a" }, color: { bg: "#000000" } }))).toBe("STYLE_SLOT_UNKNOWN");
    expect(code(() => validateStyleSlotValuesV1(t, { text: { keyword: "a" }, image: { photo: { source: { kind: "asset", assetId: "a" } } } }))).toBe("STYLE_SLOT_UNKNOWN");
    expect(code(() => validateStyleSlotValuesV1(t, { text: { keyword: "一二三四五六七八九" } }))).toBe("STYLE_SLOT_TEXT_TOO_LONG");
    expect(code(() => validateStyleSlotValuesV1(t, { text: { keyword: "一二三四五六七八" } }))).toBe("accepted");
    // Grapheme clusters, not UTF-16 units: an emoji family is one character.
    expect(styleSlotTextLength("👨‍👩‍👧")).toBe(1);
    expect(code(() => validateStyleSlotValuesV1(t, { text: { keyword: "兩\n行" } }))).toBe("STYLE_SLOT_TEXT_INVALID");
    expect(code(() => validateStyleSlotValuesV1(t, { text: { keyword: 3 } }))).toBe("STYLE_SLOT_TEXT_INVALID");
    expect(code(() => validateStyleSlotValuesV1(t, { text: { lead: "還有" } }))).toBe("STYLE_SLOT_TEXT_REQUIRED");
    expect(code(() => validateStyleSlotValuesV1(t, { text: { lead: "還有" } }, { requireRequired: false }))).toBe("accepted");
    for (const colour of ["#FFF", "yellow", "#GGGGGG", "#FCC8344"]) expect(code(() => validateStyleSlotValuesV1(t, { text: { keyword: "a" }, color: { accent: colour } }))).toBe("STYLE_SLOT_COLOR_INVALID");
    expect(code(() => validateStyleSlotValuesV1(t, { text: { keyword: "a" }, image: { card: { source: { kind: "asset", assetId: "a" }, focal: [1.2, 0.5] } } }))).toBe("STYLE_SLOT_IMAGE_INVALID");
    expect(code(() => validateStyleSlotValuesV1(t, { text: { keyword: "a" }, image: { card: { source: { kind: "asset", assetId: "a" }, crop: [0.5, 0, 0.5, 1] } } }))).toBe("STYLE_SLOT_IMAGE_INVALID");
    expect(code(() => validateStyleSlotValuesV1(t, { text: { keyword: "a" }, image: { card: { source: { kind: "url", href: "http://x" } } } }))).toBe("STYLE_SLOT_IMAGE_INVALID");
    expect(code(() => validateStyleSlotValuesV1(t, { text: [] }))).toBe("STYLE_SLOT_VALUES_INVALID");
    expect(new StyleSlotRefusalV1("STYLE_SLOT_UNKNOWN").message).toBe("STYLE_SLOT_UNKNOWN");
  });
});

describe("compiling a template clip", () => {
  it("keys every slot change, never an unchanged one, and keeps the component job in the field", () => {
    const base = compileStyleTemplateClipV1({ templateId: "S1_explainer_ui", slots: s1Slots(), frame, images: {} });
    expect(base.field).toMatchObject({ schema: "editkin.style-job/v1", template: { id: "S1_explainer_ui", revision: 4 }, component: { id: "uiCardScene", renderer: "svg", revision: 1 },
      output: "opaque", job: { frameCount: 120, fps: "30/1", params: { component: "uiCardScene", accent: "#FCC834", ink: "#121214", text: { keyword: "角色立繪" } } } });
    expect(compileStyleTemplateClipV1({ templateId: "S1_explainer_ui", slots: s1Slots(), frame, images: {} }).field.key).toBe(base.field.key);
    const keys = new Set([base.field.key,
      compileStyleTemplateClipV1({ templateId: "S1_explainer_ui", slots: s1Slots("遊戲引擎"), frame, images: {} }).field.key,
      compileStyleTemplateClipV1({ templateId: "S1_explainer_ui", slots: s1Slots(undefined, { color: { accent: "#5CE4F4" } }), frame, images: {} }).field.key,
      compileStyleTemplateClipV1({ templateId: "S1_explainer_ui", slots: s1Slots(), frame, images: {}, durationSeconds: 5 }).field.key,
      compileStyleTemplateClipV1({ templateId: "S1_explainer_ui", slots: s1Slots(undefined, { image: { card: { source: { kind: "asset", assetId: "a" } } } }), frame, images: { card: IMAGE } }).field.key,
      compileStyleTemplateClipV1({ templateId: "S1_explainer_ui", slots: s1Slots(undefined, { image: { card: { source: { kind: "asset", assetId: "a" }, focal: [0.2, 0.5] } } }), frame, images: { card: IMAGE } }).field.key,
      compileStyleTemplateClipV1({ templateId: "S1_explainer_ui", slots: s1Slots(undefined, { image: { card: { source: { kind: "asset", assetId: "a" } } } }), frame, images: { card: { ...IMAGE, sha256: "b".repeat(64) } } }).field.key,
      compileStyleTemplateClipV1({ templateId: "S1_explainer_ui", slots: s1Slots(), frame: { width: 1920, height: 1080, fps: 30 }, images: {} }).field.key,
    ]);
    expect(keys.size).toBe(8);
    // The domain recomputes the same key from the stored field.
    const field = base.field;
    expect(styleJobCacheKeyV1({ template: field.template, component: field.component, output: field.output, slotsSha256: field.slotsSha256, params: field.job.params,
      frameCount: field.job.frameCount, fps: field.job.fps, width: 1080, height: 1920 })).toBe(field.key);
  });

  it("derives the tag colour from the roles when the ink does not read on the accent", () => {
    const dark = compileStyleTemplateClipV1({ templateId: "S1_explainer_ui", slots: s1Slots(undefined, { color: { accent: "#202020" } }), frame, images: {} });
    expect(dark.field.job.params).toMatchObject({ accent: "#202020", ink: "#121214" });
    expect((dark.field.job.params as { onAccent: string }).onAccent).not.toBe("#121214");
  });

  it("refuses what it cannot render: stubs, unknown templates, formats, lengths, missing pictures and undrawable characters", () => {
    // S4/S5/S7 are built (2026-10-23): a named S4 compiles; an unregistered component would be refused as NOT_IMPLEMENTED.
    expect(code(() => compileStyleTemplateClipV1({ templateId: "S4_motion_promo_3d", slots: { text: { title: "新品" } }, frame, images: {} }))).toBe("accepted");
    expect(code(() => compileStyleTemplateClipV1({ templateId: "S9_none", slots: s1Slots(), frame, images: {} }))).toBe("STYLE_TEMPLATE_UNKNOWN");
    expect(code(() => compileStyleTemplateClipV1({ templateId: "S1_explainer_ui", slots: s1Slots(), frame: { width: 1080, height: 1080, fps: 30 }, images: {} }))).toBe("STYLE_TEMPLATE_FORMAT_UNSUPPORTED");
    expect(code(() => compileStyleTemplateClipV1({ templateId: "S1_explainer_ui", slots: s1Slots(), frame, images: {}, durationSeconds: 1 }))).toBe("STYLE_TEMPLATE_DURATION_INVALID");
    expect(code(() => compileStyleTemplateClipV1({ templateId: "S1_explainer_ui", slots: s1Slots(undefined, { image: { card: { source: { kind: "asset", assetId: "a" } } } }), frame, images: {} })))
      .toBe("STYLE_TEMPLATE_IMAGE_MISSING");
    expect(code(() => compileStyleTemplateClipV1({ templateId: "S1_explainer_ui", slots: s1Slots("𓀀"), frame, images: {} }))).toBe("STYLE_TEMPLATE_GLYPH_UNSUPPORTED");
    expect(new StyleTemplateClipRefusalV1("STYLE_TEMPLATE_UNKNOWN", "x").message).toBe("STYLE_TEMPLATE_UNKNOWN: x");
  });

  it("pins the light implemented-component table to the renderer registry", () => {
    const { registry, table, registryParts, tableParts } = implementedComponentTableV1();
    expect(table).toEqual(registry);
    expect(tableParts).toEqual(registryParts);
    expect(Object.keys(registry).sort()).toEqual(["collageExplainer", "mesh3dDeviceScreen", "mesh3dKineticLyric", "uiCardScene"]);
    expect(styleClipComponentV1("mesh3dDeviceScreen")).toMatchObject({ renderer: "mesh3d", parts: [{ id: "mesh3dExtrudedTitle" }] });
    expect(styleClipComponentV1("notAComponent")).toBeUndefined();
  });
});

describe("pictures: placement, derivative size, element and rights", () => {
  it("covers about the focal point, contains centred, and punches in about the focal point without uncovering the window", () => {
    const image = { width: 1600, height: 900, fit: "cover" as const, focal: [0.2, 0.5] as const }, win = { w: 990, h: 950 };
    const cover = imagePlacement(image, win);
    expect(cover.h).toBeCloseTo(950); expect(cover.w).toBeCloseTo(1600 * 950 / 900);
    expect(cover.x).toBe(0); // the focal point wants the picture further right than its edge allows
    expect(imagePlacement({ ...image, focal: [1, 0.5] }, win).x).toBeCloseTo(990 - cover.w);
    const centred = imagePlacement({ ...image, focal: [0.5, 0.5] }, win);
    expect(centred.x + centred.w / 2).toBeCloseTo(495);
    const contain = imagePlacement({ ...image, fit: "contain" }, win);
    expect(contain).toMatchObject({ x: 0 }); expect(contain.w).toBeCloseTo(990); expect(contain.y).toBeCloseTo((950 - 990 * 900 / 1600) / 2);
    for (const focal of [[0, 0], [0.2, 0.5], [1, 1], [0.7, 0.1]] as const) {
      const punched = imagePlacement({ ...image, focal }, win, 1.15);
      expect(punched.x).toBeLessThanOrEqual(1e-9); expect(punched.y).toBeLessThanOrEqual(1e-9);
      expect(punched.x + punched.w).toBeGreaterThanOrEqual(990 - 1e-9); expect(punched.y + punched.h).toBeGreaterThanOrEqual(950 - 1e-9);
    }
    expect(slotImageTargetSize({ width: 4000, height: 3000 }, win, "cover", 1.15)).toEqual({ width: 1456, height: 1092 });
    expect(slotImageTargetSize({ width: 800, height: 600 }, win, "cover", 1.15)).toEqual({ width: 800, height: 600 });
  });

  it("builds <image> only from base64 PNG or JPEG data URIs", () => {
    expect(svgImageElement("data:image/png;base64,AAAA", 1, 2, 3, 4)).toBe('<image x="1" y="2" width="3" height="4" preserveAspectRatio="none" href="data:image/png;base64,AAAA"/>');
    for (const href of ["file:///C:/x.png", "https://example.com/x.png", "data:image/svg+xml;base64,AAAA", 'data:image/png;base64,AA"/><script>']) {
      expect(() => svgImageElement(href, 0, 0, 1, 1)).toThrow();
    }
    expect(() => svgImageElement("data:image/png;base64,AAAA", 0, 0, 0, 1)).toThrow();
  });

  it("never makes a clip freer than the pictures inside it", () => {
    expect(styleTemplateClipRightsV1([])).toEqual({ license: "Editkin original", redistributable: true });
    const asset = (extra: Record<string, unknown>) => ({ id: "p", name: "p", kind: "image" as const, uri: "p.png", duration: 5, ...extra });
    expect(styleTemplateClipRightsV1([asset({ redistributable: true })])).toMatchObject({ redistributable: true });
    expect(styleTemplateClipRightsV1([asset({ redistributable: true }), asset({})])).not.toHaveProperty("redistributable");
    expect(styleTemplateClipRightsV1([asset({ redistributable: false })])).toMatchObject({ redistributable: false });
    expect(styleTemplateClipRightsV1([asset({ id: "private-visual:x" })])).toMatchObject({ license: "PRIVATE-OWNER-ONLY", redistributable: false, distributionScope: "private-owner-only" });
    expect(styleTemplateClipRightsV1([asset({ distributionScope: "private-owner-only", redistributable: true })])).toMatchObject({ redistributable: false });
  });
});
