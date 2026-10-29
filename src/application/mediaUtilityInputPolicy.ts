/** Utility inputs must be self-contained files. HLS, concat and image2 can
 * open unbound secondary files even when the top-level path is in workspace.
 * MOV external track/absolute alias support keeps FFmpeg's disabled default. */
export const MEDIA_UTILITY_SELF_CONTAINED_FORMATS = [
  "mov", "matroska", "avi", "flv", "asf", "mpeg", "mpegts", "nut", "ivf",
  "mp3", "wav", "aac", "flac", "ogg", "aiff", "ape", "wv", "au", "amr",
  "gif", "apng", "png_pipe", "jpeg_pipe", "webp_pipe", "bmp_pipe", "tiff_pipe",
] as const;
export function mediaUtilityInputOptions(path = ""): string[] {
  // JPEG auto-detection can choose image2; force the single already-open file
  // reader so an ordinary photo works without allowing numbered/glob inputs.
  const jpeg = /\.(?:jpe?g|jpe|jfif)$/i.test(path);
  return ["-format_whitelist", MEDIA_UTILITY_SELF_CONTAINED_FORMATS.join(","), "-protocol_whitelist", "file", ...(jpeg ? ["-f", "jpeg_pipe"] : [])];
}
