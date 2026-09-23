import type { MediaAsset } from "../domain/types";

export type CanvasOrientation = "portrait" | "landscape" | "square";

export interface CanvasResolution {
  width: number;
  height: number;
  orientation: CanvasOrientation;
  label: "9:16" | "16:9" | "1:1";
}

export function canvasResolutionForAsset(asset: Pick<MediaAsset, "kind" | "width" | "height">): CanvasResolution | undefined {
  if (asset.kind === "audio" || !asset.width || !asset.height || asset.width <= 0 || asset.height <= 0) return undefined;
  const ratio = asset.width / asset.height;
  if (ratio < 0.9) return { width: 1080, height: 1920, orientation: "portrait", label: "9:16" };
  if (ratio > 1.1) return { width: 1920, height: 1080, orientation: "landscape", label: "16:9" };
  return { width: 1080, height: 1080, orientation: "square", label: "1:1" };
}

export function isStarterDemo(project: { assets: Array<{ id: string }>; tracks: Array<{ clips: Array<{ id: string }> }> }): boolean {
  return project.assets.length === 1
    && project.assets[0]?.id === "asset-demo"
    && project.tracks.flatMap((track) => track.clips).length === 1
    && project.tracks.some((track) => track.clips.some((clip) => clip.id === "clip-demo"));
}
