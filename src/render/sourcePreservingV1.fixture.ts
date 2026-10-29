import { DEFAULT_TRANSFORM, DEFAULT_COLOR, DEFAULT_CLIP_LAYER, DEFAULT_COLOR_MANAGEMENT, DEFAULT_CAPTION_STYLE, type EditProject } from "../domain/types";
export function sourcePreservingFixtureV1(uri = "C:/owned/source.mp4"): EditProject {
  const updatedAt = "2026-10-14T00:00:00.000Z";
  const project: EditProject = { schemaVersion: 9, revision: 0, id: "owned-source-copy", name: "Owned source-preserving control",
    width: 64, height: 64, fps: 30, editorialProfile: "auto", colorManagement: { ...DEFAULT_COLOR_MANAGEMENT },
    assets: [], compositions: [], tracks: [
      { id: "video-main", name: "Video", kind: "video", locked: false, muted: false, clips: [] },
      { id: "audio-main", name: "Audio", kind: "audio", locked: false, muted: false, clips: [] }],
    captions: [], captionStyle: { ...DEFAULT_CAPTION_STYLE }, motionTracks: [], motionGraphics: [],
    director: { schema: "editkin.director-console/v1", reviewState: "draft", markers: [], updatedAt }, updatedAt };
  project.assets = [{ id: "source", name: "Original", kind: "video", uri, duration: 2, width: 64, height: 64 }];
  project.tracks[0].clips = [{ id: "whole", assetId: "source", trackId: project.tracks[0].id, timelineStart: 0, sourceStart: 0,
    duration: 2, volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, layer: { ...DEFAULT_CLIP_LAYER }, keyframes: [], expressions: {} }];
  return project;
}
export function sourcePreservingProbeFixtureV1() {
  return { format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "2.000000", tags: { major_brand: "isom" } },
    streams: [{ codec_type: "video", codec_name: "h264", width: 64, height: 64, sample_aspect_ratio: "1:1", duration: "2.000000",
      avg_frame_rate: "30/1", r_frame_rate: "30/1", time_base: "1/15360", color_primaries: "bt709", color_transfer: "bt709", color_space: "bt709", color_range: "tv", disposition: { attached_pic: 0 } },
      { codec_type: "audio", codec_name: "aac", sample_rate: "48000", channels: 2, channel_layout: "stereo", time_base: "1/48000" }] };
}
