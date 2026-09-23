import { projectFromComposition } from "../domain/editGraph";
import type { EditProject, MediaAsset, TimelineClip, TrackKind } from "../domain/types";

export interface PreviewCompositionAncestor {
  project: EditProject;
  clip: TimelineClip;
  playhead: number;
}

export interface ActivePreviewLayer {
  clip: TimelineClip;
  asset: MediaAsset;
  source: string;
  /** True only for an explicitly bound generated display surface. */
  displayProxy?: boolean;
  displayClip?: TimelineClip;
  displayProject?: EditProject;
  displayPlayhead?: number;
  compositionAncestors?: PreviewCompositionAncestor[];
}

export function previewSurfaceAsset(asset: MediaAsset, source: string, runtimeUrls: Record<string, string>): MediaAsset {
  const derivatives = asset.derivatives;
  const isProxy = source === runtimeUrls[`${asset.id}:proxy`] || source === runtimeUrls[`${asset.id}:overlay-proxy`];
  if (!isProxy || !derivatives?.proxyColor || derivatives.proxyColorContract !== "editkin.browser-display-proxy/v1") return asset;
  // Only a view clone changes interpretation. Saved metadata, source bindings,
  // native admission and formal rendering keep the camera original.
  return { ...asset, color: { ...derivatives.proxyColor } };
}

export function activeMediaLayers(
  project: EditProject,
  time: number,
  runtimeUrls: Record<string, string>,
  kind: Extract<TrackKind, "video" | "audio">,
): ActivePreviewLayer[] {
  const root = project;
  const collect = (view: EditProject, localTime: number, ancestors: PreviewCompositionAncestor[], path: string[]): ActivePreviewLayer[] => (
    view.tracks.filter((track) => track.kind === kind && !track.muted).flatMap((track) => {
      const clip = track.clips.find((item) => localTime >= item.timelineStart && localTime < item.timelineStart + item.duration);
      if (!clip || clip.layer?.enabled === false || clip.layer?.role === "controller" || clip.layer?.role === "adjustment") return [];
      const asset = root.assets.find((item) => item.id === clip.assetId);
      if (!asset) return [];
      if (asset.compositionId) {
        if (path.includes(asset.compositionId)) return [];
        const composition = root.compositions.find((candidate) => candidate.id === asset.compositionId);
        if (!composition) return [];
        const nestedTime = clip.sourceStart + localTime - clip.timelineStart;
        const nested = projectFromComposition(root, composition);
        return collect(nested, nestedTime, [...ancestors, { project: view, clip, playhead: localTime }], [...path, asset.compositionId]);
      }
      const source = runtimeUrls[asset.id] ?? asset.uri;
      const surfaceAsset = previewSurfaceAsset(asset, source, runtimeUrls);
      const displayProxy = surfaceAsset !== asset;
      if (!ancestors.length) return [{ clip, asset: surfaceAsset, source, displayProxy }];
      const mediaTime = clip.sourceStart + Math.max(0, localTime - clip.timelineStart);
      const synthetic: TimelineClip = {
        ...clip,
        id: `${path.join("/")}/${clip.id}`,
        timelineStart: time,
        sourceStart: mediaTime,
        duration: Math.max(1 / root.fps, clip.timelineStart + clip.duration - localTime),
      };
      return [{
        clip: synthetic,
        asset: surfaceAsset,
        source,
        displayProxy,
        displayClip: clip,
        displayProject: view,
        displayPlayhead: localTime,
        compositionAncestors: ancestors,
      }];
    })
  );
  return collect(project, time, [], []);
}
