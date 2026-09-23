import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { analyzeAutoRoto } from "../src/application/autoRoto";
import { AUTO_ROTO_SAM21_ENGINE } from "../src/application/autoRotoModelRouter";

const appRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(appRoot, "../..");
const packRoot = join(repoRoot, ".rd/model-packs/editkin-auto-roto-sam21-tiny-windows-cuda-1.0.3");
const ffmpeg = join(appRoot, "vendor/ffmpeg/win32-x64/ffmpeg.exe");
const nativeCore = join(appRoot, "native/bin/win32-x64/hao-core.exe");
const reportRoot = join(appRoot, ".rd/benchmarks/editkin-auto-roto-synthetic-hardcase");
const reportPath = join(reportRoot, "report.json");
const sourcePath = join(reportRoot, "translucent-occlusion.mp4");
const rawPath = join(reportRoot, "translucent-occlusion.rgb24");
const truthPath = join(reportRoot, "truth-alpha8.bin");
const thinPath = join(reportRoot, "truth-thin-detail.bin");
const width = 480; const height = 270; const fps = 24; const analysisFps = 12; const duration = 3; const analysisFrames = duration * analysisFps;

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function run(executable: string, args: string[]): Promise<void> {
  await new Promise<void>((resolveRun, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] }); let stderr = "";
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-8_000); }); child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolveRun() : reject(new Error(stderr)));
  });
}

function blend(rgb: Buffer, pixel: number, color: [number, number, number], alpha: number): void {
  const offset = pixel * 3;
  for (let channel = 0; channel < 3; channel += 1) rgb[offset + channel] = Math.round(rgb[offset + channel] * (1 - alpha) + color[channel] * alpha);
}

function fixture(): { rgb: Buffer; alpha: Buffer; thin: Buffer } {
  const rgb = Buffer.alloc(width * height * fps * duration * 3);
  const alpha = Buffer.alloc(width * height * analysisFrames);
  const thin = Buffer.alloc(width * height * analysisFrames);
  for (let sourceFrame = 0; sourceFrame < fps * duration; sourceFrame += 1) {
    const analysisFrame = Math.floor(sourceFrame / 2);
    const frameRgb = rgb.subarray(sourceFrame * width * height * 3, (sourceFrame + 1) * width * height * 3);
    const frameAlpha = alpha.subarray(analysisFrame * width * height, (analysisFrame + 1) * width * height);
    const frameThin = thin.subarray(analysisFrame * width * height, (analysisFrame + 1) * width * height);
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x; const offset = pixel * 3; const tile = ((x >> 4) + (y >> 4)) % 2;
      frameRgb[offset] = 28 + tile * 34 + Math.round(20 * x / width);
      frameRgb[offset + 1] = 45 + (1 - tile) * 25 + Math.round(26 * y / height);
      frameRgb[offset + 2] = 72 + tile * 28;
    }
    const cx = 82 + analysisFrame * 8; const cy = 135 + Math.round(Math.sin(analysisFrame * .36) * 34);
    const trails = analysisFrame >= 10 && analysisFrame <= 15 ? [24, 16, 8, 0] : [0];
    for (let trailIndex = 0; trailIndex < trails.length; trailIndex += 1) {
      const trail = trails[trailIndex]; const opacityScale = trail === 0 ? 1 : (4 - trailIndex) * .16;
      for (let y = Math.max(0, cy - 62); y < Math.min(height, cy + 63); y += 1) for (let x = Math.max(0, cx - trail - 58); x < Math.min(width, cx - trail + 82); x += 1) {
        const dx = x - (cx - trail); const dy = y - cy; const body = dx * dx / (52 * 52) + dy * dy / (58 * 58) <= 1;
        const border = body && dx * dx / (46 * 46) + dy * dy / (52 * 52) > 1;
        const finger = x >= cx + 40 - trail && x <= cx + 78 - trail && [cy - 34, cy - 17, cy, cy + 17, cy + 34].some((line) => Math.abs(y - line) <= 2);
        if (!body && !finger) continue;
        const pixel = y * width + x; const objectAlpha = (border || finger ? .92 : .56) * opacityScale;
        blend(frameRgb, pixel, finger ? [255, 238, 104] : [64, 232, 228], objectAlpha);
        if (sourceFrame % 2 === 0) {
          frameAlpha[pixel] = Math.max(frameAlpha[pixel], Math.round(255 * objectAlpha));
          if (finger) frameThin[pixel] = Math.max(frameThin[pixel], Math.round(255 * objectAlpha));
        }
      }
    }
    if (analysisFrame >= 16 && analysisFrame <= 21) {
      const full = analysisFrame === 18 || analysisFrame === 19;
      const left = full ? cx - 90 : cx + 5; const right = full ? cx + 100 : cx + 100;
      for (let y = 44; y < 228; y += 1) for (let x = Math.max(0, left); x < Math.min(width, right); x += 1) {
        const pixel = y * width + x; const offset = pixel * 3; const stripe = (x + y) % 19 < 9;
        frameRgb[offset] = stripe ? 218 : 168; frameRgb[offset + 1] = stripe ? 72 : 38; frameRgb[offset + 2] = stripe ? 84 : 52;
        if (sourceFrame % 2 === 0) { frameAlpha[pixel] = 0; frameThin[pixel] = 0; }
      }
    }
  }
  return { rgb, alpha, thin };
}

function jaccard(predicted: Uint8Array, truth: Uint8Array, offset: number): number {
  let intersection = 0; let union = 0;
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const p = predicted[offset + pixel] >= 32; const t = truth[offset + pixel] >= 32;
    if (p && t) intersection += 1; if (p || t) union += 1;
  }
  return union === 0 ? 1 : intersection / union;
}

function mean(values: number[]): number { return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length); }
function evaluate(metrics: { aggregateSupportJ: number; translucentRecall: number; thinDetailRecall: number; motionBlurJ: number; occlusionLeakage: number; reappearanceJ: number; hashBound: boolean }) {
  const checks = {
    aggregateSupportJ: metrics.aggregateSupportJ >= .7, translucentRecall: metrics.translucentRecall >= .75,
    thinDetailRecall: metrics.thinDetailRecall >= .5, motionBlurJ: metrics.motionBlurJ >= .55,
    occlusionLeakage: metrics.occlusionLeakage <= .2, reappearanceJ: metrics.reappearanceJ >= .7, hashBound: metrics.hashBound,
  };
  return { status: Object.values(checks).every(Boolean) ? "GREEN_SYNTHETIC_HARDCASE" : "FAIL", checks };
}

function selfTest(): void {
  const valid = { aggregateSupportJ: .9, translucentRecall: .9, thinDetailRecall: .7, motionBlurJ: .8, occlusionLeakage: .03, reappearanceJ: .9, hashBound: true };
  if (evaluate(valid).status !== "GREEN_SYNTHETIC_HARDCASE") throw new Error("synthetic evaluator rejected valid fixture");
  const mutations = ["aggregateSupportJ", "translucentRecall", "thinDetailRecall", "motionBlurJ", "reappearanceJ"].map((key) => ({ ...valid, [key]: 0 }));
  mutations.push({ ...valid, occlusionLeakage: 1 }, { ...valid, hashBound: false });
  if (mutations.some((value) => evaluate(value).status !== "FAIL")) throw new Error("synthetic evaluator accepted a negative mutation");
  process.stdout.write("AUTO_ROTO_SYNTHETIC_SELF_TEST status=GREEN mutations=7\n");
}

async function main(): Promise<void> {
  await rm(reportRoot, { recursive: true, force: true }); await mkdir(reportRoot, { recursive: true });
  const generated = fixture(); await Promise.all([writeFile(rawPath, generated.rgb), writeFile(truthPath, generated.alpha), writeFile(thinPath, generated.thin)]);
  await run(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pixel_format", "rgb24", "-video_size", `${width}x${height}`, "-framerate", String(fps), "-i", rawPath, "-c:v", "libx264", "-crf", "8", "-pix_fmt", "yuv420p", sourcePath]);
  const manifestPath = join(packRoot, "manifest.json"); const hostScriptPath = join(packRoot, "host/auto-roto-sam21-video-host.py");
  const result = await analyzeAutoRoto({
    sourcePath, sourceStart: 0, duration, fps, sourceWidth: width, sourceHeight: height, initialTime: 0,
    initialRect: { x: 24 / width, y: 70 / height, width: 140 / width, height: 130 / height },
    sourceSha256: sha256(await readFile(sourcePath)), temporalStability: .08, feather: .003, edgeShift: 0, contrast: 1.1,
  }, { ffmpegPath: ffmpeg, nativeCorePath: nativeCore, cacheRoot: join(reportRoot, "cache"), sam21Pack: { trustedRoot: packRoot, manifestPath, hostScriptPath }, routePolicy: { mode: "research", requestedEngine: AUTO_ROTO_SAM21_ENGINE } });
  const predicted = await readFile(result.sequencePath); const frameBytes = width * height;
  const supportJ = Array.from({ length: analysisFrames }, (_, frame) => jaccard(predicted, generated.alpha, frame * frameBytes));
  let translucentHit = 0; let translucentTotal = 0; let thinHit = 0; let thinTotal = 0; let occludedPredicted = 0;
  for (let frame = 0; frame < analysisFrames; frame += 1) for (let pixel = 0; pixel < frameBytes; pixel += 1) {
    const index = frame * frameBytes + pixel; const truth = generated.alpha[index]; const prediction = predicted[index];
    if (truth >= 80 && truth <= 200) { translucentTotal += 1; if (prediction >= 32) translucentHit += 1; }
    if (generated.thin[index] >= 80) { thinTotal += 1; if (prediction >= 32) thinHit += 1; }
    if (frame === 18 || frame === 19) { if (prediction >= 32) occludedPredicted += 1; }
  }
  const nominalSubjectPixels = generated.alpha.subarray(0, frameBytes).filter((value) => value >= 32).length;
  const metrics = {
    aggregateSupportJ: mean(supportJ.filter((_, frame) => frame !== 18 && frame !== 19)),
    translucentRecall: translucentHit / Math.max(1, translucentTotal), thinDetailRecall: thinHit / Math.max(1, thinTotal),
    motionBlurJ: mean(supportJ.slice(10, 16)), occlusionLeakage: occludedPredicted / Math.max(1, nominalSubjectPixels * 2),
    reappearanceJ: mean(supportJ.slice(23, 29)),
    hashBound: result.qualityState === "measured" && result.sequenceSha256 === sha256(predicted) && result.sequenceBytes === predicted.length,
  };
  const verdict = evaluate(metrics);
  const report = {
    schema: "editkin.auto-roto-synthetic-hardcase-gate/v1", ...verdict, metrics,
    perFrameSupportJ: supportJ, result: { engine: result.engine, qualityState: result.qualityState, elapsedMs: result.elapsedMs, model: result.sam2Model },
    artifacts: {
      source: { path: sourcePath, bytes: (await stat(sourcePath)).size, sha256: sha256(await readFile(sourcePath)) },
      truth: { path: truthPath, bytes: generated.alpha.length, sha256: sha256(generated.alpha) },
      thinTruth: { path: thinPath, bytes: generated.thin.length, sha256: sha256(generated.thin) },
      matte: { path: result.sequencePath, bytes: predicted.length, sha256: sha256(predicted) },
    },
    claimBoundary: "Controlled pixel-truth screen for tracking the visible support of a translucent subject, thin details, blur trails, full occlusion and reappearance. It does not claim optical-flow-quality fractional alpha reconstruction or foreground color decontamination.",
  };
  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
  process.stdout.write(`AUTO_ROTO_SYNTHETIC status=${verdict.status} J=${metrics.aggregateSupportJ.toFixed(3)} blur=${metrics.motionBlurJ.toFixed(3)} reappear=${metrics.reappearanceJ.toFixed(3)} report=${reportPath}\n`);
  if (verdict.status === "FAIL") process.exitCode = 1;
}

if (process.argv.includes("--self-test")) selfTest(); else await main();
