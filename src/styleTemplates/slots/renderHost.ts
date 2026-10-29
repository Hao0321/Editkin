import type { StyleJobClipV1, StyleSlotValuesV1 } from "../../domain/styleJobFieldsV1";
import type { MediaAsset } from "../../domain/types";

/**
 * How the GUI re-renders a template clip after a slot change (browser-safe). The renderer is Node-only
 * (renderTemplateClip.ts), so the desktop app runs it as an engine task beside the Motion Library one and answers with the
 * `styleJob` field, the cache asset and a webview URL for it. A browser has no native render: the inspector still edits
 * and validates every slot, and says plainly that applying needs the desktop app.
 *
 * Hook (not in this file's ownership): the desktop bridge exposes `renderStyleTemplateV1` (engine task kind
 * `style_template_render_v1`, handler styleTemplates/slots/engineTask.ts) and optionally `pickStyleTemplateImageV1`
 * (the native image chooser) and `styleTemplateAssetUrlV1` (webview URL of a project asset). Until it does, the desktop
 * host is absent and the inspector shows STYLE_TEMPLATE_NATIVE_REQUIRED_V1.
 */

export interface StyleTemplateRenderRequestV1 {
  readonly templateId: string;
  readonly slots: StyleSlotValuesV1;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly durationSeconds: number;
  /** The project assets the picture slots name (an imported file included). */
  readonly assets: readonly MediaAsset[];
}

export interface StyleTemplateRenderedV1 {
  readonly field: StyleJobClipV1;
  readonly asset: MediaAsset;
  /** Webview URLs for the rendered file, by asset id (empty where nothing can be played). */
  readonly previewUrls: Readonly<Record<string, string>>;
}

export interface StyleTemplateRenderHostV1 {
  render(request: StyleTemplateRenderRequestV1, options: { signal: AbortSignal; onProgress(progress: { readonly phase: string; readonly fraction: number }): void }): Promise<StyleTemplateRenderedV1>;
  /** The native image chooser: imports one picture file as a project image asset record (not yet in the project). */
  pickImageFile?(): Promise<MediaAsset | undefined>;
  /** A displayable URL for a project asset (picture thumbnails in the focal-point picker). */
  assetUrl?(asset: MediaAsset): string | undefined;
}

export const STYLE_TEMPLATE_NATIVE_REQUIRED_V1 = "這裡可以改字、改色、換圖；重新產生模板片段需要 Editkin 桌面版的渲染引擎。";
export const STYLE_TEMPLATE_CANCELLED_V1 = "STYLE_TEMPLATE_RENDER_CANCELLED";

let override: StyleTemplateRenderHostV1 | undefined;

/** Tests (and a developer's console in the browser preview) can supply a host; production never sets one. */
export function setStyleTemplateRenderHostOverrideV1(host: StyleTemplateRenderHostV1 | undefined): void {
  override = host;
}

interface DesktopStyleTemplateApiV1 {
  renderStyleTemplateV1?: (input: StyleTemplateRenderRequestV1 & { operationId: string },
    options: { signal: AbortSignal; onProgress?: (event: { phase: string; fraction: number }) => void }) => Promise<StyleTemplateRenderedV1>;
  pickStyleTemplateImageV1?: () => Promise<MediaAsset | undefined>;
  styleTemplateAssetUrlV1?: (asset: MediaAsset) => string | undefined;
}

export function desktopStyleTemplateRenderHostV1(api: DesktopStyleTemplateApiV1 | undefined): StyleTemplateRenderHostV1 | undefined {
  const render = api?.renderStyleTemplateV1;
  if (!render) return undefined;
  return {
    async render(request, options) {
      const operationId = `style-template-${crypto.randomUUID()}`;
      try {
        const result = await render.call(api, { ...request, operationId }, { signal: options.signal, onProgress: event => options.onProgress(event) });
        if (result.field.template.id !== request.templateId || result.asset.width !== request.width || result.asset.height !== request.height) throw new Error("STYLE_TEMPLATE_RENDER_BINDING_CHANGED");
        return result;
      } catch (error) {
        if (options.signal.aborted) throw new Error(STYLE_TEMPLATE_CANCELLED_V1);
        throw error instanceof Error ? error : new Error(String(error));
      }
    },
    ...(api?.pickStyleTemplateImageV1 ? { pickImageFile: () => api.pickStyleTemplateImageV1!() } : {}),
    ...(api?.styleTemplateAssetUrlV1 ? { assetUrl: (asset: MediaAsset) => api.styleTemplateAssetUrlV1!(asset) } : {}),
  };
}

/** The host for this runtime: a test/dev override, else the desktop bridge (once wired), else none (browser). */
export function resolveStyleTemplateRenderHostV1(): StyleTemplateRenderHostV1 | undefined {
  if (override) return override;
  return typeof window === "undefined" ? undefined : desktopStyleTemplateRenderHostV1((window as unknown as { haoDesktop?: DesktopStyleTemplateApiV1 }).haoDesktop);
}
