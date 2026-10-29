import { styleTemplateRenderInputSchemaV1, type StyleTemplateRenderInputV1 } from "../application/engineTaskContractV1";
import type { MediaAsset } from "../domain/types";
import type { StyleTemplateRenderRequestV1, StyleTemplateRenderedV1 } from "../styleTemplates/slots/renderHost";
import type { EngineTaskApiV1 } from "./engineTaskHostV1";

/**
 * The desktop side of the 「模板片段」 inspector (styleTemplates/slots/renderHost.ts): re-render through the engine task
 * `style_template_render_v1`, the native picture chooser, and webview URLs for project pictures. Browser-safe; the Tauri
 * bridge supplies `convertFileSrc` and the picker call, tests supply fakes.
 */

export interface StyleTemplateDesktopApiV1 {
  renderStyleTemplateV1(input: StyleTemplateRenderRequestV1 & { operationId: string },
    options: { signal: AbortSignal; onProgress?: (event: { phase: string; fraction: number }) => void }): Promise<StyleTemplateRenderedV1>;
  /** The native chooser (pictures only, one file): the picked file as a project image asset record, not yet in the project. */
  pickStyleTemplateImageV1(): Promise<MediaAsset | undefined>;
  /** A webview URL for a project picture on the local disk (focal-point picker thumbnails); undefined otherwise. */
  styleTemplateAssetUrlV1(asset: MediaAsset): string | undefined;
}

export interface StyleTemplateDesktopHostV1 {
  convertFileSrc(path: string): string;
  /** The native media chooser limited to pictures (pick_media with imageOnly). */
  pickImageFiles(): Promise<ReadonlyArray<{ asset: MediaAsset; previewPath: string }>>;
}

/**
 * Only what the render and the clip's rights need crosses IPC; the rest of the project asset (derivatives, proxies, colour
 * metadata) never reaches the engine. A composition or image sequence is not a picture source.
 */
export function styleTemplateEngineInputV1(request: StyleTemplateRenderRequestV1 & { operationId: string }): StyleTemplateRenderInputV1 {
  const assets = request.assets.map(asset => {
    if ((asset.kind !== "image" && asset.kind !== "video") || asset.compositionId !== undefined || asset.imageSequence !== undefined) {
      throw new Error(`STYLE_JOB_SLOT_ASSET_KIND: ${asset.id}`);
    }
    return {
      id: asset.id, name: asset.name.slice(0, 400), kind: asset.kind, uri: asset.uri, duration: asset.duration,
      ...(asset.width !== undefined ? { width: asset.width } : {}), ...(asset.height !== undefined ? { height: asset.height } : {}),
      ...(asset.license !== undefined ? { license: asset.license } : {}), ...(asset.redistributable !== undefined ? { redistributable: asset.redistributable } : {}),
      ...(asset.rightsBasis !== undefined ? { rightsBasis: asset.rightsBasis } : {}), ...(asset.distributionScope !== undefined ? { distributionScope: asset.distributionScope } : {}),
    };
  });
  return styleTemplateRenderInputSchemaV1.parse({ operationId: request.operationId, templateId: request.templateId, slots: request.slots,
    width: request.width, height: request.height, fps: request.fps, durationSeconds: request.durationSeconds, assets });
}

/** An absolute local file path (drive letter, or POSIX root); never a network, device or relative path. */
function localFilePath(uri: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(uri) || (uri.startsWith("/") && !uri.startsWith("//"));
}

export function createStyleTemplateDesktopApiV1(engineTasks: Pick<EngineTaskApiV1, "runStyleTemplateRenderTaskV1">, host: StyleTemplateDesktopHostV1): StyleTemplateDesktopApiV1 {
  return {
    async renderStyleTemplateV1(input, options) {
      const reply = await engineTasks.runStyleTemplateRenderTaskV1(styleTemplateEngineInputV1(input), { signal: options.signal,
        onProgress: event => options.onProgress?.({ phase: event.progress.stage, fraction: event.progress.fraction }) });
      const { field, asset } = reply.result;
      // The host admitted exactly this cache file into the webview's asset scope (engine_tasks_v1.rs).
      return { field, asset, previewUrls: { [asset.id]: host.convertFileSrc(asset.uri) } };
    },
    async pickStyleTemplateImageV1() {
      const picked = await host.pickImageFiles();
      if (!picked.length) return undefined;
      if (picked.length !== 1 || picked[0].asset.kind !== "image") throw new Error("STYLE_TEMPLATE_IMAGE_REQUIRED: choose one picture file");
      return picked[0].asset;
    },
    styleTemplateAssetUrlV1(asset) {
      return asset.kind === "image" && localFilePath(asset.uri) ? host.convertFileSrc(asset.uri) : undefined;
    },
  };
}
