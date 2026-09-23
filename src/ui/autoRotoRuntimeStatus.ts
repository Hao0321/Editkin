import {
  PRODUCT_AUTO_ROTO_ENGINE,
  PRODUCT_AUTO_ROTO_MAX_ALPHA_BYTES,
  PRODUCT_AUTO_ROTO_MAX_FRAMES,
  productAutoRotoRouteReceiptShapeSchema,
} from "../domain/autoRotoProductReceipt";

export type AutoRotoRuntimeState = "activated_current" | "candidate_diagnostic" | "unavailable";

export interface AutoRotoRuntimeStatus {
  state: AutoRotoRuntimeState;
  canInvoke: boolean;
  badge: string;
  title: string;
  detail: string;
  receipt?: {
    engine: typeof PRODUCT_AUTO_ROTO_ENGINE;
    routeReceiptSha256: string;
    sequenceSha256: string;
    sequenceBytes: number;
    frameCount: number;
    qualityState: "diagnostic";
  };
}

const SHA256 = /^[a-f0-9]{64}$/;

export function initialAutoRotoRuntimeStatus(analyze: unknown): AutoRotoRuntimeStatus {
  if (typeof analyze !== "function") {
    return {
      state: "unavailable",
      canInvoke: false,
      badge: "目前不可用",
      title: "Auto Roto Runtime 未連上",
      detail: "這個執行環境沒有 Auto Roto 呼叫入口。請使用含相符原生 Runtime 的 Editkin 桌面版。",
    };
  }
  return {
    state: "candidate_diagnostic",
    canInvoke: true,
    badge: "待執行驗證",
    title: "Auto Roto 呼叫入口已偵測",
    detail: "尚未收到目前 Runtime 的 hash receipt；候選檔、測試報告或舊專案都不算目前已啟用。第一次成功分析後才會更新狀態。",
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * Promotes the UI to `activated_current` only from a receipt returned by the
 * runtime used for the current analysis. Build candidates and persisted UI
 * flags cannot call this path without the bounded artifact receipt.
 */
export function autoRotoRuntimeStatusFromReceipt(value: unknown): AutoRotoRuntimeStatus {
  const result = record(value);
  const route = productAutoRotoRouteReceiptShapeSchema.safeParse(result?.routeReceipt);
  const routing = record(result?.regionMemoryRouting);
  const refinement = record(result?.alphaRefinement);
  const frames = Array.isArray(result?.frames) ? result.frames : [];
  const width = result?.width;
  const height = result?.height;
  const sequenceBytes = result?.sequenceBytes;
  const sequenceSha256 = result?.sequenceSha256;
  const manifestPath = result?.manifestPath;
  const validFrames = frames.length >= 1 && frames.length <= PRODUCT_AUTO_ROTO_MAX_FRAMES
    && frames.every((item, index) => {
      const frame = record(item);
      return frame?.frame === index
        && typeof frame.alphaPath === "string" && frame.alphaPath.length > 0
        && typeof frame.previewSha256 === "string" && SHA256.test(frame.previewSha256)
        && typeof frame.alphaFrameSha256 === "string" && SHA256.test(frame.alphaFrameSha256);
    });
  const validDimensions = Number.isInteger(width) && Number.isInteger(height)
    && Number(width) >= 16 && Number(height) >= 16
    && Number(width) <= 32_768 && Number(height) <= 32_768;
  const expectedSequenceBytes = validDimensions ? Number(width) * Number(height) * frames.length : 0;
  const valid = result?.schema === "editkin.auto-roto-matte/v1"
    && result.engine === PRODUCT_AUTO_ROTO_ENGINE
    && result.frozen === true
    && result.qualityState === "diagnostic"
    && route.success
    && route.data.quality.state === "diagnostic"
    && route.data.quality.claim === "unmeasured"
    && route.data.quality.humanReviewRequired === true
    && validFrames
    && validDimensions
    && Number.isSafeInteger(sequenceBytes)
    && sequenceBytes === expectedSequenceBytes
    && Number(sequenceBytes) > 0
    && Number(sequenceBytes) <= PRODUCT_AUTO_ROTO_MAX_ALPHA_BYTES
    && typeof sequenceSha256 === "string" && SHA256.test(sequenceSha256)
    && typeof manifestPath === "string" && manifestPath.length > 0
    && routing?.schema === "editkin.region-memory-routing/v1"
    && routing.requested === "fixed_baseline"
    && routing.executed === "fixed_baseline"
    && routing.candidateAttempted === false
    && routing.deterministicFallback === false
    && refinement?.schema === "editkin.optical-alpha-refinement-aggregate/v1"
    && refinement.engine === "editkin-self-authored-optical-alpha-refiner/v1"
    && refinement.appliedFrames === frames.length;

  if (!valid || !route.success || typeof sequenceSha256 !== "string" || typeof sequenceBytes !== "number") {
    throw new Error("Auto Roto Runtime 回傳的 activation receipt 不完整；介面拒絕標示為目前已執行。");
  }

  return {
    state: "activated_current",
    canInvoke: true,
    badge: "目前 Runtime 已驗證",
    title: "Auto Roto 已在本次工作階段執行",
    detail: `已收到 ${frames.length} 格、hash 綁定的本機執行 receipt。品質仍是 diagnostic，必須人工檢查；這不代表品質已通過。`,
    receipt: {
      engine: PRODUCT_AUTO_ROTO_ENGINE,
      routeReceiptSha256: route.data.receiptSha256,
      sequenceSha256,
      sequenceBytes,
      frameCount: frames.length,
      qualityState: "diagnostic",
    },
  };
}
