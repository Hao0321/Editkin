import { Mesh3dGeometryCache, mesh3dSceneTextFaceIdsV1, parseMesh3dFont } from "../motion/mesh3dGeometry";
import type { Mesh3dScene } from "../motion/mesh3dScene";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { loadMotionLibraryFaceBytesV1 } from "./motionLibraryThumbnailServiceV1";

/**
 * Fonts the mesh 3D preview (Mesh3dPreview.tsx) loads before building geometry, as the export does
 * (mesh3dRender.ts): Noto Sans TC weights for the legacy `text` kind, and the bundled faces of `text_extrude` /
 * `band_text` objects by compiled face ID — read through the desktop's bounded font IPC (or public/fonts in a
 * browser), SHA-256-checked against the compiled catalog, then parsed.
 */
type Font = ReturnType<typeof parseMesh3dFont>;

export interface Mesh3dPreviewFontPlanV1 { weights: number[]; faceIds: string[]; error?: string }

/** The scene's font needs. A face the catalog lacks is an error to show, not an exception during render. */
export function mesh3dPreviewFontPlanV1(scene: Mesh3dScene): Mesh3dPreviewFontPlanV1 {
  const weights = [...new Set(scene.segments.flatMap(s => s.objects.flatMap(o => o.geometry.kind === "text" ? [o.geometry.fontWeight] : [])))].sort();
  try { return { weights, faceIds: mesh3dSceneTextFaceIdsV1(scene) }; }
  catch (cause) { return { weights, faceIds: [], error: cause instanceof Error ? cause.message : String(cause) }; }
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  if (typeof globalThis.crypto?.subtle?.digest !== "function") throw new Error("瀏覽器未提供字型 SHA 驗證介面");
  return Array.from(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes)), value => value.toString(16).padStart(2, "0")).join("");
}

/** One bundled face, verified before parsing. `load` defaults to the desktop IPC / public fonts loader. */
export async function loadMesh3dPreviewFaceV1(faceId: string, load: (faceId: string) => Promise<Uint8Array> = loadMotionLibraryFaceBytesV1): Promise<Font> {
  const expected = bundledFontFaceSpec(faceId).sha256;
  const bytes = new Uint8Array(await load(faceId));
  if (await sha256Hex(bytes) !== expected) throw new Error(`3D 文字字型 ${faceId} 與內建字型目錄的 SHA 不符，已停止載入`);
  return parseMesh3dFont(bytes.buffer);
}

const faceLoads = new Map<string, Promise<Font>>();
/** The preview's shared face cache (a failed load is forgotten so it can be retried). */
function cachedFace(faceId: string): Promise<Font> {
  let pending = faceLoads.get(faceId);
  if (!pending) {
    pending = loadMesh3dPreviewFaceV1(faceId);
    faceLoads.set(faceId, pending);
    pending.catch(() => faceLoads.delete(faceId));
  }
  return pending;
}

/** The geometry cache for a plan: `weight` loads a Noto Sans TC weight; `face` (default: verified, cached) a bundled face. */
export async function loadMesh3dPreviewGeometryV1(plan: Mesh3dPreviewFontPlanV1, loaders: { weight: (weight: number) => Promise<Font>; face?: (faceId: string) => Promise<Font> }): Promise<Mesh3dGeometryCache> {
  if (plan.error) throw new Error(plan.error);
  const face = loaders.face ?? cachedFace;
  const [fonts, faces] = await Promise.all([
    Promise.all(plan.weights.map(async weight => [weight, await loaders.weight(weight)] as const)),
    Promise.all(plan.faceIds.map(async faceId => [faceId, await face(faceId)] as const)),
  ]);
  return new Mesh3dGeometryCache(new Map(fonts), new Map(faces));
}
