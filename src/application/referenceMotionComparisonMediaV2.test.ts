import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { applyCommand } from "../domain/commands";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type MotionGraphic } from "../domain/types";
import { floatingFrameLayout } from "../motion/floatingVideoFrame";
import { motionGraphicV2FrameReceipt, motionGraphicV2LayoutReceipt, motionGraphicV2PhysicalLayoutReceipt } from "../motion/compositionV2";
import { referenceMotionTemplateInputSchema, type ReferenceMotionTemplateInput } from "../motion/referenceMotionTemplates";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { prepareGlyphRun, type PreparedGlyphRun } from "../typography/preparedGlyphRun";
import { parseProject } from "./projectCodec";
import { buildReferenceMotionTemplateCommands, type ReferenceMotionTemplateCompileOptions } from "./referenceMotionTemplateCommands";

const faceId = "EditkinFace-bebas-neue-400";
const runs = new Map<string, PreparedGlyphRun>();
beforeAll(async () => {
  // Actual compiled font bytes and factory-branded runs. Media entries are
  // controlled source graphs, not decoded media or art acceptance receipts.
  const bytes = new Uint8Array(await readFile(join(resolve("public/fonts"), bundledFontFaceSpec(faceId).fontFile)));
  for (const text of ["COMPARE", "EVIDENCE", "SOURCE A", "SOURCE B", "LOOK CLOSELY"]) {
    runs.set(text, await prepareGlyphRun(faceId, text, bytes));
  }
});

function fixture(): EditProject {
  const project = parseProject(createEmptyProject("Comparison contain source", { id: "comparison-soft", width: 1080, height: 1920, fps: 30 }));
  project.assets.push({ id: "landscape", name: "Owned landscape", kind: "video", uri: "D:/owned/comparison-landscape.mp4",
    duration: 24, width: 1920, height: 1080, displayAspectRatio: 16 / 9, color: { interpretation: "rec709" } },
  { id: "portrait", name: "Owned portrait", kind: "video", uri: "D:/owned/comparison-portrait.mp4",
    duration: 24, width: 1080, height: 1920, displayAspectRatio: 9 / 16, color: { interpretation: "rec709" } });
  project.tracks[0].clips.push({ id: "main", assetId: "landscape", trackId: project.tracks[0].id,
    timelineStart: 0, sourceStart: 1, duration: 18, volume: .7, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR },
    keyframes: [], expressions: {}, layer: { enabled: true, blendMode: "normal", role: "content" } });
  return project;
}
function input(): ReferenceMotionTemplateInput {
  return { templateId: "comparison_pair", clipId: "main", startFrame: 0, durationFrames: 540,
    title: "COMPARE", kicker: "EVIDENCE", primaryLabel: "SOURCE A", subtitle: "LOOK CLOSELY",
    sources: [{ assetId: "portrait", sourceStart: 2, label: "SOURCE B" }], mediaPresentation: "source_soft_v2",
    purpose: "Two independently declared source views with one listening reference", evidenceRefs: ["fixture:original-comparison-brief"],
    style: { palette: { surface: "#FFFFFF", text: "#172033", accent: "#175CD3", muted: "#5B6678", separator: "#D8DEE8" },
      typography: { headingFamily: "Bebas Neue", bodyFamily: "Bebas Neue" }, animationSpeed: 1 } };
}
function physical(project: EditProject): ReferenceMotionTemplateCompileOptions {
  return { generation: 2, allocateRoleId: role => `role-${role.key.replaceAll(":", "-")}`,
    layoutForGraphic: (graphic: MotionGraphic) => {
      const run = runs.get(graphic.text);
      if (!run) throw new Error(`No real fixture glyph run for ${graphic.text}`);
      return motionGraphicV2PhysicalLayoutReceipt(project, graphic, run);
    } };
}
function compile(project: EditProject, value = input(), options = physical(project)) {
  let serial = 0;
  return buildReferenceMotionTemplateCommands(project, value, prefix => `${prefix}-${serial++}`, options);
}
const clips = (project: EditProject) => project.tracks.flatMap(track => track.clips);

describe("comparison source soft v2 physical media presentation", () => {
  it("contains mixed upright source corners in two distinct matte apertures with real physical text", () => {
    const project = fixture(), before = structuredClone(project), packet = compile(project);
    expect(project).toEqual(before);
    expect(packet.status).toBe("REVIEW_REQUIRED");
    expect(packet.mediaBindings).toEqual([]);
    expect(packet.floatingMediaBindings).toHaveLength(2);
    const projected = packet.floatingMediaBindings!.map((binding, index) => {
      expect(binding.floatingFrame).toMatchObject({ schema: "editkin.floating-video-frame/v2", style: "matte", aspect: "source",
        mediaFit: "contain", size: .405,
        yawDegrees: 0, pitchDegrees: 0, motion: { entranceFrames: 0, exitFrames: 0, travelY: 0 } });
      expect(binding.floatingFrame.centerX).toBeCloseTo(index === 0 ? .2675 : .7325, 12);
      expect(binding.floatingFrame.centerY).toBeCloseTo(.505, 12);
      const { geometry, sourceFit, sourceContentRect: content } = binding.layout;
      const ratio = index === 0 ? 16 / 9 : 9 / 16;
      expect(content.width / content.height).toBeCloseTo(ratio, 10);
      expect(content.left).toBeGreaterThanOrEqual(sourceFit.left);
      expect(content.top).toBeGreaterThanOrEqual(sourceFit.top);
      expect(content.left + content.width).toBeLessThanOrEqual(sourceFit.left + sourceFit.width + 1e-9);
      expect(content.top + content.height).toBeLessThanOrEqual(sourceFit.top + sourceFit.height + 1e-9);
      expect(sourceFit.cropped).toBe(false);
      expect(sourceFit.left).toBeGreaterThan(0); // Opaque rounded/feather buffer, not a corner crop.
      const maxWidth = project.width * .405, maxHeight = project.height * .405;
      expect(geometry.innerWidth).toBe(Math.floor(Math.min(maxWidth, maxHeight * ratio) / 2) * 2);
      expect(geometry.innerHeight).toBe(Math.floor(Math.min(maxHeight, maxWidth / ratio) / 2) * 2);
      // At zero yaw/pitch the true shared homography is a canvas translation.
      const left = geometry.left + geometry.border + content.left + (binding.floatingFrame.centerX! - .5) * project.width;
      const top = geometry.top + geometry.border + content.top + .005 * project.height;
      // Existing entrance keys add only +/-18px, settling to zero; include that interval.
      expect(left - 18).toBeGreaterThanOrEqual(0);
      expect(left + content.width + 18).toBeLessThanOrEqual(project.width);
      expect(top).toBeGreaterThanOrEqual(0);
      expect(top + content.height).toBeLessThanOrEqual(project.height);
      return { left, right: left + content.width };
    });
    expect(projected[0].right + 36).toBeLessThan(projected[1].left);
    expect(packet.commands.some(command => command.type === "set_clip_layout" || command.type === "add_clip_mask")).toBe(false);
    expect(packet.roles!.some(role => role.kind === "mask")).toBe(false);
    expect(packet.layouts.filter(layout => layout.physicalFont).length).toBeGreaterThan(0);
    for (const layout of packet.layouts.filter(layout => layout.physicalFont)) {
      expect(layout.physicalFont!.fontSha256).toBe(bundledFontFaceSpec(faceId).sha256);
      expect(layout.segments.every(segment => !!segment.outline?.svg && !!segment.outline?.ass)).toBe(true);
    }
  });

  it("gives measured SAR and upright rotated DAR priority over encoded dimensions", () => {
    const project = fixture();
    project.assets[0].width = 720; project.assets[0].height = 576; project.assets[0].displayAspectRatio = 16 / 9;
    project.assets[1].width = 360; project.assets[1].height = 640; project.assets[1].displayAspectRatio = 9 / 16;
    const packet = compile(project), sameDisplay = compile(fixture());
    expect(packet.floatingMediaBindings!.map(binding => binding.layout)).toEqual(sameDisplay.floatingMediaBindings!.map(binding => binding.layout));
    const first = packet.floatingMediaBindings![0].layout.sourceContentRect;
    expect(first.width / first.height).toBeCloseTo(16 / 9, 10);
    expect(Math.abs(first.width / first.height - 720 / 576)).toBeGreaterThan(.5);
    expect(packet.floatingMediaBindings![1].layout.sourceContentRect.width / packet.floatingMediaBindings![1].layout.sourceContentRect.height)
      .toBeCloseTo(9 / 16, 10);
  });

  it("preserves window semantic identities source clocks and primary audio while using only clip entrance keys", () => {
    const project = fixture(); project.tracks[0].clips[0].timelineStart = 3;
    const packet = compile(project, { ...input(), startFrame: 90 }), applied = applyCommand(project, { type: "batch", commands: packet.commands });
    const main = clips(applied).find(clip => clip.id === "main")!, secondary = clips(applied).find(clip => clip.assetId === "portrait")!;
    expect(main).toMatchObject({ id: "main", assetId: "landscape", trackId: project.tracks[0].id, timelineStart: 3, sourceStart: 1, duration: 18, volume: .7 });
    expect(secondary).toMatchObject({ id: "role-source-1-clip", trackId: "role-source-1-track", assetId: "portrait", timelineStart: 3, sourceStart: 2, duration: 18, volume: 0 });
    expect(clips(applied).filter(clip => clip.volume > 0)).toHaveLength(1);
    expect(applied.assets).toEqual(project.assets);
    expect(packet.sourceContinuity).toMatchObject({ primaryClipId: "main", playbackRate: 1, originalAudioUnchanged: true });
    expect(packet.phases[0]).toEqual({ role: "reveal", startFrame: 90, endFrame: 100 });
    for (const [index, clip] of [main, secondary].entries()) {
      expect(clip).not.toHaveProperty("layout");
      expect(clip.masks ?? []).toEqual([]);
      expect(clip.keyframes.map(key => key.time)).toEqual([0, 10 / 30]);
      expect(clip.keyframes[0].transform).toMatchObject({ opacity: 0, x: index === 0 ? -18 : 18 });
      expect(clip.keyframes[1].transform).toMatchObject({ opacity: 1, x: 0 });
      const frames = [539, 0, 270, 10, 539];
      const layouts = frames.map(localFrame => floatingFrameLayout(clip.floatingFrame!, project.width, project.height,
        { width: project.assets[index].displayAspectRatio!, height: 1, fps: 30, durationFrames: 540, localFrame }));
      expect(layouts.every(layout => layout.opacity === 1 && layout.visible)).toBe(true);
      expect(layouts[0]).toEqual(layouts[4]);
      expect(layouts[0]).toEqual(packet.floatingMediaBindings![index].layout);
    }
  });

  it("keeps omitted and explicit legacy presentation byte equivalent without adding floating receipts", () => {
    const project = fixture(), historic = input(); delete historic.mediaPresentation;
    expect(referenceMotionTemplateInputSchema.parse(historic)).not.toHaveProperty("mediaPresentation");
    const omitted = compile(project, historic), explicit = compile(project, { ...historic, mediaPresentation: "legacy_layout" });
    expect(JSON.stringify(explicit)).toBe(JSON.stringify(omitted));
    expect(omitted).not.toHaveProperty("floatingMediaBindings");
    expect(omitted.mediaBindings).toHaveLength(2);
    expect(omitted.commands.filter(command => command.type === "add_clip_mask")).toHaveLength(2);
    expect(omitted.commands.some(command => command.type === "set_clip_floating_frame")).toBe(false);
    let serial = 0;
    const legacyDirect = buildReferenceMotionTemplateCommands(project, historic, prefix => `legacy-${prefix}-${serial++}`);
    expect(legacyDirect.schema).toBe("editkin.reference-motion-template/v1");
    expect(legacyDirect).not.toHaveProperty("floatingMediaBindings");
  });

  it("rejects unsupported families focus cropping and unknown presentation before physical work", () => {
    const project = fixture(), before = structuredClone(project), provider = vi.fn(physical(project).layoutForGraphic), options = { ...physical(project), layoutForGraphic: provider };
    for (const templateId of ["strike_reframe", "level_bridge", "context_stack", "evidence_takeover", "focus_wall", "brand_recap", "kinetic_network"] as const) {
      expect(() => compile(project, { ...input(), templateId }, options)).toThrow(/source_soft_v2/);
    }
    expect(() => compile(project, { ...input(), focusRegion: { x: .1, y: .1, width: .8, height: .8 } }, options)).toThrow(/source_soft_v2/);
    expect(() => compile(project, { ...input(), mediaPresentation: "cover" } as unknown as ReferenceMotionTemplateInput, options)).toThrow();
    expect(provider).not.toHaveBeenCalled();
    expect(project).toEqual(before);
  });

  it("requires explicit physical generation two instead of falling back to the direct estimated compiler", () => {
    const project = fixture(), before = structuredClone(project), allocate = vi.fn((prefix: string) => `${prefix}-never`);
    expect(() => buildReferenceMotionTemplateCommands(project, input(), allocate)).toThrow(/generation 2.*physical/);
    expect(() => buildReferenceMotionTemplateCommands(project, input(), allocate,
      { generation: 1 } as unknown as ReferenceMotionTemplateCompileOptions)).toThrow(/physical layout provider/);
    expect(allocate).not.toHaveBeenCalled();
    expect(project).toEqual(before);
  });

  it("rejects missing nonfinite or unmeasured source geometry before physical work", () => {
    const provider = vi.fn();
    for (const displayAspectRatio of [undefined, 0, -1, Infinity, NaN]) {
      const project = fixture(); project.assets[1].displayAspectRatio = displayAspectRatio;
      expect(() => compile(project, input(), { generation: 2, layoutForGraphic: provider })).toThrow(/display aspect ratio/);
    }
    for (const width of [undefined, 0, 1920.5, Infinity]) {
      const project = fixture(); project.assets[0].width = width;
      expect(() => compile(project, input(), { generation: 2, layoutForGraphic: provider })).toThrow(/來源寬高/);
    }
    expect(provider).not.toHaveBeenCalled();
  });

  it("reopens exact floating geometry and shared glyph receipts and blocks estimated text fallback", () => {
    const project = fixture(), packet = compile(project);
    const applied = applyCommand(project, { type: "batch", commands: packet.commands });
    const reopened = parseProject(JSON.parse(JSON.stringify(applied)));
    expect(reopened).toEqual(applied);
    expect(reopened.motionScenes ?? []).toEqual([]);
    for (const binding of packet.floatingMediaBindings!) {
      expect(clips(reopened).find(clip => clip.id === binding.clipId)!.floatingFrame).toEqual(binding.floatingFrame);
    }
    for (const graphic of reopened.motionGraphics.filter(graphic => !graphic.vectorV2)) {
      const layout = packet.layouts.find(layout => layout.graphicId === graphic.id)!;
      const last = Math.round((graphic.timelineStart + graphic.duration) * project.fps) - 1;
      const expected = motionGraphicV2FrameReceipt(reopened, graphic, last, layout);
      motionGraphicV2FrameReceipt(reopened, graphic, Math.round(graphic.timelineStart * project.fps), layout);
      expect(motionGraphicV2FrameReceipt(reopened, graphic, last, layout)).toEqual(expected);
    }
    expect(() => compile(project, input(), { generation: 2,
      layoutForGraphic: graphic => motionGraphicV2LayoutReceipt(project, graphic) })).toThrow(/physical glyph/);
  });
});
