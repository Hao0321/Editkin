import type { ChromaKeyScreen, ChromaKeySettings } from "./types";

export const DEFAULT_CHROMA_KEY: ChromaKeySettings = {
  schema: "editkin.chroma-key/v1",
  engine: "editkin-chroma-distance-keyer/v1",
  enabled: true,
  screen: "green",
  screenColor: "#00B140",
  similarity: 0.075,
  softness: 0.12,
  edgeBias: 0,
  despill: 0.72,
};

export const CHROMA_KEY_PRESETS: Record<ChromaKeyScreen, ChromaKeySettings> = {
  green: { ...DEFAULT_CHROMA_KEY },
  blue: { ...DEFAULT_CHROMA_KEY, screen: "blue", screenColor: "#0047BB", similarity: 0.065, softness: 0.115 },
};

export interface KeyedRgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.max(minimum, Math.min(maximum, value));
}

export function parseHexRgb(value: string): [number, number, number] {
  if (!/^#[0-9a-f]{6}$/i.test(value)) throw new Error("綠／藍幕顏色必須是 #RRGGBB");
  return [Number.parseInt(value.slice(1, 3), 16), Number.parseInt(value.slice(3, 5), 16), Number.parseInt(value.slice(5, 7), 16)];
}

function chromaticity(r: number, g: number, b: number): [number, number, number] {
  const sum = r + g + b;
  if (sum <= 1e-6) return [1 / 3, 1 / 3, 1 / 3];
  return [r / sum, g / sum, b / sum];
}

/** Shared scalar oracle for browser preview and formal FFmpeg expression calibration. */
export function chromaKeyAlpha(r: number, g: number, b: number, settings: ChromaKeySettings): number {
  if (!settings.enabled) return 1;
  const [keyR, keyG, keyB] = parseHexRgb(settings.screenColor);
  const [rn, gn, bn] = chromaticity(r, g, b);
  const [kr, kg, kb] = chromaticity(keyR, keyG, keyB);
  const distance = Math.sqrt((rn - kr) ** 2 + (gn - kg) ** 2 + (bn - kb) ** 2);
  const threshold = clamp(settings.similarity + settings.edgeBias, 0, 0.49);
  const linear = clamp((distance - threshold) / Math.max(0.005, settings.softness));
  return linear * linear * (3 - 2 * linear);
}

export function applyChromaKeyPixel(r: number, g: number, b: number, a: number, settings: ChromaKeySettings): KeyedRgba {
  if (!settings.enabled) return { r, g, b, a };
  const matte = chromaKeyAlpha(r, g, b, settings);
  const dominant = settings.screen === "green" ? g : b;
  const neutral = settings.screen === "green" ? Math.max(r, b) : Math.max(r, g);
  const spill = Math.max(0, dominant - neutral) * settings.despill * (1 - matte);
  if (settings.screen === "green") {
    return {
      r: clamp(r + spill * 0.5, 0, 255),
      g: clamp(g - spill, 0, 255),
      b: clamp(b + spill * 0.5, 0, 255),
      a: clamp(a * matte, 0, 255),
    };
  }
  return {
    r: clamp(r + spill * 0.5, 0, 255),
    g: clamp(g + spill * 0.5, 0, 255),
    b: clamp(b - spill, 0, 255),
    a: clamp(a * matte, 0, 255),
  };
}

export function applyChromaKeyRgbaInPlace(pixels: Uint8ClampedArray, settings: ChromaKeySettings): void {
  if (!settings.enabled) return;
  for (let index = 0; index + 3 < pixels.length; index += 4) {
    const keyed = applyChromaKeyPixel(pixels[index], pixels[index + 1], pixels[index + 2], pixels[index + 3], settings);
    pixels[index] = keyed.r;
    pixels[index + 1] = keyed.g;
    pixels[index + 2] = keyed.b;
    pixels[index + 3] = keyed.a;
  }
}

function n(value: number): string {
  return Number(value.toFixed(8)).toString();
}

/** Compiles the same closed keyer equation into FFmpeg GEQ; FFmpeg is only the pixel executor. */
export function chromaKeyFfmpegFilter(settings: ChromaKeySettings, precision: "compatibility8" | "high16" = "compatibility8"): string | undefined {
  if (!settings.enabled) return undefined;
  const [keyR, keyG, keyB] = parseHexRgb(settings.screenColor);
  const [kr, kg, kb] = chromaticity(keyR, keyG, keyB);
  const sum = "(r(X,Y)+g(X,Y)+b(X,Y)+0.000001)";
  const distance = `sqrt(pow(r(X,Y)/${sum}-${n(kr)},2)+pow(g(X,Y)/${sum}-${n(kg)},2)+pow(b(X,Y)/${sum}-${n(kb)},2))`;
  const threshold = n(clamp(settings.similarity + settings.edgeBias, 0, 0.49));
  const softness = n(Math.max(0.005, settings.softness));
  const linear = `clip((${distance}-${threshold})/${softness},0,1)`;
  const matte = `((${linear})*(${linear})*(3-2*(${linear})))`;
  const dominant = settings.screen === "green" ? "g(X,Y)" : "b(X,Y)";
  const neutral = settings.screen === "green" ? "max(r(X,Y),b(X,Y))" : "max(r(X,Y),g(X,Y))";
  const spill = `(max(0,${dominant}-${neutral})*${n(settings.despill)}*(1-${matte}))`;
  const maximum = precision === "high16" ? 65535 : 255;
  const format = precision === "high16" ? "gbrap16le" : "gbrap";
  const output = precision === "high16" ? "gbrap16le" : "rgba";
  const red = `clip(r(X,Y)+${spill}*0.5,0,${maximum})`;
  const green = settings.screen === "green" ? `clip(g(X,Y)-${spill},0,${maximum})` : `clip(g(X,Y)+${spill}*0.5,0,${maximum})`;
  const blue = settings.screen === "blue" ? `clip(b(X,Y)-${spill},0,${maximum})` : `clip(b(X,Y)+${spill}*0.5,0,${maximum})`;
  return `format=${format},geq=r='${red}':g='${green}':b='${blue}':a='alpha(X,Y)*${matte}',format=${output}`;
}
