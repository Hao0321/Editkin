import type { EditProject, MotionGraphic, TimelineClip } from "../domain/types";
import { frameRateRationalV1, frameToSecondsV1 } from "./longRenderClockV1";
import { LongRenderRefusalV1 } from "./longRenderContractsV1";
import { assertLongChunkClocksV1 } from "./longChunkClockAuditV1";
import type { LongCompositeChunkV1 } from "./longChunkPlannerV1";
import { createUnifiedLayerScopeProjectorV1 } from "../domain/unifiedLayerScopeV1";

const EPS = 1e-8;
export function longChunkGraphIndexV1(project: EditProject) {
  const clips = new Map(project.tracks.flatMap(track => track.clips).map(clip => [clip.id, clip]));
  const tracks = new Map(project.motionTracks.map(track => [track.id, track]));
  const dependencies = (clip: TimelineClip) => [clip.layer?.parentClipId, clip.layer?.trackMatte?.sourceClipId].filter((id): id is string => Boolean(id));
  const graphicClips = (graphic: MotionGraphic) => [graphic.trackId, graphic.vectorTrackingV1?.trackId].filter((id): id is string => Boolean(id))
    .map(id => { const track = tracks.get(id); if (!track) throw new LongRenderRefusalV1("LONG_RENDER_CHUNK_FIELD_UNSUPPORTED", "graphic refers to a missing motion track", { trackId: id }); return track.clipId; });
  return { clips, tracks, dependencies, graphicClips };
}
function timedIndex<T>(items: readonly T[], start: (item: T) => number, duration: (item: T) => number) {
  const sorted = [...items].sort((a, b) => start(a) - start(b));
  const maxEnd: number[] = []; let latest = -Infinity;
  for (const item of sorted) { latest = Math.max(latest, start(item) + duration(item)); maxEnd.push(latest); }
  const lower = (time: number) => { let lo = 0, hi = sorted.length; while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (start(sorted[mid]) < time) lo = mid + 1; else hi = mid; } return lo; };
  return (from: number, to: number) => {
    const first = lower(from - EPS), last = lower(to - EPS);
    if (first && maxEnd[first - 1] > from + EPS) throw new LongRenderRefusalV1("LONG_RENDER_CHUNK_FIELD_UNSUPPORTED", "a visual object crosses the requested chunk start");
    const selected = sorted.slice(first, last);
    if (selected.some(item => start(item) + duration(item) > to + EPS)) throw new LongRenderRefusalV1("LONG_RENDER_CHUNK_FIELD_UNSUPPORTED", "a visual object crosses the requested chunk end");
    return selected;
  };
}

/** Build once per run; each chunk visits its selected records, rather than cloning/scanning the whole movie. */
export function createLongSubProjectIndexV1(project: EditProject) {
  assertLongChunkClocksV1(project);
  const projectOrder = createUnifiedLayerScopeProjectorV1(project);
  const rate = frameRateRationalV1(project.fps), graph = longChunkGraphIndexV1(project);
  const videos = project.tracks.filter(track => track.kind === "video").map(track => ({ track, select: timedIndex(track.clips, clip => clip.timelineStart, clip => clip.duration) }));
  const captions = timedIndex(project.captions, item => item.start, item => item.duration);
  const graphics = timedIndex(project.motionGraphics, item => item.timelineStart, item => item.duration);
  const scenes = timedIndex(project.motionScenes ?? [], item => frameToSecondsV1(item.startFrame, rate), item => frameToSecondsV1(item.durationFrames, rate));
  const assets = new Map(project.assets.map(asset => [asset.id, asset]));
  const motionByClip = new Map<string, typeof project.motionTracks>();
  for (const track of project.motionTracks) { const list = motionByClip.get(track.clipId) ?? []; list.push(track); motionByClip.set(track.clipId, list); }
  return (chunk: LongCompositeChunkV1) => {
    const start = frameToSecondsV1(chunk.startFrame, rate), end = frameToSecondsV1(chunk.startFrame + chunk.frameCount, rate);
    if (chunk.preRollFrames !== 0) throw new LongRenderRefusalV1("LONG_RENDER_ROUTE_NOT_AVAILABLE", "the current clean-boundary provider admits zero temporal support only");
    const chosen = new Map<string, TimelineClip>();
    for (const video of videos) for (const clip of video.select(start, end)) chosen.set(clip.id, clip);
    const selectedGraphics = graphics(start, end), selectedCaptions = captions(start, end), selectedScenes = scenes(start, end);
    const requireClip = (id: string) => {
      const clip = graph.clips.get(id);
      if (!clip || clip.timelineStart < start - EPS || clip.timelineStart + clip.duration > end + EPS) {
        throw new LongRenderRefusalV1("LONG_RENDER_CHUNK_FIELD_UNSUPPORTED", "a parent, matte or tracking dependency is outside its clean chunk", { clipId: id });
      }
      if (!chosen.has(id)) chosen.set(id, clip);
    };
    for (const graphic of selectedGraphics) for (const id of graph.graphicClips(graphic)) requireClip(id);
    const visited = new Set<string>();
    for (const clip of chosen.values()) {
      if (visited.has(clip.id)) continue;
      visited.add(clip.id); for (const id of graph.dependencies(clip)) requireClip(id);
    }
    const trackClips = new Map<string, TimelineClip[]>();
    for (const clip of chosen.values()) { const rows = trackClips.get(clip.trackId) ?? []; rows.push(clip); trackClips.set(clip.trackId, rows); }
    const wantedAssets = new Set<string>();
    const collectAssets = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) { value.forEach(collectAssets); return; }
      for (const [key, item] of Object.entries(value)) {
        if ((key === "assetId" || key === "sourceAssetId") && typeof item === "string") wantedAssets.add(item);
        else collectAssets(item);
      }
    };
    for (const clip of chosen.values()) collectAssets(clip);
    selectedGraphics.forEach(collectAssets);
    const selectedAssets = [];
    for (const id of wantedAssets) {
      const asset = assets.get(id);
      if (!asset) throw new LongRenderRefusalV1("LONG_RENDER_CHUNK_FIELD_UNSUPPORTED", "a selected source asset is missing", { assetId: id });
      selectedAssets.push(asset); collectAssets(asset);
    }
    const keepIds = new Set(chosen.keys());
    const selectedTracks = project.tracks.filter(track => trackClips.has(track.id)).map(track => ({ ...track, clips: trackClips.get(track.id)! }));
    if (!selectedTracks.some(track => track.kind === "video")) { const track = project.tracks.find(track => track.kind === "video"); if (track) selectedTracks.push({ ...track, clips: [] }); }
    const selectedMotionTracks = [...keepIds].flatMap(id => motionByClip.get(id) ?? []);
    const selectedProject: EditProject = { ...project, assets: selectedAssets,
      tracks: selectedTracks, captions: selectedCaptions,
      motionGraphics: selectedGraphics, motionScenes: selectedScenes, motionTracks: selectedMotionTracks,
      timelineTransitions: project.timelineTransitions?.filter(pair => keepIds.has(pair.fromClipId) && keepIds.has(pair.toClipId)),
      director: { ...project.director, markers: project.director.markers.filter(marker => marker.time >= start && marker.time < end) } };
    if (project.unifiedLayerOrderV1 !== undefined) selectedProject.unifiedLayerOrderV1 = projectOrder(selectedProject);
    const assProject: EditProject = structuredClone(selectedProject);
    const local = structuredClone(assProject), shift = (time: number) => Math.abs(time - start) < EPS ? 0 : time - start;
    for (const track of local.tracks) for (const clip of track.clips) clip.timelineStart = shift(clip.timelineStart);
    for (const caption of local.captions) caption.start = shift(caption.start);
    for (const graphic of local.motionGraphics) graphic.timelineStart = shift(graphic.timelineStart);
    for (const scene of local.motionScenes ?? []) scene.startFrame -= chunk.startFrame;
    for (const marker of local.director.markers) marker.time = shift(marker.time);
    return { project: local, assProject, startFrame: chunk.startFrame, durationSeconds: frameToSecondsV1(chunk.frameCount, rate),
      metadataClockPolicy: "original-authoring-metadata-retained" as const };
  };
}
