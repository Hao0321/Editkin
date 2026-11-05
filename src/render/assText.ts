import { resolveBundledFontFace } from "../typography/fontFaces";

export function assColor(hex: string, opacityMultiplier = 1): string {
  const clean = hex.replace("#", "").padEnd(6, "F");
  const rgb = clean.slice(0, 6);
  const cssAlpha = clean.length >= 8 ? Number.parseInt(clean.slice(6, 8), 16) : 255;
  const effectiveAlpha = Math.round((Number.isFinite(cssAlpha) ? cssAlpha : 255) * Math.max(0, Math.min(1, opacityMultiplier)));
  const assAlpha = (255 - effectiveAlpha).toString(16).padStart(2, "0").toUpperCase();
  return `&H${assAlpha}${rgb.slice(4, 6)}${rgb.slice(2, 4)}${rgb.slice(0, 2)}`;
}

export function assOverrideColor(hex: string, channel: 1 | 3 | 4, opacity: number): string {
  const color = assColor(hex, opacity);
  // Style colors are AABBGGRR, but override color tags only accept BBGGRR.
  // Alpha is a separate channel tag; embedding it in \c silently loses fades.
  return `\\${channel}c&H${color.slice(4)}&\\${channel}a&H${color.slice(2, 4)}&`;
}

export function assTime(seconds: number): string {
  const centiseconds = Math.max(0, Math.round(seconds * 100));
  return assCentiseconds(centiseconds);
}

export function assCentiseconds(centiseconds: number): string {
  const hours = Math.floor(centiseconds / 360000);
  const minutes = Math.floor((centiseconds % 360000) / 6000);
  const secs = Math.floor((centiseconds % 6000) / 100);
  const fraction = centiseconds % 100;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(fraction).padStart(2, "0")}`;
}

/** ASS events use centiseconds, while output samples are integer video frames.
 * A rounded-up event boundary selects the PREVIOUS state at the frame's PTS.
 * Floor both ends of the half-open interval instead. This cannot represent
 * >100 unique frames per second; refuse that adapter rather than drop states. */
export function assMotionFrameTime(frame: number, fps: number): string {
  if (!Number.isSafeInteger(frame) || frame < 0 || !Number.isFinite(fps) || fps <= 0 || fps > 100) throw new Error("ASS 動態文字輸出無法逐格呈現此幀率（支援最高 100 fps）");
  return assCentiseconds(Math.floor(frame * 100 / fps + 1e-7));
}

export function assText(text: string): string {
  return text.replaceAll("\\", "／").replaceAll("{", "（").replaceAll("}", "）").replaceAll("\n", "\\N").replaceAll(",", "，");
}

export function assFontName(value: string): string {
  return value.replace(/[{},\\\r\n]/g, " ").replaceAll(",", " ").trim();
}

export function assFace(family: string, requestedWeight: number, bundledFaces: boolean) {
  const resolved = resolveBundledFontFace(family, requestedWeight);
  return bundledFaces && resolved ? resolved : { fontFamily: family, fontWeight: requestedWeight };
}

export function roundAss(value: number): number {
  return Math.round(value * 100) / 100;
}
