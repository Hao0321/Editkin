import { createEmptyProject } from "../../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type MotionTrackPoint } from "../../domain/types";

/** Explicit synthetic/manual observations; not detector accuracy or real footage evidence. */
export function annotationWorkflowFixtureV1() {
  const p = createEmptyProject("Synthetic annotation authoring", { id: "annotation-control", width: 320, height: 240, fps: 30 });
  p.updatedAt = p.director.updatedAt = "2026-10-17T00:00:00.000Z";
  p.assets = [{ id: "source", name: "Synthetic source; manually authored observations", kind: "video", uri: "D:/synthetic/annotation.mp4", duration: 10, width: 320, height: 240, displayAspectRatio: 4 / 3 }];
  p.tracks[0].clips = [{ id: "selected", assetId: "source", trackId: p.tracks[0].id, timelineStart: 1, sourceStart: 2, duration: 3, volume: 0,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] }];
  p.motionTracks = [{ id: "manual-track", clipId: "selected", name: "Synthetic manual points", engine: "manual:synthetic", analysisFps: 30,
    initialRect: { x: .2, y: .2, width: .2, height: .2 }, lostRatio: 0, createdAt: p.updatedAt,
    points: [0, 1, 3].map((time, i): MotionTrackPoint => {
      const x = .2 + i * .05;
      return { time, frame: time * 30, status: "manual", confidence: 1, rect: { x, y: .2, width: .2, height: .2 },
        quad: [{ x, y: .2 }, { x: x + .2, y: .2 }, { x: x + .2, y: .4 }, { x, y: .4 }] };
    }) }]; return p;
}
