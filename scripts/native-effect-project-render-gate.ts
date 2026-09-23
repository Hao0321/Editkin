import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createEmptyProject, validateProject } from "../src/domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../src/domain/types";
import { renderProject } from "../src/render/ffmpeg";
import { renderNativeEffectPreviewProxy } from "../src/plugins/nativeEffectRender";

const root = resolve(import.meta.dirname, "..");
const evidence = resolve(root, "../../.rd/benchmarks/editkin-native-effect-project-render");
const ffmpeg = join(root, "vendor/ffmpeg/win32-x64/ffmpeg.exe");
const ffprobe = join(root, "vendor/ffmpeg/win32-x64/ffprobe.exe");
const core = join(root, "native/bin/win32-x64/hao-core.exe");
const baselineCore = resolve(root, "../../.rd/baselines/hao-core-pre-effect-sequence.exe");
const pluginLibrarySource = join(root, "native/effect-test-plugin/target/release/editkin_effect_test_plugin.dll");

function run(executable: string, args: string[], timeoutMs = 30_000): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${basename(executable)} timeout`)); }, timeoutMs);
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-20_000); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else reject(new Error(`${basename(executable)} exit ${code}: ${stderr}`));
    });
  });
}

await rm(evidence, { recursive: true, force: true });
await mkdir(evidence, { recursive: true });
const pluginRoot = join(evidence, "plugins/diagnostic-native-effect");
await mkdir(join(pluginRoot, "bin"), { recursive: true });
const libraryPath = join(pluginRoot, "bin/editkin_effect_test_plugin.dll");
await copyFile(pluginLibrarySource, libraryPath);
const librarySha256 = createHash("sha256").update(await readFile(libraryPath)).digest("hex");
const manifest = {
  schema: "editkin.plugin/v1",
  id: "editkin.diagnostic.native-effect",
  name: "Diagnostic Native Gain",
  version: "2.0.0",
  minimumHostVersion: "0.15.0",
  publisher: { name: "Editkin Gate" },
  license: { spdx: "MIT", commercialUse: true },
  permissions: ["render.effect"],
  capabilities: [{
    id: "gain-invert",
    name: "Gain Invert",
    description: "Gate-only native pixel effect",
    kind: "effect",
    automation: "manual",
    semanticRoles: ["diagnostic"],
    formats: ["any"],
    requires: [],
    avoidWhen: [],
    parameters: [
      { id: "gain", name: "Gain", type: "number", default: 0.8, min: 0, max: 2 },
      { id: "invert", name: "Invert", type: "number", default: 0.25, min: 0, max: 1 },
      { id: "fault", name: "Fault", type: "number", default: 0, min: 0, max: 3 },
    ],
    runtime: {
      type: "native_effect",
      abiVersion: 2,
      entrySymbol: "editkin_effect_plugin_v2",
      libraries: { "win32-x64": { path: "bin/editkin_effect_test_plugin.dll", sha256: librarySha256 } },
      supportedFormats: ["rgba32_float"],
      maxTemporalRadius: 0,
      timeoutMs: 100,
    },
  }],
};
const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
const manifestSha256 = createHash("sha256").update(manifestText).digest("hex");
await writeFile(join(pluginRoot, "editkin-plugin.json"), manifestText, "utf8");

const width = 64;
const height = 36;
const fps = 30;
const frameCount = 12;
const source = Buffer.alloc(width * height * 4 * frameCount);
for (let frame = 0; frame < frameCount; frame += 1) {
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (frame * width * height + y * width + x) * 4;
      source[offset] = (frame * 13 + Math.floor(x / 8) * 21) % 220;
      source[offset + 1] = (32 + frame * 7 + Math.floor(y / 6) * 19) % 220;
      source[offset + 2] = (70 + frame * 5 + Math.floor((x + y) / 10) * 17) % 220;
      source[offset + 3] = 255;
    }
  }
}
const rawSource = join(evidence, "source.rgba8");
const sourceVideo = join(evidence, "source.mkv");
await writeFile(rawSource, source);
await run(ffmpeg, [
  "-y", "-hide_banner", "-loglevel", "error",
  "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", `${width}x${height}`, "-framerate", String(fps), "-i", rawSource,
  "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${frameCount / fps}`,
  "-frames:v", String(frameCount), "-map", "0:v:0", "-map", "1:a:0", "-c:v", "ffv1", "-level", "3", "-pix_fmt", "bgra", "-c:a", "pcm_s16le", sourceVideo,
]);
const adapterSourcePath = join(evidence, "adapter-source.rgba8");
await run(ffmpeg, [
  "-y", "-hide_banner", "-loglevel", "error", "-nostdin", "-ss", "0", "-i", sourceVideo,
  "-an", "-sn", "-dn", "-vf", `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black@0,setsar=1,fps=${fps},format=rgba`,
  "-frames:v", String(frameCount), "-f", "rawvideo", "-pix_fmt", "rgba", adapterSourcePath,
]);
const adapterSource = await readFile(adapterSourcePath);
if (adapterSource.length !== source.length) throw new Error(`adapter source byte length ${adapterSource.length} != ${source.length}`);

const project = createEmptyProject("Native Effect Render Gate", { id: "native-effect-render-gate", width, height, fps });
project.assets.push({ id: "source", name: "source", kind: "video", uri: sourceVideo, duration: frameCount / fps, width, height, color: { interpretation: "rec709" } });
project.tracks[0].clips.push({
  id: "clip-native-effect", assetId: "source", trackId: project.tracks[0].id,
  timelineStart: 0, sourceStart: 0, duration: frameCount / fps, volume: 1,
  transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [],
  creative: {
    effectPresetIds: [],
    nativeEffectInstances: [{
      id: "native-gain-1",
      pluginId: manifest.id,
      capabilityId: "gain-invert",
      pluginVersion: manifest.version,
      manifestSha256,
      enabled: true,
      parameters: { gain: 0.8, invert: 0.25, fault: 0 },
    }],
  },
});
validateProject(project);

let baselineError = "";
try {
  await renderProject(project, join(evidence, "baseline.mp4"), {
    ffmpegPath: ffmpeg, ffprobePath: ffprobe, nativeCorePath: baselineCore,
    pluginRoots: [join(evidence, "plugins")], preferGpu: false, timeoutMs: 60_000,
  });
} catch (error) { baselineError = error instanceof Error ? error.message : String(error); }
if (!baselineError.includes("usage: hao-core") && !baselineError.includes("effect-plugin-sequence-run")) throw new Error(`historical core did not block project effect adapter: ${baselineError}`);
const baselineReport = {
  schemaVersion: 1,
  status: "BLOCK",
  coreSha256: createHash("sha256").update(await readFile(baselineCore)).digest("hex"),
  observedError: baselineError.slice(-1_000),
};
await writeFile(join(evidence, "baseline-report.json"), `${JSON.stringify(baselineReport, null, 2)}\n`);

const output = join(evidence, "project-output.mp4");
const result = await renderProject(project, output, {
  ffmpegPath: ffmpeg, ffprobePath: ffprobe, nativeCorePath: core,
  pluginRoots: [join(evidence, "plugins")], preferGpu: false, timeoutMs: 60_000,
});
const effectReceipt = result.nativeEffects;
if (!effectReceipt || effectReceipt.status !== "GREEN" || effectReceipt.clipCount !== 1 || effectReceipt.instanceCount !== 1) throw new Error("missing project native effect receipt");
const worker = effectReceipt.clips[0].instances[0].worker as { frameCount?: number; libraryLoads?: number; firstFrameIndex?: number; lastFrameIndex?: number; outputSha256?: string };
if (worker.frameCount !== frameCount || worker.libraryLoads !== 1 || worker.firstFrameIndex !== 0 || worker.lastFrameIndex !== frameCount - 1) throw new Error("native effect worker receipt mismatch");

const expectedFloat = Buffer.alloc(adapterSource.length * 4);
for (let index = 0; index < adapterSource.length; index += 4) {
  for (let channel = 0; channel < 3; channel += 1) {
    const base = Math.fround(adapterSource[index + channel] / 255);
    const inverted = Math.fround(1 - base);
    const expected = Math.fround(Math.fround(base + Math.fround(Math.fround(inverted - base) * Math.fround(0.25))) * Math.fround(0.8));
    expectedFloat.writeFloatLE(expected, (index + channel) * 4);
  }
  expectedFloat.writeFloatLE(1, (index + 3) * 4);
}
const expectedFloatSha256 = createHash("sha256").update(expectedFloat).digest("hex");
if (worker.outputSha256 !== expectedFloatSha256) throw new Error(`worker pixel hash ${worker.outputSha256} != ${expectedFloatSha256}`);

const decodedOutput = join(evidence, "project-output.rgba8");
await run(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-i", output, "-an", "-frames:v", String(frameCount), "-f", "rawvideo", "-pix_fmt", "rgba", decodedOutput]);
const decoded = await readFile(decodedOutput);
if (decoded.length !== adapterSource.length) throw new Error(`delivered frame byte length ${decoded.length} != ${adapterSource.length}`);
let absoluteError = 0;
let maximumError = 0;
const pixelErrors: number[] = [];
for (let index = 0; index < decoded.length; index += 4) {
  for (let channel = 0; channel < 3; channel += 1) {
    const expected = Math.round(expectedFloat.readFloatLE((index + channel) * 4) * 255);
    const error = Math.abs(decoded[index + channel] - expected);
    absoluteError += error;
    maximumError = Math.max(maximumError, error);
    pixelErrors.push(error);
  }
}
const meanAbsoluteError = absoluteError / (frameCount * width * height * 3);
pixelErrors.sort((left, right) => left - right);
const p99Error = pixelErrors[Math.ceil(pixelErrors.length * 0.99) - 1];
if (meanAbsoluteError > 5 || p99Error > 16) throw new Error(`delivered pixel error mean=${meanAbsoluteError} p99=${p99Error} max=${maximumError}`);
const deliveredAudioPath = join(evidence, "project-output.s16le");
await run(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-i", output, "-map", "0:a:0", "-f", "s16le", "-acodec", "pcm_s16le", "-ac", "1", "-ar", "48000", deliveredAudioPath]);
const deliveredAudio = await readFile(deliveredAudioPath);
let audioEnergy = 0;
for (let offset = 0; offset + 1 < deliveredAudio.length; offset += 2) audioEnergy += deliveredAudio.readInt16LE(offset) ** 2;
const deliveredAudioRms = Math.sqrt(audioEnergy / Math.max(1, deliveredAudio.length / 2));
if (deliveredAudioRms < 100) throw new Error(`native effect materialization lost source audio: rms=${deliveredAudioRms}`);

const previewRuntime = {
  ffmpegPath: ffmpeg,
  nativeCorePath: core,
  pluginRoots: [join(evidence, "plugins")],
  cacheRoot: join(evidence, "preview-cache"),
  timeoutMs: 60_000,
};
const previewFirst = await renderNativeEffectPreviewProxy(project, "clip-native-effect", previewRuntime);
const previewSecond = await renderNativeEffectPreviewProxy(project, "clip-native-effect", previewRuntime);
if (previewFirst.cacheHit || !previewSecond.cacheHit || previewFirst.cacheKey !== previewSecond.cacheKey || previewFirst.sha256 !== previewSecond.sha256) {
  throw new Error("native effect preview cache miss/hit contract failed");
}
if (previewFirst.mode !== "cached-cpu-native-sequence/v1" || previewFirst.effectReceipt.clips[0].instances[0].worker == null) {
  throw new Error("native effect preview did not preserve formal sequence receipt");
}
const previewDecodedPath = join(evidence, "preview-output.rgba8");
await run(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-i", previewFirst.path, "-an", "-frames:v", String(frameCount), "-f", "rawvideo", "-pix_fmt", "rgba", previewDecodedPath]);
const previewDecoded = await readFile(previewDecodedPath);
if (previewDecoded.length !== adapterSource.length) throw new Error(`preview frame byte length ${previewDecoded.length} != ${adapterSource.length}`);
let previewAbsoluteError = 0;
const previewPixelErrors: number[] = [];
for (let index = 0; index < previewDecoded.length; index += 4) {
  for (let channel = 0; channel < 3; channel += 1) {
    const expected = Math.round(expectedFloat.readFloatLE((index + channel) * 4) * 255);
    const error = Math.abs(previewDecoded[index + channel] - expected);
    previewAbsoluteError += error;
    previewPixelErrors.push(error);
  }
}
previewPixelErrors.sort((left, right) => left - right);
const previewMeanAbsoluteError = previewAbsoluteError / (frameCount * width * height * 3);
const previewP99Error = previewPixelErrors[Math.ceil(previewPixelErrors.length * 0.99) - 1];
if (previewMeanAbsoluteError > 5 || previewP99Error > 16) throw new Error(`preview pixel error mean=${previewMeanAbsoluteError} p99=${previewP99Error}`);
const previewAudioPath = join(evidence, "preview-output.s16le");
await run(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-i", previewFirst.path, "-map", "0:a:0", "-f", "s16le", "-acodec", "pcm_s16le", "-ac", "1", "-ar", "48000", previewAudioPath]);
const previewAudio = await readFile(previewAudioPath);
let previewAudioEnergy = 0;
for (let offset = 0; offset + 1 < previewAudio.length; offset += 2) previewAudioEnergy += previewAudio.readInt16LE(offset) ** 2;
const previewAudioRms = Math.sqrt(previewAudioEnergy / Math.max(1, previewAudio.length / 2));
if (!previewFirst.audioSourceRetained || previewAudioRms < 100) throw new Error(`cached preview lost source audio: receipt=${previewFirst.audioSourceRetained} rms=${previewAudioRms}`);
await writeFile(previewFirst.path, "corrupt", "utf8");
const previewRegenerated = await renderNativeEffectPreviewProxy(project, "clip-native-effect", previewRuntime);
if (previewRegenerated.cacheHit || previewRegenerated.sha256 !== previewFirst.sha256 || (await readFile(previewRegenerated.path)).length <= 7) {
  throw new Error("corrupt native preview cache was not regenerated atomically");
}

async function expectPreviewFailure(name: string, candidate: typeof project, expected: string, runtime = previewRuntime): Promise<string> {
  const cacheRoot = join(evidence, `negative-preview-${name}`);
  let message = "";
  try {
    await renderNativeEffectPreviewProxy(candidate, "clip-native-effect", { ...runtime, cacheRoot });
  } catch (error) { message = error instanceof Error ? error.message : String(error); }
  if (!message.includes(expected)) throw new Error(`${name} preview did not fail with ${expected}: ${message}`);
  const entries = await readdir(cacheRoot, { recursive: true }).catch(() => []);
  if (entries.some((entry) => /\.mp4$|\.json$|\.lock$|^\.work-/i.test(String(entry)))) throw new Error(`${name} preview promoted a cache artifact: ${entries.join(",")}`);
  return `preview-${name}`;
}

async function expectRenderFailure(name: string, candidate: typeof project, expected: string, pluginRoots = [join(evidence, "plugins")]): Promise<string> {
  const path = join(evidence, `${name}.mp4`);
  let message = "";
  try {
    await renderProject(candidate, path, { ffmpegPath: ffmpeg, ffprobePath: ffprobe, nativeCorePath: core, pluginRoots, preferGpu: false, timeoutMs: 60_000 });
  } catch (error) { message = error instanceof Error ? error.message : String(error); }
  if (!message.includes(expected)) throw new Error(`${name} did not fail with ${expected}: ${message}`);
  try { await access(path); throw new Error(`${name} left a promoted output`); } catch (error) {
    if (error instanceof Error && error.message.includes("left a promoted output")) throw error;
  }
  return name;
}
const negativeControls = ["historical-core-block"];
negativeControls.push(await expectPreviewFailure("historical-core", project, "usage: hao-core", { ...previewRuntime, nativeCorePath: baselineCore }));
const stale = structuredClone(project);
stale.tracks[0].clips[0].creative!.nativeEffectInstances![0].manifestSha256 = "0".repeat(64);
negativeControls.push(await expectRenderFailure("stale-manifest-identity", stale, "identity"));
negativeControls.push(await expectPreviewFailure("stale-manifest-identity", stale, "identity"));
const invalidOutput = structuredClone(project);
invalidOutput.tracks[0].clips[0].creative!.nativeEffectInstances![0].parameters.fault = 3;
negativeControls.push(await expectRenderFailure("invalid-native-output", invalidOutput, "invalid RGBA32F"));
negativeControls.push(await expectPreviewFailure("invalid-native-output", invalidOutput, "invalid RGBA32F"));
const aces = structuredClone(project);
aces.colorManagement = { mode: "aces2", workingSpace: "ACEScct", outputTransform: "rec709_sdr", configId: "studio-config-v4.0.0_aces-v2.0_ocio-v2.5" };
negativeControls.push(await expectRenderFailure("unowned-aces-contract", aces, "ACES scene-linear"));
negativeControls.push(await expectPreviewFailure("unowned-aces-contract", aces, "ACES scene-linear"));
negativeControls.push(await expectRenderFailure("missing-plugin-root", project, "缺少 Plugin runtime", []));
negativeControls.push(await expectPreviewFailure("missing-plugin-root", project, "缺少 Plugin runtime", { ...previewRuntime, pluginRoots: [] }));

const report = {
  schemaVersion: 1,
  status: "GREEN",
  projectSchemaVersion: project.schemaVersion,
  projectRevision: project.revision,
  clipCount: effectReceipt.clipCount,
  instanceCount: effectReceipt.instanceCount,
  frameCount,
  libraryLoads: worker.libraryLoads,
  workerOutputSha256: worker.outputSha256,
  expectedFloatSha256,
  deliveredMeanAbsoluteError: meanAbsoluteError,
  deliveredP99Error: p99Error,
  deliveredMaximumError: maximumError,
  deliveredAudioRms,
  preview: {
    mode: previewFirst.mode,
    firstCacheHit: previewFirst.cacheHit,
    secondCacheHit: previewSecond.cacheHit,
    corruptCacheRegenerated: !previewRegenerated.cacheHit,
    cacheKey: previewFirst.cacheKey,
    sha256: previewFirst.sha256,
    meanAbsoluteError: previewMeanAbsoluteError,
    p99Error: previewP99Error,
    audioRms: previewAudioRms,
    audioSourceRetained: previewFirst.audioSourceRetained,
  },
  planner: result.planner,
  outputSha256: createHash("sha256").update(await readFile(output)).digest("hex"),
  coreSha256: createHash("sha256").update(await readFile(core)).digest("hex"),
  negativeControls,
  evidence: join(evidence, "report.json"),
};
await writeFile(join(evidence, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report)}\n`);
