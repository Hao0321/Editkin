import { describe, expect, it } from "vitest";
import { applyCommand } from "../domain/commands";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";
import { buildNativeAutopilotCommand, planNativeAutopilotCreative } from "./nativeAutopilot";
import { planSemanticAutoEdit } from "./semanticAutoEdit";
import { createCaptionGapAllocator } from "./nativeAutopilotGraphicTiming";
import { parseProject } from "./projectFiles";

function build(width: number, height: number, alignment: 2 | 5 | 8, continuous = false) {
  let project = createEmptyProject("graphic safety", { id: "safe", width, height, fps: 30 });
  const asset = { id: "source", uri: "synthetic.mp4", name: "synthetic", kind: "video" as const, duration: 20, width, height };
  const clip = { id: "clip", assetId: asset.id, trackId: "video-main", timelineStart: 0, sourceStart: 0, duration: 20, volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] };
  project = applyCommand(project, { type: "batch", commands: [{ type: "import_asset", asset }, { type: "add_clip", clip }, { type: "set_caption_style", patch: { alignment, marginV: 110, fontSize: 72 } }] });
  const cues = [{ start: 0, end: continuous ? 20 : 1, text: "這是完整必要字幕，不可為圖卡刪掉" }];
  const semantic = { ...planSemanticAutoEdit({ duration: 20, fps: 30, cues, targetRatio: 1 }), keepRanges: [{ start: 0, end: 20 }], keptDuration: 20 };
  const creative = planNativeAutopilotCreative({ duration: 20, width, height, cues, video: true, policy: { format: "longform", ownership: "automatic" } });
  const trackingResult = { engine: "synthetic-test-track", analysisFps: 15, width, height, points: [0, 15, 30].map(frame => ({ frame, time: frame / 15, rect: { x: .2, y: .75, width: .2, height: .2 }, confidence: .9, status: "tracked" as const })), lostRatio: 0, analyzedSeconds: 20, elapsedMs: 1, cacheHit: false };
  const built = buildNativeAutopilotCommand({ project, clip, transcript: { cues }, semantic, creative, trackingResult, idFactory: (kind, index) => `${kind}-${index}` });
  return applyCommand(project, built.command);
}

describe("optional native graphics avoid actual subtitle intervals", () => {
  for (const [width, height, alignment] of [[1920, 1080, 2], [1080, 1920, 2], [1920, 1080, 8], [1080, 1920, 5]] as const) {
    it(`blocks rejected artwork even with sufficient gaps ${width}/${height}/${alignment}`, () => {
      const project = build(width, height, alignment);
      expect(project.motionGraphics).toHaveLength(0);
      expect(project.director.markers.at(-1)?.note).toContain("blocked-pending-art-review");
      expect(project.captions[0].text).toBe("這是完整必要字幕，不可為圖卡刪掉");
      for (const graphic of project.motionGraphics) for (const caption of project.captions) {
        expect(graphic.timelineStart >= caption.start + caption.duration + 1 / project.fps
          || graphic.timelineStart + graphic.duration <= caption.start - 1 / project.fps).toBe(true);
      }
      expect(() => parseProject(JSON.parse(JSON.stringify(project)))).not.toThrow();
    });
    it(`never overlays continuous subtitle text ${width}/${height}/${alignment}`, () => {
      const project = build(width, height, alignment, true);
      expect(project.motionGraphics).toHaveLength(0);
      expect(project.captions).toHaveLength(1);
      expect(project.captions[0].duration).toBe(20);
      expect(project.director.markers.at(-1)?.note).toContain("blocked-pending-art-review");
      expect(project.motionTracks).toHaveLength(0);
    });
  }
  it("does not flash optional text into a sub-second gap or exceed a track segment", () => {
    const allocate = createCaptionGapAllocator([], 0, 10, 30);
    expect(allocate(0, 4, .9)).toBeUndefined();
    expect(allocate(0, 4, 2)).toEqual({ timelineStart: 0, duration: 2 });
    expect(allocate(0, 4, 2)).toBeUndefined();
  });
});
