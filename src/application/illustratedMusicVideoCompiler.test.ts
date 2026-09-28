import { describe, expect, it } from "vitest";
import { applyCommand } from "../domain/commands";
import { createEmptyProject } from "../domain/editGraph";
import { editorCommandSchema } from "../domain/schema";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject } from "../domain/types";
import { buildRenderPlan } from "../render/planner";
import { assertAutopilotProjectTimelineBinding, parseAutopilotPlan, type CurrentAutopilotPlan } from "./autopilotPlan";
import { createAutopilotV4Fixture } from "./autopilotPlanFixture";
import { compileIllustratedMusicVideo, type IllustratedMvRequest } from "./illustratedMusicVideoCompiler";
import { prepareIllustratedMusicVideoReadOnly, type PrepareIllustratedMusicVideoInput } from "../mcp/musicVideoTools";

function fixture(): EditProject {
  let project = createEmptyProject("Illustrated MV", { id: "illustrated-mv", width: 640, height: 360, fps: 30 });
  project.assets.push(
    { id: "song", name: "Original song", kind: "audio", uri: "song.wav", duration: 8 },
    { id: "bg", name: "Original background", kind: "image", uri: "bg.png", duration: 8, width: 640, height: 360,
      provenance: "original:artist", rightsBasis: "owned", alphaMode: "opaque" },
    { id: "actor", name: "Original character", kind: "image", uri: "actor.png", duration: 8, width: 640, height: 360,
      provenance: "original:artist", rightsBasis: "owned", alphaMode: "straight" },
  );
  project = applyCommand(project, { type: "add_clip", clip: { id: "song-bed", assetId: "song", trackId: "audio-main",
    timelineStart: 0, sourceStart: 0, duration: 8, volume: 1, transform: { ...DEFAULT_TRANSFORM },
    color: { ...DEFAULT_COLOR }, keyframes: [] } });
  return project;
}

function request(): IllustratedMvRequest {
  return { musicClipId: "song-bed", backgroundTrackId: "video-main", characterTrackId: "mv-character", silhouetteTrackId: "mv-silhouette",
    sections: [
      { id: "intro", start: 0, end: 2, role: "intro", framing: "wide", backgroundAssetId: "bg", characterAssetId: "actor", musicEvidenceRef: "song:phrase:0", silhouetteRevealFrames: 12 },
      { id: "chorus", start: 2, end: 6, role: "chorus", framing: "close", backgroundAssetId: "bg", characterAssetId: "actor", musicEvidenceRef: "song:phrase:1" },
    ],
    wordCues: [{ id: "spark", text: "SPARK", start: 2.3, end: 3.7, kind: "title", placement: "right", evidenceRef: "brief:motif:spark" }],
  };
}

describe("illustrated music video compiler", () => {
  it("produces read-only frame-aligned editable image layers, motion and spatial words", () => {
    const project = fixture();
    const before = JSON.stringify(project);
    const draft = compileIllustratedMusicVideo(project, request());
    expect(JSON.stringify(project)).toBe(before);
    expect(draft.status).toBe("DRAFT_COMMAND_CANDIDATE");
    expect(draft.directApplyAllowed).toBe(false);
    expect(draft.commands.filter(command => command.type === "add_clip")).toHaveLength(5);
    expect(draft.commands.filter(command => command.type === "add_keyframe")).toHaveLength(13);
    expect(draft.editorialGraphics[0]).toMatchObject({ kind: "title_card", message: "SPARK" });
    for (const command of draft.commands) expect(() => editorCommandSchema.parse(command)).not.toThrow();
    const updated = applyCommand(project, { type: "batch", commands: draft.commands });
    const plan = buildRenderPlan(updated, uri => uri);
    expect(plan.videoLayers.filter(layer => layer.segments.some(segment => segment.kind === "clip"))).toHaveLength(3);
    expect(updated.tracks.find(track => track.id === "mv-character")?.clips).toHaveLength(2);
    expect(updated.tracks.find(track => track.id === "mv-silhouette")?.clips).toHaveLength(1);
    expect(plan.audioClips.map(item => item.clip.id)).toEqual(["song-bed"]);
    expect(updated.motionGraphics[0].backgroundColor).toBe("#00000000");
  });

  it("rejects footage stand-ins, missing alpha, unlicensed art and discontinuous sections", () => {
    const footage = fixture();
    footage.assets.find(asset => asset.id === "actor")!.kind = "video";
    expect(() => compileIllustratedMusicVideo(footage, request())).toThrow(/ILLUSTRATED_ART_REQUIRED/);
    const opaque = fixture();
    opaque.assets.find(asset => asset.id === "actor")!.alphaMode = "opaque";
    expect(() => compileIllustratedMusicVideo(opaque, request())).toThrow(/CHARACTER_ALPHA_REQUIRED/);
    const unlicensed = fixture();
    unlicensed.assets.find(asset => asset.id === "actor")!.rightsBasis = undefined;
    expect(() => compileIllustratedMusicVideo(unlicensed, request())).toThrow(/ILLUSTRATED_ART_REQUIRED/);
    const gap = request();
    gap.sections = [gap.sections[0], { ...gap.sections[1], start: 2.1 }];
    expect(() => compileIllustratedMusicVideo(fixture(), gap)).toThrow(/逐格連續/);
    const transition = request();
    transition.sections = [transition.sections[0], { ...transition.sections[1], entryTransition: "character_slide_left" }];
    expect(() => compileIllustratedMusicVideo(fixture(), transition)).toThrow(/兩側證據/);
  });

  it("accepts a high-resolution wide cel and evidence-bound character framing without a hard crop", () => {
    const project = fixture();
    const actor = project.assets.find(asset => asset.id === "actor")!;
    actor.width = 1672;
    actor.height = 941;
    const input = request();
    input.sections[1].characterFrame = { x: 20, scale: 1.1, evidenceRef: "art:wide-cel:negative-space" };
    const draft = compileIllustratedMusicVideo(project, input);
    const first = draft.commands.find(command => command.type === "add_keyframe"
      && command.clipId === "mv-actor-chorus" && command.keyframe.time === 0);
    expect(first).toMatchObject({ keyframe: { transform: { x: 20, scale: 1.1 } } });
    expect(() => applyCommand(project, { type: "batch", commands: draft.commands })).not.toThrow();
    input.sections[1].characterFrame = { x: 20, scale: 1.1, evidenceRef: "" };
    expect(() => compileIllustratedMusicVideo(project, input)).toThrow(/角色構圖/);
    actor.width = 1024;
    actor.height = 1536;
    input.sections[1].characterFrame = { x: 20, scale: 1.1, evidenceRef: "art:portrait-crop" };
    expect(() => compileIllustratedMusicVideo(project, input)).toThrow(/ART_CANVAS_REQUIRED/);
  });

  it("MCP prepare reads without project mutation", async () => {
    const project = fixture();
    const before = JSON.stringify(project);
    const draft = await prepareIllustratedMusicVideoReadOnly({ projectPath: "fixture.editkin", ...request() } as PrepareIllustratedMusicVideoInput,
      { readProject: async () => project });
    expect(draft.mutationPerformed).toBe(false);
    expect(JSON.stringify(project)).toBe(before);
  });

  it("binds alternate word placement through an explicit v4 preset variant", () => {
    const input = request();
    input.wordCues = [{ id: "left", text: "夜空", start: .4, end: 1.6,
      kind: "title", placement: "left", evidenceRef: "brief:motif:night" }];
    const draft = compileIllustratedMusicVideo(fixture(), input);
    const base = createAutopilotV4Fixture();
    const plan = { ...base,
      commands: [base.commands[0], ...draft.commands],
      editorial: { ...base.editorial, graphics: draft.editorialGraphics },
    } as unknown as CurrentAutopilotPlan;
    expect(draft.editorialGraphics[0].presetVariant).toBeDefined();
    expect(() => parseAutopilotPlan(plan)).not.toThrow();
    expect(() => assertAutopilotProjectTimelineBinding(plan, 30)).not.toThrow();
  });

  it("keeps beat hits editable, requires their evidence and binds bright-scene ink type", () => {
    const input = request();
    input.sections = [input.sections[0], { ...input.sections[1], beatAccentFrames: [15, 30],
      beatAccentEvidenceRefs: ["song:beat:2.5", "song:beat:3.0"], backgroundEffect: "dawn_bloom" }];
    input.wordCues = [{ id: "ink", text: "夜明け", start: 2.3, end: 3.7,
      kind: "title", placement: "right", tone: "ink", treatment: "impact", evidenceRef: "brief:dawn" }];
    const draft = compileIllustratedMusicVideo(fixture(), input);
    expect(draft.commands.filter(command => command.type === "add_keyframe" && command.clipId === "mv-actor-chorus")).toHaveLength(9);
    expect(draft.commands.some(command => command.type === "set_clip_creative" && command.clipId === "mv-bg-chorus"
      && command.patch.effectPresetIds?.includes("high_key_bloom"))).toBe(true);
    expect(draft.editorialGraphics[0].presetVariant?.overrides.textColor).toBe("#18264A");
    expect(draft.editorialGraphics[0].presetId).toBe("mv_illustrated_word_impact");
    const updated = applyCommand(fixture(), { type: "batch", commands: draft.commands });
    expect(updated.motionGraphics[0].textColor).toBe("#18264A");
    expect(updated.motionGraphics[0].motionV2?.sequence.unit).toBe("all");
    const missingEvidence = { ...input, sections: [input.sections[0], { ...input.sections[1], beatAccentEvidenceRefs: undefined }] };
    expect(() => compileIllustratedMusicVideo(fixture(), missingEvidence)).toThrow(/等量音樂證據/);
  });

  it("binds a brief chorus flash and center-out kinetic type to editable commands", () => {
    const input = request();
    input.sections = [input.sections[0], { ...input.sections[1], entryTransition: "accent_flash",
      transitionEvidenceRefs: ["song:pre-chorus:end", "song:chorus:downbeat"] }];
    input.wordCues = [{ id: "burst", text: "夜明け", start: 2.4, end: 3.6,
      kind: "title", placement: "right", treatment: "ripple", evidenceRef: "brief:dawn" }];
    const draft = compileIllustratedMusicVideo(fixture(), input);
    expect(draft.commands).toContainEqual({ type: "set_clip_creative", clipId: "mv-bg-chorus",
      patch: { transitionIn: { presetId: "cine_proof_flash", duration: 4 / 30 } } });
    expect(draft.editorialGraphics[0].presetId).toBe("mv_illustrated_word_ripple");
    const project = applyCommand(fixture(), { type: "batch", commands: structuredClone(draft.commands) });
    expect(project.motionGraphics[0].motionV2?.sequence).toMatchObject({ unit: "character", order: "center_out" });
    expect(project.tracks.find(track => track.id === "video-main")?.clips[1].creative?.transitionIn?.presetId).toBe("cine_proof_flash");
  });

  it("keeps a short foreground flourish on its own editable alpha track", () => {
    const project = fixture();
    project.assets.push({ id: "comet", name: "Original comet", kind: "image", uri: "comet.png", duration: 8,
      width: 640, height: 360, provenance: "original:artist", rightsBasis: "owned", alphaMode: "straight" });
    const input = request();
    input.sections = [input.sections[0], { ...input.sections[1],
      foregroundAccent: { assetId: "comet", startFrame: 12, durationFrames: 18, evidenceRef: "song:chorus:accent" } }];
    const draft = compileIllustratedMusicVideo(project, input);
    const updated = applyCommand(project, { type: "batch", commands: draft.commands });
    const flourish = updated.tracks.find(track => track.id === "mv-foreground")?.clips[0];
    expect(flourish).toMatchObject({ timelineStart: 2.4, duration: .6 });
    expect(flourish?.keyframes.map(frame => frame.transform.opacity)).toEqual([0, .42, .42, 0]);
    expect(draft.guarantees.editableForeground).toBe(true);
    project.assets.find(asset => asset.id === "comet")!.alphaMode = "opaque";
    expect(() => compileIllustratedMusicVideo(project, input)).toThrow(/FOREGROUND_ALPHA_REQUIRED/);
  });
});
