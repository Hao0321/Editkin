import type { MediaColorMetadata } from "../domain/types";

export type StrictDisplayInterpretation = "rec709" | "hlg" | "pq";

export interface DisplayColorTags {
  primaries?: unknown;
  transfer?: unknown;
  matrix?: unknown;
  range?: unknown;
  pixelFormat?: unknown;
}

const text = (value: unknown) => typeof value === "string" ? value.trim().toLowerCase() : undefined;
export const normalizedDisplayRange = (value: unknown) => {
  const observed = text(value);
  return observed === "tv" || observed === "limited" ? "limited" : observed === "pc" || observed === "full" ? "full" : undefined;
};
const RGB_PIXEL_FORMAT = /^(?:rgb24|bgr24|gbrp(?:\d+(?:le|be))?)$/;
const YUV_PIXEL_FORMAT = /^(?:yuv(?:420|422|444)p(?:\d+(?:le|be))?|nv12|p010le)$/;
const SUPPORTED_PIXEL_FORMAT = /^(?:yuv(?:420|422|444)p(?:\d+(?:le|be))?|nv12|p010le|rgb24|bgr24|gbrp(?:\d+(?:le|be))?)$/;

/**
 * Closed-world display-transform authorization shared by import analysis,
 * browser proxies and formal compositing. An authored interpretation never
 * supplies missing camera tags and never overrides contradictory ones.
 */
export function strictDisplayColorInterpretation(tags: DisplayColorTags, authored?: MediaColorMetadata): StrictDisplayInterpretation {
  const p = text(tags.primaries), t = text(tags.transfer), m = text(tags.matrix), r = normalizedDisplayRange(tags.range);
  const pixelFormat = text(tags.pixelFormat);
  let input: StrictDisplayInterpretation;
  if (p === "bt709" && t === "bt709" && (m === "bt709" || m === "gbr" || m === "rgb") && r) {
    input = "rec709";
  } else if (p === "bt2020" && r && (t === "arib-std-b67" || t === "smpte2084")) {
    const yuv = m === "bt2020nc" && (!pixelFormat || YUV_PIXEL_FORMAT.test(pixelFormat));
    const rgb = (m === "gbr" || m === "rgb") && r === "full" && Boolean(pixelFormat && RGB_PIXEL_FORMAT.test(pixelFormat));
    if (!yuv && !rgb) throw Error("unknown-or-incomplete-color-tags");
    input = t === "arib-std-b67" ? "hlg" : "pq";
  } else {
    throw Error("unknown-or-incomplete-color-tags");
  }
  if (authored) {
    const selected = authored.interpretation;
    const conflicts = (selected !== "auto" && selected !== input)
      || (authored.primaries !== undefined && text(authored.primaries) !== p)
      || (authored.transfer !== undefined && text(authored.transfer) !== t)
      || (authored.matrix !== undefined && text(authored.matrix) !== m)
      || (authored.range !== undefined && normalizedDisplayRange(authored.range) !== r);
    if (conflicts) throw Error("contradictory-color-interpretation");
  }
  return input;
}

export function strictMediaColorInterpretation(color: MediaColorMetadata, pixelFormat?: string): StrictDisplayInterpretation {
  return strictDisplayColorInterpretation({
    primaries: color.primaries,
    transfer: color.transfer,
    matrix: color.matrix,
    range: color.range,
    pixelFormat,
  }, color);
}

/** Preserve the verified stream tags when a downstream display transform is planned. */
export function sourceDisplayColorMetadata(stream: Record<string, unknown>, authored?: MediaColorMetadata): MediaColorMetadata {
  const pixelFormat = text(stream.pix_fmt);
  if (!pixelFormat || !SUPPORTED_PIXEL_FORMAT.test(pixelFormat)) throw Error("unsupported-or-alpha-pixel-format");
  const primaries = text(stream.color_primaries), transfer = text(stream.color_transfer), matrix = text(stream.color_space);
  const normalizedRange = normalizedDisplayRange(stream.color_range);
  const interpretation = strictDisplayColorInterpretation({
    primaries,
    transfer,
    matrix,
    range: stream.color_range,
    pixelFormat,
  }, authored);
  return {
    interpretation,
    primaries,
    transfer,
    matrix,
    range: normalizedRange === "limited" ? "tv" : "pc",
  };
}

/** Shared closed-world input interpretation. No metadata guessing or Log fallback. */
export function sourceDisplayInterpretation(stream: Record<string, unknown>, color?: MediaColorMetadata): "rec709" | "hlg" | "pq" {
  return sourceDisplayColorMetadata(stream, color).interpretation as StrictDisplayInterpretation;
}

/** How a still's stored samples become full-range RGB. */
export type StillImageEncodingV1 = "rgb" | "yuv-bt601-full" | "yuv-bt601-limited";
export interface StillImageDisplayColorV1 {
  interpretation: "srgb";
  /** Explicit provenance: an sRGB tag was read, or none was present and sRGB is assumed. Never measured Rec.709 video. */
  colorInterpretation: "srgb_tagged" | "srgb_assumed_untagged_image";
  encoding: StillImageEncodingV1;
}
const UNTAGGED = new Set([undefined, "unknown", "unspecified"]);
const STILL_FORMATS: Record<string, Record<string, StillImageEncodingV1 | "webp-yuv">> = {
  png: { rgb24: "rgb", rgba: "rgb", pal8: "rgb", gray: "rgb", ya8: "rgb", monob: "rgb", rgb48be: "rgb", rgba64be: "rgb", gray16be: "rgb", ya16be: "rgb" },
  // JFIF stores full-range BT.601 YCbCr; a single-component JPEG is full-range gray.
  mjpeg: { yuvj420p: "yuv-bt601-full", yuvj422p: "yuv-bt601-full", yuvj444p: "yuv-bt601-full", yuvj440p: "yuv-bt601-full", gray: "rgb" },
  // Lossy WebP is VP8 BT.601 YCbCr (studio range unless the stream says full); lossless WebP is RGB.
  webp: { yuv420p: "webp-yuv", yuva420p: "webp-yuv", argb: "rgb", rgba: "rgb", bgra: "rgb" },
};

/**
 * Display admission for a single-frame PNG, JPEG or WebP image whose colour tags are
 * missing or say sRGB (IEC 61966-2-1). It is admitted as the sRGB display image it is,
 * or is assumed to be, and says which. Every other tag set, an authored interpretation
 * other than auto/srgb, or a contradicting authored tag is refused. Video never uses this.
 */
export function stillImageDisplayColorV1(stream: Record<string, unknown>, authored?: MediaColorMetadata): StillImageDisplayColorV1 {
  const codec = text(stream.codec_name) ?? "", pixelFormat = text(stream.pix_fmt) ?? "";
  const p = text(stream.color_primaries), t = text(stream.color_transfer), m = text(stream.color_space), range = normalizedDisplayRange(stream.color_range);
  const formats = STILL_FORMATS[codec];
  if (!formats) throw Error("unsupported-still-codec");
  const stored = formats[pixelFormat];
  if (!stored) throw Error("unsupported-still-pixel-format");
  if (!UNTAGGED.has(t) && t !== "iec61966-2-1") throw Error("still-color-tags-not-srgb");
  if (!UNTAGGED.has(p) && p !== "bt709") throw Error("still-color-tags-not-srgb");
  const rgbStored = stored === "rgb";
  if (rgbStored ? !(UNTAGGED.has(m) || m === "gbr" || m === "rgb") : !(UNTAGGED.has(m) || m === "bt470bg" || m === "smpte170m")) throw Error("still-color-tags-not-srgb");
  const encoding: StillImageEncodingV1 = stored === "webp-yuv" ? (range === "full" ? "yuv-bt601-full" : "yuv-bt601-limited") : stored;
  if (encoding === "yuv-bt601-full" && range === "limited") throw Error("still-color-tags-not-srgb");
  if (authored) {
    const conflicts = (authored.interpretation !== "auto" && authored.interpretation !== "srgb")
      || (authored.primaries !== undefined && text(authored.primaries) !== p)
      || (authored.transfer !== undefined && text(authored.transfer) !== t)
      || (authored.matrix !== undefined && text(authored.matrix) !== m)
      || (authored.range !== undefined && normalizedDisplayRange(authored.range) !== range);
    if (conflicts) throw Error("contradictory-color-interpretation");
  }
  return { interpretation: "srgb", colorInterpretation: t === "iec61966-2-1" ? "srgb_tagged" : "srgb_assumed_untagged_image", encoding };
}
