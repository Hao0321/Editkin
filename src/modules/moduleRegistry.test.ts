import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyCommand } from "../domain/commands";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";
import { encodeProjectBytes } from "../application/projectCodec";
import { LOOK_PRESETS } from "../creative/corePack";
import { SHORT_FORM_TEMPLATES } from "../application/shortFormTemplates";
import { creativePresetCommands, prepareAutopilotTemplatePackageFile, prepareClipMotionPresetFile } from "../mcp/moduleCompilers";
import { prepareOriginalElementFile } from "../mcp/motionGraphicKitTools";
import { prepareMotionGraphicCreationFile } from "../mcp/motionGraphicCreationFile";
import { describeEditkinModule, editkinModuleRegistry, listEditkinModules, prepareEditkinModule } from "./moduleRegistry";
import { MODULE_KINDS } from "./moduleTypes";
import { creatableMotionPresets } from "./moduleCatalog";

let root: string;
let path: string;
let revision: number;
const fonts = { EDITKIN_FONT_ROOT: resolve("public/fonts") };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "editkin-modules-"));
  path = join(root, "owned.editkin.json");
  vi.stubEnv("EDITKIN_WORKSPACE", root);
  let project = createEmptyProject("Module parity graph", { width: 1920, height: 1080, fps: 30 });
  project = applyCommand(project, { type: "import_asset", asset: { id: "footage", name: "Footage", kind: "video", uri: "footage.mp4", duration: 8, width: 1920, height: 1080 } });
  project = applyCommand(project, { type: "add_clip", clip: { id: "clip-a", assetId: "footage", trackId: "video-main", timelineStart: 0, sourceStart: 0, duration: 4,
    volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] } });
  revision = project.revision;
  await writeFile(path, encodeProjectBytes(project));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  const relation = relative(resolve(tmpdir()), resolve(root));
  if (isAbsolute(relation) || relation.startsWith("..") || !relation.startsWith("editkin-modules-")) throw new Error("temp root outside the owned test directory");
  await rm(root, { recursive: true, force: true });
});

describe("Editkin module registry", () => {
  it("is frozen, duplicate-free and self-consistent", () => {
    const registry = editkinModuleRegistry();
    expect(registry.manifests.length).toBeGreaterThanOrEqual(25);
    expect(new Set(registry.manifests.map(manifest => manifest.id)).size).toBe(registry.manifests.length);
    for (const manifest of registry.manifests) {
      expect(MODULE_KINDS).toContain(manifest.kind);
      expect(manifest.id.startsWith(`${manifest.kind}.`)).toBe(true);
      expect(manifest.invoke.tool === "prepare_editkin_module").toBe(manifest.status === "available");
    }
    expect(Object.isFrozen(registry.manifests[0])).toBe(true);
    expect(editkinModuleRegistry().identity.sha256).toBe(registry.identity.sha256);
    expect(registry.identity.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("discovers modules by role, format and kind, with paging and full descriptions", () => {
    const emphasis = listEditkinModules({ role: "emphasis" });
    const element = emphasis.modules.find(module => module.id === "graphic.original_element");
    expect(element?.variants.map(variant => variant.id)).toContain("keyword-sticker");
    const portraitScenes = listEditkinModules({ kind: "scene", format: "portrait", limit: 50 });
    expect(portraitScenes.modules.length).toBeGreaterThan(0);
    for (const module of portraitScenes.modules) { expect(module.kind).toBe("scene"); expect(module.formats).toContain("portrait"); }
    const first = listEditkinModules({ limit: 3 }), second = listEditkinModules({ limit: 3, cursor: 3 });
    expect(first.nextCursor).toBe(3);
    expect(second.modules.map(module => module.id)).not.toEqual(first.modules.map(module => module.id));
    const described = describeEditkinModule("graphic.original_element");
    expect(described.inputs.autoFilled).toEqual(["projectPath", "elementId"]);
    expect(Object.keys((described.inputs.schema as { properties: object }).properties)).toContain("startFrame");
  });

  it("refuses unknown modules, missing or foreign variants and dedicated-tool modules", async () => {
    await expect(prepareEditkinModule({ projectPath: path, moduleId: "graphic.nope" })).rejects.toThrow(/未知模組/);
    await expect(prepareEditkinModule({ projectPath: path, moduleId: "graphic.original_element", inputs: {} })).rejects.toThrow(/需要 variantId/);
    await expect(prepareEditkinModule({ projectPath: path, moduleId: "clip_motion.camera", variantId: "keyword-sticker", inputs: {} })).rejects.toThrow(/沒有 variant/);
    await expect(prepareEditkinModule({ projectPath: path, moduleId: "scene.original_2d" })).rejects.toThrow(/prepare_original_motion_scene_2d/);
  });
});

describe("module preparation matches the dedicated compilers", () => {
  it("clip motion, looks, caption styles and templates compile to identical commands without touching the project", async () => {
    const before = await readFile(path);
    const camera = await prepareEditkinModule({ projectPath: path, moduleId: "clip_motion.camera", variantId: "punch_in", inputs: { clipId: "clip-a", energy: "punchy" } });
    expect(camera.commands).toEqual((await prepareClipMotionPresetFile({ projectPath: path, clipId: "clip-a", presetId: "punch_in", energy: "punchy" })).commands);
    expect(camera.commandTypes).toEqual(["add_keyframe"]);
    expect(camera.schema).toBe("editkin.module-invocation/v1");
    expect(camera.mutationPerformed).toBe(false);

    const look = await prepareEditkinModule({ projectPath: path, moduleId: "look.color", variantId: LOOK_PRESETS[0].id, inputs: { clipIds: ["clip-a"] } });
    expect(look.commands).toEqual(creativePresetCommands({ clipId: "clip-a", lookPresetId: LOOK_PRESETS[0].id }));
    expect(look.projectRevision).toBe(revision);

    const template = SHORT_FORM_TEMPLATES[0].id;
    const packaged = await prepareEditkinModule({ projectPath: path, moduleId: "template.short_form", variantId: template, inputs: { clipIds: ["clip-a"] } });
    const direct = await prepareAutopilotTemplatePackageFile({ projectPath: path, format: "short", templateId: template, clipIds: ["clip-a"] });
    expect(packaged.commands).toEqual(direct.commands);
    expect(packaged.carriers.suggestions).toEqual(direct.suggestions);

    expect(await readFile(path)).toEqual(before);
  });

  it("motion presets and original elements compile with real fonts to the same commands as their tools", async () => {
    const preset = creatableMotionPresets().find(item => item.id.startsWith("kinetic_")) ?? creatableMotionPresets()[0];
    const request = { expectedRevision: revision, graphicId: "module-title", text: "模組化", startFrame: 0, preferredDurationFrames: 90, scope: "existing_timeline" as const };
    const viaModule = await prepareEditkinModule({ projectPath: path, moduleId: "graphic.motion_preset", variantId: preset.id, inputs: request }, { environment: fonts });
    const viaTool = await prepareMotionGraphicCreationFile(path, { ...request, kind: preset.seed.kind!, presetId: preset.id }, fonts);
    expect(viaModule.commands).toEqual(viaTool.commands);

    const element = { startFrame: 0, durationFrames: 120 };
    const elementModule = await prepareEditkinModule({ projectPath: path, moduleId: "graphic.original_element", variantId: "keyword-sticker", inputs: element });
    const elementTool = await prepareOriginalElementFile(path, { ...element, elementId: "keyword-sticker" });
    expect(elementModule.commands).toEqual(elementTool.commands);
    expect(elementModule.carriers.timeline).toEqual(elementTool.timeline);
    expect(elementModule.commandsSha256).toMatch(/^[a-f0-9]{64}$/);
  }, 120000);
});
