import { describe, expect, it } from "vitest";
import { projectPotentialAudioGaps } from "./audioCoverage";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";
import type { EditProject, MediaAsset, TimelineClip } from "../domain/types";

const asset = (id: string, kind: MediaAsset["kind"]): MediaAsset => ({ id, name: id, kind, uri: id, duration: 60 });
const clip = (id: string, assetId: string, trackId: string, timelineStart: number, duration: number): TimelineClip => ({
  id, assetId, trackId, timelineStart, duration, sourceStart: 0, volume: 1,
  transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [],
});
const project = (): EditProject => {
  const result = createEmptyProject();
  result.assets = [asset("video", "video"), asset("still", "image"), asset("voice", "audio")];
  result.tracks[0].clips = [clip("opening", "video", "video-main", 0, 8), clip("slide", "still", "video-main", 8, 40)];
  return result;
};

describe("potential audio coverage", () => {
  it("identifies the long image-only tail without claiming video audio was verified", () => {
    expect(projectPotentialAudioGaps(project())).toEqual([{ start: 8, end: 48 }]);
  });

  it("merges overlapping sound across tracks and reacts to mute or zero volume", () => {
    const edit = project();
    edit.tracks[1].clips = [clip("voice-a", "voice", "audio-main", 7, 20), clip("voice-b", "voice", "audio-main", 26, 22)];
    expect(projectPotentialAudioGaps(edit)).toEqual([]);
    edit.tracks[1].clips[1].volume = 0;
    expect(projectPotentialAudioGaps(edit)).toEqual([{ start: 27, end: 48 }]);
    edit.tracks[1].muted = true;
    expect(projectPotentialAudioGaps(edit)).toEqual([{ start: 8, end: 48 }]);
  });

  it("ignores tiny intentional pauses and empty projects", () => {
    expect(projectPotentialAudioGaps(createEmptyProject())).toEqual([]);
    const edit = project();
    edit.tracks[1].clips = [clip("voice", "voice", "audio-main", 9, 39)];
    expect(projectPotentialAudioGaps(edit)).toEqual([]);
  });
});
