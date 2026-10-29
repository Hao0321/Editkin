import type { EditProject } from "../domain/types";
import { withRenderLifetime, assertRenderActive, renderLifetimeSignal, renderLifetimeRemainingMs } from "../render/renderLifetime";
import { createAutoReframeSparseV2 } from "./autoReframeSparseV2";
import { prepareAutoReframeSourceV1 } from "./autoReframeSourceV1";
import { prepareReframeReviewedMatteV1, type ReviewedReframeInputV1, type ReviewedReframeMatteOptionsV1 } from "./autoReframeReviewedMatteV1";
import type { MatteTrackRuntimeV1 } from "./matteTrackAnalysisV1";

/** Confirmed-v2 subject route for the existing sparse camera/source producer. The integrator
 * owns service/IPC/UI/apply; no new dispatcher or persisted project mutation is introduced. */
export async function prepareAutoReframeReviewedSourceV1(project: EditProject, input: ReviewedReframeInputV1,
  matte: ReviewedReframeMatteOptionsV1, requestedRuntime: Omit<Parameters<typeof prepareAutoReframeSourceV1>[2], "sparseCameraV2" | "reviewedMatteV1"> & {
    assetBase: string; onMatteProgress?: MatteTrackRuntimeV1["onProgress"];
  }) {
  const { assetBase, onMatteProgress, ...runtime } = { ...requestedRuntime }, timeoutMs = runtime.timeoutMs ?? 240000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 300000) throw Error("REFRAME_REVIEWED_TOTAL_BUDGET_INVALID");
  const sparseCameraV2 = createAutoReframeSparseV2(project, input);
  return withRenderLifetime({ signal: runtime.signal, timeoutMs }, async () => {
    const signal = renderLifetimeSignal(), budget = () => { assertRenderActive(); const remaining = renderLifetimeRemainingMs()!;
      if (remaining < 100) throw Error("REFRAME_REVIEWED_TOTAL_BUDGET_EXHAUSTED"); return remaining; };
    const reviewedMatteV1 = await prepareReframeReviewedMatteV1(project, input, matte, { assetBase },
      { signal, timeoutMs: budget(), onProgress: onMatteProgress });
    const result = await prepareAutoReframeSourceV1(project, input, { ...runtime, signal, timeoutMs: budget(), sparseCameraV2, reviewedMatteV1 });
    assertRenderActive();
    if (result.schema !== "editkin.auto-reframe-preparation/v2") throw Error("REFRAME_REVIEWED_SPARSE_PROTOCOL_CHANGED");
    return result;
  });
}
