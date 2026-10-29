/** Browser-safe caption outcome contract shared by the recognizer (Node service) and the desktop UI.
 * Errors cross the service boundary as plain messages, so the message itself is the contract. */
export const AUTOMATIC_CAPTION_EMPTY_MESSAGE = "辨識已完成，但沒有可用逐字稿；未產生字幕。這不代表已確認素材沒有語音";

const NO_AUDIO_STREAM = /matches no streams|does not contain any stream|沒有可分析的聲音軌/i;

/**
 * True when transcription finished without usable speech, or the source has no audio stream to
 * transcribe. Any other failure (runtime, model, timeout, cancellation) stays a real error.
 */
export function isNoSpeechTranscriptError(error: unknown): boolean {
  if (error && typeof error === "object" && (error as { code?: unknown }).code === "AUTOMATIC_CAPTION_EMPTY") return true;
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return message.includes(AUTOMATIC_CAPTION_EMPTY_MESSAGE) || NO_AUDIO_STREAM.test(message);
}
