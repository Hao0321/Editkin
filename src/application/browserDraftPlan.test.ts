import { describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { DEFAULT_COLOR_MANAGEMENT } from "../domain/types";
import { browserDraftPlan, BROWSER_DRAFT_MAX_SECONDS } from "./browserDraftPlan";

const urls = { "asset-demo": "blob:local-import" };

describe("browser draft export admission", () => {
  it("requires live imported sources rather than fetching persisted paths or remote URLs", () => {
    const project = createDemoProject();
    const invalidSources: Record<string, string>[] = [{}, { "asset-demo": "https://example.com/private.mp4" }, { "asset-demo": "file:///private.mp4" }];
    for (const sources of invalidSources) {
      expect(() => browserDraftPlan(project, sources)).toThrow(/重新匯入/);
    }
    expect(browserDraftPlan(project, urls).clips[0].source).toBe(urls["asset-demo"]);
  });
  it("ignores muted/disabled unsupported content but does not silently omit active effects", () => {
    const project = createDemoProject();
    project.tracks[0].clips[0].floatingFrame = { schema: "editkin.floating-video-frame/v1", style: "prism", size: 0.6, yawDegrees: 0, pitchDegrees: 0 };
    expect(() => browserDraftPlan(project, urls)).toThrow(/透視/);
    project.tracks[0].muted = true;
    expect(browserDraftPlan(project, {}).clips).toEqual([]);
  });
  it("refuses ACES and explicit HDR input instead of treating them as SDR", () => {
    const project = createDemoProject();
    project.colorManagement = { ...DEFAULT_COLOR_MANAGEMENT, mode: "aces2" };
    expect(() => browserDraftPlan(project, urls)).toThrow(/ACES/);
    project.colorManagement.mode = "rec709";
    project.assets[0].color = { interpretation: "hlg" };
    expect(() => browserDraftPlan(project, urls)).toThrow(/HDR/);
  });
  it("rejects linear white balance even when authored only in a keyframe", () => {
    const project = createDemoProject();
    const clip = project.tracks[0].clips[0];
    clip.keyframes.push({ id: "wb", time: 1, transform: { ...clip.transform }, color: { ...clip.color, whiteBalanceRed: 0.1 }, easing: "linear" });
    expect(() => browserDraftPlan(project, urls)).toThrow(/線性白平衡/);
  });
  it("bounds recording duration, allowing the exact limit", () => {
    const project = createDemoProject();
    project.assets[0].duration = BROWSER_DRAFT_MAX_SECONDS + 1;
    project.tracks[0].clips[0].duration = BROWSER_DRAFT_MAX_SECONDS;
    expect(browserDraftPlan(project, urls).duration).toBe(BROWSER_DRAFT_MAX_SECONDS);
    project.tracks[0].clips[0].duration++;
    expect(() => browserDraftPlan(project, urls)).toThrow(/5 分鐘/);
  });
  it("preserves portrait geometry and limits resolution and rate without enlarging small media", () => {
    const project = createDemoProject();
    project.width = 1080; project.height = 1920; project.fps = 60;
    const portrait = browserDraftPlan(project, urls);
    expect([portrait.width, portrait.height, portrait.fps]).toEqual([720, 1280, 30]);
    project.width = 320; project.height = 180; project.fps = 24;
    const small = browserDraftPlan(project, urls);
    expect([small.width, small.height, small.fps]).toEqual([320, 180, 24]);
  });
});
