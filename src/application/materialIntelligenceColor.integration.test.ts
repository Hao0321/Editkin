import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { compactMaterialContext, prepareMaterialIntelligence, readMaterialIntelligence } from "./materialIntelligence";
import { estimateAgentContextTokens } from "./agentContextBudget";
import { recordMaterialSemantics } from "./materialIntelligence";
import { verifyCurrentAutopilotMaterialEvidence } from "./autopilotMaterialEvidence";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_COLOR_MANAGEMENT, DEFAULT_TRANSFORM } from "../domain/types";
import { hashMaterialJson, sealMaterialPacket, verifyMaterialPacket } from "./materialEvidenceCache";

const app = fileURLToPath(new URL("../../", import.meta.url));
const ffmpegPath = join(app, "vendor/ffmpeg/win32-x64/ffmpeg.exe");
const ffprobePath = join(app, "vendor/ffmpeg/win32-x64/ffprobe.exe");
let sharedSource: { root: string; sourcePath: string; sourceSha256: string } | undefined;

beforeAll(async () => {
  await mkdir(join(app, ".rd/tmp"), { recursive: true });
  const root = await mkdtemp(join(app, ".rd/tmp/material-colour-integration-"));
  const sourcePath = join(root, "tagged-sdr.mp4");
  const result = spawnSync(ffmpegPath, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=320x240:r=30:d=1", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-x264-params", "colorprim=bt709:transfer=bt709:colormatrix=bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv", sourcePath], { windowsHide: true, timeout: 30000 });
  expect(result.status, result.stderr.toString()).toBe(0);
  const sourceSha256 = createHash("sha256").update(await readFile(sourcePath)).digest("hex");
  const request = { assetId: "asset", clipId: "clip", sourcePath, sourceSha256, sourceStart: 0, duration: 1, fps: 30,
    kind: "video" as const, includeTranscript: false, maxKeyframes: 3 };
  const prepared = await prepareMaterialIntelligence(request, { ffmpegPath, ffprobePath, cacheRoot: root, modelRoot: root });
  expect(prepared.cacheHit).toBe(false);
  expect(prepared.packet.analysis.color?.status).toBe("measured");
  sharedSource = { root, sourcePath, sourceSha256 };
}, 60000);

afterAll(async () => {
  if (sharedSource) await rm(sharedSource.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

async function fixture() {
  if (!sharedSource) throw new Error("material colour integration source was not prepared");
  const root = await mkdtemp(join(sharedSource.root, "cache-"));
  // Every case gets byte-identical measured evidence in an isolated cache.
  // The suite still performs one real cold FFmpeg preparation in beforeAll,
  // while avoiding four redundant encodes/extractions under full-suite load.
  await cp(join(sharedSource.root, "material-intelligence"), join(root, "material-intelligence"), { recursive: true });
  return { root, request: { assetId: "asset", clipId: "clip", sourcePath: sharedSource.sourcePath, sourceSha256: sharedSource.sourceSha256, sourceStart: 0, duration: 1, fps: 30, kind: "video" as const, includeTranscript: false, maxKeyframes: 3 }, runtime: { ffmpegPath, ffprobePath, cacheRoot: root, modelRoot: root } };
}
it("prepares real normalized RGB observations and verifies byte-equal warm evidence", async () => {
  const { request, runtime } = await fixture();
  const first = await prepareMaterialIntelligence(request, runtime);
  expect(first.packet.analysis.color?.status).toBe("measured");
  expect(first.packet.analysis.color?.coverage.sampledCount).toBe(3);
  const warm = await prepareMaterialIntelligence(request, runtime);
  expect(warm.cacheHit).toBe(true); expect(warm.packet).toEqual(first.packet);
  const color = first.packet.analysis.color!;
  expect(color.mapping.every(frame => frame.decodedRelativeTime >= frame.requestedTime - 1e-7)).toBe(true);
  const context = compactMaterialContext(first.packet, 0, 1, 80, { maxTokens: 1100 });
  expect(context.color).toMatchObject({ status: "measured", receiptSha256: color.receiptSha256, summaryOmitted: false, automaticWhiteBalance: "unmeasured" });
  expect(JSON.stringify(context)).not.toContain("tagged-sdr.mp4");
  expect(estimateAgentContextTokens(JSON.stringify(context))).toBeLessThanOrEqual(1100);
  const path = join(runtime.cacheRoot, "material-intelligence", first.packet.materialId, "manifest.json");
  const corrupt = structuredClone(first.packet); corrupt.analysis.color!.mapping[0].rawRgbSha256 = "0".repeat(64);
  const bytes = JSON.stringify(corrupt); await writeFile(path, bytes);
  await expect(readMaterialIntelligence(runtime.cacheRoot, first.packet.materialId)).rejects.toThrow(/完整性/);
  await expect(prepareMaterialIntelligence(request, runtime)).rejects.toThrow(/完整性/);
  expect(await readFile(path, "utf8")).toBe(bytes);
}, 30000);
it("binds precise sampling to real decoded clocks, cache and semantics without replacing overview evidence", async () => {
  const { request, runtime } = await fixture();
  const overview = await prepareMaterialIntelligence(request, runtime);
  const path = join(runtime.cacheRoot, "material-intelligence", overview.packet.materialId, "manifest.json");
  const oldBytes = await readFile(path, "utf8");
  const explicit = { ...request, keyframeTimes: [0.2, 0.35, 0.7] };
  const selected = await prepareMaterialIntelligence(explicit, runtime);
  expect(selected.cacheHit).toBe(false);
  expect(selected.packet.materialId).not.toBe(overview.packet.materialId);
  expect(selected.packet.cache!.identity.keyframeTimes).toEqual(explicit.keyframeTimes);
  expect(selected.packet.analysis.keyframes!.requestedSamples.map(s => s.time)).toEqual(explicit.keyframeTimes);
  expect(selected.packet.keyframes.map(f => f.display!.requested.time)).toEqual(explicit.keyframeTimes);
  for (const frame of selected.packet.keyframes) {
    expect(frame.time).toBeGreaterThanOrEqual(frame.display!.requested.time - 1e-7);
    expect(frame.time - frame.display!.requested.time).toBeLessThan(1 / 30 + 1e-7);
    expect(frame.display!.normalization.transfer).toBe("srgb");
  }
  expect((await prepareMaterialIntelligence(explicit, runtime)).packet).toEqual(selected.packet);
  expect(await readFile(path, "utf8")).toBe(oldBytes);
  const wrongIdentity = { ...selected.packet.cache!.identity, keyframeTimes: [0.1, 0.4, 0.9] };
  const wrongId = hashMaterialJson(wrongIdentity);
  const resealed = sealMaterialPacket({ ...selected.packet, materialId: wrongId }, wrongIdentity);
  expect(() => verifyMaterialPacket(resealed, wrongId)).toThrow("explicit-keyframe-times-cache-mismatch");
  const semantic = await recordMaterialSemantics(runtime.cacheRoot, {
    materialId: selected.packet.materialId, sourceSha256: request.sourceSha256, overallTopic: "Synthetic moving test pattern",
    contentType: "test", language: "en", people: [], locations: [], segments: [{ start: .2, end: .8,
      summary: "Synthetic fixture only; not original-footage review", subjects: [], actions: [], objects: [], importance: .5,
      evidenceFrameIds: selected.packet.keyframes.map(f => f.id), transcriptCueIndexes: [] }],
  });
  expect(semantic.materialId).toBe(selected.packet.materialId);
  expect(semantic.transcriptEvidence).toEqual([]);
}, 60000);
it("rejects corrupt JPEG bytes without replacing the completed evidence", async () => {
  const { request, runtime } = await fixture();
  const first = await prepareMaterialIntelligence(request, runtime);
  const directory = join(runtime.cacheRoot, "material-intelligence", first.packet.materialId);
  const manifest = await readFile(join(directory, "manifest.json"), "utf8");
  const path = join(directory, first.packet.keyframes[0].fileName); await writeFile(path, "broken JPEG");
  await expect(prepareMaterialIntelligence(request, runtime)).rejects.toThrow(/完整性/);
  expect(await readFile(join(directory, "manifest.json"), "utf8")).toBe(manifest);
  expect(await readFile(path, "utf8")).toBe("broken JPEG");
}, 30000);
it("bounds colour context at 200/600/1100 and never silently skips transcript cues", async () => {
  const { request, runtime } = await fixture();
  const { packet } = await prepareMaterialIntelligence(request, runtime);
  // Real colour receipt, synthetic transcript solely for bounded paging verification.
  packet.analysis.transcript = { state: "ready", cueCount: 20, cues: Array.from({ length: 20 }, (_, i) => ({ start: i / 20, end: (i + 1) / 20, text: `cue ${i}` })) };
  for (const maxTokens of [200, 600, 1100]) {
    const seen: number[] = []; let cursor = -1;
    for (let page = 0; page < 21; page++) {
      const context = compactMaterialContext(packet, 0, 1, 80, { maxTokens, afterCueIndex: cursor });
      expect(estimateAgentContextTokens(JSON.stringify(context))).toBeLessThanOrEqual(maxTokens);
      expect(context.color).toMatchObject({ status: "measured", receiptSha256: packet.analysis.color!.receiptSha256 });
      seen.push(...context.transcript.cues.map(cue => cue.index));
      if (!context.transcript.hasMore) break;
      expect(context.transcript.nextCueIndex).toBeGreaterThan(cursor); cursor = context.transcript.nextCueIndex!;
    }
    expect(seen).toEqual(Array.from({ length: 20 }, (_, i) => i));
  }
  packet.analysis.transcript.cues = [{ start: 0, end: 1, text: "長".repeat(3000) }]; packet.analysis.transcript.cueCount = 1;
  expect(() => compactMaterialContext(packet, 0, 1, 80, { maxTokens: 200 })).toThrow(/不可跳過/);
}, 30000);
it("binds new colour evidence to current interpretation and output management at audit/apply", async () => {
  const { request, runtime } = await fixture();
  const { packet } = await prepareMaterialIntelligence(request, runtime);
  const semantic = await recordMaterialSemantics(runtime.cacheRoot, {
    materialId: packet.materialId, sourceSha256: packet.source.sourceSha256, overallTopic: "Test pattern", contentType: "fixture", language: "en", people: [], locations: [],
    segments: [{ start: 0, end: 1, summary: "Synthetic source, not human image review", subjects: [], actions: [], objects: [], importance: 0.5, evidenceFrameIds: [packet.keyframes[0].id], transcriptCueIndexes: [] }],
  });
  const evidence = { schema: packet.schema, receipts: [{ materialId: packet.materialId, assetId: request.assetId, clipId: request.clipId, sourceSha256: request.sourceSha256, semanticReceiptSha256: semantic.semanticReceiptSha256 }] };
  const project = createEmptyProject("Colour evidence fixture", { fps: 30 });
  project.assets.push({ id: request.assetId, name: "fixture", uri: request.sourcePath, kind: "video", duration: 1 });
  project.tracks[0].clips.push({ id: request.clipId, assetId: request.assetId, trackId: project.tracks[0].id, sourceStart: 0, duration: 1, timelineStart: 0, volume: 0, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] });
  const verify = () => verifyCurrentAutopilotMaterialEvidence(evidence, project, { cacheRoot: runtime.cacheRoot, resolveSource: async () => request.sourcePath });
  await expect(verify()).resolves.toMatchObject({ receiptCount: 1 });
  project.assets[0].color = { interpretation: "hlg" };
  await expect(verify()).rejects.toThrow(/色彩解讀/);
  project.assets[0].color = undefined; project.colorManagement = { ...DEFAULT_COLOR_MANAGEMENT, mode: "aces2" };
  await expect(verify()).rejects.toThrow(/色彩解讀/);
  project.colorManagement = { ...DEFAULT_COLOR_MANAGEMENT };
  await expect(verify()).resolves.toMatchObject({ receiptCount: 1 });
}, 30000);
