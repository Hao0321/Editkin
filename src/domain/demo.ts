import { createEmptyProject, validateProject } from "./editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject } from "./types";

export const ENGINE_DEMO_SOURCE_URI = "demo-source.mp4";
export const UI_DEMO_PREVIEW_URI = "editkin-demo-preview.mp4";

function createStarterProject(sourceUri: string): EditProject {
  const project = createEmptyProject("我的第一支影片", {
    id: "editkin-demo",
    width: 1920,
    height: 1080,
    fps: 30,
  });
  project.assets.push({
    id: "asset-demo",
    name: "Editkin 示範素材",
    kind: "video",
    uri: sourceUri,
    duration: 12,
    width: 960,
    height: 540,
  });
  project.tracks[0].clips.push({
    id: "clip-demo",
    assetId: "asset-demo",
    trackId: "video-main",
    timelineStart: 0,
    sourceStart: 0,
    duration: 12,
    volume: 1,
    transform: { ...DEFAULT_TRANSFORM },
    color: { ...DEFAULT_COLOR },
    keyframes: [],
  });
  return validateProject(project);
}

/** Stable engine/test fixture. Product UI must use createUiDemoProject instead. */
export function createDemoProject(): EditProject {
  return createStarterProject(ENGINE_DEMO_SOURCE_URI);
}

/** Neutral, low-distraction starter shown only in the interactive editor UI. */
export function createUiDemoProject(): EditProject {
  return createStarterProject(UI_DEMO_PREVIEW_URI);
}
