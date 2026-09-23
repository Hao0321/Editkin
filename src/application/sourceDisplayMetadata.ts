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
