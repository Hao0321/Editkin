import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyCommand } from "../domain/commands";
import { createEmptyProject, projectDuration } from "../domain/editGraph";
import { projectSchema } from "../domain/schema";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type MediaAsset } from "../domain/types";
import { buildNativeAutopilotCommand, planNativeAutopilotCreative } from "./nativeAutopilot";
import { parseProject } from "./projectFiles";
import { parseRecoverySnapshot, readRecoveryFile, writeRecoveryFileAtomic } from "./recoveryFiles";
import { planSemanticAutoEdit } from "./semanticAutoEdit";

function fixture() {
  let project = createEmptyProject("原生自動成片測試");
  const asset: MediaAsset = { id: "source", name: "source.mp4", kind: "video", uri: "C:/source.mp4", duration: 20, width: 1920, height: 1080 };
  const clip = { id: "clip", assetId: asset.id, trackId: "video-main", timelineStart: 0, sourceStart: 0, duration: 20, volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] };
  project = applyCommand(project, { type: "batch", commands: [{ type: "import_asset", asset }, { type: "add_clip", clip }] });
  return { project, clip };
}

describe("native autopilot", () => {
  it.each([21.95, 21.949, 21.951, 22 / 30])("keeps a %s second imported tail inside the asset through captions, cut and persistence", (duration) => {
    const { project, clip } = fixture();
    project.assets[0].duration = duration;
    project.tracks[0].clips[0].duration = duration;
    clip.duration = duration;
    const cues = [{ start: 0, end: duration, text: "這次直接拿自己來實驗，保留最後一句。" }];
    const semantic = planSemanticAutoEdit({ duration, fps: project.fps, cues, targetRatio: 1 });
    const creative = planNativeAutopilotCreative({ duration, width: 1920, height: 1080, cues, video: true, policy: { format: "longform", ownership: "automatic" } });
    const built = buildNativeAutopilotCommand({ project, clip, transcript: { cues }, semantic, creative });
    const result = parseProject(applyCommand(project, built.command));
    const output = result.tracks.flatMap(track => track.clips);
    expect(output.length).toBeGreaterThan(0);
    expect(output.every(item => item.sourceStart + item.duration <= duration + 1e-7)).toBe(true);
    expect(duration - projectDuration(result)).toBeGreaterThanOrEqual(-1e-7);
    expect(duration - projectDuration(result)).toBeLessThan(1 / project.fps);
    expect(result.captionStyle.color).toBe("#FFFFFF");
    expect(JSON.stringify(project)).toContain(String(duration));
  });
  it("writes editable captions, creative choices, motion, ducked music and reasons in one undoable command", () => {
    const { project, clip } = fixture();
    const cues = [{ start: 0, end: 4, text: "這是最重要的關鍵方法！" }, { start: 8, end: 12, text: "接著展示結果" }, { start: 15, end: 19, text: "最後總結" }];
    // Retained silent gaps are required for optional repeat graphics; captions win.
    const semantic = { ...planSemanticAutoEdit({ duration: 20, fps: 30, cues, cuts: [{ time: 8, score: 75 }, { time: 15, score: 80 }], targetRatio: 0.7 }), keepRanges: [{ start: 0, end: 20 }], keptDuration: 20 };
    const creative = planNativeAutopilotCreative({ duration: 20, width: 1920, height: 1080, cues, cuts: [{ time: 8, score: 75 }], video: true, policy: { format: "shorts", ownership: "automatic" } });
    const music: MediaAsset = { id: "music", name: "music.wav", kind: "audio", uri: "creative://music", duration: 6, role: "background-music", bpm: creative.rhythm.targetBpm };
    const built = buildNativeAutopilotCommand({ project, clip, transcript: { cues }, semantic, creative, musicAsset: music, musicSelectionId: "music:test", idFactory: (kind, index) => `${kind}-${index}` });
    const result = applyCommand(project, built.command);
    expect(result.captions.length).toBeGreaterThan(0);
    expect(result.captionStyle.presetId).toBe(creative.captionPresetId);
    expect(result.tracks.find((track) => track.id === "audio-auto-music")?.clips.some((item) => item.volume === 0.12)).toBe(true);
    expect(result.tracks.find((track) => track.id === "audio-auto-music")?.clips.some((item) => item.volume === 0.25)).toBe(true);
    expect(result.tracks.find((track) => track.id === "video-main")?.clips.every((item) => item.creative?.lookPresetId === undefined)).toBe(true);
    expect(result.motionGraphics).toHaveLength(0);
    expect(result.director.markers.at(-1)?.note).toContain("blocked-pending-art-review");
    expect(result.director.markers.at(-1)?.note).toContain("rhythm=");
    expect(result.director.markers.at(-1)?.note).toContain("tracking=");
    expect(projectDuration(result)).toBeGreaterThan(0);
    expect(() => parseProject(result)).not.toThrow();
  });

  it("does not mistake low lost ratio for semantic subject evidence", () => {
    const { project, clip } = fixture();
    const cues = [{ start: 0, end: 10, text: "關鍵內容" }];
    const semantic = { ...planSemanticAutoEdit({ duration: 20, fps: 30, cues, targetRatio: 1 }), keepRanges: [{ start: 0, end: 20 }], keptDuration: 20 };
    const creative = planNativeAutopilotCreative({ duration: 20, width: 1920, height: 1080, cues, video: true });
    const built = buildNativeAutopilotCommand({ project, clip, transcript: { cues }, semantic, creative, trackingResult: { engine: "hao-core-rust-motion-track-0.2", analysisFps: 15, width: 640, height: 360, points: [0, 1, 2].map((frame) => ({ frame, time: frame / 15, rect: creative.tracking.initialRect, confidence: 0.9, status: "tracked" as const, activity: 0.02 })), lostRatio: 0.1, analyzedSeconds: 1, elapsedMs: 10, cacheHit: false }, idFactory: (kind, index) => `${kind}-${index}` });
    const result = applyCommand(project, built.command);
    expect(creative.tracking.requested).toBe(false);
    expect(result.motionTracks).toHaveLength(0);
    expect(result.motionGraphics.some((item) => item.kind === "tag" && item.trackId)).toBe(false);
    expect(built.trackingStatus).toBe("disabled-no-semantic-evidence");
    expect(() => parseProject(result)).not.toThrow();
  });

  it("persists an automatic edit with dimensionless background audio through recovery JSON", async () => {
    const { project, clip } = fixture();
    const cues = [{ start: 0, end: 4, text: "這是第一段測試語音" }, { start: 6, end: 9, text: "這是第二段重點" }];
    const semantic = planSemanticAutoEdit({ duration: clip.duration, fps: project.fps, cues, targetRatio: 1 });
    const creative = planNativeAutopilotCreative({ duration: clip.duration, width: project.width, height: project.height, cues, video: true });
    // Match the real first-edit audio boundary: 124.76s music has no video dimensions.
    // Paths/names from the diagnostic capture are deliberately not embedded here.
    const music: MediaAsset = { id: "music", name: "background.wav", kind: "audio", uri: "creative://music", duration: 124.76, role: "background-music" };
    const built = buildNativeAutopilotCommand({ project, clip, transcript: { cues }, semantic, creative, musicAsset: music, idFactory: (kind, index) => `${kind}-${index}` });
    const result = applyCommand(project, built.command);
    const parsed = parseProject(result);
    const nowMs = Date.parse(result.updatedAt);
    const workspace = await mkdtemp(join(tmpdir(), "editkin-autopilot-audio-recovery-"));
    try {
      const path = join(workspace, "session.json");
      await writeRecoveryFileAtomic(path, { project: result, cleanUpdatedAt: project.updatedAt }, { nowMs });
      const persisted = JSON.parse(await readFile(path, "utf8"));
      const audio = persisted.project.assets.find((asset: MediaAsset) => asset.id === music.id);
      expect(audio).toMatchObject({ kind: "audio", duration: 124.76, role: "background-music" });
      expect(Object.hasOwn(audio, "width")).toBe(false);
      expect(Object.hasOwn(audio, "height")).toBe(false);
      const reopened = await readRecoveryFile(path, { nowMs });
      expect(reopened.found).toBe(true);
      if (!reopened.found) throw new Error(`Recovery unexpectedly rejected generated project: ${reopened.reason}`);
      expect(reopened.snapshot.project).toEqual(parsed);
      expect(reopened.snapshot.project.captions.length).toBeGreaterThan(0);
      expect(reopened.snapshot.project.tracks.find((track) => track.id === "audio-auto-music")?.clips.length).toBeGreaterThan(0);
      expect(reopened.snapshot.project.motionGraphics).toHaveLength(0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects the captured audio-null dimensions without relaxing the persisted project contract", () => {
    const { project } = fixture();
    const malformed = structuredClone(project);
    // The packaged Rust bridge emitted these explicit nulls for audio before the fix.
    const nullDimensions = { id: "music", name: "background.wav", kind: "audio", uri: "creative://music", duration: 124.76, width: null, height: null };
    malformed.assets.push(nullDimensions as unknown as MediaAsset);
    const checked = projectSchema.safeParse(malformed);
    expect(checked.success).toBe(false);
    if (checked.success) throw new Error("Audio null dimensions must not become valid persisted data");
    expect(checked.error.issues.map((issue) => issue.path)).toEqual([["assets", 1, "width"], ["assets", 1, "height"]]);
    expect(() => parseProject(malformed)).toThrow();
    expect(() => parseRecoverySnapshot({ schemaVersion: 1, savedAt: project.updatedAt, cleanUpdatedAt: project.updatedAt, project: malformed }, Date.parse(project.updatedAt))).toThrow();
  });
});
