import { describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { buildTimelineSnapIndex, queryTimelineSnapTimes } from "./timelineSnapping";

describe("cross-track snapping index", () => {
  it("includes other track edges and caption edges, excluding only the edited item", () => {
    const project = createDemoProject();
    const source = project.tracks[0].clips[0];
    project.tracks[0].clips = [{ ...source, id: "moving", timelineStart: 3, duration: 2 }];
    project.tracks.push({ id: "overlay-test", name: "Overlay", kind: "video", locked: true, muted: false, clips: [{ ...source, id: "reference", trackId: "overlay-test", timelineStart: 7, duration: 2 }] });
    project.captions = [{ id: "words", text: "text", start: 12, duration: 1 }];
    const index = buildTimelineSnapIndex(project);
    expect(queryTimelineSnapTimes(index, "clip:moving", [3, 5], 80, 30, 20)).not.toEqual(expect.arrayContaining([3, 5]));
    expect(queryTimelineSnapTimes(index, "clip:moving", [7.04, 9.04], 80, 30, 20)).toEqual(expect.arrayContaining([7, 9, 20]));
    expect(queryTimelineSnapTimes(index, "clip:moving", [12.02], 80, 30, 20)).toContain(12);
    expect(queryTimelineSnapTimes(index, "clip:moving", [0.02], 80, 30, 20)).toContain(0);
  });

  it("queries a bounded window even with fifty thousand distant clips", () => {
    const project = createDemoProject();
    const source = project.tracks[0].clips[0];
    project.tracks[0].clips = Array.from({ length: 50000 }, (_, i) => ({ ...source, id: `clip-${i}`, timelineStart: i * 3, duration: 2 }));
    const result = queryTimelineSnapTimes(buildTimelineSnapIndex(project), "clip:clip-40000", [120003.02, 120005.02], 80, 30, 1);
    expect(result).toEqual(expect.arrayContaining([120003, 120005]));
    expect(result.length).toBeLessThan(6);
  });
});
