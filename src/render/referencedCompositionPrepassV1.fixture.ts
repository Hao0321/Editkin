import { createDemoProject } from "../domain/demo";
import type { EditComposition, EditProject } from "../domain/types";

/** Synthetic metadata only; these helpers neither create nor inspect media. */
export function addCompositionFixtureV1(project: EditProject, id: string, sourceAssetId: string, duration = 1): EditComposition {
  const track = structuredClone(project.tracks[0]);
  track.id = `track:${id}`;
  const clip = structuredClone(project.tracks[0].clips[0]);
  Object.assign(clip, { id: `clip:${id}`, trackId: track.id, assetId: sourceAssetId,
    timelineStart: 0, sourceStart: 0, duration, volume: 0 });
  track.clips = [clip];
  const composition: EditComposition = {
    schema: "editkin.composition/v1", id, name: id,
    width: project.width, height: project.height, fps: project.fps, duration,
    tracks: [track], captions: [], captionStyle: structuredClone(project.captionStyle),
    motionTracks: [], motionGraphics: [], director: structuredClone(project.director), updatedAt: project.updatedAt,
  };
  project.compositions.push(composition);
  project.assets.push({ id: `asset:${id}`, name: id, kind: "video", compositionId: id,
    uri: `editkin-composition://${id}`, duration, width: composition.width, height: composition.height });
  return composition;
}

export function referencedCompositionProjectFixtureV1(options: {
  sourceUri?: string; unusedUri?: string; includeUnused?: boolean; unusedDuration?: number;
} = {}): EditProject {
  const project = createDemoProject();
  project.width = 320; project.height = 180; project.fps = 30;
  project.captions = []; project.motionGraphics = []; project.motionTracks = [];
  Object.assign(project.assets[0], { uri: options.sourceUri ?? "referenced-source.mkv", width: 320, height: 180, duration: 2 });
  const clip = project.tracks[0].clips[0];
  Object.assign(clip, { timelineStart: 0, sourceStart: 0, duration: 1, volume: 0 });
  project.tracks[0].clips = [clip];
  addCompositionFixtureV1(project, "used", project.assets[0].id);
  clip.assetId = "asset:used";
  if (options.includeUnused !== false) {
    const duration = options.unusedDuration ?? 1;
    project.assets.push({ id: "unused-source", name: "unused-source", kind: "video",
      uri: options.unusedUri ?? "unused-source-must-not-open.mkv", duration, width: 320, height: 180 });
    addCompositionFixtureV1(project, "unused", "unused-source", duration);
  }
  return project;
}
