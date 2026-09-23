import { describe, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type MotionTrack, type TimelineClip } from "../domain/types";
import { buildPodcastDirectorCommand, planPodcastShots } from "./podcastDirector";

function track(role: "host" | "guest", activeFrom: number, activeTo: number): MotionTrack {
  return {
    id: role, clipId: "source", name: role, role, engine: "hao-core-rust-motion-track-0.2", analysisFps: 10,
    initialRect: role === "host" ? { x: 0.1, y: 0.2, width: 0.2, height: 0.3 } : { x: 0.68, y: 0.2, width: 0.2, height: 0.3 },
    points: Array.from({ length: 60 }, (_, frame) => ({ frame, time: frame / 10, rect: role === "host" ? { x: 0.1, y: 0.2, width: 0.2, height: 0.3 } : { x: 0.68, y: 0.2, width: 0.2, height: 0.3 }, confidence: 0.95, status: "tracked" as const, activity: frame / 10 >= activeFrom && frame / 10 < activeTo ? 0.08 : 0.004 })),
    lostRatio: 0, createdAt: "2026-08-23T00:00:00.000Z",
  };
}

describe("podcast director", () => {
  it("switches active speaker and falls back to split without speech evidence", () => {
    const shots = planPodcastShots({ duration: 6, fps: 30, host: track("host", 0, 2.5), guest: track("guest", 2.5, 5), cues: [{ start: 0, end: 5, text: "對話" }] });
    expect(shots.some((shot) => shot.mode === "host")).toBe(true);
    expect(shots.some((shot) => shot.mode === "guest")).toBe(true);
    expect(shots.at(-1)?.mode).toBe("split");
  });

  it("builds editable source-derived shots, captions and evidence marker", () => {
    const project = createEmptyProject("Podcast");
    project.assets.push({ id: "asset", name: "talk.mp4", kind: "video", uri: "C:/talk.mp4", duration: 6, width: 1920, height: 1080 });
    const clip: TimelineClip = { id: "source", assetId: "asset", trackId: "video-main", timelineStart: 0, sourceStart: 0, duration: 6, volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] };
    project.tracks[0].clips.push(clip);
    const built = buildPodcastDirectorCommand({ project, clip, host: track("host", 0, 2.5), guest: track("guest", 2.5, 5), cues: [{ start: 0, end: 5, text: "可編輯字幕" }], idFactory: (kind, index) => `${kind}-${index}` });
    expect(built.command.type).toBe("batch");
    if (built.command.type !== "batch") return;
    expect(built.command.commands.filter((command) => command.type === "add_track")).toHaveLength(2);
    expect(built.command.commands.some((command) => command.type === "add_clip" && command.clip.layout?.viewport.height === 0.5)).toBe(true);
    expect(built.command.commands.some((command) => command.type === "add_caption")).toBe(true);
    expect(built.command.commands.some((command) => command.type === "add_director_marker")).toBe(true);
  });
});
