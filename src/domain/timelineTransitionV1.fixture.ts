import { createDemoProject } from "./demo";
import type { TimelineTransition } from "./timelineTransitionV1";

export function pairFixtureV1() {
  const project = createDemoProject(), first = project.tracks[0].clips[0];
  first.duration = 2; first.sourceStart = 1;
  project.tracks[0].clips.push({ ...structuredClone(first), id: "incoming", sourceStart: 4, timelineStart: 2 });
  const transition: TimelineTransition = { schema: "editkin.timeline-transition/v1", id: "cut", trackId: first.trackId,
    fromClipId: first.id, toClipId: "incoming", beforeFrames: 12, afterFrames: 12, kernel: "dissolve" };
  return { project, transition };
}
