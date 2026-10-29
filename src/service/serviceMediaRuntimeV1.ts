import type { AutomaticCaptionRuntime } from "../application/automaticCaptionTypes";
import type { BatchAutoEditRuntime } from "../application/batchAutoEdit";

/** Media paths the desktop host sends with every service request (service_request_value in src-tauri/src/main.rs). */
export interface ServiceMediaRuntimeV1 {
  ffmpeg: string;
  modelRoot: string;
  whisperCli?: string;
  cacheRoot?: string;
}

/**
 * Caption runtime shared by single-clip captions (transcribe_media) and batch auto-edit (batch_auto_edit_item).
 * The shipped FFmpeg has no whisper filter, so both routes must hand the bundled whisper-cli to the recogniser.
 */
export function serviceCaptionRuntimeV1(runtime: ServiceMediaRuntimeV1, env: NodeJS.ProcessEnv = process.env):
  Pick<AutomaticCaptionRuntime, "ffmpegPath" | "whisperCliPath" | "modelRoot" | "modelPath" | "cacheRoot"> {
  return {
    ffmpegPath: runtime.ffmpeg,
    whisperCliPath: runtime.whisperCli,
    modelRoot: runtime.modelRoot,
    modelPath: env.EDITKIN_WHISPER_MODEL_PATH,
    cacheRoot: runtime.cacheRoot,
  };
}

export function serviceBatchAutoEditRuntimeV1(
  runtime: ServiceMediaRuntimeV1 & { ffprobe: string; nativeCore?: string; creativePackRoot?: string; personalMusicRoot?: string; fontRoot?: string; colorRoot?: string },
  env: NodeJS.ProcessEnv = process.env,
): BatchAutoEditRuntime {
  const caption = serviceCaptionRuntimeV1(runtime, env);
  return {
    ffmpegPath: caption.ffmpegPath,
    ffprobePath: runtime.ffprobe,
    nativeCorePath: runtime.nativeCore,
    cacheRoot: caption.cacheRoot,
    modelRoot: caption.modelRoot,
    whisperCliPath: caption.whisperCliPath,
    modelPath: caption.modelPath,
    creativePackRoot: runtime.creativePackRoot,
    personalMusicRoot: runtime.personalMusicRoot,
    fontRoot: runtime.fontRoot,
    colorRoot: runtime.colorRoot,
  };
}
