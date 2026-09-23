import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { materialColorRequestSnapshot, verifyMaterialColorReceipt, type MaterialColorReceipt, type MaterialColorRuntimeIdentity } from "./materialColorSampling";
import type { ColorManagementSettings, MediaColorMetadata } from "../domain/types";
import { canonicalJson } from "../shared/canonicalJson";
import { validateExplicitKeyframeTimes, type MaterialKeyframeAnalysis, type MaterialKeyframeDisplay } from "./materialKeyframeTypes";
import { verifyMaterialKeyframeDisplay } from "./materialKeyframeValidation";

export interface MaterialCacheIdentity {
  schema: "hao.editkin.material-intelligence/v1"; engineRevision: 3 | 4;
  assetId: string; clipId: string; sourceSha256: string;
  sourceStart: number; duration: number; fps: number; kind: "audio" | "video" | "image";
  language: string; includeTranscript: boolean; maxKeyframes: number;
  keyframeTimes?: number[];
  color?: MediaColorMetadata; colorManagement?: ColorManagementSettings;
  colorRuntime: MaterialColorRuntimeIdentity;
  preparationSha256: string;
  /** Omitted only for historical evidence or when speech is not requested. */
  transcriptRuntimeSha256?: string;
  transcriptPolicy?: "required";
}
export interface MaterialCacheSeal { identity: MaterialCacheIdentity; packetSha256: string }
interface CachePacket {
  materialId: string; schema: string; cache?: MaterialCacheSeal;
  source: { assetId: string; clipId: string; sourceSha256: string; sourceStart: number; duration: number; fps: number; kind: string; color?: MediaColorMetadata; colorManagement?: ColorManagementSettings };
  analysis: { keyframes?: MaterialKeyframeAnalysis; color?: MaterialColorReceipt; scene: { state: string; cuts: Array<{ time: number }> } };
  keyframes: Array<{ id: string; time: number; sceneIndex: number; fileName: string; sha256: string; bytes: number; display?: MaterialKeyframeDisplay }>;
}
export const hashMaterialJson = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export async function hashMaterialSource(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
function packetDigest(packet: CachePacket): string {
  return hashMaterialJson({ ...packet, cache: { identity: packet.cache!.identity } });
}
export function sealMaterialPacket<T extends CachePacket>(packet: T, identity: MaterialCacheIdentity): T {
  const sealed = { ...packet, cache: { identity, packetSha256: "" } };
  sealed.cache.packetSha256 = packetDigest(sealed);
  return sealed;
}
/** Integrity only, not authenticity/signature or proof the source has not changed. */
export function verifyMaterialPacket(packet: CachePacket, expectedId: string): void {
  if (packet.schema !== "hao.editkin.material-intelligence/v1" || packet.materialId !== expectedId) throw new Error("素材 cache 識別完整性不一致");
  if (!packet.cache) {
    if (packet.analysis?.color) throw new Error("色彩素材 cache 缺少完整性封存");
    return; // Legacy read-only evidence remains readable; new preparation never uses its ID.
  }
  const { identity } = packet.cache;
  if (![3, 4].includes(identity.engineRevision) || hashMaterialJson(identity) !== expectedId || packetDigest(packet) !== packet.cache.packetSha256) throw new Error("素材 cache 完整性驗證失敗");
  for (const key of ["assetId", "clipId", "sourceSha256", "sourceStart", "duration", "fps", "kind", "color", "colorManagement"] as const) {
    if (canonicalJson(packet.source[key] ?? null) !== canonicalJson(identity[key] ?? null)) throw new Error(`素材 cache 來源完整性不一致：${key}`);
  }
  const color = packet.analysis.color;
  if (!color) throw new Error("素材 cache 缺少色彩適用性收據");
  verifyMaterialColorReceipt(color, identity.engineRevision === 3 ? { historicalRuntime: "material-cache-revision-3" } : undefined);
  if (color.source.sha256 !== identity.sourceSha256 || color.source.start !== identity.sourceStart || color.source.duration !== identity.duration
    || hashMaterialJson(color.identity) !== hashMaterialJson(identity.colorRuntime)) throw new Error("素材色彩收據與來源／runtime 完整性不一致");
  const scene = packet.analysis.scene;
  if (identity.keyframeTimes !== undefined) {
    if (identity.engineRevision !== 4 || identity.kind !== "video") throw Error("explicit-keyframe-times-require-video");
    const expectedTimes = validateExplicitKeyframeTimes(identity.keyframeTimes, identity.duration, identity.maxKeyframes);
    if (canonicalJson(expectedTimes) !== canonicalJson(packet.analysis.keyframes?.requestedSamples.map(sample => sample.time))) {
      throw Error("explicit-keyframe-times-cache-mismatch");
    }
  }
  if (identity.engineRevision === 4) {
    verifyMaterialKeyframeDisplay(packet.analysis.keyframes, packet.keyframes, packet.source, identity.colorRuntime.identitySha256,
      scene.state === "ready" ? scene.cuts.map(cut => cut.time) : identity.kind === "image" ? [] : undefined);
    if (packet.analysis.keyframes!.requestedSamples.length > identity.maxKeyframes) throw new Error("keyframe-display-budget");
    const preparation = identity.colorRuntime.implementations.find(item => item.name === "materialIntelligence.ts");
    // Unmeasured runtime still has no trusted visuals, but source-only preparation
    // identity is independently bound in the cache ID (e.g. valid audio-only ASR).
    if (identity.colorRuntime.status === "verified" && preparation?.sha256 !== identity.preparationSha256) throw new Error("keyframe-preparation-identity");
  }
  const requested = materialColorRequestSnapshot({
    sourcePath: "not-read-for-receipt-validation", sourceSha256: identity.sourceSha256, sourceStart: identity.sourceStart, duration: identity.duration,
    kind: identity.kind, color: identity.color, colorManagement: identity.colorManagement,
    samples: identity.engineRevision === 4 ? packet.analysis.keyframes!.requestedSamples : packet.keyframes.map(({ id, time, sceneIndex }) => ({ id, time, sceneIndex })),
    sceneCount: identity.kind === "audio" ? 0 : scene.cuts.length + 1,
    sceneCountVerified: scene.state === "ready" || identity.kind === "image",
    sceneCuts: scene.state === "ready" ? scene.cuts.map(cut => cut.time) : identity.kind === "image" ? [] : undefined,
  });
  if (canonicalJson(requested) !== canonicalJson(color.request)) throw new Error("素材色彩收據與要求的設定／抽幀完整性不一致");
}
export async function verifyMaterialKeyframeFiles(packet: CachePacket, directory: string): Promise<void> {
  for (const frame of packet.keyframes) {
    if (!/^frame-\d{2}\.jpg$/.test(frame.fileName)) throw new Error("素材 cache 關鍵幀路徑不合法");
    const data = await readFile(join(directory, frame.fileName));
    if (data.length !== frame.bytes || createHash("sha256").update(data).digest("hex") !== frame.sha256) throw new Error("素材 cache 關鍵幀完整性驗證失敗");
  }
}
/** Only an absent directory is a cache miss; unknown/partial/corrupt evidence is retained. */
export async function readCompletedMaterialCache<T extends CachePacket>(directory: string, materialId: string): Promise<T | undefined> {
  try { await access(directory); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const packet = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as T;
  verifyMaterialPacket(packet, materialId);
  await verifyMaterialKeyframeFiles(packet, directory);
  return packet;
}

/** Windows can transiently deny a rename. This does not diagnose the OS cause.
 * A bounded retry never removes/replaces an existing complete or partial cache.
 * Injection is for deterministic failure controls, not a product bypass.
 */
export async function publishMaterialCache<T extends CachePacket>(staging: string, directory: string, materialId: string, operations = {
  rename,
  read: (path: string, id: string) => readCompletedMaterialCache<T>(path, id),
  wait: (ms: number) => new Promise<void>(done => setTimeout(done, ms)),
}): Promise<T | undefined> {
  const existing = await operations.read(directory, materialId);
  if (existing) return existing;
  const deadline = Date.now() + 750, delays = [50, 100, 200, 400];
  for (let attempt = 0; ; attempt++) {
    try { await operations.rename(staging, directory); return undefined; }
    catch (error) {
      const winner = await operations.read(directory, materialId);
      if (winner) return winner;
      const remaining = deadline - Date.now();
      if (!["EPERM", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "") || attempt >= delays.length || remaining <= 0) throw error;
      await operations.wait(Math.min(delays[attempt], remaining));
    }
  }
}
