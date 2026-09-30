import type { EditProject } from "../domain/types";
import type { DesktopMaterialReview } from "../desktop/apiTypes";
import { parseStoryDraftArtifact, storyProjectContextSignature, type StoryDraftArtifact } from "./localStoryDraft";

export interface StoryEvidenceCandidate {
  jobId: string;
  materialId: string;
  packetSha256: string;
  assetId: string;
  clipId: string;
  sourceSha256: string;
  sourceStart: number;
  duration: number;
  frameId: string;
  frameSha256: string;
  frameTime: number;
  observation: string;
}

export interface StoryEvidenceBeat {
  id: string;
  lyricExcerpt: string;
  event: string;
  candidate?: StoryEvidenceCandidate;
}

export interface StoryEvidenceBoard {
  schema: "editkin.story-evidence-board/v1";
  status: "provisional";
  story: StoryDraftArtifact;
  beats: StoryEvidenceBeat[];
  sourceChecks: { jobId: string; sha256: string; verifiedAt: string }[];
  exportedAt: string;
  limitations: { audioAligned: false; semanticReceipt: false; sourceRevalidatedAtExport: true; timelineApplied: false };
}

const sha = /^[a-f0-9]{64}$/;
const string = (value: unknown, max: number) => typeof value === "string" && value.trim().length > 0 && value.length <= max;

export function materialReviewJobKey(projectId: string, clipId: string): string {
  return `editkin.material-review.v1:${projectId}:${clipId}`;
}

export function materialReviewFingerprint(asset: { id: string; uri: string }, clip: { sourceStart: number; duration: number }, fps: number): string {
  return JSON.stringify([asset.id, asset.uri, clip.sourceStart, clip.duration, fps]);
}

/** Packet verification is performed by the desktop service before it returns this result. */
export function candidatesFromMaterialReview(project: EditProject, review: DesktopMaterialReview): StoryEvidenceCandidate[] {
  const packet = review.packet, result = review.job.result;
  if (review.job.state !== "COMPLETED" || !packet || !result || packet.materialId !== result.materialId || !sha.test(result.packetSha256)) return [];
  const clip = project.tracks.flatMap((track) => track.clips).find((item) => item.id === packet.source.clipId);
  const asset = project.assets.find((item) => item.id === packet.source.assetId);
  if (!clip || !asset || clip.assetId !== asset.id || asset.kind !== packet.source.kind
    || clip.sourceStart !== packet.source.sourceStart || clip.duration !== packet.source.duration
    || project.fps !== packet.source.fps || !sha.test(packet.source.sourceSha256)
    || (asset.derivatives?.sourceSha256 && asset.derivatives.sourceSha256 !== packet.source.sourceSha256)) return [];
  return packet.keyframes.filter((frame) => sha.test(frame.sha256) && frame.time >= 0
    && frame.time <= clip.duration).map((frame) => ({
    jobId: review.job.jobId, materialId: packet.materialId, packetSha256: result.packetSha256,
    assetId: asset.id, clipId: clip.id, sourceSha256: packet.source.sourceSha256,
    sourceStart: clip.sourceStart, duration: clip.duration, frameId: frame.id,
    frameSha256: frame.sha256, frameTime: frame.time, observation: "",
  }));
}

export function makeStoryEvidenceBoard(story: StoryDraftArtifact, beats: StoryEvidenceBeat[], project: EditProject,
  liveCandidates: StoryEvidenceCandidate[], sourceChecks: { jobId: string; sha256: string; verifiedAt: string }[]): StoryEvidenceBoard {
  const parsedStory = parseStoryDraftArtifact(story);
  if (parsedStory.project.id !== project.id || parsedStory.project.contextSignature !== storyProjectContextSignature(project)) {
    throw Error("專案素材與故事提案不一致，請重新核對");
  }
  if (beats.length < 1 || beats.length > 32) throw Error("故事段落需有 1 到 32 段");
  if (!beats.some((beat) => beat.candidate)) throw Error("至少一段需要已核對的候選影格；其餘缺口可保留待查");
  const available = new Map(liveCandidates.map((item) => [`${item.jobId}:${item.frameId}`, item]));
  const checked = new Map(sourceChecks.map((item) => [item.jobId, item]));
  const ids = new Set<string>();
  const clean = beats.map((beat) => {
    if (!string(beat.id, 100) || ids.has(beat.id) || !string(beat.event, 500) || typeof beat.lyricExcerpt !== "string" || beat.lyricExcerpt.length > 500) {
      throw Error("故事段落的事件或識別碼不合法");
    }
    ids.add(beat.id);
    const lyricExcerpt = beat.lyricExcerpt.trim();
    if (parsedStory.context.mode === "mv" && (!lyricExcerpt || !parsedStory.context.lyrics?.includes(lyricExcerpt))) {
      throw Error("每段 MV 事件須引用歌詞原文；目前尚未對齊歌曲時間");
    }
    if (parsedStory.context.mode === "general" && lyricExcerpt) throw Error("一般影片段落不能引用不存在的歌詞");
    let candidate: StoryEvidenceCandidate | undefined;
    if (beat.candidate) {
      const live = available.get(`${beat.candidate.jobId}:${beat.candidate.frameId}`);
      if (!live || !Object.entries(live).every(([key, value]) => key === "observation" || beat.candidate?.[key as keyof StoryEvidenceCandidate] === value)
        || !string(beat.candidate.observation, 500)) throw Error("候選影格已過期、未驗證或缺少人工觀察");
      const sourceCheck = checked.get(live.jobId);
      if (!sourceCheck || sourceCheck.sha256 !== live.sourceSha256 || !Number.isFinite(Date.parse(sourceCheck.verifiedAt))) {
        throw Error("原始媒體檔未在匯出時重新核對 SHA-256");
      }
      candidate = { ...live, observation: beat.candidate.observation.trim() };
    }
    return { id: beat.id, lyricExcerpt, event: beat.event.trim(), ...(candidate ? { candidate } : {}) };
  });
  return { schema: "editkin.story-evidence-board/v1", status: "provisional", story: parsedStory, beats: clean,
    sourceChecks: [...checked.values()], exportedAt: new Date().toISOString(), limitations: { audioAligned: false, semanticReceipt: false,
      sourceRevalidatedAtExport: true, timelineApplied: false } };
}
