import { describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { createHistory, dispatchCommand, undo } from "../domain/history";
import { buildCaptionTrimCommand, buildClipTrimCommand } from "./timelineTrim";
import { resolveTimelineTrim } from "../ui/timelineInteraction";

describe("timeline trim command", () => {
  it("keeps the original clip end and commits a start trim as one Undo step", () => {
    const initial = createHistory(createDemoProject());
    const clip = initial.present.tracks.flatMap((track) => track.clips)[0];
    const originalEnd = clip.timelineStart + clip.duration;
    const edited = dispatchCommand(initial, buildClipTrimCommand(clip, "start", 1));
    const current = edited.present.tracks.flatMap((track) => track.clips).find((item) => item.id === clip.id)!;
    expect(current.timelineStart).toBe(clip.timelineStart + 1);
    expect(current.timelineStart + current.duration).toBe(originalEnd);
    expect(edited.past).toHaveLength(1);
    expect(undo(edited).present).toEqual(initial.present);
  });

  it("updates caption start and duration together", () => {
    const caption = { id: "caption-test", text: "可編輯字幕", start: 2, duration: 3 };
    const command = buildCaptionTrimCommand(caption, "start", 0.5);
    expect(command).toMatchObject({ type: "update_caption", captionId: caption.id, patch: { start: caption.start + 0.5, duration: caption.duration - 0.5 } });
  });

  it.each(["start", "end"] as const)("persists the same frame-rounded %s trim shown in the preview", (edge) => {
    const caption = { id: "caption-test", text: "可編輯字幕", start: 2.013, duration: 4.013 };
    const resolved = resolveTimelineTrim({ edge, originStart: caption.start, duration: caption.duration, originClientX: 100, currentClientX: edge === "start" ? 176 : 24, pixelsPerSecond: 80, fps: 30, snapCandidates: [3, 5] });
    expect(buildCaptionTrimCommand(caption, edge, resolved.trimSeconds, 30)).toMatchObject({ patch: { start: resolved.start, duration: resolved.duration } });
  });
});
