import { createHash } from "node:crypto";
import { open, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  parseProductAutoRotoRouteReceipt,
  PRODUCT_AUTO_ROTO_ENGINE,
  PRODUCT_AUTO_ROTO_MAX_ALPHA_BYTES,
  PRODUCT_AUTO_ROTO_MAX_FRAMES,
  PRODUCT_AUTO_ROTO_MAX_PREVIEW_BYTES,
  PRODUCT_AUTO_ROTO_MAX_PREVIEW_TOTAL_BYTES,
  verifyProductAutoRotoArtifactPaths,
} from "../application/autoRotoProductContract";
import type { RotoMatteSequence } from "../domain/types";

const SHA256 = /^[a-f0-9]{64}$/;
const MANIFEST_KEYS = [
  "schema", "engine", "width", "height", "analysisFps", "initialFrame", "sequencePath", "frames",
  "sequenceSha256", "sequenceBytes", "meanBoundaryChatter", "correctionStrokesApplied", "correctedFrames",
  "regionMemoryRouting", "alphaRefinement", "frozen", "qualityState", "routeReceipt",
] as const;
const FRAME_KEYS = [
  "frame", "time", "alphaPath", "confidence", "foregroundRatio", "boundaryChatter", "previewSha256", "alphaFrameSha256",
] as const;
const EDIT_GRAPH_MATTE_KEYS = new Set([
  "schema", "engine", "width", "height", "analysisFps", "frameCount", "sequenceUri", "sequenceSha256",
  "sequenceBytes", "manifestUri", "framePreviewUris", "frameArtifactUris", "meanBoundaryChatter",
  "correctionStrokesApplied", "correctedFrames", "alphaRefinement", "regionMemoryRouting", "routeReceipt",
  "stale", "frozen", "qualityState",
]);
const ROUTING_KEYS = ["schema", "requested", "executed", "candidateAttempted", "deterministicFallback"] as const;
const MANIFEST_MAX_BYTES = 8 * 1024 * 1024;
const PREVIEW_READ_CONCURRENCY = 4;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = [...keys].sort((left, right) => left.localeCompare(right, "en"));
  const observed = Object.keys(value).sort((left, right) => left.localeCompare(right, "en"));
  return JSON.stringify(observed) === JSON.stringify(expected);
}

function assertProductMatteReceipt(matte: RotoMatteSequence): void {
  if (matte.schema !== "editkin.auto-roto-matte/v1" || matte.engine !== PRODUCT_AUTO_ROTO_ENGINE
    || matte.qualityState !== "diagnostic" || matte.frozen !== true || matte.stale === true
    || Object.keys(matte).some((key) => !EDIT_GRAPH_MATTE_KEYS.has(key))) {
    throw new Error("正式輸出只接受 Editkin 純自研 native Auto Roto artifact");
  }
  parseProductAutoRotoRouteReceipt(matte.routeReceipt);
  const routing = matte.regionMemoryRouting;
  if (!routing || !exactKeys(routing as unknown as Record<string, unknown>, ROUTING_KEYS)
    || routing.schema !== "editkin.region-memory-routing/v1" || routing.requested !== "fixed_baseline"
    || routing.executed !== "fixed_baseline" || routing.candidateAttempted || routing.deterministicFallback) {
    throw new Error("Auto Roto fixed-baseline routing receipt 不合法");
  }
  const alpha = matte.alphaRefinement;
  if (alpha?.schema !== "editkin.optical-alpha-refinement-aggregate/v1"
    || alpha.engine !== "editkin-self-authored-optical-alpha-refiner/v1"
    || alpha.appliedFrames !== matte.frameCount) throw new Error("Auto Roto optical alpha receipt 不合法");
  if (!SHA256.test(matte.sequenceSha256 ?? "") || !Number.isSafeInteger(matte.sequenceBytes)
    || matte.sequenceBytes !== matte.width * matte.height * matte.frameCount
    || matte.frameArtifactUris?.length !== matte.frameCount) {
    throw new Error("Auto Roto artifact digest 或 inventory 不完整");
  }
}

export async function verifyFrozenRotoMatte(
  matte: RotoMatteSequence,
  sequencePath: string,
  manifestPath: string,
  productCacheRoot?: string,
): Promise<string> {
  assertProductMatteReceipt(matte);
  if (!productCacheRoot) throw new Error("正式 Auto Roto 輸出缺少可信 product cache root");
  if (![matte.width, matte.height, matte.frameCount].every((value) => Number.isSafeInteger(value) && value > 0)
    || matte.frameCount > PRODUCT_AUTO_ROTO_MAX_FRAMES || matte.sequenceBytes! > PRODUCT_AUTO_ROTO_MAX_ALPHA_BYTES
    || !Number.isFinite(matte.analysisFps) || matte.analysisFps <= 0) throw new Error("Auto Roto frozen matte 尺寸、幀率或記憶體 envelope 不合法");
  if (resolve(matte.sequenceUri) !== resolve(sequencePath) || resolve(matte.manifestUri) !== resolve(manifestPath)) {
    throw new Error("Auto Roto EditGraph 路徑與 render request 不一致");
  }

  const frameArtifactUris = matte.frameArtifactUris!;
  await verifyProductAutoRotoArtifactPaths({
    manifestPath,
    sequencePath,
    frames: frameArtifactUris.map((alphaPath, frame) => ({ frame, alphaPath })),
  }, productCacheRoot);

  if ((await stat(manifestPath)).size > MANIFEST_MAX_BYTES) throw new Error("Auto Roto product manifest 超出安全上限");
  const manifestBytes = await readFile(manifestPath);
  let manifest: Record<string, unknown>;
  try { manifest = JSON.parse(manifestBytes.toString("utf8")) as Record<string, unknown>; }
  catch { throw new Error("Auto Roto product manifest 不是合法 JSON"); }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) || !exactKeys(manifest, MANIFEST_KEYS)) {
    throw new Error("Auto Roto product manifest 欄位不符合封閉式 v2 contract");
  }
  parseProductAutoRotoRouteReceipt(manifest.routeReceipt);
  if (manifest.schema !== matte.schema || manifest.engine !== matte.engine || manifest.width !== matte.width
    || manifest.height !== matte.height || manifest.analysisFps !== matte.analysisFps || manifest.sequenceSha256 !== matte.sequenceSha256
    || manifest.sequenceBytes !== matte.sequenceBytes || manifest.qualityState !== "diagnostic" || manifest.frozen !== true
    || resolve(String(manifest.sequencePath)) !== resolve(sequencePath)
    || JSON.stringify(manifest.regionMemoryRouting) !== JSON.stringify(matte.regionMemoryRouting)
    || JSON.stringify(manifest.alphaRefinement) !== JSON.stringify(matte.alphaRefinement)
    || JSON.stringify(manifest.routeReceipt) !== JSON.stringify(matte.routeReceipt)) {
    throw new Error("Auto Roto product manifest 與 EditGraph receipt 不一致");
  }

  const frames = manifest.frames;
  if (!Array.isArray(frames) || frames.length !== matte.frameCount) {
    throw new Error("Auto Roto product manifest frame inventory 不完整");
  }
  for (let frame = 0; frame < frames.length; frame += 1) {
    const receipt = frames[frame];
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)
      || !exactKeys(receipt as Record<string, unknown>, FRAME_KEYS)) throw new Error("Auto Roto frame receipt 欄位不合法");
    const item = receipt as Record<string, unknown>;
    if (item.frame !== frame || resolve(String(item.alphaPath)) !== resolve(frameArtifactUris[frame])
      || !SHA256.test(String(item.previewSha256)) || !SHA256.test(String(item.alphaFrameSha256))) {
      throw new Error(`Auto Roto frame ${frame} artifact receipt 驗證失敗`);
    }
  }
  const sequenceInfo = await stat(sequencePath);
  if (sequenceInfo.size !== matte.sequenceBytes || sequenceInfo.size > PRODUCT_AUTO_ROTO_MAX_ALPHA_BYTES) {
    throw new Error("Auto Roto frozen matte 長度超出安全 envelope");
  }
  const frameBytes = matte.width * matte.height;
  const sequenceDigest = createHash("sha256");
  const sequenceHandle = await open(sequencePath, "r");
  try {
    for (let frame = 0; frame < frames.length; frame += 1) {
      const alpha = Buffer.allocUnsafe(frameBytes);
      let offset = 0;
      while (offset < alpha.length) {
        const read = await sequenceHandle.read(alpha, offset, alpha.length - offset, frame * frameBytes + offset);
        if (read.bytesRead === 0) throw new Error("Auto Roto frozen matte 提前結束");
        offset += read.bytesRead;
      }
      sequenceDigest.update(alpha);
      if ((frames[frame] as Record<string, unknown>).alphaFrameSha256 !== sha256(alpha)) {
        throw new Error(`Auto Roto frame ${frame} alpha receipt 驗證失敗`);
      }
    }
  } finally {
    await sequenceHandle.close();
  }
  if (sequenceDigest.digest("hex") !== matte.sequenceSha256) throw new Error("Auto Roto frozen matte SHA-256 驗證失敗");

  let totalPreviewBytes = 0;
  for (const path of frameArtifactUris) {
    const bytes = (await stat(path)).size;
    if (bytes < 32 || bytes > PRODUCT_AUTO_ROTO_MAX_PREVIEW_BYTES
      || (totalPreviewBytes += bytes) > PRODUCT_AUTO_ROTO_MAX_PREVIEW_TOTAL_BYTES) {
      throw new Error("Auto Roto preview PNG 超出安全 envelope");
    }
  }
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(PREVIEW_READ_CONCURRENCY, frames.length) }, async () => {
    while (cursor < frames.length) {
      const frame = cursor;
      cursor += 1;
      const preview = await readFile(frameArtifactUris[frame]);
      if (preview.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
        || (frames[frame] as Record<string, unknown>).previewSha256 !== sha256(preview)) {
        throw new Error(`Auto Roto frame ${frame} preview receipt 驗證失敗`);
      }
    }
  }));
  return sequencePath;
}
