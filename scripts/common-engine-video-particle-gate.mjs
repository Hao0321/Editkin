import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { PNG } from "pngjs";

const root = resolve(import.meta.dirname, "..");
const executable = resolve(process.argv.find((value, index) => index > 1 && !value.startsWith("--")) ?? join(root, "native/bin/win32-x64/editkin-gpu-compositor.exe"));
const multiEmitter = process.argv.includes("--multi-emitter");
const evidenceRoot = resolve(root, "../..", multiEmitter ? ".rd/benchmarks/editkin-common-engine-video-multi-particle" : ".rd/benchmarks/editkin-common-engine-video-particle");
const baseline = process.argv.includes("--baseline");
const selfTest = process.argv.includes("--self-test");
const reportPath = join(evidenceRoot, baseline ? "baseline-report.json" : "report.json");
// Every decoded frame is byte-identical, isolating simulation determinism from decoder seeking.
const fixture = resolve(root, "public/benchmarks/layer-base.mp4");

const emitter = {
  id: "particles", inputs: [], enabled: true, kind: "particle_emitter",
  timeline: { timelineStartFrame: 18, sourceStartFrame: 0, durationFrames: 24 }, seed: 32021,
  ratePerSecond: 48, lifetimeSeconds: 1.25, initialVelocity: [18, -76, 0], gravity: [0, 82, 0],
  maxParticles: 64, emitterPosition: [.5, .72], radiusPixels: 3.25, color: [1, .42, .06, .92],
};
const secondaryEmitter = {
  id: "particles-cool-trail", inputs: [], enabled: true, kind: "particle_emitter",
  timeline: { timelineStartFrame: 24, sourceStartFrame: 0, durationFrames: 18 }, seed: 90210,
  ratePerSecond: 36, lifetimeSeconds: .9, initialVelocity: [-22, -58, 0], gravity: [0, 70, 0],
  maxParticles: 48, emitterPosition: [.35, .62], radiusPixels: 2.5, color: [.1, .65, 1, .85],
};
const targetEmitters = multiEmitter ? [emitter, secondaryEmitter] : [emitter];
const reportSchema = multiEmitter ? "editkin.common-engine-video-multi-particle-gate/v1" : "editkin.common-engine-video-particle-gate/v1";
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function graphFor(emitters = [emitter], graphId = "video-particle") {
  const nodes = [
    { id: "source", inputs: [], enabled: true, kind: "source", assetId: "video", mediaKind: "video", inputColorSpace: "rec709", timeline: { timelineStartFrame: 0, sourceStartFrame: 0, durationFrames: 90 } },
    { id: "transform", inputs: ["source"], enabled: true, kind: "transform2d", x: 0, y: 0, scaleX: 1, scaleY: 1, rotationRadians: 0, opacity: 1 },
    { id: "color", inputs: ["transform"], enabled: true, kind: "color", processor: "editkin-rec709-primary/v1", inputSpace: "rec709", workingSpace: "rec709", outputSpace: "rec709_sdr" },
  ];
  let tail = "color";
  emitters.forEach((item, index) => {
    nodes.push(item);
    const composite = { id: `composite-${index}`, inputs: [tail, item.id], enabled: true, kind: "composite", blendMode: "normal", opacity: 1 };
    nodes.push(composite);
    tail = composite.id;
  });
  nodes.push({ id: "output", inputs: [tail], enabled: true, kind: "output", format: "rgba16_float" });
  return { schema: "editkin.engine-graph/v1", graphId, width: 320, height: 180, timebase: { numerator: 1, denominator: 30 }, workingFormat: "rgba16_float", cacheBudgetMb: 64, nodes, outputNode: "output" };
}
function plainControlGraph() {
  if (multiEmitter) return graphFor([emitter], "video-particle-primary-control");
  const graph = graphFor([], "video-particle-plain");
  const output = graph.nodes.pop();
  graph.nodes.push(
    { id: "source-control", inputs: [], enabled: true, kind: "source", assetId: "video", mediaKind: "video", inputColorSpace: "rec709", timeline: { timelineStartFrame: 0, sourceStartFrame: 0, durationFrames: 90 } },
    { id: "transform-control", inputs: ["source-control"], enabled: true, kind: "transform2d", x: 0, y: 0, scaleX: 1, scaleY: 1, rotationRadians: 0, opacity: 1 },
    { id: "color-control", inputs: ["transform-control"], enabled: true, kind: "color", processor: "editkin-rec709-primary/v1", inputSpace: "rec709", workingSpace: "rec709", outputSpace: "rec709_sdr" },
    { id: "composite-control", inputs: ["color", "color-control"], enabled: true, kind: "composite", blendMode: "normal", opacity: 0 },
    { ...output, inputs: ["composite-control"] },
  );
  return graph;
}
function pixelDifference(baseBytes, styledBytes) {
  const base = PNG.sync.read(baseBytes); const styled = PNG.sync.read(styledBytes);
  if (base.width !== styled.width || base.height !== styled.height) throw new Error("particle oracle dimensions differ");
  let changed = 0; let maximum = 0; let orange = 0; let blue = 0; let blueChanged = 0;
  for (let offset = 0; offset < base.data.length; offset += 4) {
    const delta = Math.max(...[0, 1, 2, 3].map((channel) => Math.abs(base.data[offset + channel] - styled.data[offset + channel])));
    if (delta > 2) {
      changed += 1;
      const redDelta = styled.data[offset] - base.data[offset];
      const greenDelta = styled.data[offset + 1] - base.data[offset + 1];
      const blueDelta = styled.data[offset + 2] - base.data[offset + 2];
      if (blueDelta > 8 && blueDelta > redDelta + 4 && blueDelta > greenDelta + 4) blueChanged += 1;
    }
    maximum = Math.max(maximum, delta);
    if (styled.data[offset] > styled.data[offset + 1] * 1.25 && styled.data[offset + 1] > styled.data[offset + 2] * 1.3) orange += 1;
    if (styled.data[offset + 2] > styled.data[offset + 1] * 1.25 && styled.data[offset + 1] > styled.data[offset] * 1.3) blue += 1;
  }
  return { changedPixels: changed, changedPixelRatio: changed / (base.width * base.height), maximumChannelDifference: maximum, orangePixels: orange, bluePixels: blue, blueChangedPixels: blueChanged };
}
function assertGreen(report) {
  if (report.schema !== reportSchema || report.status !== "GREEN") throw new Error("video-particle report is not GREEN");
  if (!report.directExecution || !report.requiredNodeIds.every((id) => report.executedNodeIds.includes(id))) throw new Error("video-particle graph coverage failed");
  if (report.vfxSimulation?.simulationContract !== "screen_space_analytic_particles/v1" || report.vfxSimulation?.timeSource !== "rational_node_local_frame" || report.vfxSimulation?.executor !== "wgpu-resident-video-particle-overlay/v1" || report.vfxSimulation?.emitterCount !== targetEmitters.length || report.vfxSimulation?.particleCeiling !== targetEmitters.reduce((sum, item) => sum + item.maxParticles, 0)) throw new Error("resident video particle receipt is incomplete");
  if (!report.sameFrameDeterministic || !report.timeEvolves || !report.localClockReset || !report.inactiveFramesSuppressParticleWrites || report.changedPixelRatio < .0005 || (multiEmitter ? report.blueChangedPixels < 20 : report.orangePixels < 20)) throw new Error("video particle artifact or timeline oracle failed");
  if (report.gpuTextureWrites < 1 || report.cpuPixelUploads !== 0 || report.productPathCpuPixelCopies !== 0) throw new Error("video particle executor is not GPU-resident");
  if (report.presentedFrames < 60 || report.presentP95Ms > 20 || report.rejectedNegativeControls.length !== (multiEmitter ? 6 : 5) || report.releaseFences.pendingFenceCount !== 0) throw new Error("video particle performance or fail-closed evidence failed");
}
function syntheticSelfTest() {
  const negativeNames = multiEmitter ? ["ceiling", "z-motion", "fifth-emitter", "aggregate-budget", "disabled", "missing-timeline"] : ["ceiling", "z-motion", "fifth-emitter", "disabled", "missing-timeline"];
  const valid = { schema: reportSchema, status: "GREEN", directExecution: true, requiredNodeIds: ["source", ...targetEmitters.map((item) => item.id), "composite-0", "output"], executedNodeIds: ["source", ...targetEmitters.map((item) => item.id), "composite-0", "output"], vfxSimulation: { simulationContract: "screen_space_analytic_particles/v1", emitterCount: targetEmitters.length, particleCeiling: targetEmitters.reduce((sum, item) => sum + item.maxParticles, 0), timeSource: "rational_node_local_frame", executor: "wgpu-resident-video-particle-overlay/v1" }, sameFrameDeterministic: true, timeEvolves: true, localClockReset: true, inactiveFramesSuppressParticleWrites: true, changedPixelRatio: .02, orangePixels: 100, bluePixels: 100, blueChangedPixels: 50, gpuTextureWrites: 62, cpuPixelUploads: 0, productPathCpuPixelCopies: 0, presentedFrames: 60, presentP95Ms: 10, rejectedNegativeControls: negativeNames, releaseFences: { pendingFenceCount: 0 } };
  assertGreen(valid); let calibratedNegatives = 0;
  for (const negative of [{ ...valid, sameFrameDeterministic: false }, { ...valid, timeEvolves: false }, { ...valid, localClockReset: false }, { ...valid, inactiveFramesSuppressParticleWrites: false }, { ...valid, cpuPixelUploads: 1 }, { ...valid, presentP95Ms: 21 }, multiEmitter ? { ...valid, blueChangedPixels: 0 } : { ...valid, orangePixels: 0 }]) { let rejected = false; try { assertGreen(negative); } catch { rejected = true; calibratedNegatives += 1; } if (!rejected) throw new Error("video particle evaluator accepted a calibrated negative"); }
  console.log(JSON.stringify({ status: "GREEN", evaluator: reportSchema, calibratedNegatives }));
}
async function run() {
  const temporary = await mkdtemp(join(tmpdir(), "editkin-video-particle-"));
  const child = spawn(executable, ["serve"], { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout }); const pending = new Map(); let stderr = ""; let readyResolve;
  const ready = new Promise((resolvePromise) => { readyResolve = resolvePromise; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  lines.on("line", (line) => { const message = JSON.parse(line); if (message.event === "ready") readyResolve(message); else { const handler = pending.get(message.id); if (handler) { pending.delete(message.id); handler(message); } } });
  let sequence = 0;
  const request = (command, payload = {}) => new Promise((resolvePromise, reject) => { const id = `particle-${++sequence}`; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${command} timed out: ${stderr}`)); }, 60_000); pending.set(id, (message) => { clearTimeout(timer); resolvePromise(message); }); child.stdin.write(`${JSON.stringify({ id, command, ...payload })}\n`); });
  try {
    await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error(`sidecar did not become ready: ${stderr}`)), 30_000))]);
    const graph = graphFor(targetEmitters); const graphPath = join(temporary, "particle.json"); const bindingsPath = join(temporary, "bindings.json");
    await writeFile(graphPath, JSON.stringify(graph)); await writeFile(bindingsPath, JSON.stringify({ video: fixture }));
    const loaded = await request("engine_video_load", { sessionId: "particle", graphPath, bindingsPath, timelineFrame: 18 });
    if (baseline) { await request("shutdown"); return { status: "BLOCK", reason: multiEmitter ? "resident video graph rejects a second particle emitter" : "resident video graph has no particle overlay executor", observedError: loaded.error, rejected: !loaded.ok && String(loaded.error).includes(multiEmitter ? "exactly one emitter" : "particle_emitter") }; }
    if (!loaded.ok) throw new Error(`video particle load failed: ${JSON.stringify(loaded)}`);
    const plainGraphPath = join(temporary, "plain.json"); await writeFile(plainGraphPath, JSON.stringify(plainControlGraph()));
    const plainLoaded = await request("engine_video_load", { sessionId: "plain", graphPath: plainGraphPath, bindingsPath, timelineFrame: 18 }); if (!plainLoaded.ok) throw new Error(`plain video load failed: ${JSON.stringify(plainLoaded)}`);
    const bound = await request("surface_bind", { parentHwnd: "0", x: 40, y: 40, width: 96, height: 54 }); if (!bound.ok) throw new Error(`surface bind failed: ${JSON.stringify(bound)}`);
    const before = await request("engine_video_present_frame", { sessionId: "particle", timelineFrame: 17, toleranceSeconds: 1 / 30 });
    const start = await request("engine_video_present_frame", { sessionId: "particle", timelineFrame: 18, toleranceSeconds: 1 / 30 });
    const next = await request("engine_video_present_frame", { sessionId: "particle", timelineFrame: 19, toleranceSeconds: 1 / 30 });
    const secondaryStart = multiEmitter ? await request("engine_video_present_frame", { sessionId: "particle", timelineFrame: 24, toleranceSeconds: 1 / 30 }) : null;
    const after = await request("engine_video_present_frame", { sessionId: "particle", timelineFrame: 42, toleranceSeconds: 1 / 30 });
    if (![before, start, next, after].every((item) => item.ok)) throw new Error(`video particle timeline presentation failed: ${JSON.stringify({ before, start, next, after })}`);
    const localClockReset = start.result.activeParticles?.localFrame === 0 && start.result.activeParticles?.timeSeconds === 0
      && next.result.activeParticles?.localFrame === 1 && Math.abs(next.result.activeParticles?.timeSeconds - 1 / 30) < 1e-6
      && start.result.activeParticles?.timeline?.timelineStartFrame === 18 && start.result.activeParticles?.timeline?.durationFrames === 24
      && (!multiEmitter || (secondaryStart?.ok && secondaryStart.result.activeParticleEmitters?.length === 2 && secondaryStart.result.activeParticleEmitters[1]?.nodeId === secondaryEmitter.id && secondaryStart.result.activeParticleEmitters[1]?.localFrame === 0 && secondaryStart.result.activeParticleEmitters[1]?.timeSeconds === 0));
    const inactiveFramesSuppressParticleWrites = before.result.activeParticles == null && after.result.activeParticles == null;
    const paths = { plain30: join(temporary, "plain-30.png"), frame30a: join(temporary, "particle-30a.png"), frame30b: join(temporary, "particle-30b.png"), frame31: join(temporary, "particle-31.png") };
    const plain30 = await request("engine_video_verify_frame", { sessionId: "plain", timelineFrame: 30, toleranceSeconds: 1 / 30, outputPath: paths.plain30 });
    const frame30a = await request("engine_video_verify_frame", { sessionId: "particle", timelineFrame: 30, toleranceSeconds: 1 / 30, outputPath: paths.frame30a });
    const frame30b = await request("engine_video_verify_frame", { sessionId: "particle", timelineFrame: 30, toleranceSeconds: 1 / 30, outputPath: paths.frame30b });
    const frame31 = await request("engine_video_verify_frame", { sessionId: "particle", timelineFrame: 31, toleranceSeconds: 1 / 30, outputPath: paths.frame31 });
    if (![plain30, frame30a, frame30b, frame31].every((item) => item.ok)) throw new Error(`video particle verification failed: ${JSON.stringify({ plain30, frame30a, frame30b, frame31 })}`);
    const bytes = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([key, path]) => [key, await readFile(path)])));
    await mkdir(evidenceRoot, { recursive: true }); await writeFile(join(evidenceRoot, "plain-30.png"), bytes.plain30); await writeFile(join(evidenceRoot, "particle-30.png"), bytes.frame30a); await writeFile(join(evidenceRoot, "particle-31.png"), bytes.frame31);
    const difference = pixelDifference(bytes.plain30, bytes.frame30a);
    const repeatedFrameDifference = pixelDifference(bytes.frame30a, bytes.frame30b);
    const nextFrameDifference = pixelDifference(bytes.frame30a, bytes.frame31);
    const sameFrameDeterministic = repeatedFrameDifference.maximumChannelDifference === 0;
    const timeEvolves = nextFrameDifference.changedPixels > 0;
    const times = []; let last;
    for (let index = 0; index < 64; index += 1) { const started = performance.now(); last = await request("engine_video_present_frame", { sessionId: "particle", timelineFrame: 18 + (index % 24), toleranceSeconds: 1 / 30 }); if (!last.ok) throw new Error(`video particle present failed: ${JSON.stringify(last)}`); if (index >= 4) times.push(performance.now() - started); }
    times.sort((a, b) => a - b);
    const rejectedNegativeControls = [];
    async function negative(name, mutate, marker) { const candidate = graphFor([structuredClone(emitter)], `negative-${name}`); mutate(candidate); const path = join(temporary, `negative-${name}.json`); await writeFile(path, JSON.stringify(candidate)); const response = await request("engine_video_load", { sessionId: `negative-${name}`, graphPath: path, bindingsPath, timelineFrame: 0 }); if (response.ok || !String(response.error).includes(marker)) throw new Error(`negative ${name} was not rejected: ${JSON.stringify(response)}`); rejectedNegativeControls.push(name); }
    await negative("ceiling", (candidate) => { candidate.nodes.find((node) => node.kind === "particle_emitter").maxParticles = 65; }, "ceiling is 64");
    await negative("z-motion", (candidate) => { candidate.nodes.find((node) => node.kind === "particle_emitter").gravity[2] = 1; }, "do not accept Z motion");
    await negative("fifth-emitter", (candidate) => { const emitters = Array.from({ length: 5 }, (_, index) => ({ ...structuredClone(emitter), id: `particles-extra-${index}`, seed: emitter.seed + index })); Object.assign(candidate, graphFor(emitters, "negative-fifth-emitter")); }, "at most 4 emitters");
    if (multiEmitter) await negative("aggregate-budget", (candidate) => { const emitters = Array.from({ length: 4 }, (_, index) => ({ ...structuredClone(emitter), id: `particles-budget-${index}`, seed: emitter.seed + index, maxParticles: 64 })); Object.assign(candidate, graphFor(emitters, "negative-aggregate-budget")); }, "aggregate ceiling is 192");
    await negative("disabled", (candidate) => { candidate.nodes.find((node) => node.kind === "particle_emitter").enabled = false; }, "disabled particle emitter");
    await negative("missing-timeline", (candidate) => { delete candidate.nodes.find((node) => node.kind === "particle_emitter").timeline; }, "invalid particle emitter");
    const released = await request("engine_video_release", { sessionId: "particle" }); await request("engine_video_release", { sessionId: "plain" }); await request("surface_release"); await request("shutdown");
    const activeReceipts = frame31.result.activeParticleEmitters ?? (frame31.result.activeParticles ? [frame31.result.activeParticles] : []);
    return { status: "GREEN", directExecution: loaded.result.engineGraph.directExecution, requiredNodeIds: graph.nodes.map((node) => node.id), executedNodeIds: loaded.result.engineGraph.executedNodeIds, vfxSimulation: loaded.result.vfxSimulation, sameFrameDeterministic, timeEvolves, localClockReset, inactiveFramesSuppressParticleWrites, intervals: targetEmitters.map((item) => item.timeline), repeatedFrameDifference, nextFrameDifference, ...difference, activeEmitterReceipts: activeReceipts, gpuTextureWrites: activeReceipts.reduce((sum, item) => sum + (item.gpuTextureWrites ?? 0), 0), cpuPixelUploads: Math.max(0, ...activeReceipts.map((item) => item.cpuPixelUploads ?? -1)), productPathCpuPixelCopies: Math.max(frame30a.result.productPathCpuPixelCopies, frame31.result.productPathCpuPixelCopies, last.result.frame.decodePathCpuPixelCopies, last.result.frame.stagingCpuPixelReadbacks, last.result.frame.nativeSurfaceCpuPixelReadbacks), presentedFrames: times.length, presentP50Ms: times[Math.floor(times.length * .5)], presentP95Ms: times[Math.floor((times.length - 1) * .95)], rejectedNegativeControls, artifacts: { control30Sha256: sha256(bytes.plain30), frame30Sha256: sha256(bytes.frame30a), frame31Sha256: sha256(bytes.frame31) }, releaseFences: released.result.fences };
  } finally { lines.close(); if (child.exitCode === null) child.kill(); await rm(temporary, { recursive: true, force: true }); }
}
async function main() { if (selfTest) return syntheticSelfTest(); const observed = await run(); const report = { schema: reportSchema, measuredAt: new Date().toISOString(), executable, executableSha256: sha256(await readFile(executable)), ...observed }; await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`); if (!baseline) assertGreen(report); console.log(JSON.stringify(report, null, 2)); }
main().catch((error) => { console.error(error.stack ?? error); process.exitCode = 1; });
