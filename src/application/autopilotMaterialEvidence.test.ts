import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyProject, findClip } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";
import type { CurrentAutopilotPlan } from "./autopilotPlan";
import {
  MATERIAL_INTELLIGENCE_SCHEMA,
  recordMaterialSemantics,
  type MaterialIntelligencePacket,
} from "./materialIntelligence";
import { verifyCurrentAutopilotMaterialEvidence } from "./autopilotMaterialEvidence";

const temporaryPaths: string[] = [];
afterEach(async () => {
  for (const path of temporaryPaths.splice(0)) await rm(path, { recursive: true, force: true });
});

// Tiny synthetic bytes test evidence identity, not decoding, visual quality or live MCP.
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "editkin-material-current-"));
  temporaryPaths.push(root);
  const sourcePath = join(root, "來源 with spaces.mp4");
  const sourceBytes = Buffer.from("owned source bytes A");
  await writeFile(sourcePath, sourceBytes);
  const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
  const materialId = "a".repeat(64);
  const directory = join(root, "material-intelligence", materialId);
  await mkdir(directory, { recursive: true });
  const project = createEmptyProject("Isolated evidence", { id: "project-a", fps: 30 });
  project.assets.push({ id: "asset-a", name: "Fixture", uri: sourcePath, kind: "video", duration: 10 });
  project.tracks[0].clips.push({
    id: "clip-a", assetId: "asset-a", trackId: project.tracks[0].id,
    sourceStart: 1, duration: 4, timelineStart: 0, volume: 1,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [],
  });
  const packet: MaterialIntelligencePacket = {
    schema: MATERIAL_INTELLIGENCE_SCHEMA, materialId,
    source: { assetId: "asset-a", clipId: "clip-a", sourceSha256, sourceStart: 1, duration: 4, kind: "video", fps: 30, hasAudio: true },
    analysis: {
      scene: { state: "ready", cuts: [] },
      transcript: { state: "ready", cueCount: 1, cues: [{ start: 0, end: 1, text: "Synthetic fixture evidence：我是王小明，Editkin 創辦人。" }] },
    },
    keyframes: [], createdAt: new Date().toISOString(),
  };
  const savePacket = () => writeFile(join(directory, "manifest.json"), JSON.stringify(packet), "utf8");
  await savePacket();
  const receipt = await recordMaterialSemantics(root, {
    materialId, sourceSha256, overallTopic: "Synthetic identity fixture", contentType: "test", language: "en", people: [], locations: [],
    segments: [{ start: 0, end: 1, summary: "Fixture cue", subjects: [], actions: [], objects: [], importance: 0.5, evidenceFrameIds: [], transcriptCueIndexes: [0] }],
  });
  const evidence: CurrentAutopilotPlan["materialEvidence"] = {
    schema: MATERIAL_INTELLIGENCE_SCHEMA,
    receipts: [{ materialId, sourceSha256, assetId: "asset-a", clipId: "clip-a", semanticReceiptSha256: receipt.semanticReceiptSha256 }],
  };
  const resolveSource = vi.fn(async (assetId: string) => {
    if (assetId !== "asset-a") throw new Error("Source not authorized by fixture resolver");
    return sourcePath;
  });
  const runtime = { cacheRoot: root, resolveSource };
  const verify = () => verifyCurrentAutopilotMaterialEvidence(evidence, project, runtime);
  return { root, directory, sourcePath, sourceBytes, sourceSha256, materialId, project, packet, receipt, evidence, runtime, savePacket, verify };
}

describe("current autopilot material evidence", () => {
  it("accepts the unchanged actual source without derivative metadata", async () => {
    const f = await fixture();
    const before = JSON.stringify(f.project);
    await expect(f.verify()).resolves.toEqual({ receiptCount: 1, materialIds: [f.materialId] });
    expect(JSON.stringify(f.project)).toBe(before);
  });

  it("resolves lower-third identity refs to an immutable semantic receipt and its actual transcript cue", async () => {
    const f = await fixture();
    const reference = `mi:${f.materialId}:${f.receipt.semanticReceiptSha256}:cue:0`;
    const identityGraphics: CurrentAutopilotPlan["editorial"]["graphics"] = [{
      id: "speaker-name", presetId: "lower_third_clean_blue_name", range: { startFrame: 0, endFrame: 45 },
      kind: "lower_third_name", purpose: "identity", message: "王小明", evidenceRefs: [reference],
    }, {
      id: "speaker-unit", presetId: "lower_third_clean_blue_unit", range: { startFrame: 0, endFrame: 45 },
      kind: "lower_third_affiliation", purpose: "identity", message: "Editkin 創辦人", evidenceRefs: [reference],
    }];
    await expect(verifyCurrentAutopilotMaterialEvidence(f.evidence, f.project, f.runtime, identityGraphics)).resolves.toMatchObject({ receiptCount: 1 });

    const madeUpCue = structuredClone(identityGraphics);
    madeUpCue[0].evidenceRefs = [`mi:${f.materialId}:${f.receipt.semanticReceiptSha256}:cue:9`];
    await expect(verifyCurrentAutopilotMaterialEvidence(f.evidence, f.project, f.runtime, madeUpCue)).rejects.toThrow(/不存在的 transcript cue/);

    const unsupportedClaim = structuredClone(identityGraphics);
    unsupportedClaim[1].message = "虛構公司執行長";
    await expect(verifyCurrentAutopilotMaterialEvidence(f.evidence, f.project, f.runtime, unsupportedClaim)).rejects.toThrow(/沒有逐字稿證據支持/);
  });

  it("rejects transcript text drift after the semantic receipt sealed the cited cue", async () => {
    const f = await fixture();
    f.packet.analysis.transcript.cues[0].text = "被竄改的身分內容";
    await f.savePacket();
    await expect(f.verify()).rejects.toThrow(/逐字稿證據已漂移/);
  });

  it("rejects same-path same-length replacement even with restored mtime and stale derivative hash", async () => {
    const f = await fixture();
    f.project.assets[0].derivatives = { sourceSha256: f.sourceSha256, generatedAt: new Date().toISOString() };
    const before = await stat(f.sourcePath);
    await writeFile(f.sourcePath, Buffer.from("owned source bytes B"));
    await utimes(f.sourcePath, before.atime, before.mtime);
    expect((await stat(f.sourcePath)).size).toBe(before.size);
    expect(createHash("sha256").update(await readFile(f.sourcePath)).digest("hex")).not.toBe(f.sourceSha256);
    await expect(f.verify()).rejects.toThrow();
  });

  it.each(["sourceStart", "duration"] as const)("rejects a same-ID %s change", async (field) => {
    const f = await fixture();
    findClip(f.project, "clip-a")[field] += 1 / f.project.fps;
    await expect(f.verify()).rejects.toThrow();
  });

  it("rejects a same-ID project fps change", async () => {
    const f = await fixture();
    f.project.fps = 24;
    await expect(f.verify()).rejects.toThrow();
  });

  it("rehashes on a second verification and rejects source replacement after a successful audit-shaped call", async () => {
    const f = await fixture();
    const projectBefore = JSON.stringify(f.project);
    await f.verify();
    await writeFile(f.sourcePath, Buffer.from("owned source bytes B"));
    await expect(f.verify()).rejects.toThrow(/實際來源 SHA-256/);
    expect(f.runtime.resolveSource).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(f.project)).toBe(projectBefore);
    expect(JSON.parse(await readFile(join(f.directory, "manifest.json"), "utf8"))).toEqual(f.packet);
  });

  it("accepts identical replacement bytes and changed timeline position but does not skip source resolution", async () => {
    const f = await fixture();
    await writeFile(f.sourcePath, f.sourceBytes);
    findClip(f.project, "clip-a").timelineStart = 50;
    await expect(f.verify()).resolves.toMatchObject({ receiptCount: 1 });
    expect(f.runtime.resolveSource).toHaveBeenCalledExactlyOnceWith("asset-a");
  });

  it("uses only the caller-authorized original source, not project URI or proxy URI fallback", async () => {
    const f = await fixture();
    f.project.assets[0].uri = "creative://fixture-asset";
    f.project.assets[0].derivatives = {
      sourceSha256: f.sourceSha256, proxyUri: "unreadable-proxy.mp4", generatedAt: new Date().toISOString(),
    };
    await expect(f.verify()).resolves.toMatchObject({ receiptCount: 1 });
    expect(f.runtime.resolveSource).toHaveBeenCalledExactlyOnceWith("asset-a");
  });

  it.each(["scope", "unknown source", "permission denied"])("propagates resolver refusal: %s", async (reason) => {
    const f = await fixture();
    const refused = new Error(reason);
    f.runtime.resolveSource.mockRejectedValue(refused);
    await expect(f.verify()).rejects.toBe(refused);
  });

  it("rejects a missing original even while derivative metadata matches", async () => {
    const f = await fixture();
    f.project.assets[0].derivatives = { sourceSha256: f.sourceSha256, generatedAt: new Date().toISOString() };
    await rm(f.sourcePath);
    await expect(f.verify()).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a directory returned as source instead of hashing a non-file", async () => {
    const f = await fixture();
    f.runtime.resolveSource.mockResolvedValue(f.root);
    await expect(f.verify()).rejects.toThrow();
  });

  it("still rejects contradictory derivative metadata even when actual bytes are current", async () => {
    const f = await fixture();
    f.project.assets[0].derivatives = { sourceSha256: "b".repeat(64), generatedAt: new Date().toISOString() };
    await expect(f.verify()).rejects.toThrow(/分析後改變/);
  });

  it.each(["clipId", "assetId"] as const)("rejects a missing current %s", async (field) => {
    const f = await fixture();
    f.evidence.receipts[0][field] = "missing";
    await expect(f.verify()).rejects.toThrow();
    expect(f.runtime.resolveSource).not.toHaveBeenCalled();
  });

  it("rejects the same clip ID reassigned to another existing asset", async () => {
    const f = await fixture();
    f.project.assets.push({ ...f.project.assets[0], id: "asset-b" });
    findClip(f.project, "clip-a").assetId = "asset-b";
    await expect(f.verify()).rejects.toThrow(/clip／asset 不一致/);
  });

  it.each(["clipId", "assetId", "sourceSha256"] as const)("rejects cached packet %s disagreement", async (field) => {
    const f = await fixture();
    f.packet.source[field] = field === "sourceSha256" ? "b".repeat(64) : "wrong-id";
    await f.savePacket();
    await expect(f.verify()).rejects.toThrow(/已過期或引用錯誤/);
  });

  it("rejects cached packet material ID disagreement", async () => {
    const f = await fixture();
    f.packet.materialId = "b".repeat(64);
    await f.savePacket();
    await expect(f.verify()).rejects.toThrow(/識別完整性/);
  });

  it("rejects a media-kind change", async () => {
    const f = await fixture();
    f.project.assets[0].kind = "audio";
    await expect(f.verify()).rejects.toThrow(/類型已改變/);
  });

  it("does not equate 29.97 fps with 30000/1001 or hide sub-frame trim drift", async () => {
    const f = await fixture();
    f.project.fps = 30_000 / 1_001;
    f.packet.source.fps = 29.97;
    await f.savePacket();
    await expect(f.verify()).rejects.toThrow(/fps/);
    f.packet.source.fps = f.project.fps;
    await f.savePacket();
    await f.verify();
    findClip(f.project, "clip-a").sourceStart += 1e-9;
    await expect(f.verify()).rejects.toThrow(/時間窗/);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid project fps %s", async (fps) => {
    const f = await fixture();
    f.project.fps = fps;
    await expect(f.verify()).rejects.toThrow(/fps/);
  });

  it.each(["sourceStart", "duration"] as const)("rejects invalid current clip %s", async (field) => {
    const f = await fixture();
    findClip(f.project, "clip-a")[field] = Number.NaN;
    await expect(f.verify()).rejects.toThrow(/時間窗/);
  });

  it("rejects a tampered semantic receipt", async () => {
    const f = await fixture();
    await writeFile(join(f.directory, "semantics", `${f.receipt.semanticReceiptSha256}.json`), JSON.stringify({ ...f.receipt, overallTopic: "tampered" }));
    await expect(f.verify()).rejects.toThrow(/receipt 完整性/);
  });

  it("rejects a valid hash-bound semantic receipt copied from a different material directory", async () => {
    const f = await fixture();
    const otherMaterialId = "b".repeat(64);
    const otherDirectory = join(f.root, "material-intelligence", otherMaterialId);
    await mkdir(otherDirectory);
    await writeFile(join(otherDirectory, "manifest.json"), JSON.stringify({ ...f.packet, materialId: otherMaterialId }));
    const otherReceipt = await recordMaterialSemantics(f.root, {
      materialId: otherMaterialId, sourceSha256: f.sourceSha256,
      overallTopic: f.receipt.overallTopic, contentType: f.receipt.contentType, language: f.receipt.language,
      people: [], locations: [], segments: f.receipt.segments,
    });
    const name = `${otherReceipt.semanticReceiptSha256}.json`;
    await copyFile(join(otherDirectory, "semantics", name), join(f.directory, "semantics", name));
    f.evidence.receipts[0].semanticReceiptSha256 = otherReceipt.semanticReceiptSha256;
    await expect(f.verify()).rejects.toThrow(/receipt 的 materialId/);
  });
});
