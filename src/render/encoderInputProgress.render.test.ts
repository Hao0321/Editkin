import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FFMPEG_PROGRESS_ARGS, runProcess } from "./mediaProcess";
import { withRenderLifetime } from "./renderLifetime";

/**
 * Render fixes 2026-10-22: FFmpeg's -progress `frame` / `out_time` / `total_size` count written packets. libx264 holds
 * frames back (lookahead, B-frames, frame threads), so a slow filter graph shows no progress for tens of frames and the
 * no-progress watchdog stopped a healthy matte export. renderComposite now also prints `-stats_enc_pre` lines
 * (`encoder_input_frame=N`, one per frame entering the encoder) on the same stdout, and the watchdog counts them. Here
 * frames arrive every 100 ms (realtime filter) and the encoder holds 60 back (rc-lookahead=60, about 6 s without a
 * packet); the stall window is 2 s.
 */
const ffmpeg = resolve("vendor/ffmpeg/win32-x64/ffmpeg.exe");
let root: string;
beforeAll(async () => { root = join(resolve(process.env.TEMP ?? "."), `render-fix-encoder-input-${process.pid}`); await mkdir(root, { recursive: true }); });
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

const args = (output: string, stats = false) => ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=160x96:r=10:d=8", "-vf", "realtime,format=yuv420p",
  "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-x264-params", "rc-lookahead=60", ...(stats ? ["-stats_enc_pre:v", "pipe:1", "-stats_enc_pre_fmt:v", "encoder_input_frame={n}"] : []),
  ...FFMPEG_PROGRESS_ARGS, output];

describe("no-progress watchdog with an encoder that holds frames back", () => {
  it("packet counters and output growth alone look stalled", async () => {
    const output = join(root, "packets-only.mp4");
    await expect(withRenderLifetime({ timeoutMs: 120_000, stallMs: 2_000 }, () => runProcess(ffmpeg, args(output), 120_000, undefined, { ffmpegProgress: true, paths: [output] })))
      .rejects.toThrow(/停滯/);
  }, 120_000);

  it("encoder-input lines on stdout keep a healthy encode alive", async () => {
    const output = join(root, "with-stats.mp4");
    const { stdout } = await withRenderLifetime({ timeoutMs: 120_000, stallMs: 2_000 }, () => runProcess(ffmpeg, args(output, true), 120_000, undefined, { ffmpegProgress: true, paths: [output] }));
    expect(stdout.split(/\r?\n/)).toContain("encoder_input_frame=79");
    expect(stdout).toMatch(/progress=end/);
  }, 120_000);
});
