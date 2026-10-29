import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { applyCommand, type EditorCommand } from "../domain/commands";
import { createEmptyProject, validateProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";
import { createMotionGraphic, legacyMotionGraphicSeed } from "../motion/composition";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import { motionGraphicV2FrameReceipt, motionGraphicV2LayoutReceipt } from "../motion/compositionV2";
import { motionVectorPaths } from "../motion/vectorGeometry";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { prepareGlyphRun } from "../typography/preparedGlyphRun";
import { prepareReferenceMotionTemplateInstance } from "./referenceMotionTemplateInstances";
import { preparePaletteRevision, paletteRevisionHash } from "./agentPaletteRevision";
import { paletteProject, paletteRequest } from "./paletteRevisionFixture";
import { assertScopedPaletteRevisionEffects } from "./scopedPaletteRevision";
import { assertDesignDecisionBinding, type DesignEvidence } from "./autopilotDesignContract";
import { motionCommandFamilies } from "./motionTreatment";

const recolor = (id: string, patch: Record<string, string>): EditorCommand => ({ type: "update_motion_graphic", graphicId: id, patch });
const guard = (project: ReturnType<typeof paletteProject>, commands: EditorCommand[]) => assertScopedPaletteRevisionEffects(project, commands);

describe("existing-layer palette revisions in the current graph", () => {
  it("binds strict color changes to a design beat and the color family, without credit for metadata or mixed edits", () => {
    const commands = [recolor("palette-title", { textColor: "#175CD3" })];
    const evidence: DesignEvidence = {
      schema: "editkin.autopilot-design-evidence/v1", projectSha256: "a".repeat(64), sourceSha256: "b".repeat(64), briefSha256: "c".repeat(64),
      request: { format: "reels", domain: "technology", topic: "Own palette", duration: 3,
        beats: [{ id: "focus", role: "first_frame", energy: .8, subject: "Actual readable title" }] },
      decisions: [{ beatId: "focus", recipeSha256: "d".repeat(64), application: "Use brand ink on the existing readable title", commandIndexes: [0] }],
    };
    expect(() => assertDesignDecisionBinding(evidence, commands, ["focus"])).not.toThrow();
    expect(motionCommandFamilies(commands[0])).toEqual(["color"]);
    expect(() => assertDesignDecisionBinding(evidence, [{ type: "rename_project", name: "Palette applied" }], ["focus"])).toThrow(/not metadata/);
    const mixed: EditorCommand = { type: "update_motion_graphic", graphicId: "palette-title", patch: { textColor: "#175CD3", text: "Changed content" } };
    expect(motionCommandFamilies(mixed)).toEqual([]);
    expect(() => guard(paletteProject(), [mixed])).toThrow(/color fields alone/);
  });

  it("refuses legacy, normalized no-op and genuinely unused vector paint", () => {
    const legacy = paletteProject(); legacy.motionGraphics[0] = createMotionGraphic("palette-title", "title", "OLD", 0, 3, undefined, legacyMotionGraphicSeed("title"));
    expect(() => preparePaletteRevision(legacy, paletteRequest(legacy))).toThrow(/existing v2/);
    const project = paletteProject();
    expect(() => guard(project, [recolor("palette-title", { textColor: "#111827FF" })])).toThrow(/no active paint/);
    const graphic = createMotionGraphic("ellipse", "card", "", 0, 3, undefined, findMotionGraphicPreset("reel_native_disc").seed);
    project.motionGraphics = [graphic];
    expect(() => guard(project, [recolor(graphic.id, { textColor: "#00FF00" })])).toThrow(/no active paint/);
  });

  it("matches actual text-panel alpha/default border and does not grant invisible accent credit", () => {
    const project = paletteProject(), title = project.motionGraphics[0];
    title.backgroundColor = "#11182700"; title.outlineWidth = 3; title.shadowDepth = 0;
    expect(() => guard(project, [recolor(title.id, { accentColor: "#00FF00" })])).toThrow(/no active paint/);
    title.backgroundColor = "#111827"; title.outlineWidth = undefined;
    expect(() => guard(project, [recolor(title.id, { accentColor: "#00FF00" })])).not.toThrow();
  });

  it("does not use fresh or deleted/recreated preset IDs to bypass the authoring path", () => {
    const project = paletteProject(), title = project.motionGraphics[0];
    expect(() => guard(project, [{ type: "add_motion_graphic", graphic: { ...title, id: "fresh" } }, recolor("fresh", { textColor: "#175CD3" })])).toThrow(/existing unreplaced/);
    expect(() => guard(project, [recolor(title.id, { textColor: "#175CD3" }), { type: "delete_motion_graphic", graphicId: title.id }, { type: "add_motion_graphic", graphic: { ...title, textColor: "#175CD3" } }])).toThrow(/final surviving/);
  });

  it("requires a final paint change independent of geometry, reversals or removed shadows", () => {
    const project = paletteProject(), grid = project.motionGraphics[1];
    grid.vectorV2 = { schema: "editkin.motion-vector/v1", kind: "dot_grid", heightPixels: 200, revealFrames: 1, spacingPixels: 50, dotRadiusPixels: 2 };
    expect(() => guard(project, [recolor(grid.id, { accentColor: "#00FF00" }), { type: "update_motion_graphic", graphicId: grid.id, patch: { vectorV2: { schema: "editkin.motion-vector/v1", kind: "ellipse", heightPixels: 200, revealFrames: 1 } } }])).toThrow(/final surviving/);
    expect(() => guard(project, [recolor(grid.id, { accentColor: "#00FF00" }), recolor(grid.id, { accentColor: grid.accentColor })])).toThrow(/final surviving/);
    const title = project.motionGraphics[0]; title.backgroundColor = "#11182700"; title.outlineWidth = 0; title.shadowDepth = 3;
    expect(() => guard(project, [recolor(title.id, { accentColor: "#00FF00" }), { type: "update_motion_graphic", graphicId: title.id, patch: { shadowDepth: 0 } }])).toThrow(/final surviving/);
  });

  it("keeps real late connection paint at its phase boundary and ignores overridden group colors", () => {
    const project = paletteProject();
    const graphic = createMotionGraphic("connections", "card", "", 0, 3, undefined, findMotionGraphicPreset("reel_connection_field").seed);
    graphic.motionV2!.exit.durationFrames = 12;
    graphic.vectorV2 = { schema: "editkin.motion-vector/v1", kind: "connection_field", heightPixels: 400, revealFrames: 1,
      seed: 32021, points: 32, dotRadiusPixels: 3.5, lineWidthPixels: 1.1, burstFrames: 4, gatherStartFrame: 20, gatherFrames: 4,
      connectStartFrame: 77, connectFrames: 1, groupColors: ["#DE3559", "#00AF9F", "#F4C83C"] };
    project.motionGraphics = [graphic]; validateProject(project);
    const command = recolor(graphic.id, { backgroundColor: "#00FF00" });
    expect(() => guard(project, [command])).not.toThrow();
    const edited = applyCommand(project, command).motionGraphics[0], layout = motionGraphicV2LayoutReceipt(project, edited);
    const paths = motionVectorPaths(edited, layout, motionGraphicV2FrameReceipt(project, edited, 78, layout));
    expect(paths.some(path => path.color === "#00FF00" && path.svg && path.ass)).toBe(true);
    expect(() => guard(project, [recolor(graphic.id, { textColor: "#00FF00" })])).toThrow(/no active paint/);
  });

  it("protects actual saved reference roles even when no templateOwner marker is present", async () => {
    const project = createEmptyProject("Saved source", { id: "saved-palette", width: 1080, height: 1920, fps: 30 });
    project.assets = [{ id: "owned", name: "Own source", kind: "video", uri: "owned.mp4", duration: 12, width: 1080, height: 1920, color: { interpretation: "rec709" } }];
    project.tracks[0].clips = [{ id: "primary", assetId: "owned", trackId: project.tracks[0].id, timelineStart: 0, sourceStart: 0, duration: 12,
      volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] }];
    let id = 0;
    const packet = await prepareReferenceMotionTemplateInstance(project, { templateId: "level_bridge", clipId: "primary", startFrame: 0, durationFrames: 360,
      title: "FOCUS", previousText: "OLD", primaryLabel: "MAIN", purpose: "Keep owned source readable", evidenceRefs: ["owned:source"],
      items: [{ label: "ONE", detail: "READ" }, { label: "TWO", detail: "KEEP" }, { label: "THREE", detail: "RETURN" }],
      style: { palette: { surface: "#FFFFFF", text: "#172033", accent: "#175CD3", muted: "#5B6678", separator: "#D8DEE8" },
        typography: { headingFamily: "Bebas Neue", bodyFamily: "Bebas Neue" }, animationSpeed: 1 } }, prefix => `${prefix}-${id++}`, {
      prepareText: async (faceId, text) => prepareGlyphRun(faceId, text, new Uint8Array(await readFile(join("public/fonts", bundledFontFaceSpec(faceId).fontFile)))),
    });
    const saved = applyCommand(project, { type: "batch", commands: packet.commands });
    const role = packet.instance.roles.find(role => role.kind === "graphic")!;
    expect(saved.motionGraphics.find(graphic => graphic.id === role.id)!.templateOwner).toBeUndefined();
    const before = paletteRevisionHash(saved), request = { ...paletteRequest(saved),
      bindings: [{ graphicId: role.id, colors: { textColor: "ink" }, alphaMode: "retain_target" }] };
    expect(() => preparePaletteRevision(saved, request)).toThrow(/owner-managed/);
    expect(() => guard(saved, [recolor(role.id, { textColor: "#00FF00" })])).toThrow(/owner-managed/);
    expect(paletteRevisionHash(saved)).toBe(before);
  });
});
