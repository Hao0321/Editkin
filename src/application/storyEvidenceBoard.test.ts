import { describe, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import type { TimelineClip } from "../domain/types";
import type { DesktopMaterialReview } from "../desktop/apiTypes";
import { makeStoryDraftArtifact, storyProjectContextSignature } from "./localStoryDraft";
import { candidatesFromMaterialReview, makeStoryEvidenceBoard, materialReviewFingerprint, materialReviewJobKey } from "./storyEvidenceBoard";

const sourceSha = "a".repeat(64), packetSha = "b".repeat(64), frameSha = "c".repeat(64), materialId = "d".repeat(64);
function fixture() {
  const project = createEmptyProject();
  const asset = { id: "asset-1", name: "scene.mp4", kind: "video" as const, uri: "C:/private/scene.mp4", duration: 8,
    derivatives: { sourceSha256: sourceSha } };
  project.assets.push(asset as typeof project.assets[number]);
  const clip = { id: "clip-1", assetId: asset.id, sourceStart: 2, duration: 4, timelineStart: 0 } as TimelineClip;
  project.tracks[0].clips.push(clip);
  const review = { job: { jobId: "job-1", state: "COMPLETED", result: { materialId, packetSha256: packetSha } },
    packet: { materialId, source: { assetId: asset.id, clipId: clip.id, sourceSha256: sourceSha,
      sourceStart: 2, duration: 4, fps: project.fps, kind: "video" },
    keyframes: [{ id: "frame-1", time: 1, sha256: frameSha }] } } as DesktopMaterialReview;
  const story = makeStoryDraftArtifact({ project: { id: project.id, revision: project.revision, updatedAt: project.updatedAt,
    contextSignature: storyProjectContextSignature(project) }, sourceLabel: "人工撰寫", brief: "一封信被送達",
    context: { mode: "mv", lyrics: "第一段：收到信\n副歌：把信打開" },
    draft: { premise: "一封信改變選擇", setup: "收到信", turn: "把信打開", resolution: "決定留下",
      visualIdeas: "信件特寫", pacing: "副歌後停頓", evidenceToCheck: "畫面中是否有信" } });
  return { project, asset, clip, review, story };
}

describe("story evidence board", () => {
  it("binds a displayed frame receipt to its clip and keeps lyrics unaligned", () => {
    const { project, asset, clip, review, story } = fixture();
    expect(materialReviewJobKey(project.id, clip.id)).toContain("clip-1");
    expect(materialReviewFingerprint(asset, clip, project.fps)).toContain(asset.uri);
    const [candidate] = candidatesFromMaterialReview(project, review);
    expect(candidate.frameTime).toBe(1); // relative to sourceStart, not absolute media time
    const beat = { id: "beat-1", lyricExcerpt: "副歌：把信打開", event: "觀眾看到信被打開", candidate: { ...candidate, observation: "畫面可見信封" } };
    const check = [{ jobId: candidate.jobId, sha256: sourceSha, verifiedAt: "2026-09-29T00:00:00Z" }];
    const board = makeStoryEvidenceBoard(story, [beat], project, [candidate], check);
    expect(board.status).toBe("provisional");
    expect(board.limitations).toEqual({ audioAligned: false, semanticReceipt: false, sourceRevalidatedAtExport: true, timelineApplied: false });
    expect(JSON.stringify(board)).not.toContain(asset.uri);
  });

  it("rejects replaced assets, invented lyric text, and forged frame hashes", () => {
    const { project, review, story } = fixture();
    const [candidate] = candidatesFromMaterialReview(project, review);
    const check = [{ jobId: candidate.jobId, sha256: sourceSha, verifiedAt: "2026-09-29T00:00:00Z" }];
    const beat = { id: "beat-1", lyricExcerpt: "副歌：把信打開", event: "看到信", candidate: { ...candidate, observation: "可見信封" } };
    expect(() => makeStoryEvidenceBoard(story, [{ ...beat, lyricExcerpt: "不存在的歌詞" }], project, [candidate], check)).toThrow(/歌詞原文/);
    expect(() => makeStoryEvidenceBoard(story, [{ ...beat, candidate: { ...beat.candidate, frameSha256: "f".repeat(64) } }], project, [candidate], check)).toThrow(/候選影格/);
    expect(() => makeStoryEvidenceBoard(story, [beat], project, [candidate], [])).toThrow(/原始媒體檔/);
    project.assets[0].derivatives!.sourceSha256 = "e".repeat(64);
    expect(candidatesFromMaterialReview(project, review)).toEqual([]);
    expect(() => makeStoryEvidenceBoard(story, [beat], project, [candidate], check)).toThrow(/專案素材/);
  });
});
