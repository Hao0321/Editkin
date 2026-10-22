// LV-02 (decision Q-L1: every render, SHORT and LONG): formal output decodes ORIGINAL media only.
// Preview derivatives (the 540p proxy and the 216p/15 fps overlay proxy) stay on the saved project for
// preview. The formal export clone drops them before the resident graph is built, and the built graph is
// re-checked so a later builder change cannot silently bind a preview file again.
import type { EditProject, MediaDerivatives } from "../domain/types";
import { nativeMediaPath, type GpuEngineVideoPreviewGraph } from "./gpuCompositorAdmission";

export const FORMAL_RENDER_PROXY_REFUSED = "FORMAL_RENDER_PROXY_REFUSED" as const;

/** Every preview-only decode field of {@link MediaDerivatives}. Thumbnail, waveform and source identity are never decoded by formal output. */
export const PREVIEW_PROXY_DERIVATIVE_FIELDS_V1 = [
  "proxyUri", "proxyWidth", "proxyHeight", "proxyColor", "proxyColorContract",
  "overlayProxyUri", "overlayProxyWidth", "overlayProxyHeight", "overlayProxyFrameRateNumerator", "overlayProxyFrameRateDenominator", "overlayProxyProfile",
] as const satisfies ReadonlyArray<keyof MediaDerivatives>;

/** A copy of `derivatives` without any preview proxy; the input object is not modified. */
export function formalExportDerivativesV1(derivatives: MediaDerivatives): MediaDerivatives {
  const copy: Partial<MediaDerivatives> = { ...derivatives };
  for (const field of PREVIEW_PROXY_DERIVATIVE_FIELDS_V1) delete copy[field];
  return copy as MediaDerivatives;
}

export class FormalRenderProxyRefusedError extends Error {
  readonly code = FORMAL_RENDER_PROXY_REFUSED;
  constructor(readonly assetId: string, readonly detail: string) {
    super(`${FORMAL_RENDER_PROXY_REFUSED}: 正式輸出只能解碼原始素材（${assetId}：${detail}）；預覽代理不可進入正式輸出。`);
    this.name = "FormalRenderProxyRefusedError";
  }
}

/**
 * Throws unless every video source the formal resident graph decodes is the original media of `exportProject`
 * (the export clone whose URIs were already resolved), at the asset's own dimensions.
 */
export function assertFormalOriginalBindingsV1(exportProject: EditProject,
  preview: Pick<GpuEngineVideoPreviewGraph, "assetBindings" | "decoderDimensions">): void {
  const assets = new Map(exportProject.assets.map(asset => [asset.id, asset] as const));
  for (const [assetId, decoder] of Object.entries(preview.decoderDimensions)) {
    const asset = assets.get(assetId);
    const original = asset?.kind === "video" && !asset.compositionId ? nativeMediaPath(asset.uri) : undefined;
    if (decoder.source !== "original") throw new FormalRenderProxyRefusedError(assetId, `decoder source ${decoder.source}`);
    if (!original || preview.assetBindings[assetId] !== original) throw new FormalRenderProxyRefusedError(assetId, "bound file is not the asset original");
    if (decoder.width !== asset!.width || decoder.height !== asset!.height) throw new FormalRenderProxyRefusedError(assetId, `decoder ${decoder.width}x${decoder.height} differs from the original`);
  }
  for (const assetId of Object.keys(preview.assetBindings)) {
    if (!(assetId in preview.decoderDimensions)) throw new FormalRenderProxyRefusedError(assetId, "binding without a declared decoder source");
  }
}
