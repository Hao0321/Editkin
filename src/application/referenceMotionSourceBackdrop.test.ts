import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createEmptyProject } from "../domain/editGraph";
import { applyCommand } from "../domain/commands";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type MotionGraphic } from "../domain/types";
import { REFERENCE_MOTION_SOURCE_BACKDROP_CONTRACT, referenceMotionTemplateInputSchema, type ReferenceMotionTemplateInput } from "../motion/referenceMotionTemplates";
import { type MotionGraphicV2LayoutReceipt } from "../motion/compositionV2";
import { effectFilters } from "../render/creativeFilters";
import { previewEffectFilter } from "../creative/corePack";
import { initializeStudioCreativeAssets } from "../creative/studioAssets";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { prepareGlyphRun } from "../typography/preparedGlyphRun";
import { decodeProjectBytes, encodeProjectBytes, parseProject } from "./projectCodec";
import { inspectReferenceMotionTemplateInstance, prepareReferenceMotionTemplateInstance,
  prepareReferenceMotionTemplateRevision } from "./referenceMotionTemplateInstances";

// Synthetic graph metadata (no file probe, rights or pixels); real bundled glyph bytes; settled outlines observed.
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
const BRAND = { palette: { surface: "#1a0f35", text: "#ffffff", accent: "#ffd23f", muted: "#9696b4", separator: "#8a5cff" },
  typography: { headingFamily: "Noto Sans TC", bodyFamily: "Noto Sans TC" }, animationSpeed: 1 };
// Hao's verified travel face (Bold-only physical family).
const TRAVEL_BRAND = { ...BRAND, typography: { headingFamily: "LXGW WenKai TC", bodyFamily: "LXGW WenKai TC" } };
type Family = "comparison_pair" | "evidence_takeover" | "focus_wall";
const COPY: Record<Family, Partial<ReferenceMotionTemplateInput>> = {
  comparison_pair: { kicker: "新莊｜豐衣足食", title: "同樣的皮 兩種做法", primaryLabel: "紅油抄手 皮薄透餡", subtitle: "同一張皮，一盤煮一盤炸" },
  evidence_takeover: { kicker: "大溪老街｜蔡記", title: "現做麥芽花生糖", subtitle: "鋪粉、壓條全程看得到" },
  focus_wall: { kicker: "新莊｜豐衣足食", title: "我點了四道來驗", primaryLabel: "紅油抄手 皮薄到透餡" },
};
const SOURCE_LABELS = ["再炸一盤 起泡翹邊", "排骨蛋炒飯", "蔥鹽雞"];
function fixture(family: Family, brand: "default" | "travel" = "default") {
  const project = createEmptyProject("Synthetic source backdrop control", { id: `backdrop-${family}`, width: 1080, height: 1920, fps: 30 });
  const extra = family === "comparison_pair" ? 1 : family === "focus_wall" ? 3 : 0;
  project.assets = Array.from({ length: extra + 1 }, (_, index) => ({ id: `media-${index}`, name: `Synthetic source ${index}`, kind: "video" as const,
    uri: `D:/synthetic/backdrop-${index}.mov`, duration: 30, width: 1080, height: 1920, displayAspectRatio: 9 / 16,
    color: { interpretation: "rec709" as const }, provenance: "Synthetic graph only; not a file, rights or footage-content verification" }));
  project.tracks[0].clips = [{ id: "primary", trackId: project.tracks[0].id, assetId: "media-0", timelineStart: 0, sourceStart: 1,
    duration: 12, volume: .7, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] }];
  const input = { templateId: family, clipId: "primary", startFrame: 0, durationFrames: 360, graphicCadence: "kinetic",
    windowPresentation: "source_backdrop_v1", intent: "shortform", style: brand === "travel" ? TRAVEL_BRAND : BRAND,
    sources: Array.from({ length: extra }, (_, index) => ({ assetId: `media-${index + 1}`, sourceStart: 2, label: SOURCE_LABELS[index] })),
    evidenceRefs: ["synthetic:backdrop"], purpose: "Synthetic source backdrop control; no rendered art or ownership assertion",
    ...COPY[family] } as ReferenceMotionTemplateInput;
  return { project: parseProject(project), input };
}
type Packet = Awaited<ReturnType<typeof prepareReferenceMotionTemplateInstance>>;
const cache = new Map<string, Promise<ReturnType<typeof fixture> & { packet: Packet; current: EditProject }>>();
function saved(family: Family, brand: "default" | "travel" = "default") {
  const key = `${family}:${brand}`;
  if (!cache.has(key)) cache.set(key, (async () => {
    const f = fixture(family, brand);
    const packet = await prepareReferenceMotionTemplateInstance(f.project, f.input, ids(), { prepareText: physicalText });
    return { ...f, packet, current: applyCommand(f.project, { type: "batch", commands: packet.commands }) };
  })());
  return cache.get(key)!;
}
const clips = (project: EditProject) => project.tracks.flatMap(track => track.clips);
const role = (packet: Packet, key: string) => packet.instance.roles.find(row => row.key === key)?.id;
function settledInk(layouts: readonly MotionGraphicV2LayoutReceipt[], graphic: MotionGraphic) {
  const layout = layouts.find(row => row.graphicId === graphic.id)!;
  const inks = layout.segments.filter(segment => segment.outline?.ink).map(segment => ({ left: segment.x + segment.outline!.ink!.xMin,
    right: segment.x + segment.outline!.ink!.xMax, top: segment.y + segment.outline!.ink!.yMin, bottom: segment.y + segment.outline!.ink!.yMax }));
  return { left: Math.min(...inks.map(i => i.left)), right: Math.max(...inks.map(i => i.right)), top: Math.min(...inks.map(i => i.top)), bottom: Math.max(...inks.map(i => i.bottom)) };
}

describe("window families over the same image enlarged and softly blurred (source_backdrop_v1)", () => {
  it.each([["comparison_pair", "default"], ["evidence_takeover", "default"], ["focus_wall", "default"], ["comparison_pair", "travel"],
    ["evidence_takeover", "travel"], ["focus_wall", "travel"]] as const)("keeps the primary as the blurred backdrop with its audio and clock (%s, %s brand)", async (family, brand) => {
    const f = await saved(family, brand), primary = clips(f.current).find(clip => clip.id === "primary")!;
    const before = clips(f.project).find(clip => clip.id === "primary")!;
    expect(primary.transform).toEqual({ ...DEFAULT_TRANSFORM, scale: REFERENCE_MOTION_SOURCE_BACKDROP_CONTRACT.backdrop.scale });
    expect(primary.creative?.effectPresetIds).toEqual([REFERENCE_MOTION_SOURCE_BACKDROP_CONTRACT.backdrop.effectPresetId]);
    expect([primary.volume, primary.sourceStart, primary.timelineStart, primary.duration, primary.assetId, primary.trackId])
      .toEqual([before.volume, before.sourceStart, before.timelineStart, before.duration, before.assetId, before.trackId]);
    expect(primary.layout).toBeUndefined(); expect(primary.floatingFrame).toBeUndefined();
    expect(role(f.packet, "source:0:clip")).toBe("primary");
    // Every window is a silent clone on its own track; nothing draws a stage panel, grid or header box.
    const windows = clips(f.current).filter(clip => clip.id !== "primary");
    expect(windows.length).toBeGreaterThan(0);
    for (const window of windows) { expect(window.volume).toBe(0); expect(window.trackId).not.toBe(primary.trackId); }
    expect(f.current.motionGraphics.some(graphic => graphic.vectorV2?.kind === "panel" || graphic.vectorV2?.kind === "line_grid")).toBe(false);
    for (const graphic of f.current.motionGraphics) {
      expect(graphic.shadowBlurPixels).toBeGreaterThan(0);
      expect(parseInt(graphic.textColor.slice(1, 3), 16)).toBeGreaterThanOrEqual(0xf0);
      if (brand === "travel") expect(graphic.fontFamily).toBe("LXGW WenKai TC");
    }
    expect(f.packet.instance.dependencies.recipeVersion).toMatch(/^editkin\.reference-motion-recipes\/source-backdrop-v1:/);
    expect(f.packet.instance.primaryBefore).toMatchObject({ layout: null, transform: { ...DEFAULT_TRANSFORM }, creative: null });
    const reopened = decodeProjectBytes(encodeProjectBytes(f.current));
    expect(reopened.motionGraphics).toEqual(f.current.motionGraphics); expect(reopened.tracks).toEqual(f.current.tracks);
    expect((await inspectReferenceMotionTemplateInstance(reopened, f.packet.instance.id)).status).toBe("CURRENT");
  });

  it("sets each comparison label under its own window and keeps the band above both windows", async () => {
    const f = await saved("comparison_pair");
    expect(f.packet.instance.input.mediaPresentation).toBe("legacy_layout");
    const windows = ["source:0:window:clip", "source:1:clip"].map(key => clips(f.current).find(clip => clip.id === role(f.packet, key))!);
    // Rounded, feathered source-ratio windows; no floating passe-partout.
    for (const window of windows) { expect(window.floatingFrame).toBeUndefined(); expect(window.layout).toBeDefined(); expect(window.masks?.length).toBe(1); }
    const title = f.current.motionGraphics.find(graphic => graphic.id === role(f.packet, "headline"))!;
    const titleInk = settledInk(f.packet.layouts, title);
    const inks = windows.map((window, index) => {
      const view = window.layout!.viewport, W = f.current.width, H = f.current.height;
      const label = f.current.motionGraphics.find(graphic => graphic.id === role(f.packet, `source:${index}:label`))!;
      const ink = settledInk(f.packet.layouts, label);
      expect(ink.top).toBeGreaterThan((view.y + view.height) * H);
      expect(ink.left).toBeGreaterThanOrEqual(view.x * W - 1); expect(ink.right).toBeLessThanOrEqual((view.x + view.width) * W + 1);
      expect(titleInk.bottom).toBeLessThan(view.y * H);
      return ink;
    });
    // The two labels belong to two different windows: they never share space.
    expect(inks[0].right).toBeLessThan(inks[1].left);
  });

  it("lets the synced window take over only after the title has read and left, then states the evidence after the hand-back", async () => {
    const f = await saved("evidence_takeover");
    const window = clips(f.current).find(clip => clip.id === role(f.packet, "source:0:window:clip"))!;
    expect([window.assetId, window.sourceStart, window.timelineStart, window.duration]).toEqual(["media-0", 1, 0, 12]);
    const settle = window.keyframes.find(key => key.id === role(f.packet, "source:0:window:focus-settle"))!;
    const title = f.current.motionGraphics.find(graphic => graphic.id === role(f.packet, "headline"))!;
    const takeoverStart = window.keyframes.find(key => key.id === role(f.packet, "source:0:window:hold-end"))!.time;
    expect(title.timelineStart + title.duration).toBeLessThanOrEqual(takeoverStart + 1e-9);
    expect(settle.transform.scale).toBeGreaterThan(1);
    const subtitle = f.current.motionGraphics.find(graphic => graphic.id === role(f.packet, "subtitle"))!;
    const returned = window.keyframes.find(key => key.id === role(f.packet, "source:0:window:return-settle"))!.time;
    expect(subtitle.timelineStart).toBeGreaterThanOrEqual(returned - 1e-9);
  });

  it("focuses one wall source by a continuous foreground clone and labels it after the focus settles", async () => {
    const f = await saved("focus_wall");
    const cells = ["source:0:window:clip", "source:1:clip", "source:2:clip", "source:3:clip"].map(key => clips(f.current).find(clip => clip.id === role(f.packet, key))!);
    expect(cells.map(cell => cell.assetId)).toEqual(["media-0", "media-1", "media-2", "media-3"]);
    const foreground = clips(f.current).find(clip => clip.id === role(f.packet, "source:0:foreground:clip"))!;
    const settle = foreground.keyframes.find(key => key.id === role(f.packet, "source:0:foreground:focus-settle"))!;
    const label = f.current.motionGraphics.find(graphic => graphic.id === role(f.packet, "source:0:foreground:label"))!;
    expect(label.timelineStart).toBeGreaterThanOrEqual(settle.time - 1e-9);
    expect(label.text).toBe(COPY.focus_wall.primaryLabel);
  });

  it("revises the copy and font from a scratch project that restores the user's own clip", async () => {
    const f = await saved("comparison_pair");
    const revised = await prepareReferenceMotionTemplateRevision(f.current, f.packet.instance.id,
      { title: "同一張皮 兩種吃法", style: { typography: { headingFamily: "LXGW WenKai TC", bodyFamily: "LXGW WenKai TC" } } },
      { expectedInstanceRevision: 1, prepareText: physicalText, idFactory: ids() });
    const next = applyCommand(f.current, { type: "batch", commands: revised.commands });
    const primary = clips(next).find(clip => clip.id === "primary")!;
    expect(primary.creative?.effectPresetIds).toEqual([REFERENCE_MOTION_SOURCE_BACKDROP_CONTRACT.backdrop.effectPresetId]);
    expect(next.motionGraphics.find(graphic => graphic.id === role(f.packet, "headline"))!.text).toBe("同一張皮 兩種吃法");
    expect((await inspectReferenceMotionTemplateInstance(next, f.packet.instance.id)).status).toBe("CURRENT");
  });

  it("admits the backdrop only for the window families and renders it as an output-pixel blur plus RGB dim", () => {
    const f = fixture("comparison_pair");
    for (const patch of [{ templateId: "level_bridge" }, { overlayPresentation: "source_editorial_v1" }, { mediaPresentation: "source_soft_v2" }]) {
      expect(referenceMotionTemplateInputSchema.safeParse({ ...f.input, ...patch }).success).toBe(false);
    }
    initializeStudioCreativeAssets();
    const clip = { ...clips(f.project)[0], creative: { effectPresetIds: [REFERENCE_MOTION_SOURCE_BACKDROP_CONTRACT.backdrop.effectPresetId] } };
    expect(effectFilters(clip)).toEqual(["gblur=sigma=30:steps=3", "colorchannelmixer=rr=0.68:gg=0.68:bb=0.68"]);
    expect(previewEffectFilter([REFERENCE_MOTION_SOURCE_BACKDROP_CONTRACT.backdrop.effectPresetId])).toContain("blur(");
  });
});
