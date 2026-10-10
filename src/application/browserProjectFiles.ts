import type { OpenProjectResult } from "../desktop/types";
import type { AssetKind, EditProject, MediaAsset } from "../domain/types";
import { decodeProjectBytes, PROJECT_MAX_BYTES } from "./projectCodec";

const PICKER_TIMEOUT_MS = 120_000;
const METADATA_TIMEOUT_MS = 15_000;
const SOURCE_HASH_MAX_BYTES = 64 * 1024 * 1024;

/** One explicit user choice; names are never used to automatically match graph assets. */
export function chooseBrowserFile(accept: string): Promise<File | undefined> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.hidden = true;
    let settled = false;
    const finish = (file?: File, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.removeEventListener("change", changed);
      input.removeEventListener("cancel", canceled);
      input.remove();
      if (error) reject(error); else resolve(file);
    };
    const changed = () => finish(input.files?.[0]);
    const canceled = () => finish();
    const timer = setTimeout(() => finish(undefined, new Error("選檔逾時；專案與素材保持不變，請重新選擇。")), PICKER_TIMEOUT_MS);
    input.addEventListener("change", changed);
    input.addEventListener("cancel", canceled);
    try { document.body.appendChild(input); input.click(); }
    catch (error) { finish(undefined, error instanceof Error ? error : new Error("無法開啟選檔視窗")); }
  });
}

export async function readBrowserProjectFile(file: Pick<File, "size" | "arrayBuffer">): Promise<EditProject> {
  if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > PROJECT_MAX_BYTES) throw new Error("專案檔超過 64 MiB 上限，拒絕讀取");
  const buffer = await file.arrayBuffer();
  if (buffer.byteLength !== file.size) throw new Error("專案檔在讀取時變動，拒絕讀取");
  return decodeProjectBytes(new Uint8Array(buffer));
}

export async function openBrowserProject(): Promise<OpenProjectResult> {
  const file = await chooseBrowserFile(".editkin.json,.json,application/json");
  if (!file) return { canceled: true };
  // A browser File supplies no writable native path. Asset URLs must be relinked explicitly.
  return { canceled: false, project: await readBrowserProjectFile(file), runtimeUrls: {} };
}

export function missingBrowserMedia(project: EditProject, runtimeUrls: Readonly<Record<string, string>>): MediaAsset[] {
  return project.assets.filter(asset => !asset.compositionId && !runtimeUrls[asset.id]);
}

export interface BrowserRelinkMetadata { kind: AssetKind; duration?: number; width?: number; height?: number; sourceSha256?: string }

/** Checks the preserved graph against actual measurements; it never edits clips or asset metadata. */
export function assertBrowserMediaRelink(project: EditProject, assetId: string, measured: BrowserRelinkMetadata): MediaAsset {
  const asset = project.assets.find(item => item.id === assetId);
  if (!asset || asset.compositionId) throw new Error("要重新連結的素材已不存在，或是專案內合成。");
  if (asset.imageSequence) throw new Error("瀏覽器無法重新連結 OpenEXR 序列；請使用桌面版。");
  if (asset.kind !== measured.kind) throw new Error("所選檔案類型與原素材不同。");
  if (asset.kind !== "audio") {
    for (const dimension of ["width", "height"] as const) {
      const actual = measured[dimension];
      if (!Number.isSafeInteger(actual) || actual! <= 0) throw new Error("所選檔案沒有有效畫面尺寸。");
      if (asset[dimension] !== undefined && actual !== asset[dimension]) throw new Error("所選檔案尺寸與原素材不同，未重新連結。");
    }
  }
  if (asset.kind !== "image") {
    const duration = measured.duration;
    if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) throw new Error("所選檔案沒有有效時長。");
    if (Math.abs(duration - asset.duration) > Math.max(1 / project.fps, 0.005)) throw new Error("所選檔案時長與原素材不同，未重新連結。");
    const tracks = [...project.tracks, ...project.compositions.flatMap(composition => composition.tracks)];
    for (const clip of tracks.flatMap(track => track.clips)) {
      if (clip.assetId !== assetId) continue;
      const end = clip.sourceStart + clip.duration;
      const tolerance = Number.EPSILON * Math.max(1, Math.abs(end), Math.abs(duration)) * 8;
      if (!Number.isFinite(end) || end > duration + tolerance) throw new Error("所選檔案不足以涵蓋既有片段來源範圍，未重新連結。");
    }
  }
  const pinnedSha = asset.derivatives?.sourceSha256;
  if (pinnedSha && measured.sourceSha256 !== pinnedSha) throw new Error("所選檔案與原素材 SHA-256 不符，未重新連結。");
  return asset;
}

function kindOfFile(file: File): AssetKind {
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("audio/")) return "audio";
  if (file.type.startsWith("image/")) return "image";
  throw new Error("瀏覽器無法識別所選檔案的媒體類型。");
}

/** The metadata probe only ever loads the object URL created for the user's chosen file. */
function localObjectUrl(url: string): string {
  if (!url.startsWith("blob:")) throw new Error("只能讀取所選檔案的媒體資訊。");
  // CodeQL does not model the scheme check above as a sanitizer. A blob: URL
  // is plain ASCII, so encodeURI returns it unchanged.
  return encodeURI(url);
}

function readMetadata(url: string, kind: AssetKind): Promise<BrowserRelinkMetadata> {
  return new Promise((resolve, reject) => {
    const element = kind === "image" ? document.createElement("img") : document.createElement(kind);
    let settled = false;
    const finish = (metadata?: BrowserRelinkMetadata, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      element.onload = null;
      element.onerror = null;
      if (element instanceof HTMLMediaElement) { element.onloadedmetadata = null; element.pause(); }
      element.removeAttribute("src");
      if (element instanceof HTMLMediaElement) element.load();
      if (error) reject(error); else resolve(metadata!);
    };
    const timer = setTimeout(() => finish(undefined, new Error("讀取媒體資訊逾時，未重新連結。")), METADATA_TIMEOUT_MS);
    element.onerror = () => finish(undefined, new Error("瀏覽器無法讀取所選媒體檔案。"));
    if (element instanceof HTMLImageElement) element.onload = () => finish({ kind, width: element.naturalWidth, height: element.naturalHeight });
    else {
      element.preload = "metadata";
      element.onloadedmetadata = () => finish({ kind, duration: element.duration,
        ...(element instanceof HTMLVideoElement ? { width: element.videoWidth, height: element.videoHeight } : {}) });
    }
    try { element.src = localObjectUrl(url); }
    catch (error) { finish(undefined, error instanceof Error ? error : new Error("無法讀取媒體資訊。")); }
  });
}

export async function prepareBrowserMediaRelink(project: EditProject, assetId: string, file: File): Promise<{
  runtimeUrl: string; measured: BrowserRelinkMetadata; dispose: () => void;
}> {
  const asset = project.assets.find(item => item.id === assetId);
  if (!asset || asset.compositionId || asset.imageSequence) throw new Error("此素材需要桌面版重新連結。");
  if (!Number.isSafeInteger(file.size) || file.size < 0) throw new Error("所選素材的檔案大小不合法。");
  const kind = kindOfFile(file);
  if (kind !== asset.kind) throw new Error("所選檔案類型與原素材不同。");
  let sourceSha256: string | undefined;
  if (asset.derivatives?.sourceSha256) {
    if (file.size > SOURCE_HASH_MAX_BYTES) throw new Error("此素材的實體 SHA 驗證超過瀏覽器 64 MiB 上限；請使用桌面版重新連結。");
    const bytes = await file.arrayBuffer();
    if (bytes.byteLength !== file.size) throw new Error("素材在讀取時變動，未重新連結。");
    sourceSha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), value => value.toString(16).padStart(2, "0")).join("");
  }
  const runtimeUrl = URL.createObjectURL(file);
  let disposed = false;
  const dispose = () => { if (!disposed) { disposed = true; URL.revokeObjectURL(runtimeUrl); } };
  try {
    const measured = { ...await readMetadata(runtimeUrl, kind), sourceSha256 };
    assertBrowserMediaRelink(project, assetId, measured);
    return { runtimeUrl, measured, dispose };
  } catch (error) { dispose(); throw error; }
}
