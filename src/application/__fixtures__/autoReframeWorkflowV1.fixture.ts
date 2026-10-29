import { createEmptyProject } from "../../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../../domain/types";
import type { EditProject } from "../../domain/types";
import type { AutoReframeReplyV1, AutoReframeRequestV1, ReframePreparedV1 } from "../autoReframeEditV1";
import type { AutoReframeSparseSinkV2 } from "../autoReframeSparseV2";

export const WORKFLOW_TIME_V1 = "2026-10-17T00:00:00.000Z";
export const workflowIdentityV1 = () => ({ id: "separate-portrait", name: "Portrait draft", createdAt: WORKFLOW_TIME_V1 });
/** Synthetic graph only: hashes and rights below are instrument fixtures, never real media approval. */
export function autoReframeWorkflowFixtureV1(portrait = true): EditProject {
  const p = createEmptyProject("Authored original <&>", { id: "workflow-source", width: portrait ? 90 : 160, height: portrait ? 160 : 90, fps: 4 });
  p.updatedAt = WORKFLOW_TIME_V1; p.director.updatedAt = WORKFLOW_TIME_V1;
  p.assets = [{ id: "source", name: "Original source", kind: "video", uri: "source.mkv", duration: 8, width: 64, height: 40, displayAspectRatio: 1.6,
    derivatives: { sourceSha256: "a".repeat(64), proxyUri: "never-the-original.mp4", generatedAt: WORKFLOW_TIME_V1 }, rightsBasis: "instrument-owned", distributionScope: "private-test",
    license: "instrument-only", redistributable: false, provenance: "synthetic unit fixture" },
  { id: "audio", name: "Authored audio", kind: "audio", uri: "sound.wav", duration: 8, license: "instrument-only", redistributable: false }];
  const clip = { id: "selected", assetId: "source", trackId: "video-main", timelineStart: 2, sourceStart: .5, duration: 1.25, volume: .7,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR, saturation: .8 }, keyframes: [], linkGroupId: "linked-sound" };
  p.tracks[0].clips = [clip, { ...structuredClone(clip), id: "outside", timelineStart: 5, linkGroupId: undefined }];
  p.tracks[1].muted = true; p.tracks[1].solo = true;
  p.tracks[1].clips = [{ ...structuredClone(clip), id: "linked-audio", assetId: "audio", trackId: "audio-main", timelineStart: 2.25, sourceStart: 1, duration: .75, volume: .42 }];
  p.motionTracks = [{ id: "source-track", clipId: "selected", name: "Authored mask tracker", engine: "instrument-only", analysisFps: 4,
    initialRect: { x: .25, y: .25, width: .25, height: .5 }, points: [{ frame: 0, time: 0, rect: { x: .25, y: .25, width: .25, height: .5 }, confidence: 1, status: "tracked" }], lostRatio: 0, createdAt: WORKFLOW_TIME_V1 }];
  p.tracks[0].clips[0].masks = [{ id: "authored-mask", name: "Authored mask", kind: "polygon", mode: "add", enabled: true, inverted: false,
    opacity: .9, feather: .02, expansion: .01, trackId: "source-track", path: [{ id: "p1", x: .1, y: .1 }, { id: "p2", x: .8, y: .1 }, { id: "p3", x: .5, y: .8 }],
    keyframes: [], refine: { edgeShift: 0, contrast: .5, chatterReduction: .65 } }];
  p.captions = [{ id: "crossing", text: "Keep authored words <&>", start: 1.75, duration: .75, translation: { text: "保留原文", language: "zh-TW" } },
    { id: "tail", text: "End", start: 3, duration: .75 }, { id: "elsewhere", text: "Outside", start: 5, duration: 1 }];
  p.director.markers = [{ id: "inside", time: 2.5, title: "Authored note", note: "Keep note", kind: "note", status: "open", createdAt: WORKFLOW_TIME_V1 },
    { id: "after", time: 3.25, title: "Outside", note: "", kind: "note", status: "open", createdAt: WORKFLOW_TIME_V1 }];
  return p;
}
/** Adds explicitly fake decoder metadata to a REAL sparse-compiler result. Unit tests use
 * this double; the separate physical-source case does not. No native/semantic quality claim. */
export function instrumentOnlyWorkflowReplyV1(request: AutoReframeRequestV1, compiled: ReturnType<AutoReframeSparseSinkV2["finish"]>): AutoReframeReplyV1 {
  const prepared = { ...compiled, sourceSha256: request.expectedSourceSha256,
    analysis: { modelsDownloaded: 0, rawMoviePixelFiles: 0, matte: null, instrumentOnly: true }, ordinaryUiIntegrated: false } as unknown as ReframePreparedV1;
  return { schema: "editkin.auto-reframe-reply/v1", request: structuredClone(request), prepared };
}
