import { detectPcmSilences } from "./pcmSilence";
import { DEFAULT_SMART_CUT_OPTIONS, planSmartCutReference, type SmartCutOptions, type SmartCutResult } from "./smartCutPlan";

const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const MAX_SOURCE_SECONDS = 5 * 60;
const DECODE_SAMPLE_RATE = 16_000;

export interface BrowserSmartCutRequest {
  sourceUrl?: string;
  sourceDuration: number;
  sourceStart: number;
  duration: number;
  fps: number;
  options?: Partial<SmartCutOptions>;
}

export async function analyzeBrowserSmartCut(request: BrowserSmartCutRequest): Promise<SmartCutResult> {
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
  const response = await fetch(request.sourceUrl);
  if (!response.ok) throw new Error("無法讀取本機素材，請重新匯入。");
  const blob = await response.blob();
  if (blob.size > MAX_SOURCE_BYTES) throw new Error("網頁版智慧去停頓只支援 32 MiB 以內的檔案；較大素材請使用桌面版。");
  if (typeof OfflineAudioContext === "undefined") throw new Error("這個瀏覽器不支援 Web Audio 音訊解碼，請使用桌面版。");
  // decodeAudioData needs the whole encoded file; cap size/duration and resample to 16 kHz.
  const context = new OfflineAudioContext(2, 1, DECODE_SAMPLE_RATE);
  let audio: AudioBuffer;
  try {
    audio = await context.decodeAudioData(await blob.arrayBuffer());
  } catch {
    throw new Error("瀏覽器無法解碼這個素材的聲音；可能沒有音軌或格式不支援，請使用桌面版。");
  }
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
