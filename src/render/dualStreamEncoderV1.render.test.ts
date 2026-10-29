import { mkdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDualStreamEncoderV1 } from "./dualStreamEncoderV1";

/**
 * Render fixes 2026-10-22: `finish()` used to race the encoder's exit against a fixed 5 s timer that starts when both
 * inputs end. A real long export still flushes the encoder, writes the trailer and rewrites the whole file for
 * +faststart after that point, so a healthy 30-minute render could be killed mid-faststart. Here the tail is made
 * deterministic: the realtime filter emits 80 frames at 10 fps after all of them were written, so the child needs about
 * 8 s to close after its inputs end. finish() must wait for it (the stage deadline still bounds it).
 */
const ffmpeg = resolve("vendor/ffmpeg/win32-x64/ffmpeg.exe"), W = 32, H = 16, FRAMES = 80, SAMPLES = 2_400;
let root: string;
beforeAll(async () => { root = join(resolve(process.env.TEMP ?? "."), `render-fix-dual-encoder-${process.pid}`); await mkdir(root, { recursive: true }); });
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

describe("dual-stream encoder close", () => {
  it("waits for an encoder that is still working after both inputs ended", async () => {
    const output = join(root, "tail.mkv"), controller = new AbortController();
    const encoder = startDualStreamEncoderV1({ executable: ffmpeg, signal: controller.signal, timeoutMs: 120_000,
      args: ["-n", "-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pixel_format", "gray", "-video_size", `${W}x${H}`, "-framerate", "10", "-i", "pipe:0",
        "-f", "f32le", "-ar", "48000", "-ac", "4", "-channel_layout", "quad", "-i", "pipe:3", "-map", "0:v", "-map", "1:a", "-vf", "realtime",
        "-c:v", "ffv1", "-c:a", "pcm_f32le", output],
      maximumVideoWriteBytes: W * H, maximumAudioWriteBytes: 262_144, expectedVideoWrites: FRAMES, expectedAudioBytes: SAMPLES * 16 });
    const frame = new Uint8Array(W * H).fill(128), pcm = new Uint8Array(262_144);
    const video = (async () => { for (let i = 0; i < FRAMES; i += 1) await encoder.write(frame); encoder.endVideo(); })();
    const audio = (async () => {
      for (let sent = 0; sent < SAMPLES * 16;) { const bytes = Math.min(pcm.length, SAMPLES * 16 - sent); await encoder.writeAudio(pcm.subarray(0, bytes)); sent += bytes; }
      encoder.endAudio();
    })();
    await Promise.all([video, audio]);
    const ended = performance.now(), receipt = await encoder.finish();
    expect(performance.now() - ended).toBeGreaterThan(5_000);
    expect(receipt.code).toBe(0);
    expect((await stat(output)).size).toBeGreaterThan(0);
  }, 120_000);
});
