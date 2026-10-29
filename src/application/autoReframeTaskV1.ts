import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type { EditProject } from "../domain/types";
import { canonicalJson } from "../shared/canonicalJson";
import { resolveMediaPath } from "../render/mediaProcess";
import { withRenderLifetime, assertRenderActive, fullDecodeTimeoutMs, renderLifetimeRemainingMs, renderLifetimeSignal } from "../render/renderLifetime";
import { prepareAutoReframeSparseSourceV2 } from "./autoReframeSparseSourceV2";
import { prepareAutoReframeReviewedSourceV1 } from "./autoReframeReviewedSourceV1";
import { autoReframeRequestSchemaV1, autoReframeTargetV1, type AutoReframeProgressV1, type AutoReframeReplyV1 } from "./autoReframeEditV1";
import { assertAutoReframeVideoV1 } from "./autoReframePortraitProjectV1";
import type { ReviewedReframeMatteOptionsV1 } from "./autoReframeReviewedMatteV1";
import { verifyRotoMatteTrustV1 } from "./rotoMatteTrustV1";

export interface AutoReframeTaskRuntimeV1 {
  assetBase: string; cacheRoot: string; productCacheRoot?: string; ffmpegPath: string; ffprobePath: string; signal?: AbortSignal; timeoutMs?: number;
  onProgress?(progress: AutoReframeProgressV1): void;
  resolveReviewedMatte?(confirmationSha256: string, source: { projectId: string; clipId: string; assetId: string; sourceSha256: string; sourceStart: number; duration: number; signal: AbortSignal }): Promise<ReviewedReframeMatteOptionsV1>;
}
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
/** Per-package Node task adapter for the one future shared engine-task owner. It resolves the
 * selected original, reuses existing source producers, and returns a draft; it never applies/writes. */
export async function analyzeAutoReframeTaskV1(project: EditProject, value: unknown, requestedRuntime: AutoReframeTaskRuntimeV1): Promise<AutoReframeReplyV1> {
  const request = autoReframeRequestSchemaV1.parse(value), runtime = Object.freeze({ ...requestedRuntime }), sourceJson = canonicalJson(project), source = structuredClone(project);
  const { clip, asset } = assertAutoReframeVideoV1(source, request.clipId);
  if (!isAbsolute(runtime.assetBase) || resolve(runtime.assetBase) !== runtime.assetBase) throw Error("AUTO_REFRAME_ABSOLUTE_ASSET_BASE_REQUIRED");
  if (source.id !== request.sourceProjectId || source.revision !== request.sourceRevision || hash(source) !== request.sourceProjectSha256
    || asset.derivatives?.sourceSha256 !== request.expectedSourceSha256) throw Error("AUTO_REFRAME_TASK_STALE");
  const target = autoReframeTargetV1(source, request).project;
  if (hash(target) !== request.targetProjectSha256) throw Error("AUTO_REFRAME_TARGET_BINDING_CHANGED");
  const sourcePath = resolve(resolveMediaPath(asset.uri, runtime.assetBase));
  let previousStage: AutoReframeProgressV1["stage"] | undefined, previousAt = -Infinity;
  const emit = (stage: AutoReframeProgressV1["stage"], completed: number, total: number) => {
    assertRenderActive(); const now = performance.now();
    if (stage !== previousStage || completed === total || now - previousAt >= 100) {
      previousStage = stage; previousAt = now; runtime.onProgress?.({ stage, completed, total }); assertRenderActive();
    }
  };
  return withRenderLifetime({ signal: runtime.signal, timeoutMs: runtime.timeoutMs ?? fullDecodeTimeoutMs(asset.duration), workSeconds: clip.duration }, async () => {
    emit("verify", 0, 1); const signal = renderLifetimeSignal(), total = Math.round(clip.duration * source.fps);
    const input = { clipId: clip.id, outputWidth: request.outputWidth, outputHeight: request.outputHeight, expectedSourceSha256: request.expectedSourceSha256 };
    const base = { sourcePath, cacheRoot: runtime.cacheRoot, productCacheRoot: runtime.productCacheRoot, ffmpegPath: runtime.ffmpegPath,
      ffprobePath: runtime.ffprobePath, signal, timeoutMs: renderLifetimeRemainingMs(), onFrame: async (frame: number) => { emit("source", frame + 1, total); } };
    let prepared;
    if (request.subject.kind === "confirmed-matte-v2") {
      if (!runtime.resolveReviewedMatte) throw Error("AUTO_REFRAME_REVIEWED_SUBJECT_UNAVAILABLE");
      const matte = await new Promise<ReviewedReframeMatteOptionsV1>((resolveMatte, reject) => {
        const stop = () => reject(signal!.reason); signal!.addEventListener("abort", stop, { once: true });
        Promise.resolve().then(() => { signal!.throwIfAborted(); return runtime.resolveReviewedMatte!(request.subject.kind === "confirmed-matte-v2" ? request.subject.confirmationSha256 : "", {
          projectId: source.id, clipId: clip.id, assetId: asset.id, sourceSha256: request.expectedSourceSha256, sourceStart: clip.sourceStart, duration: clip.duration, signal: signal! }); })
          .then(resolveMatte, reject).finally(() => signal!.removeEventListener("abort", stop));
      });
      assertRenderActive();
      if (canonicalJson(project) !== sourceJson) throw Error("AUTO_REFRAME_TASK_STALE");
      const confirmation = verifyRotoMatteTrustV1(matte.artifacts.trust, matte.artifacts.cutout.matteIdentity);
      if (createHash("sha256").update(JSON.stringify(confirmation)).digest("hex") !== request.subject.confirmationSha256)
        throw Error("AUTO_REFRAME_REVIEWED_SUBJECT_CHANGED");
      emit("verify", 1, 1);
      prepared = await prepareAutoReframeReviewedSourceV1(target, input, matte, { ...base, assetBase: runtime.assetBase,
        timeoutMs: Math.min(300000, renderLifetimeRemainingMs()!), onMatteProgress: p => emit("matte", p.completed, p.total) });
      const receipt = prepared.analysis.matte;
      if (!receipt || !("subjectConfirmationSha256" in receipt) || receipt.subjectConfirmationSha256 !== request.subject.confirmationSha256)
        throw Error("AUTO_REFRAME_REVIEWED_SUBJECT_CHANGED");
    } else { emit("verify", 1, 1); prepared = await prepareAutoReframeSparseSourceV2(target, input, base); }
    assertRenderActive();
    if (canonicalJson(project) !== sourceJson) throw Error("AUTO_REFRAME_TASK_STALE");
    if (prepared.projectSha256 !== request.targetProjectSha256 || prepared.sourceSha256 !== request.expectedSourceSha256) throw Error("AUTO_REFRAME_TARGET_BINDING_CHANGED");
    emit("finalize", 1, 1);
    return { schema: "editkin.auto-reframe-reply/v1", request, prepared };
  });
}
