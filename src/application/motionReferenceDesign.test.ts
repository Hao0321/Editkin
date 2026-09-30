import { describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { prepareMotionReferenceDesign, type MotionReferenceDesignInput } from "./motionReferenceDesign";
import { prepareNativeReelScene } from "./nativeReelScenes";
import { applyCommand } from "../domain/commands";
import { parseProject } from "./projectFiles";

function fixture() {
  const project = createDemoProject(); project.width = 1080; project.height = 1920;
  project.assets[0].duration = 12; project.tracks[0].clips[0].duration = 12;
  const observation = { composition: "A single reading lane leaves the original operation visible.", subjectMotion: "The source subject retains its original movement and identity.", camera: "A deliberate focus change follows the relevant narration clause.", rhythm: "A brief entrance settles into a stable readable hold.", typography: "Display type establishes one clear headline above subordinate labels.", colorRoles: "The source accent marks emphasis; its actual color is not imported.", transition: "The next statement begins after the current proof can be read.", depthAndEdges: "Soft outer edges leave the subject's real texture intact.", automationLesson: "Use evidence and semantic purpose to choose each movement.", evidenceRefs: ["study:actual-motion-observation"] };
  const input: MotionReferenceDesignInput = { format: "shorts", brand: { name: "Original studio", logo: { mode: "omit", reason: "The creator explicitly selected a wordmark-free sample." },
    palette: { surface: "#EAF0F6", text: "#152A42", accent: "#266BC0", muted: "#627C94", separator: "#C2D4E5" },
    typography: { headingFamily: "Noto Serif TC", bodyFamily: "Noto Sans TC" },
    serviceFacts: [{ id: "native", text: "The editor keeps each scene editable.", evidenceRefs: ["product:editable-scene-contract"] }], redesignIntent: "Redesign with original content and studio typography, retaining useful movement semantics." },
    references: [{ id: "reference", url: "https://example.com/reference", sourceSha256: "a".repeat(64), fps: 30, totalFrames: 300, width: 1080, height: 1920,
      fullVideoObserved: true, boundaryPolicy: "coverage_bins_not_cut_receipts", referenceOnlyAssetIds: ["research-media"], sections: [
        { ...observation, id: "open", startFrame: 0, endFrame: 150, purpose: "hook", grammars: ["depth_gallery", "focus_reveal"] },
        { ...observation, id: "close", startFrame: 150, endFrame: 300, purpose: "recap", grammars: ["chapter_progress", "focus_wall"] },
      ] }], beats: [{ id: "opening", startFrame: 0, endFrame: 120, purpose: "hook", narration: "Each scene stays editable.", title: "每幕皆可修改", clipId: project.tracks[0].clips[0].id, factIds: ["native"], evidenceRefs: ["narration:verified-clause"] }] };
  return { project: parseProject(project), input };
}
describe("complete-reference original motion design", () => {
  it("keeps complete reference coverage, original branding and genuinely distinct narratives without mutating the project", () => {
    const { project, input } = fixture(); const before = structuredClone(project);
    const packet = prepareMotionReferenceDesign(project, input);
    expect(project).toEqual(before); expect(packet.status).toBe("STORYBOARD_REVIEW_REQUIRED");
    expect(packet.referenceCoverage[0]).toMatchObject({ totalFrames: 300, observedFrames: 300 });
    expect(packet.storyboards.map(option => option.scenes[0].grammar)).toEqual(["evidence_takeover", "chapter_progress", "depth_gallery"]);
    for (const option of packet.storyboards) expect(option.scenes[0]).toMatchObject({ startFrame: 0, endFrame: 120, brand: { name: input.brand.name, logo: input.brand.logo, palette: input.brand.palette, typography: input.brand.typography }, verifiedFacts: input.brand.serviceFacts });
    expect(packet.storyboards[0].scenes[0].state).toBe("IMPLEMENTATION_REQUIRED");
    expect(packet.referenceCoverage[0].lessons[1].grammarCapabilities[1].state).toBe("IMPLEMENTATION_REQUIRED");
  });
  it("rejects partial reference studies, missing final coverage and unknown product claims", () => {
    const { project, input } = fixture();
    const missing = structuredClone(input); missing.references[0].sections.pop();
    expect(() => prepareMotionReferenceDesign(project, missing)).toThrow(/結尾/);
    const gap = structuredClone(input); gap.references[0].sections[1].startFrame++;
    expect(() => prepareMotionReferenceDesign(project, gap)).toThrow(/不遺漏/);
    const falseClaim = structuredClone(input); falseClaim.beats[0].factIds = ["unsupported"];
    expect(() => prepareMotionReferenceDesign(project, falseClaim)).toThrow(/服務宣稱/);
  });
  it("keeps missing fonts/logo as explicit material gaps and blocks reference footage reuse", () => {
    const { project, input } = fixture();
    input.brand.typography.headingFamily = "Unavailable Brand Face";
    input.brand.logo = { mode: "asset", assetId: "missing-logo", evidenceRefs: ["creator:brand-identity"] };
    expect(prepareMotionReferenceDesign(project, input)).toMatchObject({ status: "MATERIAL_REQUIRED", gaps: [{ code: "FONT_REQUIRED" }, { code: "LOGO_REQUIRED" }] });
    input.references[0].referenceOnlyAssetIds.push(project.assets[0].id);
    expect(() => prepareMotionReferenceDesign(project, input)).toThrow(/參考影片不會導入/);
  });
  it("redesigns landscape reading/evidence order rather than carrying a portrait frame into it", () => {
    const { project, input } = fixture(); input.format = "longform";
    expect(() => prepareMotionReferenceDesign(project, input)).toThrow(/畫布方向/);
    project.width = 1920; project.height = 1080;
    const packet = prepareMotionReferenceDesign(project, input);
    expect(packet.storyboards[1].scenes[0].canvasPlan).toMatch(/保留全尺寸連續素材/);
    expect(packet.storyboards.every(option => !option.scenes[0].compiler?.includes("native_reel_scene"))).toBe(true);
  });
  it("compiles original palette and physical fonts through the same editable scene and preserves footage/audio", () => {
    const { project, input } = fixture(); let serial = 0;
    const scene = prepareNativeReelScene(project, { templateId: "editorial_steps", startFrame: 0, durationFrames: 120, title: "原創字體階層", body: "保留原始素材的動作", progress: { steps: 3, activeStep: 1 }, evidenceRefs: ["brief:original-design"],
      style: { palette: input.brand.palette, typography: input.brand.typography, animationSpeed: .7 } }, prefix => `${prefix}-${serial++}`);
    const applied = applyCommand(project, { type: "batch", commands: scene.commands });
    expect(applied.tracks).toEqual(project.tracks);
    expect(applied.motionGraphics.find(g => g.text === "原創字體階層")).toMatchObject({ fontFamily: "Noto Serif TC", textColor: "#152A42", motionV2: { entrance: { durationFrames: 11 } } });
    expect(applied.motionGraphics.find(g => g.text === "保留原始素材的動作")?.fontFamily).toBe("Noto Sans TC");
    expect(applied.motionGraphics.filter(g => g.vectorV2?.kind === "step_progress")[0].accentColor).toBe("#266BC0");
    expect(scene.editorialGraphics.find(g => g.message === "原創字體階層")?.presetVariant?.overrides.fontFamily).toBe("Noto Serif TC");
    expect(() => prepareNativeReelScene(project, { templateId: "editorial_steps", startFrame: 0, durationFrames: 120, title: "實體字型缺口", progress: { steps: 2, activeStep: 1 }, evidenceRefs: ["brief:font"], style: { palette: input.brand.palette, typography: { ...input.brand.typography, headingFamily: "Missing" }, animationSpeed: 1 } }, prefix => prefix)).toThrow(/FONT_REQUIRED/);
  });
});
