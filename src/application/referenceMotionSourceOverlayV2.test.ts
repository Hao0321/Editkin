import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createEmptyProject } from "../domain/editGraph";
import { applyCommand, type EditorCommand } from "../domain/commands";
import { createHistory, dispatchCommand, redo, undo } from "../domain/history";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type MediaAsset, type MotionGraphic } from "../domain/types";
import { DEFAULT_REFERENCE_MOTION_STYLE, REFERENCE_MOTION_SOURCE_OVERLAY_V2_CONTRACT,
  type ReferenceMotionTemplateInput } from "../motion/referenceMotionTemplates";
import { motionGraphicV2FrameReceipt, motionGraphicV2LayoutReceipt, type MotionGraphicV2LayoutReceipt } from "../motion/compositionV2";
import { motionSceneContourInk, type MotionSceneInk } from "../motion/sceneCamera2d";
import { motionVectorPaths } from "../motion/vectorGeometry";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { prepareGlyphRun } from "../typography/preparedGlyphRun";
import { canonicalJson } from "../shared/canonicalJson";
import { verifyReferenceMotionPlan } from "../mcp/referenceMotionPlanVerification";
import type { ReferenceMotionPlan } from "./referenceMotionPlan";
import { referenceMotionTemplateSourceColorAdmitted } from "./referenceMotionTemplateCommands";
import { decodeProjectBytes, encodeProjectBytes, parseProject } from "./projectCodec";
import { inspectReferenceMotionTemplateInstance, prepareReferenceMotionTemplateInstance,
  prepareReferenceMotionTemplateRevision } from "./referenceMotionTemplateInstances";

// Graph metadata is synthetic (no file probe, rights or pixels). Glyphs use the real bundled font bytes and the
// observer reads emitted outlines frame by frame. Footage legibility itself stays a rendered-artifact review.
const faces = new Map<string, Uint8Array>();
async function physicalText(faceId: string, text: string) {
  let bytes = faces.get(faceId);
  if (!bytes) {
    bytes = new Uint8Array(await readFile(join(resolve("public/fonts"), bundledFontFaceSpec(faceId).fontFile)));
    faces.set(faceId, bytes);
  }
  return prepareGlyphRun(faceId, text, bytes);
}
function ids() {
  let ordinal = 0;
  return (prefix: string, role?: string) => `${prefix}-${role?.replaceAll(":", "-")}-${ordinal++}`;
}
const HLG = { interpretation: "auto", primaries: "bt2020", transfer: "arib-std-b67", matrix: "bt2020nc", range: "tv" } as const;
const BRAND = { palette: { surface: "#1a0f35", text: "#ffffff", accent: "#ffd23f", muted: "#9696b4", separator: "#8a5cff" },
  typography: { headingFamily: "Noto Sans TC", bodyFamily: "Noto Sans TC" }, animationSpeed: 1 };
const REGION = { x: .085, y: .34, width: .83, height: .24 };
// Hao's verified travel face (Bold-only physical family) runs through the same observers as Noto.
const TRAVEL_BRAND = { ...BRAND, typography: { headingFamily: "LXGW WenKai TC", bodyFamily: "LXGW WenKai TC" } };
type Variant = "portrait_kinetic" | "portrait_default_style" | "landscape_serif" | "portrait_travel_brand";
function fixture(variant: Variant = "portrait_kinetic", color: MediaAsset["color"] = { interpretation: "rec709" }) {
  const landscape = variant === "landscape_serif";
  const project = createEmptyProject("Synthetic on-footage editorial control", {
    id: `source-editorial-${variant}`, width: landscape ? 1920 : 1080, height: landscape ? 1080 : 1920, fps: 30,
  });
  project.assets = [{ id: "primary-media", name: "Synthetic source metadata", kind: "video", uri: "D:/synthetic/source-editorial.mov",
    duration: 20, width: landscape ? 1920 : 1080, height: landscape ? 1080 : 1920, color: structuredClone(color),
    provenance: "Synthetic graph only; not a file, rights or footage-content verification" }];
  project.tracks[0].clips = [{ id: "primary", trackId: project.tracks[0].id, assetId: "primary-media",
    timelineStart: 0, sourceStart: 1, duration: 11, volume: .6,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] }];
  const input: ReferenceMotionTemplateInput = {
    templateId: "strike_reframe", clipId: "primary", startFrame: 0, durationFrames: 330,
    strikePresentation: "semantic_replace_v1", strikeSurface: "source_overlay_v2", graphicCadence: "kinetic",
    previousText: "來看蝙蝠", title: "來看水簾", subtitle: "名字叫蝙蝠洞，但現在已經沒有蝙蝠", kicker: "桃園復興｜三民蝙蝠洞",
    brandMark: "Hao0321 Studio", sources: [], intent: landscape ? "standalone_showcase" : "shortform",
    evidenceRefs: ["synthetic:source-editorial"], purpose: "Synthetic on-footage editorial control; no rendered art or ownership assertion",
    ...(variant === "portrait_default_style" ? {} : { style: landscape ? { ...BRAND, typography: { headingFamily: "Noto Serif TC", bodyFamily: "Noto Sans TC" } }
      : variant === "portrait_travel_brand" ? TRAVEL_BRAND : BRAND }),
    ...(variant === "landscape_serif" ? {} : { textRegion: REGION }),
  };
  return { project: parseProject(project), input };
}
type Packet = Awaited<ReturnType<typeof prepareReferenceMotionTemplateInstance>>;
const savedControls = new Map<string, Promise<ReturnType<typeof fixture> & { packet: Packet; current: EditProject }>>();
function saved(variant: Variant = "portrait_kinetic", color?: MediaAsset["color"]) {
  const key = `${variant}:${canonicalJson(color ?? null)}`;
  if (!savedControls.has(key)) savedControls.set(key, (async () => {
    const f = fixture(variant, color);
    const packet = await prepareReferenceMotionTemplateInstance(f.project, f.input, ids(), { prepareText: physicalText });
    return { ...f, packet, current: applyCommand(f.project, { type: "batch", commands: packet.commands }) };
  })());
  return savedControls.get(key)!;
}
function sourceState(project: EditProject) {
  return canonicalJson({ assets: project.assets, tracks: project.tracks, captions: project.captions,
    colorManagement: project.colorManagement, width: project.width, height: project.height, fps: project.fps });
}
function roleGraphic(packet: Packet, role: string): MotionGraphic {
  const id = packet.instance.roles.find(row => row.key === role)?.id;
  const command = packet.commands.find(row => row.type === "add_motion_graphic" && row.graphic.id === id);
  if (!command || command.type !== "add_motion_graphic") throw new Error(`Actual ${role} command is absent`);
  return command.graphic;
}
function layoutFor(project: EditProject, graphic: MotionGraphic, layouts: readonly MotionGraphicV2LayoutReceipt[]) {
  if (graphic.vectorV2) return motionGraphicV2LayoutReceipt(project, graphic);
  const layout = layouts.find(row => row.graphicId === graphic.id);
  if (!layout?.physicalFont || layout.segments.some(segment => !segment.outline?.ink)) throw new Error("Observer requires actual physical text outlines");
  return layout;
}
const transformed = (ink: MotionSceneInk, x: number, y: number, scale: number): MotionSceneInk =>
  ({ xMin: x + ink.xMin * scale, yMin: y + ink.yMin * scale, xMax: x + ink.xMax * scale, yMax: y + ink.yMax * scale });
function glyphInk(project: EditProject, graphic: MotionGraphic, layout: MotionGraphicV2LayoutReceipt, frame: number) {
  const receipt = motionGraphicV2FrameReceipt(project, graphic, frame, layout);
  if (!receipt.visible) return [];
  return receipt.segments.flatMap(state => {
    if (state.opacity <= .001) return [];
    const segment = layout.segments.find(value => value.id === state.segmentId);
    if (!segment?.outline?.ink) throw new Error("Visible glyph lacks an actual outline");
    return [transformed(segment.outline.ink, segment.x + state.translateXPixels, segment.y + state.translateYPixels, state.scale)];
  });
}
function vectorInk(project: EditProject, graphic: MotionGraphic, layout: MotionGraphicV2LayoutReceipt, frame: number) {
  const receipt = motionGraphicV2FrameReceipt(project, graphic, frame, layout), state = receipt.vectorState;
  if (!receipt.visible || !state || state.opacity <= .001) return [];
  return motionVectorPaths(graphic, layout, receipt).flatMap(path => {
    const ink = motionSceneContourInk(path.svg);
    return ink ? [transformed(ink, layout.box.x + state.translateXPixels, layout.box.y + state.translateYPixels, state.scale)] : [];
  });
}
function settledInk(layout: MotionGraphicV2LayoutReceipt) {
  const bounds = layout.segments.filter(segment => segment.outline?.ink).map(segment => transformed(segment.outline!.ink!, segment.x, segment.y, 1));
  return { xMin: Math.min(...bounds.map(ink => ink.xMin)), xMax: Math.max(...bounds.map(ink => ink.xMax)),
    yMin: Math.min(...bounds.map(ink => ink.yMin)), yMax: Math.max(...bounds.map(ink => ink.yMax)) };
}
function isSettled(project: EditProject, graphic: MotionGraphic, layout: MotionGraphicV2LayoutReceipt, frame: number) {
  const receipt = motionGraphicV2FrameReceipt(project, graphic, frame, layout);
  return receipt.visible && receipt.segments.length > 0 && receipt.segments.every(state =>
    state.opacity === 1 && state.scale === 1 && state.translateXPixels === 0 && state.translateYPixels === 0);
}
const visibleText = (project: EditProject, packet: Packet, role: string, frame: number) => {
  const graphic = roleGraphic(packet, role);
  return glyphInk(project, graphic, layoutFor(project, graphic, packet.layouts), frame).length > 0;
};

/** Frame-by-frame structure of the editorial surface: no backing, source untouched, all ink on canvas, the claim and
 * the answer never together, location only with the claim, and a clean final tail. */
function observeEditorial(f: ReturnType<typeof fixture> & { packet: Packet; current: EditProject }) {
  const { project, current, packet } = f, frames = f.input.durationFrames;
  if (sourceState(project) !== sourceState(current)) throw new Error("Source picture or media/audio clock changed");
  if (current.motionGraphics.some(graphic => graphic.vectorV2 && graphic.vectorV2.kind !== "rule")) throw new Error("Editorial surface must not add backing vectors");
  const canvas = { xMin: 0, yMin: 0, xMax: current.width, yMax: current.height };
  let tail = 0;
  for (let frame = 0; frame < frames; frame++) {
    let any = false;
    for (const graphic of current.motionGraphics) {
      const layout = layoutFor(current, graphic, packet.layouts);
      const inks = graphic.vectorV2 ? vectorInk(current, graphic, layout, frame) : glyphInk(current, graphic, layout, frame);
      any ||= inks.length > 0;
      for (const ink of inks) if (ink.xMin < canvas.xMin - .03 || ink.yMin < canvas.yMin - .03 || ink.xMax > canvas.xMax + .03 || ink.yMax > canvas.yMax + .03) {
        throw new Error(`Visible ink leaves the source canvas at frame ${frame}`);
      }
    }
    if (visibleText(current, packet, "previous", frame) && visibleText(current, packet, "headline", frame)) throw new Error(`Claim and answer overlap at frame ${frame}`);
    if (visibleText(current, packet, "kicker", frame) && visibleText(current, packet, "headline", frame)) throw new Error(`Location persists into the answer at frame ${frame}`);
    tail = any ? 0 : tail + 1;
  }
  return { cleanTailFrames: tail };
}

describe("on-footage editorial strike (source_overlay_v2)", () => {
  it.each(["portrait_kinetic", "portrait_default_style", "landscape_serif", "portrait_travel_brand"] as const)("keeps the source untouched, adds no backing and ends on a clean tail (%s)", async variant => {
    const f = await saved(variant);
    const report = observeEditorial(f);
    // The answer holds for reading plus margin; the payoff then plays clean for at least the contract minimum.
    expect(report.cleanTailFrames).toBeGreaterThanOrEqual(Math.round(REFERENCE_MOTION_SOURCE_OVERLAY_V2_CONTRACT.cleanTailSeconds * 30));
    expect(f.packet.commands.every(command => command.type === "add_motion_graphic" || command.type === "upsert_reference_motion_instance")).toBe(true);
    expect(f.packet.instance.roles.map(role => role.key).sort()).toEqual(["brand-mark", "headline", "kicker", "previous", "strike", "subtitle"]);
    for (const role of ["kicker", "previous", "headline", "subtitle", "brand-mark"]) {
      const graphic = roleGraphic(f.packet, role);
      expect(graphic.shadowDepth).toBeGreaterThan(0); expect(graphic.shadowBlurPixels).toBeGreaterThan(0);
      expect(graphic.accentColor).toMatch(/^#000000[0-9a-f]{2}$/i);
      expect(parseInt(graphic.textColor.slice(1, 3), 16)).toBeGreaterThanOrEqual(0xf0);
    }
    const reopened = decodeProjectBytes(encodeProjectBytes(f.current));
    expect(sourceState(reopened)).toBe(sourceState(f.project)); expect(reopened.motionGraphics).toEqual(f.current.motionGraphics);
    expect((await inspectReferenceMotionTemplateInstance(reopened, f.packet.instance.id)).status).toBe("CURRENT");
  });

  it("is complete on the first frame, reads before the strike and holds the answer long enough", async () => {
    const f = await saved(), current = f.current;
    const claim = roleGraphic(f.packet, "previous"), location = roleGraphic(f.packet, "kicker"), headline = roleGraphic(f.packet, "headline");
    const strike = roleGraphic(f.packet, "strike"), subtitle = roleGraphic(f.packet, "subtitle");
    const claimLayout = layoutFor(current, claim, f.packet.layouts), headlineLayout = layoutFor(current, headline, f.packet.layouts);
    expect(isSettled(current, claim, claimLayout, 0)).toBe(true);
    expect(isSettled(current, location, layoutFor(current, location, f.packet.layouts), 0)).toBe(true);
    // The answer replaces the struck claim on the same measured first-ink line, at the same size.
    const firstInk = (layout: MotionGraphicV2LayoutReceipt) => Math.min(...layout.segments.map(segment => segment.y + segment.outline!.ink!.yMin));
    expect(headline.fontSize).toBe(claim.fontSize);
    expect(Math.abs(firstInk(headlineLayout) - firstInk(claimLayout))).toBeLessThan(.01);
    const strikeStart = Math.round(strike.timelineStart * 30), reading = (text: string) => Math.ceil((.65 + [...text].length / 8) * 30);
    expect(strikeStart).toBeGreaterThanOrEqual(Math.max(reading(claim.text), reading(location.text) - 30));
    let answerHold = 0, supportHold = 0;
    const subtitleLayout = layoutFor(current, subtitle, f.packet.layouts);
    for (let frame = 0; frame < f.input.durationFrames; frame++) {
      if (isSettled(current, headline, headlineLayout, frame)) answerHold++;
      if (isSettled(current, subtitle, subtitleLayout, frame)) supportHold++;
    }
    expect(answerHold).toBeGreaterThanOrEqual(reading(headline.text));
    expect(supportHold).toBeGreaterThanOrEqual(reading(subtitle.text));
    // The strike spans the claim's actual ink and sits on its optical middle.
    const ink = settledInk(claimLayout), rule = vectorInk(current, strike, layoutFor(current, strike, f.packet.layouts), strikeStart + 20)[0];
    expect(Math.abs(rule.xMin - ink.xMin)).toBeLessThan(1); expect(Math.abs(rule.xMax - ink.xMax)).toBeLessThan(1);
    expect(Math.abs((rule.yMin + rule.yMax) / 2 - (ink.yMin + ink.yMax) / 2)).toBeLessThan(1);
  });

  it("typesets one left ink column inside the observed region with ink-proportional rhythm", async () => {
    const f = await saved(), current = f.current, column = REGION.x * current.width;
    const inks = ["kicker", "previous", "headline", "subtitle", "brand-mark"].map(role => {
      const graphic = roleGraphic(f.packet, role);
      return { role, ink: settledInk(layoutFor(current, graphic, f.packet.layouts)) };
    });
    for (const { ink } of inks) {
      expect(Math.abs(ink.xMin - column)).toBeLessThan(.08 * 132);
      expect(ink.yMin).toBeGreaterThanOrEqual(REGION.y * current.height - 1);
      expect(ink.yMax).toBeLessThanOrEqual((REGION.y + REGION.height) * current.height + 1);
    }
    const at = (role: string) => inks.find(row => row.role === role)!.ink;
    expect(at("previous").yMin - at("kicker").yMax).toBeGreaterThan(8); expect(at("previous").yMin - at("kicker").yMax).toBeLessThan(.5 * 132);
    expect(at("subtitle").yMin - at("headline").yMax).toBeGreaterThan(8); expect(at("subtitle").yMin - at("headline").yMax).toBeLessThan(.5 * 132);
    expect(at("brand-mark").yMin - at("subtitle").yMax).toBeGreaterThan(4); expect(at("brand-mark").yMin - at("subtitle").yMax).toBeLessThan(60);
  });

  it("refuses copy that does not fit the observed quiet region instead of moving or shrinking it", async () => {
    const f = fixture(), observed = vi.fn(physicalText), before = canonicalJson(f.project);
    await expect(prepareReferenceMotionTemplateInstance(f.project, { ...f.input, textRegion: { ...REGION, height: .1 } }, ids(),
      { prepareText: observed })).rejects.toThrow(/留白範圍/);
    await expect(prepareReferenceMotionTemplateInstance(f.project, { ...f.input, previousText: "這是一句非常長而且必須分成兩行的舊說法" }, ids(),
      { prepareText: physicalText })).rejects.toThrow(/單行|閱讀|safe-area|auto-fit/);
    await expect(prepareReferenceMotionTemplateInstance(f.project, { ...f.input, strikeSurface: "source_overlay" }, ids(),
      { prepareText: physicalText })).rejects.toThrow(/textRegion|留白/);
    expect(canonicalJson(f.project)).toBe(before);
  });

  it("has its own recipe identity and leaves the explicit V1 overlay output intact", async () => {
    const f = await saved(), v1 = fixture(); v1.input.strikeSurface = "source_overlay"; delete v1.input.textRegion;
    const legacy = await prepareReferenceMotionTemplateInstance(v1.project, v1.input, ids(), { prepareText: physicalText });
    expect(f.packet.instance.dependencies.recipeVersion).toMatch(/^editkin\.reference-motion-recipes\/source-overlay-v2:/);
    expect(legacy.instance.dependencies.recipeVersion).toMatch(/^editkin\.reference-motion-recipes\/source-overlay-v1:/);
    expect(roleGraphic(legacy, "stage").vectorV2?.kind).toBe("panel");
    expect(legacy.instance.roles.some(role => role.key === "stage:grid")).toBe(true);
  });

  it("allows trusted v4 recompile and rejects an answer moved off the observed region", async () => {
    const f = await saved(), declaration: ReferenceMotionPlan = { schema: "editkin.reference-motion-plan/v1", instances: [{
      mode: "create", instanceId: f.packet.instance.id, commandIndexes: f.packet.commands.map((_, index) => index) }] };
    const environment = { ...process.env, EDITKIN_FONT_ROOT: resolve("public/fonts") };
    expect((await verifyReferenceMotionPlan(declaration, f.project, f.packet.commands, environment)).instanceCount).toBe(1);
    const commands: EditorCommand[] = structuredClone(f.packet.commands);
    const id = f.packet.instance.roles.find(role => role.key === "headline")!.id;
    const moved = commands.find(command => command.type === "add_motion_graphic" && command.graphic.id === id);
    if (!moved || moved.type !== "add_motion_graphic") throw new Error("Tamper control needs the compiled answer");
    moved.graphic.y = .7;
    await expect(verifyReferenceMotionPlan(declaration, f.project, commands, environment)).rejects.toThrow(/independently recompiled/);
  });

  it("revises a saved standalone strike to the editorial surface with an observed region, one Undo/Redo and byte CURRENT", async () => {
    const f = fixture(); f.input.strikeSurface = "standalone"; delete f.input.textRegion;
    const original = await prepareReferenceMotionTemplateInstance(f.project, f.input, ids(), { prepareText: physicalText });
    const current = applyCommand(f.project, { type: "batch", commands: original.commands }), before = sourceState(current);
    const revised = await prepareReferenceMotionTemplateRevision(current, original.instance.id, { strikeSurface: "source_overlay_v2", textRegion: REGION },
      { expectedInstanceRevision: 1, prepareText: physicalText, idFactory: ids() });
    for (const role of original.instance.roles.filter(row => revised.instance.roles.some(next => next.key === row.key))) {
      expect(revised.instance.roles.find(row => row.key === role.key)?.id).toBe(role.id);
    }
    const history = dispatchCommand(createHistory(current), { type: "batch", commands: revised.commands });
    expect(history.past).toHaveLength(1); expect(sourceState(history.present)).toBe(before);
    const reopened = decodeProjectBytes(encodeProjectBytes(history.present));
    expect(reopened.referenceMotionInstances![0].input).toMatchObject({ strikeSurface: "source_overlay_v2", textRegion: REGION });
    expect((await inspectReferenceMotionTemplateInstance(reopened, original.instance.id)).status).toBe("CURRENT");
    const undone = undo(history); expect(undone.present.motionGraphics).toEqual(current.motionGraphics);
    expect(redo(undone).present.motionGraphics).toEqual(history.present.motionGraphics);
    await expect(prepareReferenceMotionTemplateRevision(current, original.instance.id, { textRegion: REGION },
      { expectedInstanceRevision: 1, prepareText: physicalText, idFactory: ids() })).rejects.toThrow(/source_overlay_v2/);
  });
});

describe("template source colour admission for camera HLG", () => {
  const rec709Project = () => fixture().project;
  const asset = (color: MediaAsset["color"]): MediaAsset => ({ id: "a", name: "a", kind: "video", uri: "D:/synthetic/a.mov", duration: 9, color });
  it("keeps explicit Rec.709 and admits complete camera HLG or tagged auto SDR only in a rec709-mode project", () => {
    const project = rec709Project();
    expect(referenceMotionTemplateSourceColorAdmitted(project, asset({ interpretation: "rec709" }), false)).toBe(true);
    expect(referenceMotionTemplateSourceColorAdmitted(project, asset(undefined), false)).toBe(true);
    expect(referenceMotionTemplateSourceColorAdmitted(project, asset({ ...HLG }), false)).toBe(true);
    expect(referenceMotionTemplateSourceColorAdmitted(project, asset({ ...HLG, interpretation: "hlg" }), false)).toBe(true);
    expect(referenceMotionTemplateSourceColorAdmitted(project, asset({ interpretation: "auto", primaries: "bt709", transfer: "bt709", matrix: "bt709", range: "tv" }), false)).toBe(true);
  });
  it("rejects HLG under ACES2 or native paint, PQ, Log, untagged auto, incomplete and contradictory tags", () => {
    const project = rec709Project(), aces = { ...rec709Project(), colorManagement: { ...rec709Project().colorManagement!, mode: "aces2" as const } };
    expect(referenceMotionTemplateSourceColorAdmitted(aces, asset({ ...HLG }), false)).toBe(false);
    expect(referenceMotionTemplateSourceColorAdmitted(project, asset({ ...HLG }), true)).toBe(false);
    expect(referenceMotionTemplateSourceColorAdmitted(project, asset({ ...HLG, transfer: "smpte2084" }), false)).toBe(false);
    expect(referenceMotionTemplateSourceColorAdmitted(project, asset({ interpretation: "apple_log" }), false)).toBe(false);
    expect(referenceMotionTemplateSourceColorAdmitted(project, asset({ interpretation: "auto" }), false)).toBe(false);
    expect(referenceMotionTemplateSourceColorAdmitted(project, asset({ ...HLG, matrix: undefined }), false)).toBe(false);
    expect(referenceMotionTemplateSourceColorAdmitted(project, asset({ ...HLG, interpretation: "hlg", transfer: "bt709", primaries: "bt709", matrix: "bt709" }), false)).toBe(false);
    expect(referenceMotionTemplateSourceColorAdmitted(project, asset({ interpretation: "linear_rec709" }), false)).toBe(false);
  });
  it("compiles the editorial strike over a tagged HLG camera source without touching its colour, geometry or clock", async () => {
    const f = await saved("portrait_kinetic", { ...HLG });
    expect(f.current.assets[0].color).toEqual(f.project.assets[0].color);
    observeEditorial(f);
    const pq = fixture("portrait_kinetic", { ...HLG, transfer: "smpte2084" });
    await expect(prepareReferenceMotionTemplateInstance(pq.project, pq.input, ids(), { prepareText: physicalText })).rejects.toThrow(/Rec\.709/);
  });
});
