import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  MATERIAL_INTELLIGENCE_SCHEMA,
  compactMaterialContext,
  readMaterialIntelligence,
  recordMaterialSemantics,
  selectMaterialKeyframeTimes,
  verifyMaterialSemanticsReceipt,
  type MaterialIntelligencePacket,
} from "./materialIntelligence";
import { estimateAgentContextTokens } from "./agentContextBudget";

const temporaryPaths: string[] = [];
afterEach(async () => {
  for (const path of temporaryPaths.splice(0)) await rm(path, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "editkin-material-unit-"));
  temporaryPaths.push(root);
  const materialId = "a".repeat(64);
  const sourceSha256 = "b".repeat(64);
  const directory = join(root, "material-intelligence", materialId);
  await mkdir(directory, { recursive: true });
  const packet: MaterialIntelligencePacket = {
    schema: MATERIAL_INTELLIGENCE_SCHEMA,
    materialId,
    source: { assetId: "asset-a", clipId: "clip-a", sourceSha256, sourceStart: 0, duration: 10, kind: "video", fps: 30, hasAudio: true },
    analysis: {
      scene: { state: "ready", engine: "ffmpeg-scdet-8", cuts: [{ time: 5, frame: 150, score: 12 }] },
      transcript: { state: "ready", engine: "whisper", language: "zh", cueCount: 2, cues: [{ start: 0, end: 2, text: "開場" }, { start: 6, end: 8, text: "收尾" }] },
    },
    keyframes: [
      { id: "kf-1", time: 1, sceneIndex: 0, sha256: "c".repeat(64), bytes: 10, mimeType: "image/jpeg", fileName: "frame-01.jpg" },
      { id: "kf-2", time: 7, sceneIndex: 1, sha256: "d".repeat(64), bytes: 10, mimeType: "image/jpeg", fileName: "frame-02.jpg" },
    ],
    createdAt: new Date().toISOString(),
  };
  await writeFile(join(directory, "manifest.json"), JSON.stringify(packet), "utf8");
  return { root, packet, materialId, sourceSha256 };
}

describe("material intelligence evidence", () => {
  it("selects bounded scene-aware keyframes", () => {
    const selected = selectMaterialKeyframeTimes(12, [{ time: 4, frame: 120, score: 10 }, { time: 8, frame: 240, score: 11 }], 4);
    expect(selected).toHaveLength(4);
    expect(selected[0]).toBeGreaterThanOrEqual(0);
    expect(selected.at(-1)).toBeLessThan(12);
    expect([...selected].sort((left, right) => left - right)).toEqual(selected);
  });

  it("returns only the requested transcript window", async () => {
    const { root, packet } = await fixture();
    expect(await readMaterialIntelligence(root, packet.materialId)).toMatchObject({ materialId: packet.materialId });
    const context = compactMaterialContext(packet, 0, 4, 10);
    expect(context.transcript.cues.map((cue) => cue.text)).toEqual(["開場"]);
    expect(JSON.stringify(context)).not.toContain("frame-01.jpg");
  });

  it("paginates a long transcript and bounds the complete response by estimated tokens", async () => {
    const { packet } = await fixture();
    packet.source.duration = 100;
    packet.analysis.transcript.cues = Array.from({ length: 120 }, (_, index) => ({
      start: index * 0.5,
      end: index * 0.5 + 0.4,
      text: `第${index + 1}段${"長逐字稿".repeat(20)}`,
    }));
    packet.analysis.transcript.cueCount = packet.analysis.transcript.cues.length;
    packet.analysis.scene.cuts = Array.from({ length: 120 }, (_, index) => ({ time: index * 0.5, frame: index * 15, score: 70 }));
    const first = compactMaterialContext(packet, 0, 70, 80, { maxTokens: 600, maxCuts: 20 });
    expect(first.transcript.hasMore).toBe(true);
    expect(first.transcript.nextCueIndex).toBeGreaterThanOrEqual(0);
    expect(first.cuts.length).toBeLessThanOrEqual(20);
    expect(estimateAgentContextTokens(JSON.stringify(first))).toBeLessThanOrEqual(600);
    const second = compactMaterialContext(packet, 0, 70, 80, { afterCueIndex: first.transcript.nextCueIndex, maxTokens: 600, maxCuts: 20 });
    expect(second.transcript.cues[0]?.index).toBeGreaterThan(first.transcript.cues.at(-1)?.index ?? -1);
  });

  it("requires cited evidence and detects a tampered semantic receipt", async () => {
    const { root, materialId, sourceSha256 } = await fixture();
    await expect(recordMaterialSemantics(root, {
      materialId, sourceSha256, overallTopic: "測試", contentType: "demo", language: "zh", people: [], locations: [],
      segments: [{ start: 0, end: 3, summary: "沒有證據", subjects: [], actions: [], objects: [], importance: 0.5, evidenceFrameIds: [], transcriptCueIndexes: [] }],
    })).rejects.toThrow(/至少需要一項/);
    await expect(recordMaterialSemantics(root, {
      materialId, sourceSha256: "e".repeat(64), overallTopic: "測試", contentType: "demo", language: "zh", people: [], locations: [],
      segments: [{ start: 0, end: 3, summary: "來源已變更", subjects: [], actions: [], objects: [], importance: 0.5, evidenceFrameIds: ["kf-1"], transcriptCueIndexes: [] }],
    })).rejects.toThrow(/SHA-256 已失效/);
    const receipt = await recordMaterialSemantics(root, {
      materialId, sourceSha256, overallTopic: "測試", contentType: "demo", language: "zh", people: [], locations: [],
      segments: [{ start: 0, end: 3, summary: "有關鍵幀證據", subjects: [], actions: [], objects: [], importance: 0.8, evidenceFrameIds: ["kf-1"], transcriptCueIndexes: [] }],
    });
    await expect(verifyMaterialSemanticsReceipt(root, materialId, receipt.semanticReceiptSha256)).resolves.toMatchObject({ overallTopic: "測試" });
    const path = join(resolve(root), "material-intelligence", materialId, "semantics", `${receipt.semanticReceiptSha256}.json`);
    await writeFile(path, JSON.stringify({ ...receipt, overallTopic: "被竄改" }), "utf8");
    await expect(verifyMaterialSemanticsReceipt(root, materialId, receipt.semanticReceiptSha256)).rejects.toThrow(/完整性/);
  });
});
