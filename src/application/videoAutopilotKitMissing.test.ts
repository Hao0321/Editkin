import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VIDEO_AUTOPILOT_KIT_URL, VideoAutopilotKitMissingError, assertVideoAutopilotKitInstalled, resolveLiveVideoAutopilotSkillPath } from "./autopilotInvocationIdentity";

let scratch = "";
beforeEach(async () => { scratch = await mkdtemp(join(tmpdir(), "editkin-va-kit-")); });
afterEach(async () => { await rm(scratch, { recursive: true, force: true }); });

describe("Video Autopilot Kit missing", () => {
  it("names the Kit and where to get it instead of a bare ENOENT", async () => {
    const missing = join(scratch, "skills", "video-autopilot", "SKILL.md");
    const error = await resolveLiveVideoAutopilotSkillPath(missing).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(VideoAutopilotKitMissingError);
    expect((error as VideoAutopilotKitMissingError).code).toBe("VIDEO_AUTOPILOT_KIT_MISSING");
    expect((error as Error).message).toContain(VIDEO_AUTOPILOT_KIT_URL);
    expect((error as Error).message).toMatch(/Video Autopilot Kit/);
    expect((error as Error).message).not.toMatch(/ENOENT|realpath/);
  });

  it("rejects an incomplete Kit and accepts a complete one", async () => {
    const kit = join(scratch, "video-autopilot"), skill = join(kit, "SKILL.md");
    await mkdir(kit, { recursive: true });
    await writeFile(skill, "---\nname: video-autopilot\n---\n");
    await writeFile(join(kit, "workflow_contract.json"), "{}");
    await expect(assertVideoAutopilotKitInstalled(skill)).rejects.toThrow(/editkin_design_bridge\.py[\s\S]*github\.com\/Hao0321\/video-autopilot-kit/);
    await writeFile(join(kit, "editkin_design_bridge.py"), "");
    await expect(assertVideoAutopilotKitInstalled(skill)).resolves.toMatch(/SKILL\.md$/i);
  });
});

describe("in-app vertical Short without the Kit", () => {
  it("refuses with the install message before creating anything", async () => {
    const root = join(scratch, "workspace");
    await mkdir(join(root, ".autopilot"), { recursive: true });
    vi.resetModules();
    vi.doMock("../application/materialColorCodeIdentity", () => ({ materialColorCodeIdentity: () => ({}) }));
    try {
      const { dispatchTemplateShortServiceCommand } = await import("../service/templateShortService");
      const run = dispatchTemplateShortServiceCommand("template_short_run", { sourcePath: "videos/IMG_4022.MOV", genre: "travel",
        copy: { payoff: "其實是來看水簾的", hook: "來看蝙蝠" }, progressPath: join(root, "job", "progress.json") },
      { EDITKIN_WORKSPACE: root, EDITKIN_VIDEO_AUTOPILOT_SKILL: join(scratch, "not-installed", "SKILL.md") });
      await expect(run).rejects.toThrow(VIDEO_AUTOPILOT_KIT_URL);
      expect(await readdir(root)).toEqual([".autopilot"]);
      expect(await readdir(join(root, ".autopilot"))).toEqual([]);
    } finally {
      vi.doUnmock("../application/materialColorCodeIdentity");
      vi.resetModules();
    }
  });
});
