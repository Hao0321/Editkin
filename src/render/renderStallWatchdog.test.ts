import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { FFMPEG_PROGRESS_ARGS, runProcess } from "./mediaProcess";
import {
  DEFAULT_RENDER_STALL_MS,
  formatRenderDuration,
  fullDecodeTimeoutMs,
  MAX_RENDER_TIMER_MS,
  publishRenderOutput,
  RENDER_DEADLINE_BASE_MS,
  renderDeadlineForWorkSeconds,
  renderLifetimeRemainingMs,
  renderStageTimeout,
  withRenderLifetime,
} from "./renderLifetime";

const node = process.execPath;
async function scratch(prefix: string) { return mkdtemp(join(tmpdir(), prefix)); }
async function waitForPid(path: string): Promise<number> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try { const pid = Number.parseInt(await readFile(path, "utf8"), 10); if (pid > 0) return pid; } catch { /* starting */ }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 10));
  }
  throw new Error("child did not start");
}

describe("export deadline scales with the rendered duration (no fixed cap)", () => {
  it("grows with work seconds and is bounded only by the timer limit", () => {
    expect(renderDeadlineForWorkSeconds(0)).toBe(RENDER_DEADLINE_BASE_MS);
    expect(renderDeadlineForWorkSeconds(432)).toBe(RENDER_DEADLINE_BASE_MS + 432 * 60_000);
    expect(renderDeadlineForWorkSeconds(Number.NaN)).toBe(RENDER_DEADLINE_BASE_MS);
    expect(renderDeadlineForWorkSeconds(1e9)).toBe(MAX_RENDER_TIMER_MS);
    expect(fullDecodeTimeoutMs(0)).toBe(20 * 60_000);
    expect(fullDecodeTimeoutMs(2 * 3600)).toBeGreaterThan(8 * 3600_000);
  }, 30_000);

  it("gives a long film's stages far more than the former fixed 15 minutes", async () => {
    await withRenderLifetime({ workSeconds: 2 * 3600 }, async () => {
      expect(renderLifetimeRemainingMs()!).toBeGreaterThan(100 * 3600_000);
      expect(renderStageTimeout(MAX_RENDER_TIMER_MS)).toBeGreaterThan(100 * 3600_000);
    });
    // Without duration information the floor is still above the old hidden cap.
    await withRenderLifetime({}, async () => expect(renderLifetimeRemainingMs()!).toBeGreaterThan(15 * 60_000));
  }, 30_000);

  it("keeps an explicit caller deadline as a hard total limit with a clear message", async () => {
    await expect(withRenderLifetime({ timeoutMs: 150 }, () => runProcess(node, ["-e", "setInterval(()=>{},1000)"], 5_000)))
      .rejects.toThrow(/總時間逾時（上限 1 秒）/);
  }, 30_000);

  it("formats durations for zh-TW messages", () => {
    expect(formatRenderDuration(DEFAULT_RENDER_STALL_MS)).toBe("10 分鐘");
    expect(formatRenderDuration(45_000)).toBe("45 秒");
    expect(formatRenderDuration(90 * 60_000)).toBe("1 小時 30 分鐘");
    expect(formatRenderDuration(2 * 3600_000)).toBe("2 小時");
  }, 30_000);
});

describe("no-progress watchdog for watched export processes", () => {
  it("stops an encoder that makes no progress, kills it, and the render can never publish or be GREEN", async () => {
    const directory = await scratch("editkin-stall-silent-");
    const temporary = join(directory, "pending.mp4"), requested = join(directory, "prior.mp4"), pidFile = join(directory, "pid");
    try {
      await writeFile(temporary, "candidate"); await writeFile(requested, "prior");
      let stageError: unknown;
      const started = performance.now();
      await expect(withRenderLifetime({ timeoutMs: 30_000, stallMs: 300 }, async () => {
        try {
          await runProcess(node, ["-e", "require('fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)", pidFile],
            30_000, undefined, { ffmpegProgress: true, paths: [temporary] });
        } catch (error) { stageError = error; }
        // Even a caller that swallows the stage error cannot commit the candidate.
        await publishRenderOutput(temporary, requested);
        return "GREEN";
      })).rejects.toThrow(/影片輸出停滯/);
      expect((stageError as Error).message).toMatch(/停滯：.+已連續 1 秒沒有任何進度/);
      expect(performance.now() - started).toBeLessThan(10_000);
      const pid = await waitForPid(pidFile);
      expect(() => process.kill(pid, 0)).toThrow();
      expect(await readFile(requested, "utf8")).toBe("prior");
      expect(await readFile(temporary, "utf8")).toBe("candidate");
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 30_000);

  it("does not stop an encoder whose progress counters keep advancing past the stall window", async () => {
    const script = "let f=0;const t=setInterval(()=>{f++;process.stdout.write(`frame=${f}\\nout_time_us=${f*33333}\\nprogress=continue\\n`);if(f>=24){clearInterval(t);process.stdout.write('progress=end\\n')}},50)";
    const started = performance.now();
    const result = await withRenderLifetime({ timeoutMs: 30_000, stallMs: 300 }, () =>
      runProcess(node, ["-e", script], 30_000, undefined, { ffmpegProgress: true }));
    expect(performance.now() - started).toBeGreaterThan(900);
    expect(result.stdout).toContain("progress=end");
  }, 30_000);

  it("treats repeated identical counters (a stuck FFmpeg still reporting) as no progress", async () => {
    const script = "let f=0;setInterval(()=>{f=Math.min(f+1,8);process.stdout.write(`frame=${f}\\nout_time_us=${f*33333}\\ntotal_size=4096\\nprogress=continue\\n`)},40)";
    await expect(withRenderLifetime({ timeoutMs: 30_000, stallMs: 400 }, () =>
      runProcess(node, ["-e", script], 30_000, undefined, { ffmpegProgress: true }))).rejects.toThrow(/影片輸出停滯/);
  }, 30_000);

  it("counts output-file growth (for example the faststart rewrite) and new frame files as progress", async () => {
    const directory = await scratch("editkin-stall-files-");
    try {
      const output = join(directory, "growing.mp4"), frames = join(directory, "frames");
      await mkdir(frames);
      const grow = "const fs=require('fs');let n=0;const t=setInterval(()=>{fs.appendFileSync(process.argv[1],'x'.repeat(64));if(++n>=24)clearInterval(t)},50)";
      await withRenderLifetime({ timeoutMs: 30_000, stallMs: 300 }, () =>
        runProcess(node, ["-e", grow, output], 30_000, undefined, { ffmpegProgress: true, paths: [output] }));
      expect((await stat(output)).size).toBe(24 * 64);
      const sequence = "const fs=require('fs'),p=require('path');let n=0;const t=setInterval(()=>{fs.writeFileSync(p.join(process.argv[1],`frame-${n}.png`),'');if(++n>=24)clearInterval(t)},50)";
      await withRenderLifetime({ timeoutMs: 30_000, stallMs: 300 }, () =>
        runProcess(node, ["-e", sequence, frames], 30_000, undefined, { paths: [frames] }));
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 30_000);

  it("leaves unwatched short tools and work outside a render lifetime alone", async () => {
    await withRenderLifetime({ timeoutMs: 30_000, stallMs: 150 }, () => runProcess(node, ["-e", "setTimeout(()=>{},600)"], 30_000));
    await runProcess(node, ["-e", "setTimeout(()=>{},300)"], 30_000, undefined, { ffmpegProgress: true });
  }, 30_000);

  it("still reports the user's cancellation, not a stall, while a watched encoder runs", async () => {
    const controller = new AbortController(); const reason = new Error("user stopped export");
    const timer = setTimeout(() => controller.abort(reason), 150);
    try {
      await expect(withRenderLifetime({ signal: controller.signal, timeoutMs: 30_000, stallMs: 5_000 }, () =>
        runProcess(node, ["-e", "setInterval(()=>{},1000)"], 30_000, undefined, { ffmpegProgress: true }))).rejects.toBe(reason);
    } finally { clearTimeout(timer); }
  }, 30_000);

  it("reads real FFmpeg progress with the shared progress arguments before the output path", async () => {
    const ffmpeg = resolve("vendor/ffmpeg/win32-x64/ffmpeg.exe");
    if (process.platform !== "win32" || !existsSync(ffmpeg)) return;
    const directory = await scratch("editkin-stall-ffmpeg-");
    try {
      const output = join(directory, "progress.mp4");
      const result = await withRenderLifetime({ timeoutMs: 60_000, stallMs: 15_000 }, () => runProcess(ffmpeg, [
        "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=30:duration=2",
        "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-movflags", "+faststart", ...FFMPEG_PROGRESS_ARGS, output,
      ], 60_000, undefined, { ffmpegProgress: true, paths: [output] }));
      expect(result.stdout).toMatch(/^frame=\d+$/m);
      expect(result.stdout).toMatch(/^progress=end$/m);
      expect((await stat(output)).size).toBeGreaterThan(0);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 30_000);
});
