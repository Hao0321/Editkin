import { registerMotionLibraryFontBytes } from "../motionLibrary/svg/glyphs";
import { composeMotionLibraryFrameV1, type MotionLibraryFrameRequestV1 } from "./motionLibraryFramesV1";
import { missingMotionLibraryFaceV1, motionLibrarySvgDataUrlV1, type MotionLibraryThumbnailWorkerInV1, type MotionLibraryThumbnailWorkerOutV1 } from "./motionLibraryThumbnailProtocolV1";

/**
 * Motion Library thumbnail worker: runs the item generators (glyph layout, path building) off the editor's main
 * thread, so browsing 160 animated cards never blocks scrolling or the keyboard. Fonts arrive from the main thread
 * (desktop IPC or the dev server); this worker verifies and parses them once.
 */
const scope = self as unknown as { postMessage(message: MotionLibraryThumbnailWorkerOutV1): void; onmessage: ((event: MessageEvent<MotionLibraryThumbnailWorkerInV1>) => void) | null };
const waiters = new Map<string, Array<(error?: string) => void>>();
const loaded = new Set<string>();

function ensureFace(faceId: string): Promise<void> {
  if (loaded.has(faceId)) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const list = waiters.get(faceId);
    const settle = (error?: string) => (error ? reject(new Error(error)) : resolve());
    if (list) { list.push(settle); return; }
    waiters.set(faceId, [settle]);
    scope.postMessage({ type: "need-font", faceId });
  });
}

async function frame(id: number, request: MotionLibraryFrameRequestV1): Promise<void> {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const started = performance.now();
    try {
      const svg = composeMotionLibraryFrameV1(request);
      scope.postMessage({ type: "frame", id, url: motionLibrarySvgDataUrlV1(svg), ms: performance.now() - started });
      return;
    } catch (error) {
      const face = missingMotionLibraryFaceV1(error);
      if (!face || loaded.has(face)) { scope.postMessage({ type: "error", id, message: error instanceof Error ? error.message : String(error) }); return; }
      try { await ensureFace(face); }
      catch (failure) { scope.postMessage({ type: "error", id, message: failure instanceof Error ? failure.message : String(failure), font: true }); return; }
    }
  }
  scope.postMessage({ type: "error", id, message: "too many font requests for one frame" });
}

scope.onmessage = event => {
  const message = event.data;
  if (message.type === "frame") { void frame(message.id, message.request); return; }
  if (message.type !== "font") return;
  const settle = (error?: string) => { for (const waiter of waiters.get(message.faceId) ?? []) waiter(error); waiters.delete(message.faceId); };
  if (message.error || !message.bytes) { settle(message.error ?? "font unavailable"); return; }
  registerMotionLibraryFontBytes(message.faceId, new Uint8Array(message.bytes))
    .then(() => { loaded.add(message.faceId); settle(); }, error => settle(error instanceof Error ? error.message : String(error)));
};
