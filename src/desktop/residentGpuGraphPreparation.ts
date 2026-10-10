import type { EditProject } from "../domain/types";
import { assertMotionPaintContract } from "../domain/motionPaint";
import { prepareNativeMotionPaint, type PreparedNativeMotionPaint } from "../motion/nativeMotionPaint";
import { acquireMotionFontDelivery, type MotionFontDeliveryLease, type MotionFontDeliveryOptions } from "../typography/motionFontDelivery";
import { motionFontSelection } from "../typography/motionFontReadiness";
import type { PreparedGlyphRun } from "../typography/preparedGlyphRun";
import { RetiredGpuPreview } from "./residentGpuPreviewGeneration";
import { prepareNativeFloatingVideoFrames, type PreparedNativeFloatingVideoFrames } from "../render/nativeFloatingVideoFrame";
import { buildGpuEnginePreviewGraph, buildGpuEngineVideoPreviewGraph, canPresentGpuVideoOnNativeSurface,
  type GpuEnginePreviewGraph } from "../render/gpuCompositor";

/** Compile/admit the full resident timeline once per immutable project revision.
 * These two builders use time only for timelineFrame, not graph membership. */
export function prepareResidentGpuGraphs(project: EditProject, nativeMotionPaint?: PreparedNativeMotionPaint,
  nativeFloatingVideoFrames?: PreparedNativeFloatingVideoFrames) {
  const hasFloatingVideoFrames = project.tracks.some(track => track.clips.some(clip => clip.floatingFrame !== undefined));
  const floating = nativeFloatingVideoFrames ?? (hasFloatingVideoFrames ? prepareNativeFloatingVideoFrames(project) : undefined);
  const video = buildGpuEngineVideoPreviewGraph(project, 0, nativeMotionPaint, floating);
  // A prepared floating owner must stay on the complete shared graph. Do not
  // expose an old single-video fallback after failed or stale admission.
  if ((hasFloatingVideoFrames || floating) && !video) {
    throw new Error("此浮空影片專案尚未符合 current factory-owned ACES2 原生預覽契約，不能退回舊單片路徑");
  }
  return {
    image: buildGpuEnginePreviewGraph(project, 0),
    video,
    // This admission function owns typography/caption guards, not floating
    // handles. Keep its exact signature and additionally require the admitted
    // shared floating graph before allowing a native surface.
    nativeSurfaceSafe: canPresentGpuVideoOnNativeSurface(project, nativeMotionPaint)
      && (!hasFloatingVideoFrames || Boolean(video)),
  };
}

export type PreparedResidentGpuGraphs = ReturnType<typeof prepareResidentGpuGraphs>;

/** Authored paint cannot use the old single-video route while its font is pending. */
export function residentProjectNeedsNativeMotionPaint(project: EditProject): boolean {
  return project.motionGraphics.some(graphic => graphic.paintV1 !== undefined || graphic.visualStyle === "native_paint");
}

export interface ResidentGpuGraphPreparationLease {
  readonly ready: Promise<PreparedResidentGpuGraphs>;
  isActive(): boolean;
  dispose(): void;
}
export interface ResidentGpuGraphPreparationOptions {
  readonly signal?: AbortSignal;
  /** The committed project owner, checked after each async boundary. */
  readonly isCurrent?: () => boolean;
  readonly fontDelivery?: Omit<MotionFontDeliveryOptions, "signal" | "prepareGlyphs">;
}

/** Retain verified FontFace/glyph leases for the same lifetime as the resident
 * graph. No font work or graph publication may escape a retired project owner. */
export function acquireResidentGpuGraphPreparation(project: EditProject, options: ResidentGpuGraphPreparationOptions = {}): ResidentGpuGraphPreparationLease {
  const controller = new AbortController(), leases: MotionFontDeliveryLease[] = [];
  const revision = project.revision, updatedAt = project.updatedAt, projectId = project.id;
  let active = true;
  const isCurrent = () => active && !controller.signal.aborted && !options.signal?.aborted
    && project.revision === revision && project.updatedAt === updatedAt && project.id === projectId
    && (options.isCurrent?.() ?? true);
  const dispose = () => {
    if (!active) return;
    active = false; controller.abort(); options.signal?.removeEventListener("abort", dispose);
    for (const lease of leases) lease.release();
  };
  const assertCurrent = () => { if (!isCurrent()) throw new RetiredGpuPreview(); };
  options.signal?.addEventListener("abort", dispose, { once: true });
  const ready = (async () => {
    try {
      assertCurrent();
      // Factory ownership spans the same immutable project/font lease. The
      // builder revalidates its complete source/clock signature after async
      // font delivery, so mutation cannot publish a differently owned graph.
      const floating = project.tracks.some(track => track.clips.some(clip => clip.floatingFrame !== undefined))
        ? prepareNativeFloatingVideoFrames(project) : undefined;
      assertCurrent();
      if (!residentProjectNeedsNativeMotionPaint(project)) {
        const prepared = prepareResidentGpuGraphs(project, undefined, floating);
        assertCurrent();
        return prepared;
      }
      const graphics = project.motionGraphics.filter(graphic => graphic.paintV1 !== undefined || graphic.visualStyle === "native_paint");
      if (graphics.length > 4) throw new Error("原生 paint 預覽最多同時持有 4 個圖文資源");
      for (const graphic of graphics) assertMotionPaintContract(graphic);
      const requests = graphics.filter(graphic => !graphic.vectorV2).map(graphic => {
        const selection = motionFontSelection({ family: graphic.fontFamily ?? "Noto Sans TC", weight: graphic.fontWeight ?? 700, text: graphic.text });
        const lease = acquireMotionFontDelivery(selection, { ...options.fontDelivery, signal: controller.signal, prepareGlyphs: true, priority: "current" });
        leases.push(lease);
        return { graphic, selection, lease };
      });
      const receipts = await Promise.all(requests.map(request => request.lease.ready));
      assertCurrent();
      const runs = new Map<string, PreparedGlyphRun>();
      for (const [index, receipt] of receipts.entries()) {
        const { graphic, selection, lease } = requests[index];
        if (receipt.status !== "registered" || receipt.selectionKey !== selection.selectionKey || !lease.isRegistered() || !receipt.glyphRun) {
          throw new Error(receipt.reason ?? `原生 paint ${graphic.id} 缺少當前已驗證的實體字型 glyph run`);
        }
        runs.set(graphic.id, receipt.glyphRun);
      }
      assertCurrent();
      const handle = prepareNativeMotionPaint(project, runs);
      assertCurrent();
      const prepared = prepareResidentGpuGraphs(project, handle, floating);
      if (!prepared.video || !prepared.nativeSurfaceSafe) throw new Error("此 paint 專案尚未符合 current ACES2 covered-video 原生預覽契約");
      assertCurrent();
      return prepared;
    } catch (error) {
      dispose(); throw error;
    }
  })();
  return { ready, isActive: () => isCurrent() && leases.every(lease => lease.isRegistered()), dispose };
}

/** Keep resource/graph identity stable; sampling only chooses the native frame. */
export function sampleResidentGpuGraph<T extends GpuEnginePreviewGraph>(graph: T | undefined, playhead: number): T | undefined {
  if (!graph) return undefined;
  return { ...graph, timelineFrame: Math.max(0, Math.round(playhead * graph.graph.timebase.denominator / graph.graph.timebase.numerator)) };
}
