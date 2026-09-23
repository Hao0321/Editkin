import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { analyzeMotionTrack } from "../src/application/motionTracking";

const ffmpeg = process.env.HAO_FFMPEG_PATH ?? resolve("vendor/ffmpeg/win32-x64/ffmpeg.exe");
const nativeCore = process.env.HAO_NATIVE_CORE_PATH ?? resolve("native/bin/win32-x64/hao-core.exe");

function run(executable: string, args: string[]): Promise<void> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", rejectRun);
    child.once("close", (code) => code === 0 ? resolveRun() : rejectRun(new Error(stderr)));
  });
}

const workspace = await mkdtemp(join(tmpdir(), "editkin-motion-integration-"));
const source = join(workspace, "moving-subject.mp4");
const rotatingSource = join(workspace, "rotating-subject.mp4");
const cacheRoot = join(workspace, "cache");
try {
  await mkdir(cacheRoot, { recursive: true });
  const width = 320; const height = 180; const fps = 30; const frameCount = 90;
  const raw = Buffer.alloc(width * height * 3 * frameCount, 24);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const x = Math.round(20 + 40 * frame / fps);
    for (let y = 52; y < 102; y += 1) for (let column = x; column < x + 50; column += 1) {
      const offset = (frame * width * height + y * width + column) * 3;
      const inner = column < x + 14 && y < 66;
      raw[offset] = inner ? 38 : 242; raw[offset + 1] = inner ? 48 : 242; raw[offset + 2] = inner ? 58 : 242;
    }
  }
  const rawSource = join(workspace, "moving-subject.rgb");
  await writeFile(rawSource, raw);
  await run(ffmpeg, [
    "-y", "-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pixel_format", "rgb24", "-video_size", `${width}x${height}`, "-framerate", String(fps), "-i", rawSource,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", source,
  ]);
  const rotatingRaw = Buffer.alloc(width * height * 3 * frameCount, 24);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const progress = frame / (frameCount - 1);
    const centerX = 90 + progress * 60;
    const centerY = 92 + Math.sin(progress * Math.PI) * 8;
    const scale = 1 + progress * 0.22;
    const angle = progress * 32 * Math.PI / 180;
    const cosine = Math.cos(angle); const sine = Math.sin(angle);
    const subjectWidth = 50 * scale; const subjectHeight = 36 * scale;
    for (let y = Math.max(0, Math.floor(centerY - 50)); y < Math.min(height, Math.ceil(centerY + 50)); y += 1) {
      for (let x = Math.max(0, Math.floor(centerX - 50)); x < Math.min(width, Math.ceil(centerX + 50)); x += 1) {
        const dx = x - centerX; const dy = y - centerY;
        const localX = dx * cosine + dy * sine; const localY = -dx * sine + dy * cosine;
        if (Math.abs(localX) > subjectWidth / 2 || Math.abs(localY) > subjectHeight / 2) continue;
        const checker = (Math.floor((localX + subjectWidth / 2) / 7) + Math.floor((localY + subjectHeight / 2) / 6)) % 2;
        const accent = localX < -subjectWidth * .18 && localY < 0;
        const value = accent ? [245, 72, 44] : checker ? [230, 226, 62] : [55, 184, 238];
        const offset = (frame * width * height + y * width + x) * 3;
        rotatingRaw[offset] = value[0]; rotatingRaw[offset + 1] = value[1]; rotatingRaw[offset + 2] = value[2];
      }
    }
    if (frame >= 40 && frame <= 46) {
      for (let y = 70; y < 116; y += 1) for (let x = Math.round(centerX); x < Math.min(width, Math.round(centerX + 20)); x += 1) {
        const offset = (frame * width * height + y * width + x) * 3;
        rotatingRaw[offset] = 24; rotatingRaw[offset + 1] = 24; rotatingRaw[offset + 2] = 24;
      }
    }
  }
  const rotatingRawSource = join(workspace, "rotating-subject.rgb");
  await writeFile(rotatingRawSource, rotatingRaw);
  await run(ffmpeg, [
    "-y", "-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pixel_format", "rgb24", "-video_size", `${width}x${height}`, "-framerate", String(fps), "-i", rotatingRawSource,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", rotatingSource,
  ]);
  const request = {
    sourcePath: source, sourceStart: 0, duration: 3, fps: 30, sourceWidth: 320, sourceHeight: 180, initialTime: 0,
    initialRect: { x: 20 / 320, y: 52 / 180, width: 50 / 320, height: 50 / 180 },
  };
  const first = await analyzeMotionTrack(request, { ffmpegPath: ffmpeg, nativeCorePath: nativeCore, cacheRoot });
  const second = await analyzeMotionTrack(request, { ffmpegPath: ffmpeg, nativeCorePath: nativeCore, cacheRoot });
  const rotating = await analyzeMotionTrack({
    ...request, sourcePath: rotatingSource, initialRect: { x: 65 / 320, y: 74 / 180, width: 50 / 320, height: 36 / 180 },
  }, { ffmpegPath: ffmpeg, nativeCorePath: nativeCore, cacheRoot });
  const last = first.points.at(-1)!;
  const expectedX = (20 + 40 * last.time) / 320;
  const rotatingLast = rotating.points.at(-1)!;
  const rotationError = Math.abs(rotatingLast.rotationDegrees - 32);
  const scaleError = Math.abs(rotatingLast.scale - 1.22);
  const status = first.engine === "hao-core-rust-motion-track-0.4-region-fallback" && rotating.engine === "hao-core-rust-motion-track-0.4-planar" && first.points.length >= 44 && first.lostRatio <= 0.15
    && first.points.every((point) => Number.isFinite(point.activity) && point.activity >= 0 && point.activity <= 1 && Number.isFinite(point.rotationDegrees) && Number.isFinite(point.scale) && point.quad.length === 4)
    && Math.abs(last.rect.x - expectedX) <= 0.08 && second.cacheHit && rotating.lostRatio <= .25 && rotationError <= 12 && scaleError <= .25 ? "GREEN" : "BLOCK";
  const report = { schemaVersion: 3, status, engine: first.engine, frames: first.points.length, lostRatio: first.lostRatio, finalX: last.rect.x, expectedX, error: Math.abs(last.rect.x - expectedX), cacheHit: second.cacheHit,
    rotationScaleHoldout: { engine: rotating.engine, frames: rotating.points.length, lostRatio: rotating.lostRatio, expectedRotation: 32, actualRotation: rotatingLast.rotationDegrees, rotationError, expectedScale: 1.22, actualScale: rotatingLast.scale, scaleError, finalQuad: rotatingLast.quad,
      observations: rotating.points.map(({ frame, status, confidence, rotationDegrees, scale, quad, planarDiagnostics }) => ({ frame, status, confidence, rotationDegrees, scale, quad, planarDiagnostics })) },
  };
  const evidence = resolve("../../.rd/benchmarks/editkin-motion-tracking-integration.json");
  await mkdir(resolve("../../.rd/benchmarks"), { recursive: true });
  await writeFile(evidence, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ ...report, evidence })}\n`);
  if (status !== "GREEN") process.exitCode = 1;
} finally {
  await rm(workspace, { recursive: true, force: true });
}
