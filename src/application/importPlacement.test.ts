import { describe, expect, it } from "vitest";
import { applyCommand } from "../domain/commands";
import { createEmptyProject } from "../domain/editGraph";
import { createUiDemoProject } from "../domain/demo";
import type { EditProject, MediaAsset } from "../domain/types";
import { planImportedMediaPlacement } from "./importPlacement";

const media = (id: string, kind: MediaAsset["kind"], duration: number, width?: number, height?: number): MediaAsset => ({
  id, name: id, kind, uri: `C:/fixtures/${id}.${kind === "audio" ? "wav" : kind === "image" ? "jpg" : "mp4"}`,
  duration, ...(width && height ? { width, height } : {}),
});
const applyPlacement = (project: EditProject, assets: MediaAsset[]) => {
  let clipIndex = 0;
  const placement = planImportedMediaPlacement(project, assets, () => `clip-${++clipIndex}`);
  return { placement, project: applyCommand(project, { type: "batch", commands: placement.commands }) };
};

describe("import placement", () => {
  it("removes the starter clip when audio is the first real import", () => {
    const result = applyPlacement(createUiDemoProject(), [media("voice", "audio", 5)]);
    expect(result.placement.replacedStarter).toBe(true);
    expect(result.project.assets.map((asset) => asset.id)).toEqual(["voice"]);
    expect(result.project.tracks.find((track) => track.kind === "video")?.clips).toEqual([]);
    expect(result.project.tracks.find((track) => track.kind === "audio")?.clips[0]?.timelineStart).toBe(0);
  });

  it("aligns new picture and voice from zero while keeping each track sequential", () => {
    const result = applyPlacement(createEmptyProject(), [
      media("voice-a", "audio", 4), media("video-a", "video", 2, 1080, 1920),
      media("image-b", "image", 3, 1080, 1920), media("voice-b", "audio", 6),
    ]);
    expect(result.project.tracks.find((track) => track.kind === "video")?.clips.map((clip) => clip.timelineStart)).toEqual([0, 2]);
    expect(result.project.tracks.find((track) => track.kind === "audio")?.clips.map((clip) => clip.timelineStart)).toEqual([0, 4]);
    expect([result.project.width, result.project.height]).toEqual([1080, 1920]);
  });

  it("continues imported media at the end of its own existing track", () => {
    const initial = applyPlacement(createEmptyProject(), [media("video-a", "video", 5, 1920, 1080), media("voice-a", "audio", 3)]).project;
    let clipIndex = 10;
    const placement = planImportedMediaPlacement(initial, [media("voice-b", "audio", 4), media("video-b", "video", 2, 1920, 1080)], () => `clip-${++clipIndex}`);
    const updated = applyCommand(initial, { type: "batch", commands: placement.commands });
    expect(updated.tracks.find((track) => track.kind === "video")?.clips.map((clip) => clip.timelineStart)).toEqual([0, 5]);
    expect(updated.tracks.find((track) => track.kind === "audio")?.clips.map((clip) => clip.timelineStart)).toEqual([0, 3]);
  });
});
