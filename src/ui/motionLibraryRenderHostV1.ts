import type { MotionLibraryRenderResultV1 } from "../application/engineTaskContractV1";
import type { HaoDesktopApi } from "../desktop/types";
import type { MediaAsset } from "../domain/types";

/**
 * How the Motion Library GUI renders an item before it dispatches a command (PHASE3_INTEGRATION_DESIGN §2–3): the
 * desktop engine task `motion_library_render_v1` renders into the project media cache and answers with the asset
 * records. A browser has no native render: the GUI still browses, thumbnails and live-previews every item, and says
 * plainly that adding needs the desktop app.
 */

export interface MotionLibraryRenderRequestV1 {
  readonly itemId: string;
  /** Caller input (partial params); the host resolves it against the item's defaults. */
  readonly params: Readonly<Record<string, unknown>>;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
}

export interface MotionLibraryRenderedV1 {
  readonly itemId: string;
  readonly kind: "text" | "transition" | "background";
  readonly itemRevision: number;
  readonly engineVersion: string;
  readonly cacheKey: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly frameCount: number;
  readonly durationSeconds: number;
  readonly assets: { readonly clip?: MediaAsset; readonly matte?: MediaAsset; readonly overlay?: MediaAsset };
  /** Webview URLs for the rendered files, by asset id (empty when nothing can be played in this runtime). */
  readonly previewUrls: Readonly<Record<string, string>>;
}

export interface MotionLibraryRenderProgressV1 {
  readonly phase: string;
  /** 0–1 across the whole render. */
  readonly fraction: number;
}

export interface MotionLibraryRenderHostV1 {
  render(request: MotionLibraryRenderRequestV1, options: { signal: AbortSignal; onProgress(progress: MotionLibraryRenderProgressV1): void }): Promise<MotionLibraryRenderedV1>;
}

export const MOTION_LIBRARY_NATIVE_REQUIRED_V1 = "瀏覽器只能瀏覽與預覽動態素材；要加入時間軸，請用 Editkin 桌面版（需要本機渲染引擎）。";
export const MOTION_LIBRARY_ENGINE_OUTDATED_V1 = "這個桌面版的渲染引擎還不支援動態素材，請更新 Editkin 後再加入。";
export const MOTION_LIBRARY_CANCELLED_V1 = "MOTION_LIBRARY_RENDER_CANCELLED";

/** Weight of each render phase in the overall fraction (generation dominates; encode and verify are short). */
const PHASES: Readonly<Record<string, readonly [number, number]>> = {
  cache: [0, 0.04], generate: [0.04, 0.78], encode: [0.78, 0.94], verify: [0.94, 0.99], done: [1, 1],
};

export function motionLibraryProgressFractionV1(stage: string, completed: number, total: number): number {
  const [from, to] = PHASES[stage] ?? [0, 1];
  const local = total > 0 ? Math.max(0, Math.min(1, completed / total)) : 0;
  return from + (to - from) * local;
}

let override: MotionLibraryRenderHostV1 | undefined;

/** Tests (and a developer's console in the browser preview) can supply a host; production never sets one. */
export function setMotionLibraryRenderHostOverrideV1(host: MotionLibraryRenderHostV1 | undefined): void {
  override = host;
}
// Development builds let a browser-preview check install a stand-in host from the console (production never reads this).
if (import.meta.env?.DEV) (globalThis as { __editkinMotionLibraryHost?: unknown }).__editkinMotionLibraryHost = setMotionLibraryRenderHostOverrideV1;

export function desktopMotionLibraryRenderHostV1(api: Pick<HaoDesktopApi, "renderMotionLibraryV1"> | undefined): MotionLibraryRenderHostV1 | undefined {
  const render = api?.renderMotionLibraryV1;
  if (!render) return undefined;
  return {
    async render(request, options) {
      const operationId = `motion-library-${crypto.randomUUID()}`;
      let result: MotionLibraryRenderResultV1 & { previewUrls: Record<string, string> };
      try {
        result = await render.call(api, { operationId, itemId: request.itemId, params: { ...request.params }, width: request.width, height: request.height, fps: request.fps }, {
          signal: options.signal,
          onProgress: event => options.onProgress({ phase: event.progress.stage,
            fraction: motionLibraryProgressFractionV1(event.progress.stage, event.progress.completed, event.progress.total) }),
        });
      } catch (error) {
        if (options.signal.aborted) throw new Error(MOTION_LIBRARY_CANCELLED_V1);
        const message = error instanceof Error ? error.message : String(error);
        if (/ENGINE_TASK_KIND_UNSUPPORTED/.test(message)) throw new Error(MOTION_LIBRARY_ENGINE_OUTDATED_V1);
        if (/ENGINE_TASK_CANCELLED/.test(message)) throw new Error(MOTION_LIBRARY_CANCELLED_V1);
        throw error instanceof Error ? error : new Error(message);
      }
      if (result.itemId !== request.itemId || result.width !== request.width || result.height !== request.height) throw new Error("MOTION_LIBRARY_RENDER_BINDING_CHANGED");
      return { itemId: result.itemId, kind: result.kind, itemRevision: result.itemRevision, engineVersion: result.engineVersion, cacheKey: result.cacheKey,
        params: result.params, frameCount: result.frameCount, durationSeconds: result.durationSeconds, assets: result.assets, previewUrls: result.previewUrls ?? {} };
    },
  };
}

/** The host for this runtime: a test/dev override, else the desktop bridge, else none (browser). */
export function resolveMotionLibraryRenderHostV1(): MotionLibraryRenderHostV1 | undefined {
  if (override) return override;
  return typeof window === "undefined" ? undefined : desktopMotionLibraryRenderHostV1(window.haoDesktop);
}
