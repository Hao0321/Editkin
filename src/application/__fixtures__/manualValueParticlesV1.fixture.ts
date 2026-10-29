import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createEmptyProject } from "../../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../../domain/types";
import { createProjectSession } from "../projectSession";
import { MATERIAL_INTELLIGENCE_SCHEMA, recordMaterialSemantics } from "../materialIntelligence";
import type { ManualValueParticleRequestV1 } from "../manualValueParticlesV1";
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
/** Synthetic byte identities and explicitly manual cue; no decoder/ASR/value truth claim. */
export async function manualValueParticleFixtureV1() {
  const root = await mkdtemp(join(tmpdir(), "editkin-manual-value-control-")), source = join(root, "source.mp4");
  await writeFile(source, Buffer.from("Synthetic value identity fixture, no movie quality claim"));
  const sourceSha256 = sha(await readFile(source)), p = createEmptyProject("Manual value control", { id: "manual-value-control", width: 64, height: 40, fps: 24 });
  p.assets = [{ id: "source", name: "Synthetic source", kind: "video", uri: source, duration: 1.25, width: 64, height: 40, displayAspectRatio: 1.6 }];
  p.tracks[0].clips = [{ id: "selected", assetId: "source", trackId: p.tracks[0].id, timelineStart: 2, sourceStart: 0, duration: 1.25,
    volume: 0, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] }];
  const materialId = "a".repeat(64), directory = join(root, "material-intelligence", materialId); await mkdir(directory, { recursive: true });
  const image = Buffer.from("Synthetic keyframe bytes"), framePath = join(directory, "frame-01.jpg"); await writeFile(framePath, image);
  await writeFile(join(directory, "manifest.json"), JSON.stringify({ schema: MATERIAL_INTELLIGENCE_SCHEMA, materialId,
    source: { assetId: "source", clipId: "selected", sourceSha256, sourceStart: 0, duration: 1.25, kind: "video", fps: 24, hasAudio: false },
    analysis: { scene: { state: "ready", cuts: [] }, transcript: { state: "ready", cueCount: 1, cues: [{ start: .2, end: 1.2, text: "人工合成測試值12000元，不是ASR。" }] } },
    keyframes: [{ id: "kf-1", time: .5, sceneIndex: 0, sha256: sha(image), bytes: image.length, mimeType: "image/jpeg", fileName: "frame-01.jpg" }], createdAt: p.updatedAt }));
  const semantic = await recordMaterialSemantics(root, { materialId, sourceSha256, overallTopic: "Synthetic value", contentType: "fixture", language: "zh", people: [], locations: [],
    segments: [{ start: .2, end: 1.2, summary: "合成數值12000元", subjects: [], actions: [], objects: [], importance: .8, evidenceFrameIds: ["kf-1"], transcriptCueIndexes: [0] }] });
  const evidence = { materialId, semanticReceiptSha256: semantic.semanticReceiptSha256, segmentIndex: 0, cueIndex: 0, quotedValue: "12000元" };
  const request: ManualValueParticleRequestV1 = { schema: "editkin.manual-value-particles/v1", expectedRevision: p.revision, id: "manual-a", clipId: "selected", range: { startFrame: 56, endFrame: 68 },
    createdAt: p.updatedAt, value: { kind: "user_asserted", quotedValue: "12000元", confirmed: true },
    parameters: { seed: 37, ratePerSecond: 24, lifetimeSeconds: .3, maxParticles: 12, emitterPosition: [.5, .65], initialVelocity: [12, -20], gravity: [0, 40], radiusPixels: 2, color: [1, 1, 1, .8] } };
  return { root, source, sourceSha256, framePath, directory, p, request, evidence, session: createProjectSession(p), host: { cacheRoot: root, assetBase: process.cwd(), resolveSource: async () => source,
    notes: { user_asserted: "此數值由使用者手動提供，尚未由素材內容查證。", material_evidence: "此數值引用素材證據，仍待人工查證。" } } };
}
export async function finishManualValueParticleFixtureV1(root: string) {
  await writeFile(join(root, "TEST-OWNER.json"), JSON.stringify({ producer: "manualValueParticlesV1.fixture.ts", root, testsTerminal: true }), { flag: "wx" });
}
