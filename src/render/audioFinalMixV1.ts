import { secondsToSamplesV1 } from "./longRenderClockV1";

/** Preserve the old millisecond spelling when exact; otherwise retain the authored 48 kHz sample position. */
export function audioTimelineDelayFilterV1(seconds: number): string {
  const samples = secondsToSamplesV1(seconds, 48000), milliseconds = Math.round(seconds * 1000);
  return `adelay=${samples === milliseconds * 48 ? milliseconds : `${samples}S`}:all=1`;
}

/** Shared ducking tail. Padded sidechain inputs and a finite output trim avoid an EOF framesync race. */
export function audioSidechainStagesV1(samples: number) {
  if (!Number.isSafeInteger(samples) || samples < 1) throw Error("AUDIO_FINAL_SAMPLE_CLOCK_INVALID");
  return {
    voiceSplit: "asplit=2[voiceout][voicekey-source]",
    musicPad: "apad[musicbus]",
    tail: ["[voicekey-source]apad[voicekey]",
      "[musicbus][voicekey]sidechaincompress=threshold=0.025:ratio=8:attack=25:release=360:makeup=1[duckedmusic]",
      `[voiceout][duckedmusic]amix=inputs=2:duration=longest:normalize=0,atrim=end_sample=${samples}[premaster]`],
  };
}
