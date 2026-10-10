import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { currentMotionFontReadiness, loadMotionFontReadiness, type MotionFontReadiness, type MotionFontSelection } from "../typography/motionFontReadiness";
import { acquireMotionFontDelivery, motionFontSurface, MOTION_FONT_DELIVERY_TIMEOUT_MS, type MotionFontDeliveryLease } from "../typography/motionFontDelivery";
import type { PreparedGlyphRun } from "../typography/preparedGlyphRun";
import { createMotionTemplateTextPreparer, MOTION_TEMPLATE_TEXT_TIMEOUT_MS, type MotionTemplateTextPreparer } from "../typography/motionTemplateTextPreparation";

export interface MotionFontConsumerReadiness extends MotionFontReadiness {
  readonly glyphRun?: PreparedGlyphRun;
}

const subscribe = () => () => {};
const browserSnapshot = () => true;
const serverSnapshot = () => false;

/** Each graphic owns its request; changing identity hides old readiness in this render. */
export function useMotionFontReadiness(selection: MotionFontSelection, priority: "current" | "lookahead" = "current", options: { prepareGlyphs?: boolean } = {}): MotionFontConsumerReadiness {
  const browserRender = useSyncExternalStore(subscribe, browserSnapshot, serverSnapshot);
  const surface = motionFontSurface();
  const prepareGlyphs = options.prepareGlyphs === true;
  const request = useMemo(() => ({}), [selection.selectionKey, browserRender, surface, prepareGlyphs]);
  const current = useRef<{ request: object; lease?: MotionFontDeliveryLease; preparer?: MotionTemplateTextPreparer } | undefined>(undefined);
  const [observed, setObserved] = useState<{ request: object; readiness: MotionFontConsumerReadiness }>();
  useEffect(() => {
    if (!browserRender || currentMotionFontReadiness(selection, undefined, true).status !== "pending") return;
    const controller = new AbortController();
    const owner: { request: object; lease?: MotionFontDeliveryLease; preparer?: MotionTemplateTextPreparer } = { request };
    current.current = owner;
    setObserved({ request, readiness: currentMotionFontReadiness(selection, undefined, true) });
    let fontSet: FontFaceSet | undefined;
    try { fontSet = typeof document === "undefined" ? undefined : document.fonts; } catch { /* Loader reports unavailable API. */ }
    const deadline = performance.now() + (surface === "web" && prepareGlyphs ? MOTION_TEMPLATE_TEXT_TIMEOUT_MS : MOTION_FONT_DELIVERY_TIMEOUT_MS);
    void (async () => {
      let readiness: MotionFontConsumerReadiness;
      if (surface === "desktop") {
        owner.lease = acquireMotionFontDelivery(selection, { signal: controller.signal, priority, prepareGlyphs });
        const delivery = await owner.lease.ready;
        if (controller.signal.aborted || current.current !== owner) return;
        if (delivery.status !== "registered" || !owner.lease.isRegistered()) {
          readiness = { selectionKey: selection.selectionKey, status: delivery.status === "registered" || delivery.status === "cancelled" ? "blocked" : delivery.status,
            face: selection.face, reason: delivery.reason ?? "實體字型 registration 未完成；請確認桌面字型資源" };
        } else if (prepareGlyphs && !delivery.glyphRun) {
          readiness = { selectionKey: selection.selectionKey, status: "blocked", face: selection.face, reason: "此字型介面未提供實體 glyph run；請更新後重新開啟專案" };
        } else {
          const remaining = Math.floor(deadline - performance.now());
          readiness = remaining > 0 ? await loadMotionFontReadiness(selection, { fontSet, signal: controller.signal, timeoutMs: remaining })
            : { selectionKey: selection.selectionKey, status: "blocked", face: selection.face, reason: "實體字型傳遞逾時；請重新開啟專案" };
          if (readiness.status === "ready" && !owner.lease.isRegistered()) readiness = { ...readiness, status: "blocked", reason: "實體字型 lease 已失效；請重新開啟專案" };
          if (readiness.status === "ready" && prepareGlyphs && performance.now() >= deadline) readiness = { ...readiness, status: "blocked", reason: "實體 glyph 與字型檢查超過原請求期限；請重新開啟專案" };
          if (readiness.status === "ready" && prepareGlyphs) readiness = { ...readiness, glyphRun: delivery.glyphRun };
        }
      } else if (prepareGlyphs) {
        try {
          owner.preparer = createMotionTemplateTextPreparer({ signal: controller.signal });
          const glyphRun = await owner.preparer.prepareText(selection.face!.faceId, selection.text.replaceAll("\r", ""));
          if (controller.signal.aborted || current.current !== owner) return;
          const remaining = Math.floor(deadline - performance.now());
          readiness = remaining > 0 ? await loadMotionFontReadiness(selection, { fontSet, signal: controller.signal, timeoutMs: remaining })
            : { selectionKey: selection.selectionKey, status: "blocked", face: selection.face, reason: "Web 實體 glyph 與字型準備逾時" };
          if (readiness.status === "ready" && performance.now() >= deadline) readiness = { ...readiness, status: "blocked", reason: "Web 實體 glyph 與字型檢查超過原請求期限" };
          if (readiness.status === "ready") readiness = { ...readiness, glyphRun };
        } catch (error) {
          readiness = { selectionKey: selection.selectionKey, status: controller.signal.aborted ? "cancelled" : "blocked", face: selection.face,
            reason: error instanceof Error ? error.message : String(error) };
        }
      }
      else readiness = await loadMotionFontReadiness(selection, { fontSet, signal: controller.signal });
      if (!controller.signal.aborted && current.current === owner && readiness.status !== "cancelled") setObserved({ request, readiness });
    })();
    return () => {
      controller.abort(); owner.lease?.release(); owner.preparer?.dispose();
      if (current.current === owner) current.current = undefined;
    };
  }, [request, selection.selectionKey, browserRender, surface, prepareGlyphs]);
  // Visibility promotes an existing physical lease, without resetting its
  // deadline, repeating I/O, or deleting a successfully prefetched face.
  useEffect(() => { if (current.current?.request === request) current.current.lease?.setPriority(priority); }, [request, priority]);
  let accepted = observed?.request === request ? observed.readiness : undefined;
  const owner = current.current;
  if (surface === "desktop" && accepted?.status === "ready" && (owner?.request !== request || !owner?.lease?.isRegistered())) {
    accepted = { selectionKey: selection.selectionKey, face: selection.face, status: "blocked", reason: "實體字型 lease 已釋放或失效；請重新開啟專案" };
  }
  const readiness = currentMotionFontReadiness(selection, accepted, browserRender);
  return readiness === accepted ? accepted! : readiness;
}
