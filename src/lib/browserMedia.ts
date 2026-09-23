import type { AssetKind, MediaAsset } from "../domain/types";
import { makeId } from "./format";

export interface ImportedBrowserMedia {
  asset: MediaAsset;
  runtimeUrl: string;
}

function kindFromFile(file: File): AssetKind {
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("audio/")) return "audio";
  if (file.type.startsWith("image/")) return "image";
  throw new Error(`不支援的檔案格式：${file.name}`);
}

function mediaMetadata(url: string, kind: "video" | "audio"): Promise<{
  duration: number;
  width?: number;
  height?: number;
}> {
  return new Promise((resolve, reject) => {
    const media = document.createElement(kind);
    media.preload = "metadata";
    media.onloadedmetadata = () => {
      const video = media as HTMLVideoElement;
      resolve({
        duration: media.duration,
        width: kind === "video" ? video.videoWidth : undefined,
        height: kind === "video" ? video.videoHeight : undefined,
      });
    };
    media.onerror = () => reject(new Error("瀏覽器無法讀取這個媒體檔案"));
    media.src = url;
  });
}

function imageMetadata(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => reject(new Error("瀏覽器無法讀取這張圖片"));
    image.src = url;
  });
}

export async function importBrowserMedia(file: File): Promise<ImportedBrowserMedia> {
  const kind = kindFromFile(file);
  const runtimeUrl = URL.createObjectURL(file);
  try {
    const metadata = kind === "image"
      ? { ...(await imageMetadata(runtimeUrl)), duration: 5 }
      : await mediaMetadata(runtimeUrl, kind);
    if (!Number.isFinite(metadata.duration) || metadata.duration <= 0) {
      throw new Error(`讀不到 ${file.name} 的有效時長`);
    }
    return {
      runtimeUrl,
      asset: {
        id: makeId("asset"),
        name: file.name,
        kind,
        uri: `local://${encodeURIComponent(file.name)}`,
        duration: metadata.duration,
        width: metadata.width,
        height: metadata.height,
      },
    };
  } catch (error) {
    URL.revokeObjectURL(runtimeUrl);
    throw error;
  }
}
