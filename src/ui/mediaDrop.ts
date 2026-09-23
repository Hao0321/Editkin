const SUPPORTED_MEDIA_EXTENSIONS = new Set([
  "mp4", "mov", "mkv", "webm", "m4v",
  "mp3", "wav", "m4a", "aac", "flac",
  "png", "jpg", "jpeg", "webp", "exr",
]);

function extensionOf(name: string): string {
  const normalized = name.trim().replaceAll("\\", "/");
  const baseName = normalized.slice(normalized.lastIndexOf("/") + 1);
  const dot = baseName.lastIndexOf(".");
  return dot > 0 ? baseName.slice(dot + 1).toLowerCase() : "";
}

export function isSupportedMediaName(name: string): boolean {
  if (name.trim().replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() === "editkin-openexr-sequence.json") return true;
  return SUPPORTED_MEDIA_EXTENSIONS.has(extensionOf(name));
}

export function partitionSupportedMedia<T>(items: readonly T[], nameOf: (item: T) => string): { supported: T[]; rejected: T[] } {
  const supported: T[] = [];
  const rejected: T[] = [];
  for (const item of items) (isSupportedMediaName(nameOf(item)) ? supported : rejected).push(item);
  return { supported, rejected };
}

export function rejectedMediaMessage(count: number): string {
  return `有 ${count} 個檔案不是支援的影片、聲音或圖片，已略過。`;
}
