import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { PNG } from "pngjs";

const root = resolve(import.meta.dirname, "..");
const executable = resolve(process.argv.find((value, index) => index > 1 && !value.startsWith("--")) ?? join(root, "native/bin/win32-x64/editkin-gpu-compositor.exe"));
const evidenceRoot = resolve(root, "../..", ".rd/benchmarks/editkin-common-engine-video-caption");
const baseline = process.argv.includes("--baseline");
const selfTest = process.argv.includes("--self-test");
const reportPath = join(evidenceRoot, baseline ? "baseline-report.json" : "report.json");
const fixture = resolve(root, "public/demo-source.mp4");
const fontRoot = resolve(root, "public/fonts");
const caption = { id: "caption", inputs: [], enabled: true, kind: "caption", cueId: "cue", text: "字幕千萬不要多色", timeline: { timelineStartFrame: 15, sourceStartFrame: 0, durationFrames: 45 }, fontFamily: "Noto Sans TC", fontSize: 54, textColor: "#FFFFFFFF", outlineColor: "#000000FF", outlineWidth: 3, backgroundColor: "#000000A6", alignment: 2, marginVertical: 42, bold: false, italic: false };

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function graphFor(captions = [caption], graphId = "video-caption") {
  const nodes = [
    { id: "source", inputs: [], enabled: true, kind: "source", assetId: "video", mediaKind: "video", inputColorSpace: "rec709", timeline: { timelineStartFrame: 0, sourceStartFrame: 0, durationFrames: 90 } },
    { id: "transform", inputs: ["source"], enabled: true, kind: "transform2d", x: 0, y: 0, scaleX: 1, scaleY: 1, rotationRadians: 0, opacity: 1 },
    { id: "color", inputs: ["transform"], enabled: true, kind: "color", processor: "editkin-rec709-primary/v1", inputSpace: "rec709", workingSpace: "rec709", outputSpace: "rec709_sdr" },
  ];
  let tail = "color";
  captions.forEach((item, index) => { nodes.push(item); const composite = { id: `composite-${index}`, inputs: [tail, item.id], enabled: true, kind: "composite", blendMode: "normal", opacity: 1 }; nodes.push(composite); tail = composite.id; });
  nodes.push({ id: "output", inputs: [tail], enabled: true, kind: "output", format: "rgba16_float" });
  return { schema: "editkin.engine-graph/v1", graphId, width: 960, height: 540, timebase: { numerator: 1, denominator: 30 }, workingFormat: "rgba16_float", cacheBudgetMb: 64, nodes, outputNode: "output" };
}
function changedStats(baseBytes, captionBytes) {
  const base = PNG.sync.read(baseBytes); const styled = PNG.sync.read(captionBytes); let changed = 0; let outside = 0; let white = 0; let dark = 0; let changedBottom = 0; const pixels = base.width * base.height;
  for (let y = 0; y < base.height; y += 1) for (let x = 0; x < base.width; x += 1) {
    const offset = (y * base.width + x) * 4; const delta = [0, 1, 2].some((channel) => Math.abs(base.data[offset + channel] - styled.data[offset + channel]) > 8);
    if (delta) { changed += 1; if (y >= 360) changedBottom += 1; else outside += 1; }
    const [r, g, b] = [styled.data[offset], styled.data[offset + 1], styled.data[offset + 2]];
    if (y >= 360 && r > 220 && g > 220 && b > 220 && Math.max(r, g, b) - Math.min(r, g, b) <= 8) white += 1;
    if (y >= 360 && r < 45 && g < 45 && b < 45) dark += 1;
  }
  return { changedPixelRatio: changed / pixels, changedBottomRatio: changedBottom / (base.width * 180), outsideChangedRatio: outside / (base.width * 360), whiteTextPixels: white, darkBackgroundPixels: dark };
}
function assertGreen(report) {
  if (report.schema !== "editkin.common-engine-video-caption-gate/v1" || report.status !== "GREEN") throw new Error("caption report is not GREEN");
  if (!report.directExecution || !report.requiredNodeIds.every((id) => report.executedNodeIds.includes(id))) throw new Error("caption graph coverage failed");
  if (!report.captionReceipt || report.glyphCount < 8 || report.missingGlyphCount !== 0 || report.captionTextureUploads !== 1) throw new Error("caption glyph receipt is incomplete");
  if (!report.timelineOracle || report.changedBottomRatio < .02 || report.outsideChangedRatio > .02 || report.whiteTextPixels < 100 || report.darkBackgroundPixels < 1000) throw new Error("caption artifact oracle failed");
  if (report.presentedFrames < 60 || report.presentP95Ms > 20 || report.productPathCpuPixelCopies !== 0 || report.rejectedNegativeControls.length !== 5 || report.releaseFences.pendingFenceCount !== 0) throw new Error("caption performance, zero-copy or fail-closed evidence failed");
}
function syntheticSelfTest() {
  const valid = { schema: "editkin.common-engine-video-caption-gate/v1", status: "GREEN", directExecution: true, requiredNodeIds: ["source", "transform", "color", "caption", "composite-0", "output"], executedNodeIds: ["source", "transform", "color", "caption", "composite-0", "output"], captionReceipt: true, glyphCount: 9, missingGlyphCount: 0, captionTextureUploads: 1, timelineOracle: true, changedBottomRatio: .2, outsideChangedRatio: 0, whiteTextPixels: 1000, darkBackgroundPixels: 4000, presentedFrames: 60, presentP95Ms: 16, productPathCpuPixelCopies: 0, rejectedNegativeControls: ["blank", "font", "count", "translation", "order"], releaseFences: { pendingFenceCount: 0 } };
  assertGreen(valid); let calibratedNegatives = 0;
  for (const negative of [{ ...valid, captionReceipt: false }, { ...valid, missingGlyphCount: 1 }, { ...valid, changedBottomRatio: .001 }, { ...valid, presentP95Ms: 21 }, { ...valid, productPathCpuPixelCopies: 1 }]) { let rejected = false; try { assertGreen(negative); } catch { rejected = true; calibratedNegatives += 1; } if (!rejected) throw new Error("caption evaluator accepted a calibrated negative"); }
  console.log(JSON.stringify({ status: "GREEN", evaluator: "editkin.common-engine-video-caption-gate/v1", calibratedNegatives }));
}
async function run() {
  const temporary = await mkdtemp(join(tmpdir(), "editkin-video-caption-"));
  const child = spawn(executable, ["serve"], { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, EDITKIN_FONT_ROOT: fontRoot } });
  const lines = createInterface({ input: child.stdout }); const pending = new Map(); let stderr = ""; let readyResolve; const ready = new Promise((resolvePromise) => { readyResolve = resolvePromise; });
  child.stderr.on("data", (chunk) => { stderr += chunk; }); lines.on("line", (line) => { const message = JSON.parse(line); if (message.event === "ready") readyResolve(message); else { const handler = pending.get(message.id); if (handler) { pending.delete(message.id); handler(message); } } });
  let sequence = 0; const request = (command, payload = {}) => new Promise((resolvePromise, reject) => { const id = `caption-${++sequence}`; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${command} timed out: ${stderr}`)); }, 60_000); pending.set(id, (message) => { clearTimeout(timer); resolvePromise(message); }); child.stdin.write(`${JSON.stringify({ id, command, ...payload })}\n`); });
  try {
    await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error(`sidecar did not become ready: ${stderr}`)), 30_000))]);
    const graph = graphFor(); const graphPath = join(temporary, "caption.json"); const bindingsPath = join(temporary, "bindings.json"); await writeFile(graphPath, JSON.stringify(graph)); await writeFile(bindingsPath, JSON.stringify({ video: fixture }));
    const loaded = await request("engine_video_load", { sessionId: "caption", graphPath, bindingsPath, timelineFrame: 0 });
    if (baseline) { await request("shutdown"); return { status: "BLOCK", reason: "decoded common-video rejects typed caption nodes", observedError: loaded.error, rejected: !loaded.ok && String(loaded.error).includes("caption") }; }
    if (!loaded.ok) throw new Error(`caption load failed: ${JSON.stringify(loaded)}`); const plainGraphPath = join(temporary, "plain.json"); await writeFile(plainGraphPath, JSON.stringify(graphFor([], "video-caption-plain"))); const plainLoaded = await request("engine_video_load", { sessionId: "plain", graphPath: plainGraphPath, bindingsPath, timelineFrame: 0 }); if (!plainLoaded.ok) throw new Error(`plain control load failed: ${JSON.stringify(plainLoaded)}`); const bound = await request("surface_bind", { parentHwnd: "0", x: 40, y: 40, width: 96, height: 54 }); if (!bound.ok) throw new Error(`surface bind failed: ${JSON.stringify(bound)}`);
    const basePath = join(temporary, "base.png"); const captionPath = join(temporary, "caption-active.png"); const afterPath = join(temporary, "caption-after.png"); const plainBeforePath = join(temporary, "plain-before.png"); const plainActivePath = join(temporary, "plain-active.png"); const plainAfterPath = join(temporary, "plain-after.png");
    const before = await request("engine_video_verify_frame", { sessionId: "caption", timelineFrame: 0, toleranceSeconds: 1 / 30, outputPath: basePath }); const active = await request("engine_video_verify_frame", { sessionId: "caption", timelineFrame: 30, toleranceSeconds: 1 / 30, outputPath: captionPath }); const after = await request("engine_video_verify_frame", { sessionId: "caption", timelineFrame: 75, toleranceSeconds: 1 / 30, outputPath: afterPath }); const plainBefore = await request("engine_video_verify_frame", { sessionId: "plain", timelineFrame: 0, toleranceSeconds: 1 / 30, outputPath: plainBeforePath }); const plainActive = await request("engine_video_verify_frame", { sessionId: "plain", timelineFrame: 30, toleranceSeconds: 1 / 30, outputPath: plainActivePath }); const plainAfter = await request("engine_video_verify_frame", { sessionId: "plain", timelineFrame: 75, toleranceSeconds: 1 / 30, outputPath: plainAfterPath });
    if (![before, active, after, plainBefore, plainActive, plainAfter].every((item) => item.ok)) throw new Error(`caption verification failed: ${JSON.stringify({ before, active, after, plainBefore, plainActive, plainAfter })}`);
    const baseBytes = await readFile(basePath); const captionBytes = await readFile(captionPath); const afterBytes = await readFile(afterPath); const plainBeforeBytes = await readFile(plainBeforePath); const plainActiveBytes = await readFile(plainActivePath); const plainAfterBytes = await readFile(plainAfterPath); await mkdir(evidenceRoot, { recursive: true }); await writeFile(join(evidenceRoot, "before.png"), baseBytes); await writeFile(join(evidenceRoot, "active.png"), captionBytes); await writeFile(join(evidenceRoot, "after.png"), afterBytes); await writeFile(join(evidenceRoot, "active-plain-control.png"), plainActiveBytes);
    const stats = changedStats(plainActiveBytes, captionBytes); const beforeControl = changedStats(plainBeforeBytes, baseBytes); const afterControl = changedStats(plainAfterBytes, afterBytes); const times = []; let last;
    for (let index = 0; index < 64; index += 1) { const started = performance.now(); last = await request("engine_video_present_frame", { sessionId: "caption", timelineFrame: 15 + (index % 45), toleranceSeconds: 1 / 30 }); if (!last.ok) throw new Error(`caption present failed: ${JSON.stringify(last)}`); if (index >= 4) times.push(performance.now() - started); } times.sort((a, b) => a - b);
    const rejectedNegativeControls = []; async function negative(name, captions, marker) { const path = join(temporary, `negative-${name}.json`); await writeFile(path, JSON.stringify(graphFor(captions, `negative-${name}`))); const response = await request("engine_video_load", { sessionId: `negative-${name}`, graphPath: path, bindingsPath, timelineFrame: 0 }); if (response.ok || !String(response.error).includes(marker)) throw new Error(`negative ${name} was not rejected: ${JSON.stringify(response)}`); rejectedNegativeControls.push(name); }
    await negative("blank", [{ ...caption, text: " " }], "invalid caption"); await negative("font", [{ ...caption, fontFamily: "Missing Font" }], "font family"); await negative("count", Array.from({ length: 9 }, (_, index) => ({ ...caption, id: `caption-${index}`, cueId: `cue-${index}` })), "at most 8"); await negative("translation", [{ ...caption, translation: "No mixed bilingual renderer" }], "translation");
    const orderGraph = graphFor(); orderGraph.nodes.find((node) => node.id === "composite-0").inputs = ["caption", "color"]; const orderPath = join(temporary, "negative-order.json"); await writeFile(orderPath, JSON.stringify(orderGraph)); const orderResponse = await request("engine_video_load", { sessionId: "negative-order", graphPath: orderPath, bindingsPath, timelineFrame: 0 }); if (orderResponse.ok || !String(orderResponse.error).includes("caption overlays must follow video layers")) throw new Error(`negative order was not rejected: ${JSON.stringify(orderResponse)}`); rejectedNegativeControls.push("order");
    const released = await request("engine_video_release", { sessionId: "caption" }); await request("engine_video_release", { sessionId: "plain" }); await request("surface_release"); await request("shutdown"); const captionReceipt = loaded.result.captions?.[0];
    return { status: "GREEN", directExecution: loaded.result.engineGraph.directExecution, requiredNodeIds: graph.nodes.map((node) => node.id), executedNodeIds: loaded.result.engineGraph.executedNodeIds, captionReceipt: Boolean(captionReceipt?.atlasSha256 && captionReceipt?.fontSha256), glyphCount: captionReceipt?.glyphCount ?? -1, missingGlyphCount: captionReceipt?.missingGlyphCount ?? -1, captionTextureUploads: loaded.result.captionTextureUploads, timelineOracle: before.result.activeCaptions?.length === 0 && active.result.activeCaptions?.length === 1 && after.result.activeCaptions?.length === 0 && beforeControl.changedPixelRatio === 0 && afterControl.changedPixelRatio === 0, sameFrameInactiveChangedPixelRatios: [beforeControl.changedPixelRatio, afterControl.changedPixelRatio], ...stats, presentedFrames: times.length, presentP50Ms: times[Math.floor(times.length * .5)], presentP95Ms: times[Math.floor((times.length - 1) * .95)], productPathCpuPixelCopies: Math.max(active.result.productPathCpuPixelCopies, last.result.frame.decodePathCpuPixelCopies, last.result.frame.stagingCpuPixelReadbacks, last.result.frame.nativeSurfaceCpuPixelReadbacks), rejectedNegativeControls, artifacts: { beforeSha256: sha256(baseBytes), activeSha256: sha256(captionBytes), afterSha256: sha256(afterBytes), activePlainSha256: sha256(plainActiveBytes) }, releaseFences: released.result.fences };
  } finally { lines.close(); if (child.exitCode === null) child.kill(); await rm(temporary, { recursive: true, force: true }); }
}
async function main() { if (selfTest) return syntheticSelfTest(); const observed = await run(); const report = { schema: "editkin.common-engine-video-caption-gate/v1", measuredAt: new Date().toISOString(), executable, executableSha256: sha256(await readFile(executable)), ...observed }; await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`); if (!baseline) assertGreen(report); console.log(JSON.stringify(report, null, 2)); }
main().catch((error) => { console.error(error.stack ?? error); process.exitCode = 1; });
