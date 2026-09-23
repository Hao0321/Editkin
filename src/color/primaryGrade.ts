import type { ColorAdjustments, ColorManagementSettings, InputColorSpace, MediaAsset } from "../domain/types";
import { DEFAULT_COLOR_MANAGEMENT } from "../domain/types";
import { strictMediaColorInterpretation } from "../application/sourceDisplayMetadata";
import { HLG_DISPLAY_LINEAR_FILTER, HLG_SDR_TONEMAP_FILTER } from "./displayTransfer";

const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value));
const n = (value: number) => Number(value.toFixed(6)).toString();

function monotonicPoints(color: ColorAdjustments): Array<[number, number]> {
  const raw: Array<[number, number]> = [
    [0, clamp(color.blacks * 0.08, 0, 0.18)],
    [0.18, clamp(0.18 + color.shadows * 0.13, 0.02, 0.42)],
    [0.5, clamp(0.5 + (0.5 - color.pivot) * 0.26, 0.24, 0.76)],
    [0.82, clamp(0.82 + color.highlights * 0.13, 0.58, 0.98)],
    [1, clamp(1 + color.whites * 0.08, 0.82, 1)],
  ];
  for (let index = 1; index < raw.length; index += 1) raw[index][1] = Math.max(raw[index][1], raw[index - 1][1] + 0.002);
  for (let index = raw.length - 2; index >= 0; index -= 1) raw[index][1] = Math.min(raw[index][1], raw[index + 1][1] - 0.002);
  return raw.map(([x, y]) => [x, clamp(y, 0, 1)]);
}

export function resolveInputColorSpace(asset: MediaAsset): "rec709" | "linear_rec709" | "hlg" | "pq" | "blocked_log" {
  const interpretation = asset.color?.interpretation ?? "auto";
  if (interpretation === "log_unresolved") return "blocked_log";
  const transfer = asset.color?.transfer?.toLowerCase() ?? "";
  const hdrSelected = interpretation === "hlg" || interpretation === "pq";
  const hdrTagged = ["arib-std-b67", "hlg", "smpte2084", "pq"].includes(transfer);
  if (hdrSelected || hdrTagged) {
    try {
      if (!asset.color) throw Error("missing-color-metadata");
      return strictMediaColorInterpretation(asset.color);
    } catch {
      throw new Error(`素材「${asset.name}」的 HDR 色彩標記不完整或彼此矛盾；不能猜測 BT.2100 Input Transform。`);
    }
  }
  if (interpretation === "rec709" || interpretation === "linear_rec709") return interpretation;
  if (transfer.includes("log")) return "blocked_log";
  return "rec709";
}

const ACES_INPUT_FILES: Partial<Record<InputColorSpace, string>> = {
  rec709: "rec709", srgb: "srgb", hlg: "hlg", pq: "pq", acescct: "acescct", apple_log: "apple_log",
  arri_logc3: "arri_logc3", arri_logc4: "arri_logc4", bmd_film_gen5: "bmd_film_gen5", canon_log2: "canon_log2",
  canon_log3: "canon_log3", dji_dlog: "dji_dlog", panasonic_vlog: "panasonic_vlog", red_log3g10: "red_log3g10", sony_slog3_cine: "sony_slog3_cine",
};

const BLOCKED_LUT_PAIRS = new Map<string, string>([
  ["panasonic_vlog->rec2100_pq_1000", "Panasonic V-Log → PQ 1000 的 LUT 近似精度不足；請改用 HLG／SDR，或等待原生 OCIO processor。"],
  ["dji_dlog->rec2100_pq_1000", "DJI D-Log → PQ 1000 的 LUT 近似精度不足；請改用 HLG／SDR，或等待原生 OCIO processor。"],
]);

export function acesPrecisionBlockReason(asset: MediaAsset, management: ColorManagementSettings): string | undefined {
  if (management.mode !== "aces2") return undefined;
  const input = resolveAcesInput(asset);
  if (input === "blocked_log") return undefined;
  return BLOCKED_LUT_PAIRS.get(`${input}->${management.outputTransform}`);
}

export function resolveAcesInput(asset: MediaAsset): keyof typeof ACES_INPUT_FILES | "blocked_log" {
  const selected = asset.color?.interpretation ?? "auto";
  if (selected === "log_unresolved") return "blocked_log";
  if (selected !== "auto") return selected;
  const text = `${asset.color?.transfer ?? ""} ${asset.name}`.toLowerCase();
  if (text.includes("logc4")) return "arri_logc4";
  if (text.includes("logc3") || text.includes("arri logc")) return "arri_logc3";
  if (text.includes("s-log3") || text.includes("slog3")) return "sony_slog3_cine";
  if (text.includes("canon log 3") || text.includes("clog3")) return "canon_log3";
  if (text.includes("canon log 2") || text.includes("clog2")) return "canon_log2";
  if (text.includes("v-log") || text.includes("vlog")) return "panasonic_vlog";
  if (text.includes("log3g10")) return "red_log3g10";
  if (text.includes("blackmagic") || text.includes("bmd film")) return "bmd_film_gen5";
  if (text.includes("apple log")) return "apple_log";
  if (text.includes("d-log") || text.includes("dlog")) return "dji_dlog";
  if (text.includes("arib-std-b67") || text.includes("hlg")) return "hlg";
  if (text.includes("smpte2084") || text.includes("pq")) return "pq";
  if (text.includes("log")) return "blocked_log";
  return "rec709";
}

function filterPath(path: string): string { return path.replaceAll("\\", "/").replace(":", "\\:").replaceAll("'", "\\'"); }

export function inputNormalizationFilters(asset: MediaAsset, management: ColorManagementSettings = DEFAULT_COLOR_MANAGEMENT, colorRoot?: string): string[] {
  if (management.mode === "aces2") {
    const input = resolveAcesInput(asset);
    if (input === "blocked_log") throw new Error(`素材「${asset.name}」是未解讀 Log；ACES 必須指定正確 Input Transform。`);
    if ((input === "hlg" || input === "pq") && resolveInputColorSpace(asset) !== input) {
      throw new Error(`素材「${asset.name}」的 ACES HDR Input Transform 與來源標記不一致。`);
    }
    const precisionBlock = acesPrecisionBlockReason(asset, management);
    if (precisionBlock) throw new Error(precisionBlock);
    if (!colorRoot) throw new Error("ACES 2.0 色彩資源未載入；不能用 Rec.709 假裝輸出。");
    const key = ACES_INPUT_FILES[input];
    if (!key) throw new Error(`ACES 不支援這個 Input Transform：${input}`);
    return ["format=gbrpf32le", `lut3d=file='${filterPath(`${colorRoot}/luts/input-${key}-to-acescct.cube`)}':interp=tetrahedral`];
  }
  const input = resolveInputColorSpace(asset);
  if (input === "blocked_log") throw new Error(`素材「${asset.name}」是未解讀 Log；請先在調色工作區指定正確 Input Transform。`);
  if (input === "linear_rec709") throw new Error(`素材「${asset.name}」是 scene-linear EXR；SDR Output Transform 尚未通過產品 gate，請先輸出 EXR。`);
  if (input === "pq") return [
    "zscale=t=linear:npl=100", "format=gbrpf32le", "tonemap=tonemap=hable:desat=0", "zscale=p=bt709:t=bt709:m=bt709:r=tv", "format=rgba",
  ];
  if (input === "hlg") return [
    HLG_DISPLAY_LINEAR_FILTER, "format=gbrpf32le", HLG_SDR_TONEMAP_FILTER, "zscale=p=bt709:t=bt709:m=bt709:r=tv", "format=rgba",
  ];
  return [];
}

export function acesOutputFilter(management: ColorManagementSettings = DEFAULT_COLOR_MANAGEMENT, colorRoot?: string): string | undefined {
  if (management.mode !== "aces2") return undefined;
  if (!colorRoot) throw new Error("ACES 2.0 Output Transform 資源未載入。");
  return `lut3d=file='${filterPath(`${colorRoot}/luts/output-acescct-to-${management.outputTransform}.cube`)}':interp=tetrahedral`;
}

export function primaryGradeFilters(color: ColorAdjustments): string[] {
  return [...primaryToneFilters(color),
    primaryExposureFilter(color.exposure),
    `eq=brightness=${n(color.brightness)}:contrast=${n(color.contrast)}:saturation=${n(color.saturation)}`,
    `hue=h=${n(color.hue)}`,
  ];
}

export function primaryExposureFilter(exposure: number): string {
  return `exposure=exposure=${n(clamp(exposure, -3, 3))}:black=0`;
}

export function primaryToneFilters(color: ColorAdjustments): string[] {
  const curve = monotonicPoints(color).map(([x, y]) => `${n(x)}/${n(y)}`).join(" ");
  const temperature = clamp(color.temperature, -1, 1) * 0.1;
  const tint = clamp(color.tint, -1, 1) * 0.08;
  const filters = [`curves=master='${curve}'`];
  // FFmpeg's preserve-lightness branch sets saturation to zero at RGB 0/1
  // endpoints, even for all-zero adjustments. It creates grey islands in HDR
  // camera footage after SDR normalization. Keep neutral balance a true no-op
  // and retain the existing RGB offsets without that discontinuous HSL branch.
  if (temperature !== 0 || tint !== 0) {
    filters.push(`colorbalance=rs=${n(temperature)}:gs=${n(tint)}:bs=${n(-temperature)}:rm=${n(temperature * 0.65)}:gm=${n(tint * 0.65)}:bm=${n(-temperature * 0.65)}:rh=${n(temperature * 0.35)}:gh=${n(tint * 0.35)}:bh=${n(-temperature * 0.35)}:pl=0`);
  }
  return filters;
}

export function gradeRgb(r: number, g: number, b: number, color: ColorAdjustments): [number, number, number] {
  const points = monotonicPoints(color);
  const curve = (value: number) => {
    const normalized = clamp(value / 255, 0, 1);
    const next = points.findIndex(([x]) => x >= normalized);
    if (next < 0) return points.at(-1)![1];
    if (next === 0) return points[0][1];
    const [x0, y0] = points[next - 1];
    const [x1, y1] = points[next];
    return y0 + (y1 - y0) * ((normalized - x0) / Math.max(0.0001, x1 - x0));
  };
  let channels = [curve(r), curve(g), curve(b)];
  const exposure = 2 ** clamp(color.exposure, -3, 3);
  channels = channels.map((value) => clamp(((value - color.pivot) * color.contrast + color.pivot) * exposure + color.brightness, 0, 1));
  channels[0] = clamp(channels[0] + color.temperature * 0.055, 0, 1);
  channels[1] = clamp(channels[1] + color.tint * 0.045, 0, 1);
  channels[2] = clamp(channels[2] - color.temperature * 0.055, 0, 1);
  const luma = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  channels = channels.map((value) => clamp(luma + (value - luma) * color.saturation, 0, 1));
  return channels.map((value) => Math.round(value * 255)) as [number, number, number];
}
