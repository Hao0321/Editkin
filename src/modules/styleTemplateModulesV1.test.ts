import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useTempRoots } from "../test/tempRoot.mjs";
import { applyCommand } from "../domain/commands";
import type { EditorCommand } from "../domain/commands";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";
import { assertStyleTemplateProjectFilesV1 } from "../styleTemplates/slots/renderTemplateClip";
import { createProjectFile, readProject, writeProject } from "../mcp/storage";
import { editkinModuleRegistry } from "./moduleRegistry";
import { describeEditkinModuleV2, listEditkinModulesV2, prepareEditkinModuleV2 } from "./moduleRegistryV2";
import { editkinModuleMetadataRegistryV2 } from "./moduleMetadataRuntimeV2";
import { STYLE_TEMPLATE_MODULE_ID_V1, styleTemplateAutoPickCandidatesV1, styleTemplateModuleVariantSnapshotV1 } from "./styleTemplateModulesV1";

/**
 * graphic.style_template: discovery (snapshot, generated metadata, export), the M10 refusals, variant choice, and real
 * prepares (rendering inside prepare) that add a template clip and then change its slots through updateClipId.
 */
const app = resolve(".");
const ffmpegPath = join(app, "vendor/ffmpeg/win32-x64/ffmpeg.exe"), ffprobePath = join(app, "vendor/ffmpeg/win32-x64/ffprobe.exe");
const temp = useTempRoots();
const projectPath = "style-template-module.editkin.json";
const saved = { workspace: process.env.EDITKIN_WORKSPACE };
const environment = { ...process.env, HAO_FFMPEG_PATH: ffmpegPath, HAO_FFPROBE_PATH: ffprobePath };

beforeAll(async () => {
  const workspace = await temp.create("styletpl-module-");
  process.env.EDITKIN_WORKSPACE = workspace;
  for (const [name, args] of [["screen.png", ["-f", "lavfi", "-i", "testsrc2=s=960x540", "-frames:v", "1"]],
    ["footage.mp4", ["-f", "lavfi", "-i", "testsrc2=s=270x480:r=30:d=4", "-vf", "format=yuv420p", "-c:v", "libx264"]]] as const) {
    const made = spawnSync(ffmpegPath, ["-v", "error", "-y", ...args, join(workspace, name)], { windowsHide: true, timeout: 60_000 });
    expect(made.status, made.stderr.toString()).toBe(0);
  }
  await createProjectFile(projectPath, "Style template module", 270, 480, 30, [
    { type: "import_asset", asset: { id: "footage", name: "footage", kind: "video", uri: "footage.mp4", duration: 4, width: 270, height: 480 } },
    { type: "import_asset", asset: { id: "screen", name: "screen", kind: "image", uri: "screen.png", duration: 5, width: 960, height: 540, redistributable: true } },
    { type: "add_clip", clip: { id: "a", assetId: "footage", trackId: "video-main", timelineStart: 0, sourceStart: 0, duration: 4, volume: 1,
      transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] } },
  ]);
}, 120_000);
afterAll(() => { if (saved.workspace === undefined) delete process.env.EDITKIN_WORKSPACE; else process.env.EDITKIN_WORKSPACE = saved.workspace; });

const evidence = (text: Record<string, string>) => Object.fromEntries(Object.keys(text).map(slot => [slot, `transcript:${slot}`]));

describe("graphic.style_template discovery", () => {
  it("the checked-in snapshot equals the live slot catalogue, and metadata, eager registry and export agree", async () => {
    const snapshot = JSON.parse(await readFile(resolve("src/modules/styleTemplateModuleVariantsV1.json"), "utf8"));
    expect(snapshot).toEqual(JSON.parse(JSON.stringify(styleTemplateModuleVariantSnapshotV1())));
    const eager = editkinModuleRegistry().get(STYLE_TEMPLATE_MODULE_ID_V1)!, generated = editkinModuleMetadataRegistryV2().get(STYLE_TEMPLATE_MODULE_ID_V1)!;
    expect(generated.manifest).toEqual(eager.manifest);
    expect(generated.manifestSha256).toBe(eager.manifestSha256);
    expect(eager.manifest).toMatchObject({ kind: "graphic", status: "available", invoke: { tool: "prepare_editkin_module" },
      output: { commandTypes: ["add_style_template_clip", "update_style_template_clip", "delete_clip", "delete_asset"] } });
    expect(eager.manifest.variants.map(variant => [variant.id, variant.artStatus, variant.implemented])).toEqual([
      ["S1_explainer_ui", "pending", true], ["S4_motion_promo_3d", "certified", true], ["S5_vox_collage", "certified", true], ["S7_kinetic_lyric_3d", "certified", true]]);
    expect(listEditkinModulesV2({ query: "改字" }).modules.map(module => module.id)).toContain(STYLE_TEMPLATE_MODULE_ID_V1);
    const described = await describeEditkinModuleV2(STYLE_TEMPLATE_MODULE_ID_V1);
    expect(Object.keys((described.inputs.schema as { properties: object }).properties))
      .toEqual(expect.arrayContaining(["startFrame", "updateClipId", "removeClipId", "text", "textEvidence", "colors", "images", "videoType"]));
  });

  it("auto-picks only certified, implemented templates (S4/S5/S7 since 2026-10-29) for their video types and formats; S1 stays name-only", async () => {
    const ids = (filter?: { videoType?: string; format?: string }) => styleTemplateAutoPickCandidatesV1(filter).map(template => template.id);
    expect(ids()).toEqual(["S4_motion_promo_3d", "S5_vox_collage", "S7_kinetic_lyric_3d"]);
    expect(ids({ videoType: "launch" })).toEqual(["S4_motion_promo_3d", "S7_kinetic_lyric_3d"]);
    expect(ids({ videoType: "music_lyric", format: "landscape" })).toEqual(["S4_motion_promo_3d", "S7_kinetic_lyric_3d"]);
    expect(ids({ videoType: "explainer" })).toEqual(["S5_vox_collage"]);
    expect(ids({ videoType: "channel_trailer" })).toEqual(["S7_kinetic_lyric_3d"]);
    expect(ids({ videoType: "ai_tutorial" })).toEqual([]);
    expect(ids({ format: "square" })).toEqual([]);
    // S1 is pending: a tutorial call without variantId finds no certified template.
    await expect(prepareEditkinModuleV2({ projectPath, moduleId: STYLE_TEMPLATE_MODULE_ID_V1, inputs: { startFrame: 0, videoType: "ai_tutorial", text: { keyword: "測試" }, textEvidence: { keyword: "ocr:1" } } }, { environment }))
      .rejects.toThrow(/STYLE_TEMPLATE_NO_CERTIFIED_VARIANT/);
  });

  it("M10: refuses a call without text, or text without evidence, before reading anything", async () => {
    const missing = "missing-project.editkin.json";
    await expect(prepareEditkinModuleV2({ projectPath: missing, moduleId: STYLE_TEMPLATE_MODULE_ID_V1, variantId: "S1_explainer_ui", inputs: { startFrame: 0 } }, { environment }))
      .rejects.toThrow(/STYLE_TEMPLATE_TEXT_SLOTS_REQUIRED/);
    await expect(prepareEditkinModuleV2({ projectPath: missing, moduleId: STYLE_TEMPLATE_MODULE_ID_V1, variantId: "S1_explainer_ui", inputs: { startFrame: 0, text: { keyword: " " } } }, { environment }))
      .rejects.toThrow(/STYLE_TEMPLATE_TEXT_SLOTS_REQUIRED/);
    await expect(prepareEditkinModuleV2({ projectPath: missing, moduleId: STYLE_TEMPLATE_MODULE_ID_V1, variantId: "S1_explainer_ui",
      inputs: { startFrame: 0, text: { keyword: "角色立繪", lead: "還有" }, textEvidence: { keyword: "transcript:12-14" } } }, { environment }))
      .rejects.toThrow(/STYLE_TEMPLATE_TEXT_EVIDENCE_REQUIRED: textEvidence missing for lead/);
  });
});

describe("graphic.style_template prepare (real renders)", () => {
  it("adds a named, uncertified S1 clip with a picture, then changes text, colour and picture through updateClipId", async () => {
    const text = { chapterNumber: "01", chapterLabel: "模組測試", lead: "還有", keyword: "角色立繪", tag: "GPT" };
    const added = await prepareEditkinModuleV2({ projectPath, moduleId: STYLE_TEMPLATE_MODULE_ID_V1, variantId: "S1_explainer_ui",
      inputs: { startFrame: 15, durationFrames: 66, text, textEvidence: evidence(text), images: { card: { source: { kind: "asset", assetId: "screen" }, focal: [0.3, 0.5] } } } }, { environment });
    expect(added).toMatchObject({ readOnly: true, mutationPerformed: false, commandTypes: ["add_style_template_clip"] });
    expect(added.carriers.styleTemplate).toMatchObject({ templateId: "S1_explainer_ui", artStatus: "uncertified", autoPicked: false, frameCount: 66, cacheHit: false,
      rights: { redistributable: true, sources: ["screen"] } });
    expect((added.carriers.styleTemplate as { editorial: unknown[] }).editorial).toContainEqual({ slot: "keyword", text: "角色立繪", evidence: "transcript:keyword" });
    // Unknown slots and over-long text are refused by the same validation the command runs.
    await expect(prepareEditkinModuleV2({ projectPath, moduleId: STYLE_TEMPLATE_MODULE_ID_V1, variantId: "S1_explainer_ui",
      inputs: { startFrame: 0, text: { keyword: "一二三四五六七八九" }, textEvidence: { keyword: "x" } } }, { environment })).rejects.toThrow(/STYLE_SLOT_TEXT_TOO_LONG/);
    await expect(prepareEditkinModuleV2({ projectPath, moduleId: STYLE_TEMPLATE_MODULE_ID_V1, variantId: "S1_explainer_ui",
      inputs: { startFrame: 0, text: { keyword: "a", footer: "b" }, textEvidence: { keyword: "x", footer: "y" } } }, { environment })).rejects.toThrow(/STYLE_SLOT_UNKNOWN/);

    // Apply (as apply_autopilot_plan would after audit) and save.
    const before = await readProject(projectPath);
    const project = applyCommand(before, { type: "batch", commands: added.commands as EditorCommand[] });
    await writeProject(projectPath, project, before.revision);
    const clip = project.tracks.find(track => track.id === "styletpl")!.clips[0];
    expect(clip).toMatchObject({ timelineStart: 0.5, duration: 66 / 30, styleJob: { template: { id: "S1_explainer_ui" }, slots: { text, image: { card: { source: { assetId: "screen" } } } } } });

    // Change the keyword (with evidence), the accent, and the picture to a still of the footage: slots not passed are kept.
    const updated = await prepareEditkinModuleV2({ projectPath, moduleId: STYLE_TEMPLATE_MODULE_ID_V1,
      inputs: { updateClipId: clip.id, text: { keyword: "遊戲引擎" }, textEvidence: { keyword: "transcript:30-31" }, colors: { accent: "#5ce4f4" },
        images: { card: { source: { kind: "still", assetId: "footage", time: 1.5 }, fit: "contain" } } } }, { environment });
    expect(updated.commandTypes).toEqual(["update_style_template_clip"]);
    const next = applyCommand(project, { type: "batch", commands: updated.commands as EditorCommand[] });
    const changed = next.tracks.find(track => track.id === "styletpl")!.clips[0];
    expect(changed.styleJob).toMatchObject({ slots: { text: { ...text, keyword: "遊戲引擎" }, color: { accent: "#5CE4F4" }, image: { card: { source: { kind: "still", assetId: "footage", time: 1.5 }, fit: "contain" } } } });
    expect(changed).toMatchObject({ timelineStart: 0.5, duration: 66 / 30 });
    expect(changed.styleJob!.key).not.toBe(clip.styleJob!.key);
    expect(await assertStyleTemplateProjectFilesV1(next, join(process.env.EDITKIN_WORKSPACE!, ".editkin-media-cache"))).toBe(1);
    // The same slots again: a cache hit.
    const again = await prepareEditkinModuleV2({ projectPath, moduleId: STYLE_TEMPLATE_MODULE_ID_V1,
      inputs: { updateClipId: clip.id, text: { keyword: "遊戲引擎" }, textEvidence: { keyword: "transcript:30-31" }, colors: { accent: "#5CE4F4" },
        images: { card: { source: { kind: "still", assetId: "footage", time: 1.5 }, fit: "contain" } } } }, { environment });
    expect(again.carriers.styleTemplate).toMatchObject({ cacheHit: true, key: changed.styleJob!.key });
    await expect(prepareEditkinModuleV2({ projectPath, moduleId: STYLE_TEMPLATE_MODULE_ID_V1, inputs: { updateClipId: "a", text: { keyword: "x" }, textEvidence: { keyword: "y" } } }, { environment }))
      .rejects.toThrow(/STYLE_TEMPLATE_UPDATE_TARGET_INVALID/);
  }, 600_000);

  it("adds certified S4, S5 and S7 clips by name (mesh3d and composited renders inside prepare), and auto-picks S5 for an explainer", async () => {
    const cases = [
      ["S4_motion_promo_3d", "mesh3dDeviceScreen", { title: "一鍵剪輯", kicker: "EDITKIN" }, 75, { screen: { source: { kind: "asset", assetId: "screen" } } }],
      ["S5_vox_collage", "collageExplainer", { wordmark: "鶯歌", caption: "CLAY" }, 60, { plate: { source: { kind: "still", assetId: "footage", time: 1 } } }],
      ["S7_kinetic_lyric_3d", "mesh3dKineticLyric", { word: "剪", band: "自動剪輯" }, 45, undefined],
    ] as const;
    const project = await readProject(projectPath);
    for (const [variantId, component, text, durationFrames, images] of cases) {
      const prepared = await prepareEditkinModuleV2({ projectPath, moduleId: STYLE_TEMPLATE_MODULE_ID_V1, variantId,
        inputs: { startFrame: 90, durationFrames, text, textEvidence: evidence(text), ...(images ? { images } : {}) } }, { environment });
      expect(prepared).toMatchObject({ readOnly: true, mutationPerformed: false, commandTypes: ["add_style_template_clip"] });
      expect(prepared.carriers.styleTemplate).toMatchObject({ templateId: variantId, artStatus: "certified", autoPicked: false, frameCount: durationFrames, cacheHit: false });
      const next = applyCommand(project, { type: "batch", commands: prepared.commands as EditorCommand[] });
      const clip = next.tracks.flatMap(track => track.clips).find(candidate => candidate.styleJob?.template.id === variantId)!;
      expect(clip).toMatchObject({ timelineStart: 3, duration: durationFrames / 30, styleJob: { component: { id: component }, slots: { text } } });
      expect(await assertStyleTemplateProjectFilesV1(next, join(process.env.EDITKIN_WORKSPACE!, ".editkin-media-cache"))).toBeGreaterThanOrEqual(1);
    }
    // Text without evidence and too-long text are refused before anything renders, as for S1.
    await expect(prepareEditkinModuleV2({ projectPath, moduleId: STYLE_TEMPLATE_MODULE_ID_V1, variantId: "S7_kinetic_lyric_3d",
      inputs: { startFrame: 0, text: { word: "剪" } } }, { environment })).rejects.toThrow(/STYLE_TEMPLATE_TEXT_EVIDENCE_REQUIRED/);
    await expect(prepareEditkinModuleV2({ projectPath, moduleId: STYLE_TEMPLATE_MODULE_ID_V1, variantId: "S4_motion_promo_3d",
      inputs: { startFrame: 0, text: { title: "一二三四五六七八九十十" }, textEvidence: { title: "x" } } }, { environment })).rejects.toThrow(/STYLE_SLOT_TEXT_TOO_LONG/);
    // Without variantId, an explainer auto-picks the certified S5 (same slots as above: the render is a cache hit).
    const [, , text5, frames5, images5] = cases[1];
    const picked = await prepareEditkinModuleV2({ projectPath, moduleId: STYLE_TEMPLATE_MODULE_ID_V1,
      inputs: { startFrame: 90, durationFrames: frames5, videoType: "explainer", text: text5, textEvidence: evidence(text5), images: images5 } }, { environment });
    expect(picked.carriers.styleTemplate).toMatchObject({ templateId: "S5_vox_collage", artStatus: "certified", autoPicked: true, candidates: ["S5_vox_collage"], cacheHit: true });
  }, 900_000);
});
