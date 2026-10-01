import { detectPcmSilences } from "./pcmSilence";
import { DEFAULT_SMART_CUT_OPTIONS, planSmartCutReference, type SmartCutOptions, type SmartCutResult } from "./smartCutPlan";

const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const MAX_SOURCE_SECONDS = 5 * 60;
const DECODE_SAMPLE_RATE = 16_000;
let decoding = false;

export interface BrowserSmartCutRequest {
  sourceUrl?: string;
  sourceDuration: number;
  sourceStart: number;
  duration: number;
  fps: number;
  options?: Partial<SmartCutOptions>;
  signal?: AbortSignal;
}

function waitForAnalysis<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => { signal.removeEventListener("abort", abort); reject(error); });
    if (signal.aborted) abort();
  });
}

export async function analyzeBrowserSmartCut(request: BrowserSmartCutRequest): Promise<SmartCutResult> {
  request.signal?.throwIfAborted();
  // Only imported object URLs: never fetch persisted local paths or external media.
  if (!request.sourceUrl?.startsWith("blob:")) throw new Error("請重新匯入素材，網頁版需要本次匯入的本機檔案。");
  if (!Number.isFinite(request.sourceDuration) || request.sourceDuration <= 0 || request.sourceDuration > MAX_SOURCE_SECONDS) {
    throw new Error("網頁版智慧去停頓只支援全長 5 分鐘以內的素材；較長素材請使用桌面版。");
  }
  if (!Number.isFinite(request.sourceStart) || request.sourceStart < 0
    || !Number.isFinite(request.duration) || request.duration <= 0) throw new Error("Smart Cut 素材範圍不合法");
  const options = { ...DEFAULT_SMART_CUT_OPTIONS, ...request.options };
  // Validate the frame plan before doing expensive decoding.
  planSmartCutReference({ fps: request.fps, duration: request.duration, silences: [], options });
  const endTime = request.sourceStart + request.duration;
  const endFrame = Math.round(endTime * request.fps);
  if (request.sourceStart >= request.sourceDuration || endFrame > Math.round(request.sourceDuration * request.fps)) {
    throw new Error("Smart Cut 素材範圍不合法");
  }
  if (typeof OfflineAudioContext === "undefined") throw new Error("這個瀏覽器不支援 Web Audio 音訊解碼，請使用桌面版。");
  if (decoding) throw new Error("上一次瀏覽器音訊解碼仍在結束中；請稍後重試或使用桌面版。");
  const controller = new AbortController();
  const abort = () => controller.abort(request.signal!.reason);
  request.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("網頁智慧去停頓分析逾時；請重新匯入或使用桌面版。")), 30_000);
  try {
    return await analyzeSource(request, options, endTime, endFrame, controller.signal);
  } finally {
    clearTimeout(timer); request.signal?.removeEventListener("abort", abort);
  }
}

async function analyzeSource(request: BrowserSmartCutRequest, options: SmartCutOptions, endTime: number, endFrame: number, signal: AbortSignal): Promise<SmartCutResult> {
  const response = await waitForAnalysis(fetch(request.sourceUrl!, { signal, credentials: "omit", redirect: "error" }), signal);
  if (!response.ok) throw new Error("無法讀取本機素材，請重新匯入。");
  const blob = await waitForAnalysis(response.blob(), signal);
  if (blob.size > MAX_SOURCE_BYTES) throw new Error("網頁版智慧去停頓只支援 32 MiB 以內的檔案；較大素材請使用桌面版。");
  const encoded = await waitForAnalysis(blob.arrayBuffer(), signal);
  signal.throwIfAborted();
  if (decoding) throw new Error("上一次瀏覽器音訊解碼仍在結束中；請稍後重試或使用桌面版。");
  // decodeAudioData needs the whole encoded file; cap size/duration and resample to 16 kHz.
  const context = new OfflineAudioContext(2, 1, DECODE_SAMPLE_RATE);
  let audio: AudioBuffer;
  try {
    decoding = true;
    let decoded: Promise<AudioBuffer>;
    try { decoded = context.decodeAudioData(encoded); } catch (error) { decoding = false; throw error; }
    // decodeAudioData cannot be interrupted. Keep its concurrency gate until
    // native decoding actually settles, even when the caller has canceled.
    void decoded.then(() => { decoding = false; }, () => { decoding = false; });
    audio = await waitForAnalysis(decoded, signal);
  } catch {
    signal.throwIfAborted();
    throw new Error("瀏覽器無法解碼這個素材的聲音；可能沒有音軌或格式不支援，請使用桌面版。");
  }
  signal.throwIfAborted();
  if (audio.duration > MAX_SOURCE_SECONDS || audio.numberOfChannels > 2) {
    throw new Error("網頁版智慧去停頓只支援全長 5 分鐘以內的單聲道／雙聲道素材，請使用桌面版。");
  }
  const start = Math.round(request.sourceStart * audio.sampleRate);
  // Timeline ends round to frames; inspect only real PCM, never pad missing samples with silence.
  const end = Math.min(audio.length, Math.round(endTime * audio.sampleRate));
  if (endFrame > Math.round(audio.duration * request.fps) || end <= start) throw new Error("解碼後的聲音未涵蓋所選片段，請確認素材或使用桌面版。");
  const channels = Array.from({ length: audio.numberOfChannels }, (_, channel) => audio.getChannelData(channel).subarray(start, end));
  const silences = detectPcmSilences(channels, audio.sampleRate, options);
  const plan = planSmartCutReference({ fps: request.fps, duration: request.duration, silences, options });
  return { ...plan, engine: "editkin-web-audio-rms-0.1", silenceCount: silences.length, thresholdDb: options.thresholdDb, analyzedSeconds: request.duration, cacheHit: false };
}
