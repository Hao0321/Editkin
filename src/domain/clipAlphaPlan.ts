import type {
  ChromaKeySettings,
  ClipMask,
  EditProject,
  MaskCombineMode,
  MaskPathPoint,
  MaskShapeKind,
  MotionTrackPoint,
  RotoMatteSequence,
  TimelineClip,
} from "./types";

export interface RationalRate {
  numerator: number;
  denominator: number;
}

export interface ClipAlphaPathSample {
  time: number;
  points?: readonly MaskPathPoint[];
}

interface ClipAlphaOperationBase {
  maskId: string;
  authoredIndex: number;
  mode: MaskCombineMode;
  inverted: boolean;
  opacity: number;
}

export interface ClipAlphaVectorOperation extends ClipAlphaOperationBase {
  source: "vector";
  kind: MaskShapeKind;
  feather: number;
  expansion: number;
  edgeShift: number;
  path: readonly MaskPathPoint[];
  samples: readonly ClipAlphaPathSample[];
}

export interface ClipAlphaPixelMatteOperation extends ClipAlphaOperationBase {
  source: "pixel_matte";
  /** Auto Roto edge controls are baked into the verified alpha8 sequence. */
  refinementBaked: true;
  matte: {
    sequence: RotoMatteSequence;
    previewUris: readonly string[];
    sampleRate: RationalRate;
  };
}

export type ClipAlphaOperation = ClipAlphaVectorOperation | ClipAlphaPixelMatteOperation;

export interface ClipAlphaPlan {
  schema: "editkin.clip-alpha-plan/v1";
  clipId: string;
  /** Enabled masks in the exact order authored in TimelineClip.masks. */
  operations: readonly ClipAlphaOperation[];
  /** Enabled keyer snapshot; formal alpha consumers must not reread mutable clip state. */
  keyer?: ChromaKeySettings;
  sampleRule: {
    clock: "clip-local";
    rounding: "floor";
    projectRate: RationalRate;
  };
}

export type ClipAlphaPlanErrorCode =
  | "first-mask-must-add"
  | "multiple-pixel-mattes"
  | "pixel-matte-stale"
  | "pixel-matte-preview-missing"
  | "pixel-matte-not-frozen"
  | "pixel-matte-invalid"
  | "invalid-project-rate"
  | "invalid-vector-track";

export class ClipAlphaPlanError extends Error {
  override readonly name = "ClipAlphaPlanError";

  constructor(
    readonly code: ClipAlphaPlanErrorCode,
    readonly clipId: string,
    readonly maskId: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

function gcd(left: number, right: number): number {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b > 0) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a || 1;
}

/** Deterministic bounded continued-fraction conversion, including NTSC rates. */
export function rationalRate(value: number, maximumDenominator = 100_000): RationalRate {
  if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(maximumDenominator) || maximumDenominator < 1) {
    throw new Error("取樣率必須是有限正數，且最大分母必須是正整數");
  }
  let remainder = value;
  let previousNumerator = 0;
  let numerator = 1;
  let previousDenominator = 1;
  let denominator = 0;
  while (true) {
    const integer = Math.floor(remainder);
    const nextNumerator = integer * numerator + previousNumerator;
    const nextDenominator = integer * denominator + previousDenominator;
    if (!Number.isSafeInteger(nextNumerator) || nextDenominator > maximumDenominator) break;
    previousNumerator = numerator;
    numerator = nextNumerator;
    previousDenominator = denominator;
    denominator = nextDenominator;
    const fraction = remainder - integer;
    if (fraction <= Number.EPSILON) break;
    remainder = 1 / fraction;
  }
  const divisor = gcd(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}

function clonePoints(points: readonly MaskPathPoint[]): MaskPathPoint[] {
  return points.map((point) => ({ id: point.id, x: point.x, y: point.y }));
}

function trackPath(point: MotionTrackPoint): MaskPathPoint[] {
  if (point.quad?.length === 4) {
    return point.quad.map((corner, index) => ({ id: `tracked-${index}`, x: corner.x, y: corner.y }));
  }
  const { x, y, width, height } = point.rect;
  return [
    { id: "p1", x, y },
    { id: "p2", x: x + width, y },
    { id: "p3", x: x + width, y: y + height },
    { id: "p4", x, y: y + height },
  ];
}

function vectorSamples(project: EditProject, clip: TimelineClip, mask: ClipMask): ClipAlphaPathSample[] {
  if (mask.trackId) {
    const track = project.motionTracks.find((candidate) => candidate.id === mask.trackId && candidate.clipId === clip.id);
    if (!track) {
      throw new ClipAlphaPlanError("invalid-vector-track", clip.id, mask.id, `遮罩 ${mask.id} 的追蹤資料不存在，已阻擋正式輸出`);
    }
    return track.points.map((point) => ({
      time: point.time,
      ...(point.status === "lost" ? {} : { points: trackPath(point) }),
    }));
  }
  return mask.keyframes.map((keyframe) => ({
    time: keyframe.time,
    ...(keyframe.status === "lost" ? {} : { points: clonePoints(keyframe.points) }),
  }));
}

function compileVectorOperation(project: EditProject, clip: TimelineClip, mask: ClipMask, authoredIndex: number): ClipAlphaVectorOperation {
  return {
    source: "vector",
    maskId: mask.id,
    authoredIndex,
    mode: mask.mode,
    inverted: mask.inverted,
    opacity: mask.opacity,
    kind: mask.kind,
    feather: mask.feather,
    expansion: mask.expansion,
    edgeShift: mask.refine.edgeShift,
    path: clonePoints(mask.path),
    samples: vectorSamples(project, clip, mask),
  };
}

function compilePixelMatteOperation(
  clip: TimelineClip,
  mask: ClipMask,
  authoredIndex: number,
  purpose: "preview" | "formal",
): ClipAlphaPixelMatteOperation {
  const matte = mask.matteSequence;
  if (!matte) {
    throw new ClipAlphaPlanError("pixel-matte-invalid", clip.id, mask.id, `遮罩 ${mask.id} 保留了凍結狀態但缺少逐像素 Matte；不得退化成主體橢圓`);
  }
  if (matte.stale) {
    throw new ClipAlphaPlanError("pixel-matte-stale", clip.id, mask.id, `遮罩 ${mask.id} 的 Auto Roto Matte 已過期；請重新分析或停用遮罩`);
  }
  if ((matte as { frozen?: unknown }).frozen !== true) {
    throw new ClipAlphaPlanError("pixel-matte-not-frozen", clip.id, mask.id, `遮罩 ${mask.id} 的 Auto Roto Matte 尚未凍結，已阻擋正式輸出`);
  }
  const candidate = purpose === "formal" ? matte.frameArtifactUris : matte.framePreviewUris;
  const previews = candidate && candidate.length === matte.frameCount && candidate.every((uri) => uri.trim())
    ? candidate
    : undefined;
  if (!previews) {
    throw new ClipAlphaPlanError("pixel-matte-preview-missing", clip.id, mask.id, purpose === "formal"
      ? `遮罩 ${mask.id} 缺少完整逐幀 artifact inventory，已阻擋正式輸出`
      : `遮罩 ${mask.id} 缺少經 Desktop 驗證的逐幀預覽，已阻擋 UI 預覽`);
  }
  if (mask.kind !== "subject" || !Number.isInteger(matte.width) || matte.width < 1 || !Number.isInteger(matte.height) || matte.height < 1
    || !Number.isInteger(matte.frameCount) || matte.frameCount < 1 || !Number.isFinite(matte.analysisFps) || matte.analysisFps <= 0
    || !matte.sequenceUri.trim() || !matte.manifestUri.trim()) {
    throw new ClipAlphaPlanError("pixel-matte-invalid", clip.id, mask.id, `遮罩 ${mask.id} 的逐像素 Matte 合約不完整，已阻擋正式輸出`);
  }
  return {
    source: "pixel_matte",
    maskId: mask.id,
    authoredIndex,
    mode: mask.mode,
    inverted: mask.inverted,
    opacity: mask.opacity,
    refinementBaked: true,
    matte: {
      sequence: structuredClone(matte),
      previewUris: [...previews],
      sampleRate: rationalRate(matte.analysisFps),
    },
  };
}

/**
 * Compiles the sole executable mask-stack contract. It never repairs or reorders
 * authored state: an unsafe project fails closed before any renderer sees it.
 */
export function compileClipAlphaPlan(
  project: EditProject,
  clip: TimelineClip,
  purpose: "preview" | "formal" = "preview",
): ClipAlphaPlan {
  let projectRate: RationalRate;
  try {
    projectRate = rationalRate(project.fps);
  } catch {
    throw new ClipAlphaPlanError("invalid-project-rate", clip.id, undefined, `片段 ${clip.id} 的專案取樣率無效`);
  }
  const enabled = (clip.masks ?? [])
    .map((mask, authoredIndex) => ({ mask, authoredIndex }))
    .filter(({ mask }) => mask.enabled);
  if (enabled.length > 0 && enabled[0].mask.mode !== "add") {
    throw new ClipAlphaPlanError("first-mask-must-add", clip.id, enabled[0].mask.id, `片段 ${clip.id} 的第一個啟用遮罩必須使用 add`);
  }
  const isPixelMatteCandidate = (mask: ClipMask) => mask.matteSequence !== undefined || mask.frozenRange !== undefined;
  const pixelMattes = enabled.filter(({ mask }) => isPixelMatteCandidate(mask));
  if (pixelMattes.length > 1) {
    throw new ClipAlphaPlanError("multiple-pixel-mattes", clip.id, pixelMattes[1].mask.id, `片段 ${clip.id} 目前最多只能有一個啟用的逐像素 Matte`);
  }
  const operations = enabled.map(({ mask, authoredIndex }) => isPixelMatteCandidate(mask)
    ? compilePixelMatteOperation(clip, mask, authoredIndex, purpose)
    : compileVectorOperation(project, clip, mask, authoredIndex));
  return {
    schema: "editkin.clip-alpha-plan/v1",
    clipId: clip.id,
    operations,
    ...(clip.chromaKey?.enabled ? { keyer: { ...clip.chromaKey } } : {}),
    sampleRule: { clock: "clip-local", rounding: "floor", projectRate },
  };
}

export function pixelMatteOperation(plan: ClipAlphaPlan): ClipAlphaPixelMatteOperation | undefined {
  return plan.operations.find((operation): operation is ClipAlphaPixelMatteOperation => operation.source === "pixel_matte");
}

/** Snap numerical noise at frame boundaries, but floor arbitrary scrub positions. */
export function clipLocalProjectFrame(plan: ClipAlphaPlan, localTime: number): number {
  return localProjectFrameAtTime(plan.sampleRule.projectRate, localTime);
}

/** Shared by playback and the brush editor; arbitrary scrubs still floor. */
export function localProjectFrameAtTime(rate: RationalRate, localTime: number): number {
  if (!Number.isFinite(localTime)) throw new Error("Alpha 預覽時間必須是有限數值");
  const frame = Math.max(0, localTime) * rate.numerator / rate.denominator;
  const nearest = Math.round(frame);
  const stable = Math.abs(frame - nearest) <= 1e-7 ? nearest : Math.floor(frame);
  if (!Number.isSafeInteger(stable)) throw new Error("Alpha 預覽 frame 超出安全整數範圍");
  return stable;
}

/** Exact floor selection for a clip-local project frame; no float boundary rounding. */
export function floorClipAlphaSampleIndex(plan: ClipAlphaPlan, localProjectFrame: number): number | undefined {
  const pixel = pixelMatteOperation(plan);
  if (!pixel) return undefined;
  return floorFrameRateSampleIndex(localProjectFrame, plan.sampleRule.projectRate, pixel.matte.sampleRate, pixel.matte.sequence.frameCount);
}

/** Clock conversion only; does not assert that any pixel artifact is valid. */
export function floorFrameRateSampleIndex(localProjectFrame: number, projectRate: RationalRate, sampleRate: RationalRate, frameCount: number): number {
  if (!Number.isSafeInteger(localProjectFrame) || localProjectFrame < 0) throw new Error("片段本地 frame 必須是非負安全整數");
  if (![projectRate.numerator, projectRate.denominator, sampleRate.numerator, sampleRate.denominator, frameCount]
    .every(value => Number.isSafeInteger(value) && value > 0)) throw new Error("取樣時鐘與影格數必須是正安全整數");
  const numerator = BigInt(localProjectFrame) * BigInt(sampleRate.numerator) * BigInt(projectRate.denominator);
  const denominator = BigInt(sampleRate.denominator) * BigInt(projectRate.numerator);
  const index = Number(numerator / denominator);
  return Math.max(0, Math.min(frameCount - 1, index));
}

export function ffmpegRationalRate(rate: RationalRate): string {
  return `${rate.numerator}/${rate.denominator}`;
}
