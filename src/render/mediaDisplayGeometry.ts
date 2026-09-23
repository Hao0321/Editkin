import type { MediaProbe } from "./ffmpegContracts";

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

/**
 * Import/inspection alone reports upright geometry. probeMedia keeps its legacy
 * encoded-raster width/height for render callers. Never rotate original bytes.
 */
export function mediaProbeForDisplay(probe: MediaProbe): MediaProbe {
  if (!probe.hasVideo) return probe;
  const width = probe.encodedWidth ?? probe.width, height = probe.encodedHeight ?? probe.height;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width! <= 0 || height! <= 0) {
    throw new Error("影片缺少有效的編碼尺寸；無法安全判定展示尺寸。");
  }
  const rawRotation = probe.displayRotationDegrees === undefined ? 0 : finiteRotation(probe.displayRotationDegrees);
  const normalized = ((rawRotation % 360) + 360) % 360;
  const nearestQuarterTurn = Math.round(normalized / 90);
  // FFprobe display matrices use fixed point; allow only its tiny rounding noise,
  // not arbitrary-angle crop/scale guesses or a silent landscape fallback.
  if (Math.abs(normalized - nearestQuarterTurn * 90) > 0.001) {
    throw new Error(`素材展示旋轉 ${rawRotation}° 尚未支援；請先轉為標準直式／橫式方向。`);
  }
  const swapped = nearestQuarterTurn % 2 === 1;
  return { ...probe, encodedWidth: width, encodedHeight: height, width: swapped ? height : width, height: swapped ? width : height };
}
