import type { MediaProbe } from "./ffmpegContracts";
import type { MediaAsset } from "../domain/types";

export interface DisplayRotationStream {
  side_data_list?: Array<{ side_data_type?: string; rotation?: unknown }>;
  tags?: { rotate?: unknown };
}

function finiteRotation(value: unknown): number {
  if ((typeof value !== "number" && typeof value !== "string")
    || (typeof value === "string" && value.trim() === "") || !Number.isFinite(Number(value))) {
    throw new Error("素材展示旋轉資訊不合法；無法安全判定直式／橫式尺寸。");
  }
  return Number(value);
}

/** Preserve ffprobe's angle, rather than baking another rotation into the edit. */
export function mediaDisplayRotation(stream: DisplayRotationStream | undefined): number | undefined {
  const matrices = stream?.side_data_list?.filter(value => value.side_data_type === "Display Matrix") ?? [];
  if (matrices.length) {
    const rotations = matrices.map(value => finiteRotation(value.rotation));
    if (rotations.some(value => value !== rotations[0])) throw new Error("素材含有互相矛盾的展示旋轉資訊。");
    return rotations[0];
  }
  return stream?.tags?.rotate === undefined ? undefined : finiteRotation(stream.tags.rotate);
}

/** ffprobe's explicit unknown SAR is not evidence of square pixels. */
export function mediaSampleAspectRatio(value: unknown): number | undefined {
  if (value === undefined || value === "N/A" || value === "N:A" || value === "0:1") return undefined;
  if (typeof value !== "string" || !/^\d{1,16}:\d{1,16}$/.test(value)) throw new Error("素材 SAR 不合法");
  const [numerator, denominator] = value.split(":").map(Number);
  const ratio = numerator / denominator;
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)
    || numerator <= 0 || denominator <= 0 || !Number.isFinite(ratio) || ratio <= 0) throw new Error("素材 SAR 不合法");
  return ratio;
}

function quarterTurns(probe: MediaProbe): number {
  const raw = probe.displayRotationDegrees === undefined ? 0 : finiteRotation(probe.displayRotationDegrees);
  const normalized = ((raw % 360) + 360) % 360, nearest = Math.round(normalized / 90);
  if (Math.abs(normalized - nearest * 90) > .001) throw new Error(`素材展示旋轉 ${raw}° 尚未支援；請先轉為標準直式／橫式方向。`);
  return nearest;
}

function encodedDimensions(probe: MediaProbe): { width: number; height: number } {
  const width = probe.encodedWidth ?? probe.width, height = probe.encodedHeight ?? probe.height;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width! <= 0 || height! <= 0) {
    throw new Error("影片缺少有效的編碼尺寸；無法安全判定展示尺寸。");
  }
  return { width: width!, height: height! };
}

/** Only a known positive SAR produces a verified physical display ratio. */
export function mediaDisplayAspectRatio(probe: MediaProbe): number | undefined {
  if (!probe.hasVideo) return undefined;
  const { width, height } = encodedDimensions(probe), turns = quarterTurns(probe), sar = probe.sampleAspectRatio;
  if (sar === undefined) return undefined;
  if (!Number.isFinite(sar) || sar <= 0) throw new Error("素材 SAR 不合法");
  const raw = width / height * sar, ratio = turns % 2 ? 1 / raw : raw;
  if (!Number.isFinite(ratio) || ratio <= 0) throw new Error("素材展示比例不合法");
  return ratio;
}

/**
 * Import/inspection alone reports upright geometry. probeMedia keeps its legacy
 * encoded-raster width/height for render callers. Never rotate original bytes.
 */
export function mediaProbeForDisplay(probe: MediaProbe): MediaProbe {
  if (!probe.hasVideo) return probe;
  const { width, height } = encodedDimensions(probe), swapped = quarterTurns(probe) % 2 === 1;
  const ratio = mediaDisplayAspectRatio(probe);
  if (probe.displayAspectRatio !== undefined && (!Number.isFinite(probe.displayAspectRatio) || probe.displayAspectRatio <= 0
    || ratio === undefined || Math.abs(probe.displayAspectRatio / ratio - 1) > 1e-6)) throw new Error("素材展示比例與原始 probe 矛盾");
  return { ...probe, encodedWidth: width, encodedHeight: height, width: swapped ? height : width, height: swapped ? width : height,
    ...(ratio === undefined ? {} : { displayAspectRatio: ratio }) };
}

/** Export rechecks real bytes' probe against persisted upright geometry, never the canvas. */
export function assertMediaAssetDisplayGeometry(asset: Pick<MediaAsset, "width" | "height" | "displayAspectRatio">, probe: MediaProbe): { width: number; height: number } {
  if (!probe.hasVideo) throw new Error("浮空影片框缺少真實影片 geometry");
  const display = mediaProbeForDisplay(probe);
  if (!Number.isSafeInteger(asset.width) || !Number.isSafeInteger(asset.height) || asset.width! <= 0 || asset.height! <= 0
    || asset.width !== display.width || asset.height !== display.height) throw new Error("已保存素材展示尺寸與目前 probe 矛盾");
  const stored = asset.displayAspectRatio ?? asset.width! / asset.height!;
  if (!Number.isFinite(stored) || stored <= 0) throw new Error("已保存素材展示比例不合法");
  if (asset.displayAspectRatio !== undefined && display.displayAspectRatio === undefined) throw new Error("目前 probe 未提供已知 SAR，無法驗證保存的展示比例");
  if (display.displayAspectRatio !== undefined && Math.abs(stored / display.displayAspectRatio - 1) > 1e-6) {
    throw new Error("已保存素材展示比例與目前 probe 矛盾；請重新分析素材");
  }
  return asset.displayAspectRatio === undefined ? { width: asset.width!, height: asset.height! } : { width: stored, height: 1 };
}
