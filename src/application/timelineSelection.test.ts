import { describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { emptyTimelineSelection, normalizeTimelineSelection, selectAllTimelineItems, selectTimelineItem } from "./timelineSelection";

describe("timeline multiselection", () => {
  it("single click replaces both kinds; modifier click toggles and keeps exactly one primary", () => {
    const a = selectTimelineItem(emptyTimelineSelection(), { kind: "clip", id: "a" });
    const ab = selectTimelineItem(a, { kind: "clip", id: "b" }, true);
    expect(ab).toEqual({ clipIds: ["a", "b"], captionIds: [], primaryClipId: "b" });
    const mixed = selectTimelineItem(ab, { kind: "caption", id: "c" }, true);
    expect(mixed).toEqual({ clipIds: ["a", "b"], captionIds: ["c"], primaryCaptionId: "c" });
    expect(selectTimelineItem(mixed, { kind: "caption", id: "c" }, true)).toEqual(ab);
    expect(selectTimelineItem(mixed, { kind: "clip", id: "a" })).toEqual(a);
    expect(a.clipIds).toEqual(["a"]);
  });

  it("removes deleted ids and duplicate ids without holding a stale primary", () => {
    const project = createDemoProject();
    expect(normalizeTimelineSelection(project, { clipIds: ["gone", "clip-demo", "clip-demo"], captionIds: ["missing"], primaryClipId: "gone" }))
      .toEqual({ clipIds: ["clip-demo"], captionIds: [], primaryClipId: "clip-demo" });
    expect(normalizeTimelineSelection(project, { clipIds: ["gone"], captionIds: [], primaryClipId: "gone" })).toEqual(emptyTimelineSelection());
  });

  it("selects every timeline item, including locked tracks; forward is frame-aligned and start-based", () => {
    const project = createDemoProject();
    project.tracks[0].locked = true;
    project.tracks[0].clips[0].duration = 4;
    project.tracks[0].clips.push({ ...structuredClone(project.tracks[0].clips[0]), id: "later", timelineStart: 5 });
    project.captions = [{ id: "text", start: 5, duration: 1, text: "文字" }];
    expect(selectAllTimelineItems(project)).toMatchObject({ clipIds: ["clip-demo", "later"], captionIds: ["text"] });
    expect(selectAllTimelineItems(project, 5)).toMatchObject({ clipIds: ["later"], captionIds: ["text"] });
    expect(selectAllTimelineItems(project, 9)).toEqual(emptyTimelineSelection());
  });
});
