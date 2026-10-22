import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeProjectBytes } from "../application/projectCodec";
import { prepareMotionDesignV3Graphic } from "../application/motionDesignV3Creation";
import { applyCommand } from "../domain/commands";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject } from "../domain/types";
import { prepareEditkinModule } from "./moduleRegistry";
import { prepareEditkinTemplate } from "./templateRegistry";

let root: string;
let path: string;
let project: EditProject;
const fonts = { EDITKIN_FONT_ROOT: resolve("public/fonts") };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "editkin-modules-v3-"));
  path = join(root, "owned.editkin.json");
  vi.stubEnv("EDITKIN_WORKSPACE", root);
  project = createEmptyProject("Motion Design v3 module", { width: 1080, height: 1920, fps: 30 });
  project = applyCommand(project, { type: "import_asset", asset: { id: "footage", name: "Footage", kind: "video", uri: "footage.mp4", duration: 8, width: 1080, height: 1920 } });
  project = applyCommand(project, { type: "add_clip", clip: { id: "clip-a", assetId: "footage", trackId: "video-main", timelineStart: 0, sourceStart: 0, duration: 6,
    volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] } });
  await writeFile(path, encodeProjectBytes(project));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  const relation = relative(resolve(tmpdir()), resolve(root));
  if (isAbsolute(relation) || relation.startsWith("..") || !relation.startsWith("editkin-modules-v3-")) throw new Error("temp root outside the owned test directory");
  await rm(root, { recursive: true, force: true });
});

describe("graphic.motion_design_v3 module", () => {
  it("prepares one frame-exact v3 graphic that the editor applies and validates", async () => {
    const prepared = await prepareEditkinModule({ projectPath: path, moduleId: "graphic.motion_design_v3", variantId: "v3_location_pin",
      inputs: { startFrame: 15, durationFrames: 75, lines: ["京都 · 嵐山", "竹林小徑"], graphicId: "v3-location" } });
    expect(prepared).toMatchObject({ status: "PREPARED", mutationPerformed: false, commandCount: 1, commandTypes: ["add_motion_graphic"],
      carriers: { presetId: "v3_location_pin", template: "location_pin", textFields: ["place", "detail?"] } });
    const command = prepared.commands[0] as { type: "add_motion_graphic"; graphic: EditProject["motionGraphics"][number] };
    expect(command.graphic).toMatchObject({ id: "v3-location", schema: "hao.motion-composition/v3", designV3: { template: "location_pin" },
      presetId: "v3_location_pin", text: "京都 · 嵐山\n竹林小徑", timelineStart: .5, duration: 2.5 });
    expect(applyCommand(project, command).motionGraphics.map(graphic => graphic.id)).toEqual(["v3-location"]);
  });

  it("keeps v3 name bars out of autopilot and fails closed on short or ill-shaped copy", async () => {
    await expect(prepareEditkinModule({ projectPath: path, moduleId: "graphic.motion_design_v3", variantId: "v3_lower_third_bar",
      inputs: { startFrame: 0, durationFrames: 60, lines: ["杜撰人物"] } })).rejects.toThrow(/沒有 variant/u);
    expect(() => prepareMotionDesignV3Graphic(project, "v3_lower_third_bar", { startFrame: 0, durationFrames: 60, lines: ["杜撰人物"] })).toThrow(/人名條/u);
    await expect(prepareEditkinModule({ projectPath: path, moduleId: "graphic.motion_design_v3", variantId: "v3_location_pin",
      inputs: { startFrame: 0, durationFrames: 20, lines: ["京都 · 嵐山"] } })).rejects.toThrow(/至少需要 1 秒/u);
    await expect(prepareEditkinModule({ projectPath: path, moduleId: "graphic.motion_design_v3", variantId: "v3_location_pin",
      inputs: { startFrame: 0, durationFrames: 60, lines: ["京都", "嵐山", "竹林"] } })).rejects.toThrow(/需要 1–2 行/u);
  });

  it("serves the Shorts vlog location slot through a composed template", async () => {
    const prepared = await prepareEditkinTemplate({ projectPath: path, templateId: "shorts.vlog", base: { clipIds: ["clip-a"], beatId: "beat-open" }, fills: [
      { slotId: "location", moduleId: "graphic.motion_design_v3", variantId: "v3_location_pin", beatId: "beat-open",
        inputs: { startFrame: 0, durationFrames: 75, lines: ["京都 · 嵐山", "竹林小徑"] } },
    ], include: "full" }, { environment: fonts });
    expect(prepared.checks.composition).toBe("PASS");
    expect(prepared.fills.map(fill => `${fill.slotId}:${fill.moduleId}/${fill.variantId}`)).toContain("location:graphic.motion_design_v3/v3_location_pin");
    const graphics = (prepared.commands ?? []).filter((command: { type: string }) => command.type === "add_motion_graphic") as Array<{ graphic: { schema: string } }>;
    expect(graphics.map(command => command.graphic.schema)).toEqual(["hao.motion-composition/v3"]);
  });
});
