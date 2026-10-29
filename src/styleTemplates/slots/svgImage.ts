import { fmt } from "../../motionLibrary/svg/document";

/**
 * Pictures inside SVG template components (browser-safe). A picture slot reaches a component as a normalized derivative
 * (decoded, cropped and sized by the renderer, then identified by the sha256 of its bytes) and is drawn as an <image>
 * with a data: URI, composited inside the component (clip paths, poses, punch-ins) so preview == export by construction.
 *
 * The motion library's SVG builders allow no <image> (frozen whitelist); this is the one controlled builder: the href
 * must be a base64 PNG or JPEG data URI, every number is finite and nothing else is accepted.
 */

export interface SlotImageParams {
  /** sha256 of the derivative's bytes (the identity the cache key sees). */
  readonly sha256: string;
  readonly width: number;
  readonly height: number;
  readonly mime: "image/png" | "image/jpeg";
  readonly fit: "cover" | "contain";
  /** 0..1, y down: the point kept in view (cover) and the punch-in centre. */
  readonly focal: readonly [number, number];
}

const DATA_URI = /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/;

export function slotImageDataUri(mime: SlotImageParams["mime"], bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return `data:${mime};base64,${btoa(binary)}`;
}

export function svgImageElement(href: string, x: number, y: number, width: number, height: number): string {
  if (!DATA_URI.test(href)) throw new Error("SVG pictures must be base64 PNG or JPEG data URIs");
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) throw new Error("SVG picture geometry must be finite and positive");
  return `<image x="${fmt(x, 3)}" y="${fmt(y, 3)}" width="${fmt(width, 3)}" height="${fmt(height, 3)}" preserveAspectRatio="none" href="${href}"/>`;
}

/**
 * Where the picture sits in a window of `frame` size (px, relative to the window's top-left): cover fills the window
 * with the focal point as central as the picture allows; contain shows all of it, centred. `punch` (≥ 1) zooms about
 * the focal point's position in the window, which keeps a covering picture covering.
 */
export function imagePlacement(image: Pick<SlotImageParams, "width" | "height" | "fit" | "focal">, frame: { readonly w: number; readonly h: number }, punch = 1):
  { x: number; y: number; w: number; h: number } {
  const scale = image.fit === "cover" ? Math.max(frame.w / image.width, frame.h / image.height) : Math.min(frame.w / image.width, frame.h / image.height);
  const w = image.width * scale, h = image.height * scale;
  const [fx, fy] = image.focal;
  const clampRange = (value: number, low: number, high: number) => Math.max(Math.min(low, high), Math.min(Math.max(low, high), value));
  const x = image.fit === "cover" ? clampRange(frame.w / 2 - fx * w, frame.w - w, 0) : (frame.w - w) / 2;
  const y = image.fit === "cover" ? clampRange(frame.h / 2 - fy * h, frame.h - h, 0) : (frame.h - h) / 2;
  if (!(punch > 1)) return { x, y, w, h };
  const px = x + fx * w, py = y + fy * h;
  return { x: px - punch * (px - x), y: py - punch * (py - y), w: w * punch, h: h * punch };
}

/** Pixel size a derivative needs so the component never upscales it: the placed size at the strongest punch, never more than the source. */
export function slotImageTargetSize(source: { readonly width: number; readonly height: number }, frame: { readonly w: number; readonly h: number },
  fit: SlotImageParams["fit"], maxPunch: number): { width: number; height: number } {
  const scale = fit === "cover" ? Math.max(frame.w / source.width, frame.h / source.height) : Math.min(frame.w / source.width, frame.h / source.height);
  const k = Math.min(1, scale * Math.max(1, maxPunch));
  // Floor to even, as the renderer's FFmpeg scale expression does (2·trunc(x / 2)).
  const even = (value: number) => Math.max(2, 2 * Math.trunc(value / 2));
  return { width: even(source.width * k), height: even(source.height * k) };
}
