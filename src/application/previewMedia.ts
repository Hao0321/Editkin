import { trackAudioAudible } from "../domain/trackState";
import { projectFromComposition } from "../domain/editGraph";
import type { EditProject, MediaAsset, TimelineClip, TimelineTrack, TrackKind } from "../domain/types";

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
  /** The layer's sound is off: its track (or the track of a precomposition that holds it) is muted. Its picture still shows. */
  silent?: boolean;
}

/** Keep the final mesh frame's sources mounted, even after an end seek. */
export function mesh3dPreviewTime(project: EditProject, time: number): number {
  if (!project.scene3d?.enabled) return time;
  const last = project.scene3d.segments.at(-1);
  if (!last) return time;
  const lastFrame = Math.max(0, Math.round((last.timelineStart + last.duration) * project.fps) - 1);
  return Math.max(0, Math.min(time, lastFrame / project.fps));
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
  // Pictures come from tracks that are not hidden; a muted picture track still shows, silently. Sound tracks follow mute.
  // A hidden picture track keeps its sound: its clips (and, inside a hidden precomposition, the nested picture clips)
  // play as sound-only layers, so the media-element preview hears what the export mixes.
  const included = (view: EditProject, track: TimelineTrack, hiddenAbove: boolean) => kind === "video"
    ? track.kind === "video" && !track.hidden
    : trackAudioAudible(view, track) && (hiddenAbove ? track.kind === "video" : track.kind === "audio" || (track.kind === "video" && track.hidden === true));
  const collect = (view: EditProject, localTime: number, ancestors: PreviewCompositionAncestor[], path: string[], silentAbove: boolean, hiddenAbove = false): ActivePreviewLayer[] => (
    view.tracks.filter((track) => included(view, track, hiddenAbove)).flatMap((track) => {
      const silent = silentAbove || !trackAudioAudible(view, track);
      const clip = track.clips.find((item) => localTime >= item.timelineStart && localTime < item.timelineStart + item.duration);
      if (!clip || clip.layer?.enabled === false || clip.layer?.role === "controller" || clip.layer?.role === "adjustment") return [];
      const asset = root.assets.find((item) => item.id === clip.assetId);
      if (!asset || (kind === "audio" && asset.kind === "image")) return [];
      if (asset.compositionId) {
        if (path.includes(asset.compositionId)) return [];
        const composition = root.compositions.find((candidate) => candidate.id === asset.compositionId);
        if (!composition) return [];
        const nestedTime = clip.sourceStart + localTime - clip.timelineStart;
        const nested = projectFromComposition(root, composition);
        const hidden = kind === "audio" && (hiddenAbove || (track.kind === "video" && track.hidden === true));
        return collect(nested, nestedTime, [...ancestors, { project: view, clip, playhead: localTime }], [...path, asset.compositionId], silent, hidden);
      }
      const source = runtimeUrls[asset.id] ?? asset.uri;
      const surfaceAsset = previewSurfaceAsset(asset, source, runtimeUrls);
      const displayProxy = surfaceAsset !== asset;
      if (!ancestors.length) return [{ clip, asset: surfaceAsset, source, displayProxy, ...(silent ? { silent } : {}) }];
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
        ...(silent ? { silent } : {}),
      }];
    })
  );
  return collect(project, kind === "video" ? mesh3dPreviewTime(project, time) : time, [], [], false);
}
