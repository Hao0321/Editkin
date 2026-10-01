import type { EditProject } from "../domain/types";
import { browserDraftPlan, BROWSER_DRAFT_CODECS, BROWSER_DRAFT_MAX_BYTES } from "./browserDraftPlan";
import { drawBrowserDraftFrame, loadBrowserDraftFonts, type BrowserDraftMedia } from "../render/browserDraftCanvas";

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("已取消草稿匯出。", "AbortError");
}

function waitForMedia(element: HTMLMediaElement | HTMLImageElement, ready: () => boolean, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const events = ["load", "loadeddata", "seeked", "canplay", "timeupdate"];
    const clean = () => { clearTimeout(timer); events.forEach(event => element.removeEventListener(event, check)); element.removeEventListener("error", fail); signal.removeEventListener("abort", abort); };
    const check = () => { if (ready()) { clean(); resolve(); } };
    const fail = () => { clean(); reject(new Error("素材無法解碼；請確認瀏覽器支援這份影片、聲音或圖片。")); };
    const abort = () => { clean(); reject(abortReason(signal)); };
    const timer = setTimeout(() => { clean(); reject(new Error("素材讀取或定位逾時，草稿匯出已停止。")); }, 15_000);
    events.forEach(event => element.addEventListener(event, check));
    element.addEventListener("error", fail);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort(); else check();
  });
}

function waitForPreparation(promise: Promise<unknown>, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const clean = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); };
    const abort = () => { clean(); reject(abortReason(signal)); };
    const timer = setTimeout(() => { clean(); reject(new Error("瀏覽器音訊或字型準備逾時；請允許音訊播放後重試。")); }, 15_000);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(() => { clean(); resolve(); }, error => { clean(); reject(error); });
    if (signal.aborted) abort();
  });
}

export async function renderBrowserDraft(project: EditProject, runtimeUrls: Record<string, string>, options: {
  signal: AbortSignal;
  onProgress?: (percent: number) => void;
}) {
  const plan = browserDraftPlan(project, runtimeUrls);
  if (typeof MediaRecorder === "undefined" || typeof HTMLCanvasElement.prototype.captureStream !== "function" || typeof AudioContext === "undefined") {
    throw new Error("此瀏覽器沒有 Canvas／MediaRecorder／Web Audio 草稿匯出能力；請改用支援的瀏覽器或桌面版。");
  }
  const codecs = BROWSER_DRAFT_CODECS.filter(codec => MediaRecorder.isTypeSupported(codec.mimeType));
  if (!codecs.length) throw new Error("此瀏覽器沒有可用的 H.264/AAC 或 VP9/VP8/Opus 錄製編碼器；請使用桌面版。");
  const canvas = document.createElement("canvas");
  canvas.width = plan.width; canvas.height = plan.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("無法建立草稿畫布。");
  if (plan.needsFilter && !("filter" in ctx)) throw new Error("此瀏覽器不支援 Canvas 調色／效果；此專案請使用桌面版匯出。");
  if (document.visibilityState !== "visible") throw new Error("請保持此分頁在前景再匯出草稿。");
  const controller = new AbortController();
  const signal = controller.signal;
  const abort = () => controller.abort(abortReason(options.signal));
  const visibility = () => { if (document.visibilityState !== "visible") controller.abort(new Error("草稿需即時錄製；分頁已移至背景，匯出已停止，請保持前景後重試。")); };
  options.signal.addEventListener("abort", abort, { once: true });
  document.addEventListener("visibilitychange", visibility);
  if (options.signal.aborted) abort();
  const media: BrowserDraftMedia[] = [];
  const nodes: AudioNode[] = [];
  let stream: MediaStream | undefined;
  let audio: AudioContext | undefined;
  let recorder: MediaRecorder | undefined;
  let frame = 0;
  try {
    signal.throwIfAborted();
    // Resume in the export gesture, before any media/font await; audio is routed
    // only to the recorder, never to the user's speakers or the preview player.
    audio = new AudioContext();
    await waitForPreparation(audio.resume(), signal);
    const destination = audio.createMediaStreamDestination();
    nodes.push(destination);
    const gains = new Map<HTMLMediaElement, GainNode>();
    for (const entry of plan.clips) {
      const element = entry.asset.kind === "image" ? new Image() : document.createElement(entry.asset.kind === "video" ? "video" : "audio");
      media.push({ ...entry, element });
      if (element instanceof HTMLImageElement) {
        element.src = entry.source;
        await waitForMedia(element, () => element.complete && element.naturalWidth > 0, signal);
      } else {
        if (element instanceof HTMLVideoElement) element.playsInline = true;
        element.preload = "auto";
        element.src = entry.source;
        element.load();
        await waitForMedia(element, () => element.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA, signal);
        if (!Number.isFinite(element.duration) || entry.clip.sourceStart + entry.clip.duration > element.duration + 1 / project.fps) {
          throw new Error(`「${entry.asset.name}」的素材長度不足以輸出這份剪輯。`);
        }
        element.currentTime = entry.clip.sourceStart;
        await waitForMedia(element, () => !element.seeking && element.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA, signal);
        const source = audio.createMediaElementSource(element);
        const gain = audio.createGain();
        gain.gain.value = 0;
        source.connect(gain); gain.connect(destination);
        nodes.push(source, gain); gains.set(element, gain);
      }
    }
    await waitForPreparation(loadBrowserDraftFonts(project), signal);
    signal.throwIfAborted();
    drawBrowserDraftFrame(ctx, project, media, 0);
    stream = canvas.captureStream(plan.fps);
    destination.stream.getAudioTracks().forEach(track => stream!.addTrack(track));
    let selected: typeof codecs[number] | undefined;
    for (const codec of codecs) {
      try {
        recorder = new MediaRecorder(stream, { mimeType: codec.mimeType, videoBitsPerSecond: 2_500_000, audioBitsPerSecond: 128_000 });
        selected = codec; break;
      } catch { /* A positive capability probe can still fail for this stream. */ }
    }
    if (!recorder || !selected) throw new Error("瀏覽器回報支援編碼，但無法建立草稿錄製器。");
    const recording = recorder;
    const clock = audio;
    const chunks: Blob[] = [];
    await new Promise<void>((resolve, reject) => {
      let finished = false, complete = false, bytes = 0, progress = -1, paintedFrame = -1;
      let startedAt = clock.currentTime, lastFrameAt = performance.now();
      const started = new Set<HTMLMediaElement>();
      const clean = () => {
        cancelAnimationFrame(frame); signal.removeEventListener("abort", aborted); clock.removeEventListener("statechange", audioState);
        media.forEach(({ element }) => element.removeEventListener("error", mediaError));
      };
      const fail = (error: unknown) => {
        if (finished) return;
        finished = true; clean();
        if (recording.state !== "inactive") recording.stop();
        reject(error);
      };
      const aborted = () => fail(abortReason(signal));
      const audioState = () => { if (clock.state !== "running") fail(new Error("瀏覽器暫停了音訊時鐘，草稿匯出已停止。")); };
      const mediaError = () => fail(new Error("素材在錄製中解碼失敗，沒有下載不完整的草稿。"));
      recording.ondataavailable = event => {
        if (finished) return;
        bytes += event.data.size;
        if (bytes > BROWSER_DRAFT_MAX_BYTES) { fail(new Error("草稿超過 128 MiB 記憶體上限；請縮短影片或使用桌面版。")); return; }
        if (event.data.size) chunks.push(event.data);
      };
      recording.onerror = () => fail(new Error("瀏覽器編碼失敗，沒有下載不完整的草稿；請使用其他支援的瀏覽器或桌面版。"));
      recording.onstop = () => {
        if (finished) return;
        if (!complete) { fail(new Error("錄製器提前停止，沒有下載不完整的草稿。")); return; }
        finished = true; clean(); resolve();
      };
      const tick = () => {
        if (finished) return;
        try {
          signal.throwIfAborted();
          const now = performance.now();
          if (now - lastFrameAt > 1000) throw new Error("草稿錄製的畫面時鐘中斷超過一秒；請保持前景並降低系統負載後重試。");
          lastFrameAt = now;
          const time = clock.currentTime - startedAt;
          if (time >= plan.duration) {
            complete = true;
            media.forEach(item => { if (item.element instanceof HTMLMediaElement) item.element.pause(); });
            recording.stop(); return;
          }
          for (const { clip, element } of media) {
            if (!(element instanceof HTMLMediaElement)) continue;
            const active = time >= clip.timelineStart && time < clip.timelineStart + clip.duration;
            if (active && !started.has(element)) {
              started.add(element);
              gains.get(element)!.gain.value = clip.volume;
              // Clip admission occurs on the first foreground frame at/after its
              // start. Small real-time jitter is part of the draft contract.
              void element.play().then(() => { if (finished || clock.currentTime - startedAt >= clip.timelineStart + clip.duration) element.pause(); }, fail);
            } else if (!active && started.has(element)) {
              gains.get(element)!.gain.value = 0; element.pause();
            }
            if (active && time - clip.timelineStart > 0.5 && Math.abs(element.currentTime - (clip.sourceStart + time - clip.timelineStart)) > 0.5) {
              throw new Error("素材播放與草稿時鐘失去同步，匯出已停止；請使用桌面版輸出。");
            }
          }
          const frameIndex = Math.floor(time * plan.fps);
          if (frameIndex !== paintedFrame) { drawBrowserDraftFrame(ctx, project, media, time); paintedFrame = frameIndex; }
          const percent = Math.min(99, Math.floor(time / plan.duration * 100));
          if (percent !== progress) { progress = percent; options.onProgress?.(percent); }
          frame = requestAnimationFrame(tick);
        } catch (error) { fail(error); }
      };
      signal.addEventListener("abort", aborted, { once: true });
      clock.addEventListener("statechange", audioState);
      media.forEach(({ element }) => element.addEventListener("error", mediaError));
      try { recording.start(1000); startedAt = clock.currentTime; tick(); } catch (error) { fail(error); }
    });
    signal.throwIfAborted();
    const blob = new Blob(chunks, { type: recorder.mimeType || selected.mimeType });
    if (!blob.size) throw new Error("瀏覽器沒有產生可下載的草稿影片。");
    options.onProgress?.(100);
    return { blob, extension: selected.extension, encoder: selected.label, width: plan.width, height: plan.height, fps: plan.fps };
  } finally {
    cancelAnimationFrame(frame);
    options.signal.removeEventListener("abort", abort);
    document.removeEventListener("visibilitychange", visibility);
    if (recorder?.state !== undefined && recorder.state !== "inactive") recorder.stop();
    stream?.getTracks().forEach(track => track.stop());
    media.forEach(({ element }) => {
      if (element instanceof HTMLMediaElement) { element.pause(); element.removeAttribute("src"); element.load(); }
      else element.removeAttribute("src");
    });
    nodes.forEach(node => node.disconnect());
    if (audio && audio.state !== "closed") await audio.close();
  }
}

export function downloadBrowserDraft(blob: Blob, name: string, extension: string) {
  const safeName = name.replace(/[\\/:*?"<>|]/g, "-").trim() || "Editkin";
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${safeName}_draft.${extension}`;
  document.body.append(link);
  link.click(); link.remove();
  // Keep the URL alive until the browser has consumed the download request.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
