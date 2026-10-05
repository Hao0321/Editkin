import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MOTION_TREATMENT_FAMILIES } from "../application/motionTreatment";
import { applyCommand } from "../domain/commands";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";
import { encodeProjectBytes } from "../application/projectCodec";
import { editkinModuleRegistry, prepareEditkinModule } from "./moduleRegistry";
import { COMPOSITION_TEMPLATES } from "./templateCatalog";
import { describeEditkinTemplate, editkinTemplateRegistry, listEditkinTemplates, prepareEditkinTemplate, type TemplateFill } from "./templateRegistry";

let root: string;
const fonts = { EDITKIN_FONT_ROOT: resolve("public/fonts") };

async function projectFile(name: string, size: { width: number; height: number }) {
  let project = createEmptyProject(name, { ...size, fps: 30 });
  project = applyCommand(project, { type: "import_asset", asset: { id: "footage", name: "Footage", kind: "video", uri: "footage.mp4", duration: 20, ...size } });
  project = applyCommand(project, { type: "add_clip", clip: { id: "clip-a", assetId: "footage", trackId: "video-main", timelineStart: 0, sourceStart: 0, duration: 16,
    volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] } });
  const path = join(root, `${name}.editkin.json`);
  await writeFile(path, encodeProjectBytes(project));
  return { path, revision: project.revision };
}
const portrait = () => projectFile("portrait", { width: 1080, height: 1920 });
const landscape = () => projectFile("landscape", { width: 1920, height: 1080 });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "editkin-templates-"));
  vi.stubEnv("EDITKIN_WORKSPACE", root);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  const relation = relative(resolve(tmpdir()), resolve(root));
  if (isAbsolute(relation) || relation.startsWith("..") || !relation.startsWith("editkin-templates-")) throw new Error("temp root outside the owned test directory");
  await rm(root, { recursive: true, force: true });
});

describe("composition template registry", () => {
  it("validates every template against the live module registry and indexes them by format", () => {
    const registry = editkinTemplateRegistry();
    expect(registry.templates.map(template => template.id)).toEqual(COMPOSITION_TEMPLATES.map(template => template.id));
    expect(registry.identity.moduleRegistrySha256).toBe(editkinModuleRegistry().identity.sha256);
    expect(editkinTemplateRegistry().identity.sha256).toBe(registry.identity.sha256);
    const modules = editkinModuleRegistry();
    for (const template of registry.templates) for (const slot of template.slots) for (const option of slot.options) {
      expect(modules.get(option.moduleId)?.manifest.status).toBe("available");
    }
    expect(listEditkinTemplates({ format: "landscape" }).templates.map(template => template.id)).toEqual(["longform.teaching", "mv.illustrated"]);
    const composition = modules.get("template.composition")!.manifest;
    expect(composition.invoke.tool).toBe("prepare_editkin_template");
    expect(composition.variants.map(variant => variant.id)).toEqual(COMPOSITION_TEMPLATES.map(template => template.id));
    const described = describeEditkinTemplate("shorts.tutorial");
    expect(described.slotModules.ui_focus[0]).toMatchObject({ moduleId: "graphic.original_element", variants: ["focus-bracket"], defaults: { mode: "overlay" } });
  });
});

describe("prepare_editkin_template", () => {
  const tutorialFills = (): TemplateFill[] => [
    { slotId: "hook", variantId: "kinetic_slam", beatId: "beat-hook", inputs: { text: "三步做完", startFrame: 0, preferredDurationFrames: 60 } },
    { slotId: "ui_focus", beatId: "beat-step-1", inputs: { startFrame: 100, durationFrames: 90, title: "按這裡", target: { x: .2, y: .3, w: .3, h: .1, sourceId: "clip-a@3.3s" } } },
    { slotId: "emphasis", beatId: "beat-step-1", inputs: { clipId: "clip-a", energy: "punchy" } },
    { slotId: "recap", beatId: "beat-recap", inputs: { startFrame: 330, durationFrames: 130 } },
  ];

  it("compiles a Shorts tutorial into the exact module commands, composed, with motion coverage and no project write", async () => {
    const { path, revision } = await portrait();
    const before = await readFile(path);
    const prepared = await prepareEditkinTemplate({ projectPath: path, templateId: "shorts.tutorial", expectedRevision: revision, base: { clipIds: ["clip-a"], beatId: "beat-hook" }, fills: tutorialFills(), include: "full" },
      { environment: fonts });
    expect(prepared.checks).toEqual({ composition: "PASS", slots: "COMPLETE", pacing: "PASS", beats: "BOUND", v4Budget: "SINGLE_PLAN" });
    expect(prepared.fills.map(fill => `${fill.slotId}:${fill.moduleId}/${fill.variantId}`)).toEqual([
      "base:template.short_form/clean_tutorial", "hook:graphic.motion_preset/kinetic_slam", "ui_focus:graphic.original_element/focus-bracket",
      "emphasis:clip_motion.camera/punch_in", "recap:graphic.original_element/recap-strip"]);

    const direct = await Promise.all([
      prepareEditkinModule({ projectPath: path, moduleId: "template.short_form", variantId: "clean_tutorial", inputs: { clipIds: ["clip-a"] } }),
      prepareEditkinModule({ projectPath: path, moduleId: "graphic.motion_preset", variantId: "kinetic_slam", inputs: { expectedRevision: revision, scope: "existing_timeline",
        graphicId: "shorts-tutorial-hook-1", text: "三步做完", startFrame: 0, preferredDurationFrames: 60 } }, { environment: fonts }),
      prepareEditkinModule({ projectPath: path, moduleId: "graphic.original_element", variantId: "focus-bracket", inputs: { mode: "overlay", ...tutorialFills()[1].inputs } }),
      prepareEditkinModule({ projectPath: path, moduleId: "clip_motion.camera", variantId: "punch_in", inputs: { clipId: "clip-a", energy: "punchy" } }),
      prepareEditkinModule({ projectPath: path, moduleId: "graphic.original_element", variantId: "recap-strip", inputs: { startFrame: 330, durationFrames: 130 } }),
    ]);
    expect(prepared.commands).toEqual(direct.flatMap(result => result.commands));
    expect(prepared.v4.groups).toEqual([{ fills: [0, 1, 2, 3, 4], commandCount: prepared.commandCount, editorialGraphicsCount: 0, overBudget: false }]);
    const summary = await prepareEditkinTemplate({ projectPath: path, templateId: "shorts.tutorial", base: { clipIds: ["clip-a"], beatId: "beat-hook" }, fills: tutorialFills() }, { environment: fonts });
    expect(summary).not.toHaveProperty("commands");
    expect(summary.include).toBe("summary");
    expect(summary.commandsSha256).toBe(prepared.commandsSha256);
    expect(summary.fills.map(fill => fill.commandRange)).toEqual(prepared.fills.map(fill => fill.commandRange));
    const split = await prepareEditkinTemplate({ projectPath: path, templateId: "shorts.tutorial", base: { clipIds: ["clip-a"] }, fills: tutorialFills(), reserveCommands: 60 },
      { environment: fonts });
    expect(split.checks.v4Budget).toBe("SPLIT_REQUIRED");
    expect(split.v4.groups.flatMap(group => group.fills)).toEqual([0, 1, 2, 3, 4]);
    expect(split.v4.groups.every(group => group.commandCount <= 40)).toBe(true);
    prepared.fills.forEach((fill, index) => expect(fill.commandsSha256).toBe(direct[index].commandsSha256));
    expect(prepared.fills[2].layer).toBe("overlay");

    expect(prepared.motionCoverage.map(row => row.family)).toEqual([...MOTION_TREATMENT_FAMILIES]);
    const coverage = Object.fromEntries(prepared.motionCoverage.map(row => [row.family, row]));
    expect(coverage.color).toMatchObject({ suggestedAction: "use", commandIndexes: [0], slots: ["base"], beatIds: ["beat-hook"] });
    expect(coverage.transitions_camera.slots).toContain("emphasis");
    expect(coverage.transitions_camera.beatIds).toContain("beat-step-1");
    expect(coverage.title).toMatchObject({ suggestedAction: "use", slots: expect.arrayContaining(["hook"]) });
    expect(coverage.sound).toMatchObject({ suggestedAction: "omit", commandIndexes: [] });
    expect(await readFile(path)).toEqual(before);
  }, 120000);

  it("reports missing required slots, unbound beats and pacing problems instead of trimming", async () => {
    const { path } = await portrait();
    const prepared = await prepareEditkinTemplate({ projectPath: path, templateId: "shorts.tutorial", fills: [
      { slotId: "step", inputs: { startFrame: 0, durationFrames: 150 } },
      { slotId: "recap", beatId: "beat-recap", inputs: { startFrame: 90, durationFrames: 130 } },
    ] }, { environment: fonts });
    expect(prepared.checks).toMatchObject({ composition: "PASS", slots: "MISSING_REQUIRED", pacing: "WARN", beats: "UNBOUND" });
    expect(prepared.missing).toEqual([{ slotId: "hook", min: 1, filled: 0 }]);
    expect(prepared.unboundFills).toEqual([0]);
    expect(prepared.pacingWarnings.join("\n")).toMatch(/全幅場景重疊：step/);
  }, 120000);

  it("rejects wrong formats, unknown slots, foreign modules or variants, overfilled slots, stale revisions and colliding commands", async () => {
    const { path, revision } = await portrait();
    const run = (templateId: string, fills: TemplateFill[], extra: { expectedRevision?: number } = {}) =>
      prepareEditkinTemplate({ projectPath: path, templateId, fills, ...extra }, { environment: fonts });
    await expect(run("shorts.nope", [])).rejects.toThrow(/未知模板/);
    await expect(run("longform.teaching", [{ slotId: "chapter", inputs: { startFrame: 0, durationFrames: 90 } }])).rejects.toThrow(/只支援 landscape/);
    await expect(run("shorts.tutorial", [{ slotId: "intro", inputs: {} }])).rejects.toThrow(/沒有 slot：intro/);
    await expect(run("shorts.tutorial", [{ slotId: "recap", moduleId: "graphic.motion_kit", inputs: {} }])).rejects.toThrow(/不接受模組 graphic\.motion_kit/);
    await expect(run("shorts.tutorial", [{ slotId: "ui_focus", variantId: "recap-strip", inputs: {} }])).rejects.toThrow(/不接受 variant recap-strip/);
    await expect(run("shorts.tutorial", [{ slotId: "recap", inputs: { startFrame: 0, durationFrames: 130 } }, { slotId: "recap", inputs: { startFrame: 200, durationFrames: 130 } }]))
      .rejects.toThrow(/最多 1 個/);
    await expect(run("shorts.tutorial", [{ slotId: "recap", inputs: { startFrame: 0, durationFrames: 130 } }], { expectedRevision: revision + 1 })).rejects.toThrow(/專案已變更/);
    await expect(run("shorts.tutorial", [{ slotId: "recap", inputs: { startFrame: -1, durationFrames: 130 } }])).rejects.toThrow(/slot recap（graphic\.original_element\/recap-strip）編譯失敗/);
    const twin = { slotId: "ui_focus", inputs: { startFrame: 30, durationFrames: 90, target: { x: .2, y: .3, w: .3, h: .1, sourceId: "clip-a@1s" } } };
    await expect(run("shorts.tutorial", [twin, twin])).rejects.toThrow(/模板組合衝突：slot ui_focus（fill 1）/);
  }, 120000);

  it("keeps the longform identity: white caption style from the base package and landscape-only slots", async () => {
    const { path } = await landscape();
    const prepared = await prepareEditkinTemplate({ projectPath: path, templateId: "longform.teaching", base: { clipIds: ["clip-a"], beatId: "hook" }, include: "full", fills: [
      { slotId: "hook", beatId: "hook", inputs: { text: "一支影片講完", startFrame: 0, preferredDurationFrames: 60 } },
      { slotId: "chapter", beatId: "chapter-1", inputs: { startFrame: 200, durationFrames: 90, title: "第一步" } },
    ] }, { environment: fonts });
    expect(prepared.commands?.map(command => command.type).slice(0, 2)).toEqual(["set_clip_creative", "set_caption_style"]);
    expect(prepared.motionCoverage.find(row => row.family === "subtitles")).toMatchObject({ suggestedAction: "use", commandIndexes: [1], slots: ["base"] });
    expect(prepared.checks).toMatchObject({ composition: "PASS", slots: "COMPLETE", beats: "BOUND" });
    expect(prepared.identity.join(" ")).toMatch(/M68/);
  }, 120000);
});
