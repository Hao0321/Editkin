import { describe, expect, it } from "vitest";
import { styleJobCacheKeyV1 } from "../../domain/styleJobV1";
import { compileStyleTemplateClipV1 } from "./compileClip";
import { collageImageWindowV1, collageParams } from "./collageExplainer";
import { styleClipComponentV1 } from "./components";
import { deviceScreenImageWindowV1, deviceScreenParams } from "./mesh3dDeviceScreen";
import { kineticLyricCompositeV1, kineticLyricInternalsV1, kineticLyricParams } from "./mesh3dKineticLyric";
import { STYLE_CLIP_COMPONENTS_IMPLEMENTED_V1, STYLE_CLIP_PARTS_IMPLEMENTED_V1, styleSlotTemplatesV1 } from "./slotCatalog";
import { validateStyleSlotValuesV1 } from "./slotSchema";

/**
 * S4 motion_promo_3d, S5 vox_collage and S7 kinetic_lyric_3d as editable template clips: declarations, value checks,
 * compile keys and layout (pure; renders are in templateClipsS457.render.test.ts).
 */
const portrait = { width: 1080, height: 1920, fps: 30 }, landscape = { width: 1920, height: 1080, fps: 30 };
const code = (run: () => unknown) => { try { run(); } catch (error) { return (error as { code?: string }).code ?? (error as Error).message; } return "accepted"; };
const IMAGE = { sha256: "c".repeat(64), width: 1600, height: 1000, mime: "image/jpeg" as const };
const asset = (assetId: string) => ({ source: { kind: "asset", assetId } });

const S4 = (extra: { text?: Record<string, string>; color?: Record<string, string>; image?: Record<string, unknown> } = {}) =>
  ({ text: { title: "一鍵自動剪輯", kicker: "EDITKIN  ·  AUTO EDIT", ...extra.text }, color: { ...extra.color }, image: { ...extra.image } });
const S5 = (extra: { text?: Record<string, string>; color?: Record<string, string>; image?: Record<string, unknown> } = {}) =>
  ({ text: { wordmark: "鶯歌", kicker: "手拉坏・老街", caption: "CLAY", gloss: "原本是泥", step1: "泥團置中", step2: "手指拉開瓶口", step3: "瓶身慢慢拉高", ...extra.text }, color: { ...extra.color }, image: { ...extra.image } });
const S7 = (extra: { text?: Record<string, string>; color?: Record<string, string> } = {}) =>
  ({ text: { word: "剪", band: "自動剪輯 · AUTO EDIT · ", label: "EDITKIN", labelSub: "剪片季", display: "EDITKIN", script: "剪片季", kicker: "AUTO EDIT", ...extra.text }, color: { ...extra.color }, image: {} });

describe("S4 / S5 / S7 declarations", () => {
  it("are built slot-only templates, art certified (Hao 2026-10-29), with registered components and parts", () => {
    const catalogue = styleSlotTemplatesV1();
    for (const [id, component, renderer, parts] of [["S4_motion_promo_3d", "mesh3dDeviceScreen", "mesh3d", ["mesh3dExtrudedTitle"]], ["S5_vox_collage", "collageExplainer", "svg", []],
      ["S7_kinetic_lyric_3d", "mesh3dKineticLyric", "mesh3d", ["mesh3dLyricBand"]]] as const) {
      const template = catalogue.get(id)!;
      expect(template).toMatchObject({ stub: false, implemented: true, artStatus: "certified", revision: 2, clip: { component: { id: component, renderer } } });
      expect((template.clip.parts ?? []).map(part => part.id)).toEqual(parts);
      expect(STYLE_CLIP_COMPONENTS_IMPLEMENTED_V1[component]).toMatchObject({ renderer });
      for (const part of parts) expect(STYLE_CLIP_PARTS_IMPLEMENTED_V1[part]).toMatchObject({ root: component, renderer: "mesh3d" });
      expect(styleClipComponentV1(component)!.composite).toBeDefined();
      for (const slot of [...template.slots.text, ...template.slots.color, ...template.slots.image]) expect(Object.keys(slot.label).sort()).toEqual(["en", "es", "ja", "ko", "zh-TW"]);
      expect(template.clip.formats).toEqual(["portrait", "landscape"]);
    }
    const consumers = (id: string) => { const t = catalogue.get(id)!; return [...t.slots.text, ...t.slots.color, ...t.slots.image].flatMap(slot => slot.bind.map(bind => bind.as)); };
    expect(consumers("S4_motion_promo_3d")).toEqual(expect.arrayContaining(["mesh_text_extruded", "mesh_texture", "material_color", "light_color", "emissive_color", "svg_fill"]));
    expect(consumers("S7_kinetic_lyric_3d")).toEqual(expect.arrayContaining(["mesh_text_extruded", "mesh_text_band", "material_color", "light_color", "emissive_color"]));
    expect(consumers("S5_vox_collage")).toEqual(expect.arrayContaining(["svg_text", "svg_image", "svg_fill"]));
    // The frames' slots: S4 TEXT title/kicker, four pictures; S5 nine texts, six pictures; S7 seven texts, no pictures.
    expect(catalogue.get("S4_motion_promo_3d")!.slots.image.map(slot => [slot.id, slot.placeholder])).toEqual([["screen", "ui_panel"], ["cardHero", "ui_panel"], ["cardMenu", "ui_panel"], ["cardPill", "ui_panel"]]);
    expect(catalogue.get("S5_vox_collage")!.slots.image.map(slot => slot.id)).toEqual(["speaker", "cutout", "plate", "stepPhoto1", "stepPhoto2", "stepPhoto3"]);
    expect(catalogue.get("S5_vox_collage")!.clip.output).toBe("alpha");
    expect(catalogue.get("S7_kinetic_lyric_3d")!.slots.text.map(slot => slot.id)).toEqual(["word", "band", "label", "labelSub", "display", "script", "kicker"]);
  });

  it("checks values against the declarations (lengths, unknown slots, colours, required text)", () => {
    const catalogue = styleSlotTemplatesV1(), t4 = catalogue.get("S4_motion_promo_3d")!, t5 = catalogue.get("S5_vox_collage")!, t7 = catalogue.get("S7_kinetic_lyric_3d")!;
    expect(code(() => validateStyleSlotValuesV1(t4, S4()))).toBe("accepted");
    expect(code(() => validateStyleSlotValuesV1(t4, S4({ text: { title: "一二三四五六七八九十十" } })))).toBe("STYLE_SLOT_TEXT_TOO_LONG");
    expect(code(() => validateStyleSlotValuesV1(t4, { text: { kicker: "X" } }))).toBe("STYLE_SLOT_TEXT_REQUIRED");
    expect(code(() => validateStyleSlotValuesV1(t4, S4({ color: { paper: "#FFFFFF" } })))).toBe("STYLE_SLOT_UNKNOWN");
    expect(code(() => validateStyleSlotValuesV1(t4, S4({ color: { accent: "blue" } })))).toBe("STYLE_SLOT_COLOR_INVALID");
    expect(code(() => validateStyleSlotValuesV1(t4, S4({ image: { screen: { source: { kind: "asset", assetId: "a" }, focal: [2, 0] } } })))).toBe("STYLE_SLOT_IMAGE_INVALID");
    expect(code(() => validateStyleSlotValuesV1(t5, S5()))).toBe("accepted");
    expect(code(() => validateStyleSlotValuesV1(t5, S5({ text: { wordmark: "一二三四五六七八九" } })))).toBe("STYLE_SLOT_TEXT_TOO_LONG");
    expect(code(() => validateStyleSlotValuesV1(t5, S5({ image: { photo: asset("a") } })))).toBe("STYLE_SLOT_UNKNOWN");
    expect(code(() => validateStyleSlotValuesV1(t7, S7()))).toBe("accepted");
    expect(code(() => validateStyleSlotValuesV1(t7, S7({ text: { word: "一二三四五六七" } })))).toBe("STYLE_SLOT_TEXT_TOO_LONG");
    expect(code(() => validateStyleSlotValuesV1(t7, { ...S7(), image: { band: asset("a") } }))).toBe("STYLE_SLOT_UNKNOWN");
    expect(code(() => validateStyleSlotValuesV1(t7, { text: { band: "x" } }))).toBe("STYLE_SLOT_TEXT_REQUIRED");
  });
});

describe("compiling S4 / S5 / S7 clips", () => {
  it("keys every slot change, never an unchanged one, and the domain recomputes the key", () => {
    const cases: Array<[string, (extra?: never) => unknown, Array<() => unknown>, Record<string, typeof IMAGE>]> = [
      ["S4_motion_promo_3d", () => S4(), [() => S4({ text: { title: "轉場一鍵套用" } }), () => S4({ text: { kicker: "MOTION" } }), () => S4({ color: { accent: "#C23BFF" } }),
        () => S4({ color: { highlight: "#FFB020" } }), () => S4({ image: { screen: asset("a") } })], {}],
      ["S5_vox_collage", () => S5(), [() => S5({ text: { wordmark: "龍潭" } }), () => S5({ text: { step3: "完成" } }), () => S5({ color: { paper: "#FFF1D0" } }), () => S5({ image: { plate: asset("a") } })], {}],
      ["S7_kinetic_lyric_3d", () => S7(), [() => S7({ text: { word: "動" } }), () => S7({ text: { band: "MOTION · " } }), () => S7({ text: { display: "" } }), () => S7({ color: { accent: "#3ED6D0" } })], {}],
    ];
    for (const [templateId, base, changes] of cases) {
      const imagesFor = (slots: { image?: Record<string, unknown> }) => Object.fromEntries(Object.keys(slots.image ?? {}).map(slot => [slot, IMAGE]));
      const first = compileStyleTemplateClipV1({ templateId, slots: base(), frame: portrait, images: {} });
      expect(compileStyleTemplateClipV1({ templateId, slots: base(), frame: portrait, images: {} }).field.key).toBe(first.field.key);
      const keys = new Set([first.field.key, compileStyleTemplateClipV1({ templateId, slots: base(), frame: landscape, images: {} }).field.key,
        compileStyleTemplateClipV1({ templateId, slots: base(), frame: portrait, images: {}, durationSeconds: 5 }).field.key,
        ...changes.map(change => { const slots = change() as { image?: Record<string, unknown> }; return compileStyleTemplateClipV1({ templateId, slots, frame: portrait, images: imagesFor(slots) }).field.key; })]);
      expect(keys.size).toBe(3 + changes.length);
      const field = first.field;
      expect(field).toMatchObject({ template: { id: templateId, revision: 2 }, job: { frameCount: 120, fps: "30/1" } });
      expect(styleJobCacheKeyV1({ template: field.template, component: field.component, output: field.output, slotsSha256: field.slotsSha256, params: field.job.params,
        frameCount: field.job.frameCount, fps: field.job.fps, width: 1080, height: 1920 })).toBe(field.key);
    }
    // A picture's bytes, fit and focal point key the clip too.
    const withScreen = (focal: [number, number], sha = IMAGE.sha256) => compileStyleTemplateClipV1({ templateId: "S4_motion_promo_3d",
      slots: S4({ image: { screen: { source: { kind: "asset", assetId: "a" }, focal } } }), frame: portrait, images: { screen: { ...IMAGE, sha256: sha } } }).field.key;
    expect(new Set([withScreen([0.5, 0.5]), withScreen([0.2, 0.5]), withScreen([0.5, 0.5], "d".repeat(64))]).size).toBe(3);
  });

  it("refuses undrawable characters, square frames and lengths outside the clip's range", () => {
    expect(code(() => compileStyleTemplateClipV1({ templateId: "S7_kinetic_lyric_3d", slots: S7({ text: { word: "𓀀" } }), frame: portrait, images: {} }))).toBe("STYLE_TEMPLATE_GLYPH_UNSUPPORTED");
    expect(code(() => compileStyleTemplateClipV1({ templateId: "S4_motion_promo_3d", slots: S4({ text: { title: "𓀀" } }), frame: portrait, images: {} }))).toBe("STYLE_TEMPLATE_GLYPH_UNSUPPORTED");
    expect(code(() => compileStyleTemplateClipV1({ templateId: "S5_vox_collage", slots: S5({ text: { caption: "𓀀" } }), frame: portrait, images: {} }))).toBe("STYLE_TEMPLATE_GLYPH_UNSUPPORTED");
    for (const templateId of ["S4_motion_promo_3d", "S5_vox_collage", "S7_kinetic_lyric_3d"]) {
      const slots = templateId.startsWith("S4") ? S4() : templateId.startsWith("S5") ? S5() : S7();
      expect(code(() => compileStyleTemplateClipV1({ templateId, slots, frame: { width: 1080, height: 1080, fps: 30 }, images: {} }))).toBe("STYLE_TEMPLATE_FORMAT_UNSUPPORTED");
      expect(code(() => compileStyleTemplateClipV1({ templateId, slots, frame: portrait, images: {}, durationSeconds: 30 }))).toBe("STYLE_TEMPLATE_DURATION_INVALID");
    }
    expect(code(() => compileStyleTemplateClipV1({ templateId: "S4_motion_promo_3d", slots: S4({ image: { screen: asset("a") } }), frame: portrait, images: {} }))).toBe("STYLE_TEMPLATE_IMAGE_MISSING");
  });
});

describe("layout and motion parameters", () => {
  it("S4 fits the title to the frame in both formats and sizes picture windows to the textures", () => {
    for (const frame of [portrait, landscape]) {
      for (const title of ["一鍵自動剪輯", "AI", "一二三四五六七八九十"]) {
        const p = deviceScreenParams({ width: frame.width, height: frame.height, duration: 4, roles: { bg: "#040C1C", accent: "#1E46FF", accent2: "#0470D8", highlight: "#E0262A" }, text: { title }, images: {} });
        const xs = p.title.glyphs.map(glyph => p.title.cx + glyph.dx);
        expect(Math.min(...xs)).toBeGreaterThan(0); expect(Math.max(...xs)).toBeLessThan(frame.width);
        expect(p.title.glyphs.map(glyph => glyph.char).join("")).toBe(title);
        expect(p.palette.glow).toMatch(/^#[0-9A-F]{6}$/); expect(p.palette.metal).toMatch(/^#[0-9A-F]{6}$/);
      }
    }
    expect(deviceScreenImageWindowV1("screen")).toEqual({ w: 1600, h: 1000 });
    expect(deviceScreenImageWindowV1("cardPill")!.w / deviceScreenImageWindowV1("cardPill")!.h).toBeCloseTo(5.306, 2);
    expect(deviceScreenImageWindowV1("nope")).toBeUndefined();
  });

  it("S5 plays the steps act only when steps are given, and sizes the speaker window to its half of the frame", () => {
    const palette = { paper: "#F5EEE0", bg: "#1C1C1A", accent: "#2F6FD6" };
    expect(collageParams({ width: 1080, height: 1920, duration: 4, palette, text: { wordmark: "鶯歌" }, images: {} }).actB).toBeNull();
    expect(collageParams({ width: 1080, height: 1920, duration: 4, palette, text: { wordmark: "鶯歌", step1: "一" }, images: {} }).actB).toEqual({ at: 2, tear: 0.32 });
    expect(collageImageWindowV1(portrait, "speaker")).toEqual({ w: Math.round(1080 * 1.12), h: Math.round(960 * 1.12) });
    expect(collageImageWindowV1(landscape, "speaker")!.h).toBe(Math.round(1080 * 1.12));
  });

  it("S7: CJK extrudes at ≤ 15% of its size, Latin at about 30%; the lock-up adds act B after a whip on a beat", () => {
    const palette = { paper: "#F8D8E8", ink: "#580828", bg: "#480818", accent: "#F868A8" };
    const cjk = kineticLyricParams({ width: 1080, height: 1920, duration: 4, palette, text: { word: "剪", display: "EDITKIN" } });
    const latin = kineticLyricParams({ width: 1080, height: 1920, duration: 4, palette, text: { word: "YOU" } });
    expect(cjk.hero.depth / cjk.hero.size).toBeLessThanOrEqual(0.15);
    expect(latin.hero.depth / latin.hero.size).toBeCloseTo(0.3, 2);
    expect(cjk.whip).not.toBeNull(); expect(latin.whip).toBeNull();
    // The band's repeats read as a list: a phrase without a closing separator gets one.
    expect(["自動剪輯 · AUTO EDIT ·", "自動剪輯", "MOTION —", "MOTION · "].map(kineticLyricInternalsV1.bandPhrase)).toEqual(["自動剪輯 · AUTO EDIT ·", "自動剪輯 ·", "MOTION —", "MOTION ·"]);
    // The whip's cut lands on a beat (0.12 s into the 0.3 s pan).
    expect(((cjk.whip!.at + 0.12) / cjk.beat) % 1).toBeCloseTo(0, 6);
    const mid = cjk.whip!.at + cjk.whip!.duration / 2;
    expect([0, 1, mid, 3.5].map(t => { const ph = kineticLyricInternalsV1.phase(cjk, t); return [ph.a, ph.b]; })).toEqual([[true, false], [true, false], [true, true], [false, true]]);
    // Act A: tunnel + hero passes. Act B: floor pass, plus a pieces-only matte pass once a piece has dropped in.
    const frameAt = (t: number) => kineticLyricCompositeV1.frame(cjk as unknown as Record<string, unknown>, t, Math.round(t * 30));
    expect(frameAt(0.5).passes.map(pass => pass.id)).toEqual(["tunnel", "hero"]);
    expect(frameAt(mid).passes.map(pass => pass.id)).toEqual(["tunnel", "hero", "floor"]);
    const late = frameAt(3.5);
    expect(late.passes.map(pass => pass.id)).toEqual(["floor", "pieces"]);
    // Floor pieces drop and bounce on engine keyframes.
    expect(late.passes[0].scene.segments[0].objects.filter(object => object.keyframes.length > 0).length).toBeGreaterThanOrEqual(5);
    expect(Object.keys(late.overlays).sort()).toEqual(["labels", "lockup"]);
  });
});
