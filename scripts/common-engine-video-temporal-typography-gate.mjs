import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { PNG } from "pngjs";

const root = resolve(import.meta.dirname, "..");
const positional = process.argv.find((value, index) => index > 1 && !value.startsWith("--"));
const executable = resolve(positional ?? join(root, "native/bin/win32-x64/editkin-gpu-compositor.exe"));
const evidenceRoot = resolve(root, "../..", ".rd/benchmarks/editkin-common-engine-video-temporal-typography");
const baseline = process.argv.includes("--baseline");
const selfTest = process.argv.includes("--self-test");
const reportPath = join(evidenceRoot, baseline ? "baseline-report.json" : "report.json");
const fixture = resolve(root, "public/demo-source.mp4");
const overlayFixture = resolve(root, "public/benchmarks/layer-overlay.mp4");
const fontRoot = resolve(root, "public/fonts");
const sampleFrame = 24;
const sampleCount = 8;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function graphFor({
  graphId = "decoded-temporal-plus-typography",
  temporal = true,
  typography = true,
  videoOverlay = false,
  captionTimeline = { timelineStartFrame: 8, sourceStartFrame: 0, durationFrames: 40 },
  captionItalic = false,
  captionTranslation,
  motionAnimation = "slide_up",
  reverseTypographyOrder = false,
  budgetMb = 160,
  width = 960,
  height = 540,
} = {}) {
  const nodes = [
    { id: "source", inputs: [], enabled: true, kind: "source", assetId: "video", mediaKind: "video", inputColorSpace: "rec709", timeline: { timelineStartFrame: 0, sourceStartFrame: 0, durationFrames: 60 } },
    { id: "transform", inputs: ["source"], enabled: true, kind: "transform2d", x: 0, y: 0, scaleX: .94, scaleY: .94, rotationRadians: 0, opacity: 1 },
    { id: "color", inputs: ["transform"], enabled: true, kind: "color", processor: "editkin-rec709-primary/v1", inputSpace: "rec709", workingSpace: "rec709", outputSpace: "rec709_sdr" },
  ];
  let tail = "color";
  if (temporal) {
    nodes.push({ id: "motion-blur", inputs: [tail], enabled: true, kind: "motion_blur", shutterAngle: 360, samples: sampleCount, sourceSampling: "decoded_temporal" });
    tail = "motion-blur";
  }
  if (videoOverlay) {
    nodes.push(
      { id: "overlay-source", inputs: [], enabled: true, kind: "source", assetId: "overlay", mediaKind: "video", inputColorSpace: "rec709", timeline: { timelineStartFrame: 0, sourceStartFrame: 0, durationFrames: 60 } },
      { id: "overlay-transform", inputs: ["overlay-source"], enabled: true, kind: "transform2d", x: 285, y: 145, scaleX: .32, scaleY: .32, rotationRadians: 0, opacity: 1 },
      { id: "overlay-color", inputs: ["overlay-transform"], enabled: true, kind: "color", processor: "editkin-rec709-primary/v1", inputSpace: "rec709", workingSpace: "rec709", outputSpace: "rec709_sdr" },
      { id: "video-composite", inputs: [tail, "overlay-color"], enabled: true, kind: "composite", blendMode: "normal", opacity: 1 },
    );
    tail = "video-composite";
  }
  if (typography) {
    const caption = {
      id: "caption", inputs: [], enabled: true, kind: "caption", cueId: "caption-single-colour", text: "字幕保持單色",
      timeline: captionTimeline, fontFamily: "Noto Sans TC", fontSize: 44, textColor: "#FFFFFFFF",
      outlineColor: "#000000FF", outlineWidth: 3, backgroundColor: "#00000000", alignment: 2,
      marginVertical: 44, bold: true, italic: captionItalic, shadow: 1, letterSpacing: 0,
      ...(captionTranslation === undefined ? {} : { translation: captionTranslation }),
    };
    const graphic = {
      id: "motion-graphic", inputs: [], enabled: true, kind: "motion_graphic", graphicId: "title-card", graphicKind: "card", text: "關鍵重點",
      timeline: { timelineStartFrame: 12, sourceStartFrame: 0, durationFrames: 36 }, x: .08, y: .09, width: .48,
      fontSize: 54, fontFamily: "Noto Sans TC", fontWeight: 800, letterSpacing: 0, outlineWidth: 3,
      shadowDepth: 3, cornerRadius: 18, textColor: "#FFFFFFFF", backgroundColor: "#10151FEE",
      accentColor: "#A8FF3EFF", animation: motionAnimation, trackingMode: "anchor", offsetX: 0, offsetY: 0,
    };
    const ordered = reverseTypographyOrder ? [graphic, caption] : [caption, graphic];
    for (const overlay of ordered) {
      nodes.push(overlay);
      const composite = `composite-${overlay.id}`;
      nodes.push({ id: composite, inputs: [tail, overlay.id], enabled: true, kind: "composite", blendMode: "normal", opacity: 1 });
      tail = composite;
    }
  }
  nodes.push({ id: "output", inputs: [tail], enabled: true, kind: "output", format: "rgba16_float" });
  return { schema: "editkin.engine-graph/v1", graphId, width, height, timebase: { numerator: 1, denominator: 30 }, workingFormat: "rgba16_float", cacheBudgetMb: budgetMb, nodes, outputNode: "output" };
}

function changedStats(leftBytes, rightBytes) {
  const left = PNG.sync.read(leftBytes); const right = PNG.sync.read(rightBytes);
  if (left.width !== right.width || left.height !== right.height) throw new Error("temporal typography artifacts differ in dimensions");
  let changedPixels = 0; let highDeltaPixels = 0; let upperChangedPixels = 0; let lowerChangedPixels = 0;
  for (let y = 0; y < left.height; y += 1) for (let x = 0; x < left.width; x += 1) {
    const offset = (y * left.width + x) * 4;
    const delta = Math.abs(left.data[offset] - right.data[offset]) + Math.abs(left.data[offset + 1] - right.data[offset + 1]) + Math.abs(left.data[offset + 2] - right.data[offset + 2]);
    if (delta > 8) { changedPixels += 1; if (y < left.height * .45) upperChangedPixels += 1; else lowerChangedPixels += 1; }
    if (delta > 48) highDeltaPixels += 1;
  }
  return { changedPixels, highDeltaPixels, upperChangedPixels, lowerChangedPixels };
}

function assertGreen(report) {
  if (report.schema !== "editkin.common-engine-video-temporal-typography-gate/v1" || report.status !== "GREEN") throw new Error("temporal typography report is not GREEN");
  if (!report.directExecution || report.videoLayerCount !== 1 || report.compositeLayerCount !== 3) throw new Error("temporal typography graph did not execute as one video plus two overlays");
  if (report.combinedVideoLayerCount !== 2 || report.combinedCompositeLayerCount !== 4 || report.combinedOverlayChangedPixels < 500) throw new Error("temporal typography did not remain resident with the independent video overlay");
  if (report.temporalSampling?.sampleCount !== sampleCount || report.temporalSampling?.distinctDecodedTimestampCount < 2 || report.temporalSampling?.residentFrameRingSize < sampleCount) throw new Error("decoded temporal receipt is incomplete");
  if (report.captionCount !== 1 || report.motionGraphicCount !== 1 || report.captionTextureUploads !== 1 || report.motionGraphicTextureUploads !== 1) throw new Error("typography textures were not admitted exactly once");
  if (report.activeCaptionCount !== 1 || report.activeMotionGraphicCount !== 1 || report.captionTextColor !== "#FFFFFFFF" || report.captionTranslation !== null) throw new Error("single-colour caption or active typography receipt is incorrect");
  if (!report.repeatExact || report.temporalVsCurrent.changedPixels < 500 || report.typographyVsTemporal.changedPixels < 1000 || report.typographyVsTemporal.upperChangedPixels < 500 || report.typographyVsTemporal.lowerChangedPixels < 300) throw new Error("artifact or determinism oracle failed");
  if (report.presentedFrames < 30 || report.presentP95Ms > 25 || report.productPathCpuPixelCopies !== 0 || report.rejectedNegativeControls.length !== 5 || report.releaseFences?.pendingFenceCount !== 0) throw new Error("realtime, zero-copy, fail-closed, or fence evidence is incomplete");
}

function syntheticSelfTest() {
  const valid = {
    schema: "editkin.common-engine-video-temporal-typography-gate/v1", status: "GREEN", directExecution: true,
    videoLayerCount: 1, compositeLayerCount: 3, combinedVideoLayerCount: 2, combinedCompositeLayerCount: 4, combinedOverlayChangedPixels: 1000, temporalSampling: { sampleCount, distinctDecodedTimestampCount: 2, residentFrameRingSize: 8 },
    captionCount: 1, motionGraphicCount: 1, captionTextureUploads: 1, motionGraphicTextureUploads: 1,
    activeCaptionCount: 1, activeMotionGraphicCount: 1, captionTextColor: "#FFFFFFFF", captionTranslation: null,
    repeatExact: true, temporalVsCurrent: { changedPixels: 1000 }, typographyVsTemporal: { changedPixels: 3000, upperChangedPixels: 1800, lowerChangedPixels: 900 },
    presentedFrames: 30, presentP95Ms: 20, productPathCpuPixelCopies: 0,
    rejectedNegativeControls: ["caption-range", "caption-translation", "caption-italic", "overlay-order", "budget"], releaseFences: { pendingFenceCount: 0 },
  };
  assertGreen(valid); let calibratedNegatives = 0;
  for (const negative of [
    { ...valid, status: "BLOCK" }, { ...valid, compositeLayerCount: 2 }, { ...valid, combinedCompositeLayerCount: 3 },
    { ...valid, activeCaptionCount: 0 }, { ...valid, typographyVsTemporal: { changedPixels: 0, upperChangedPixels: 0, lowerChangedPixels: 0 } },
    { ...valid, captionTextColor: "#FF0000FF" }, { ...valid, presentP95Ms: 26 }, { ...valid, productPathCpuPixelCopies: 1 },
  ]) { let rejected = false; try { assertGreen(negative); } catch { rejected = true; calibratedNegatives += 1; } if (!rejected) throw new Error("temporal typography evaluator accepted a calibrated negative"); }
  console.log(JSON.stringify({ status: "GREEN", evaluator: valid.schema, calibratedNegatives }));
}

async function run() {
  const temporary = await mkdtemp(join(tmpdir(), "editkin-temporal-typography-"));
  const child = spawn(executable, ["serve"], { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, EDITKIN_FONT_ROOT: fontRoot } });
  const lines = createInterface({ input: child.stdout }); const pending = new Map(); let stderr = ""; let readyResolve;
  const ready = new Promise((resolvePromise) => { readyResolve = resolvePromise; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  lines.on("line", (line) => { const message = JSON.parse(line); if (message.event === "ready") readyResolve(message); else { const handler = pending.get(message.id); if (handler) { pending.delete(message.id); handler(message); } } });
  let sequence = 0;
  const request = (command, payload = {}) => new Promise((resolvePromise, reject) => {
    const id = `temporal-typography-${++sequence}`; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${command} timed out: ${stderr}`)); }, 60_000);
    pending.set(id, (message) => { clearTimeout(timer); resolvePromise(message); }); child.stdin.write(`${JSON.stringify({ id, command, ...payload })}\n`);
  });
  try {
    await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error(`sidecar did not become ready: ${stderr}`)), 30_000))]);
    const bindingsPath = join(temporary, "bindings.json"); await writeFile(bindingsPath, JSON.stringify({ video: fixture, overlay: overlayFixture }));
    const graphPath = join(temporary, "mixed.json"); await writeFile(graphPath, JSON.stringify(graphFor()));
    await request("surface_bind", { parentHwnd: "0", x: 40, y: 40, width: 96, height: 54 });
    const loaded = await request("engine_video_load", { sessionId: "mixed", graphPath, bindingsPath, timelineFrame: sampleFrame });
    if (baseline) {
      await request("surface_release"); await request("shutdown");
      return { status: "BLOCK", expectedContract: "decoded-temporal-plus-typography/v1", loadOk: loaded.ok, reason: loaded.ok ? "old executor accepted an unverified temporal typography topology" : loaded.error, rejected: !loaded.ok && /caption|motion-graphic/.test(String(loaded.error)) };
    }
    if (!loaded.ok) throw new Error(`temporal typography load failed: ${JSON.stringify(loaded)}`);
    const controls = [
      ["repeat", graphFor({ graphId: "repeat" })],
      ["temporal", graphFor({ graphId: "temporal-only", typography: false })],
      ["current", graphFor({ graphId: "current-only", typography: false, temporal: false })],
      ["combined", graphFor({ graphId: "temporal-video-typography", videoOverlay: true, budgetMb: 192 })],
    ];
    for (const [id, graph] of controls) { const path = join(temporary, `${id}.json`); await writeFile(path, JSON.stringify(graph)); const response = await request("engine_video_load", { sessionId: id, graphPath: path, bindingsPath, timelineFrame: sampleFrame }); if (!response.ok) throw new Error(`${id} control load failed: ${JSON.stringify(response)}`); }
    const outputs = Object.fromEntries(["mixed", "repeat", "temporal", "current", "combined"].map((id) => [id, join(temporary, `${id}.png`)]));
    const verified = {};
    for (const id of Object.keys(outputs)) { verified[id] = await request("engine_video_verify_frame", { sessionId: id, timelineFrame: sampleFrame, toleranceSeconds: 1 / 60, outputPath: outputs[id] }); if (!verified[id].ok) throw new Error(`${id} verification failed: ${JSON.stringify(verified[id])}`); }
    const bytes = Object.fromEntries(await Promise.all(Object.entries(outputs).map(async ([id, path]) => [id, await readFile(path)])));
    await mkdir(evidenceRoot, { recursive: true }); await Promise.all(Object.entries(bytes).map(([id, value]) => writeFile(join(evidenceRoot, `${id}-frame-${sampleFrame}.png`), value)));
    const times = []; let last;
    for (let index = 0; index < 34; index += 1) { const started = performance.now(); last = await request("engine_video_present_frame", { sessionId: "combined", timelineFrame: 10 + index % 34, toleranceSeconds: 1 / 60 }); if (!last.ok) throw new Error(`temporal video typography present failed: ${JSON.stringify(last)}`); if (index >= 4) times.push(performance.now() - started); }
    times.sort((left, right) => left - right);
    const rejectedNegativeControls = [];
    async function negative(name, graph, marker) { const path = join(temporary, `negative-${name}.json`); await writeFile(path, JSON.stringify(graph)); const response = await request("engine_video_load", { sessionId: `negative-${name}`, graphPath: path, bindingsPath, timelineFrame: sampleFrame }); if (response.ok || !String(response.error).includes(marker)) throw new Error(`negative ${name} was not rejected: ${JSON.stringify(response)}`); rejectedNegativeControls.push(name); }
    await negative("caption-range", graphFor({ graphId: "negative-caption-range", captionTimeline: { timelineStartFrame: 50, sourceStartFrame: 0, durationFrames: 20 } }), "timeline must be fully covered");
    await negative("caption-translation", graphFor({ graphId: "negative-caption-translation", captionTranslation: "No multicolour bilingual stacking" }), "translation requires");
    await negative("caption-italic", graphFor({ graphId: "negative-caption-italic", captionItalic: true }), "italic variants");
    await negative("overlay-order", graphFor({ graphId: "negative-overlay-order", reverseTypographyOrder: true }), "captions must precede motion graphic");
    await negative("budget", graphFor({ graphId: "negative-budget", width: 1920, height: 1080, budgetMb: 64 }), "resource budget is insufficient");
    await request("engine_video_release", { sessionId: "mixed" }); for (const id of ["repeat", "temporal", "current"]) await request("engine_video_release", { sessionId: id }); const released = await request("engine_video_release", { sessionId: "combined" }); await request("surface_release"); await request("shutdown");
    const result = verified.mixed.result; const temporalSampling = result.temporalSampling; const activeCaption = result.activeCaptions?.[0];
    return {
      status: "GREEN", directExecution: loaded.result.engineGraph.directExecution, videoLayerCount: loaded.result.layerCount,
      compositeLayerCount: result.compositeLayerCount, compositeExecutionMode: result.compositeExecutionMode,
      combinedVideoLayerCount: verified.combined.result.layers?.length ?? 0,
      combinedCompositeLayerCount: verified.combined.result.compositeLayerCount,
      combinedOverlayChangedPixels: changedStats(bytes.mixed, bytes.combined).changedPixels,
      temporalSampling, captionCount: loaded.result.captionCount, motionGraphicCount: loaded.result.motionGraphicCount,
      captionTextureUploads: result.captionTextureUploads, motionGraphicTextureUploads: result.motionGraphicTextureUploads,
      activeCaptionCount: result.activeCaptions?.length ?? 0, activeMotionGraphicCount: result.activeMotionGraphics?.length ?? 0,
      captionTextColor: activeCaption?.textColor ?? null, captionTranslation: activeCaption?.translation ?? null,
      repeatExact: sha256(bytes.mixed) === sha256(bytes.repeat), temporalVsCurrent: changedStats(bytes.current, bytes.temporal),
      typographyVsTemporal: changedStats(bytes.temporal, bytes.mixed), artifacts: Object.fromEntries(Object.entries(bytes).map(([id, value]) => [`${id}Sha256`, sha256(value)])),
      presentedFrames: times.length, presentP50Ms: times[Math.floor(times.length * .5)], presentP95Ms: times[Math.floor((times.length - 1) * .95)],
      productPathCpuPixelCopies: Math.max(last.result.productPathCpuPixelCopies ?? 0, temporalSampling.productPathCpuPixelCopies ?? 0, ...last.result.layerFrames.map((frame) => Math.max(frame.decodePathCpuPixelCopies ?? 0, frame.stagingCpuPixelReadbacks ?? 0))),
      rejectedNegativeControls, releaseFences: released.result.fences,
    };
  } finally {
    lines.close();
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    if (child.exitCode === null) child.kill();
    child.removeAllListeners();
    await rm(temporary, { recursive: true, force: true });
  }
}

async function main() {
  if (selfTest) return syntheticSelfTest();
  const observed = await run(); const report = { schema: "editkin.common-engine-video-temporal-typography-gate/v1", measuredAt: new Date().toISOString(), executable, executableSha256: sha256(await readFile(executable)), ...observed };
  await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`); if (!baseline) assertGreen(report); console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => { console.error(error.stack ?? error); process.exitCode = 1; });
