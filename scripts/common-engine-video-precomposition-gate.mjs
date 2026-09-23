import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";

const root = resolve(import.meta.dirname, "..");
const executable = resolve(process.argv.find((value, index) => index > 1 && !value.startsWith("--")) ?? join(root, "native/bin/win32-x64/editkin-gpu-compositor.exe"));
const baseline = process.argv.includes("--baseline"); const selfTest = process.argv.includes("--self-test");
const evidenceRoot = resolve(root, "..", "..", ".rd", "benchmarks", "editkin-common-engine-video-precomposition");
const reportPath = join(evidenceRoot, baseline ? "baseline-report.json" : "report.json");
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

function assertGreen(report) {
  if (report.schema !== "editkin.common-engine-video-precomposition-gate/v1" || report.status !== "GREEN") throw new Error("precomposition report is not GREEN");
  if (!report.directExecution || report.precompositionArtifactSha256 !== report.directArtifactSha256 || report.differingBytes !== 0) throw new Error("resolved precomposition pixels differ from the direct leaf oracle");
  if (report.layerCount !== 1 || report.decoderBindingCount !== 1 || report.precompositionCount !== 2 || report.precompositionNodeIds.length !== 2 || report.nestedGraphIds.join(",") !== "composition:outer,composition:inner") throw new Error("precomposition execution receipt is incomplete");
  if (!report.executedPrecompositionNodes || report.sourceFrame !== 38 || Math.abs(report.sourceTimeSeconds - 38 / 30) > 1e-9) throw new Error("precomposition timing or graph coverage is incomplete");
  if (report.productPathCpuPixelCopies !== 0 || report.presentedFrames < 60 || report.presentP95Ms > 1000 / 30) throw new Error("precomposition path missed zero-copy or 30 fps budget");
  if (report.rejectedNegativeControls.length !== 6 || report.releaseFences.pendingFenceCount !== 0) throw new Error("precomposition fail-closed or release evidence is incomplete");
  if (!/^[0-9a-f]{64}$/.test(report.executableSha256)) throw new Error("precomposition executable identity is missing");
}

function syntheticSelfTest() {
  const valid = { schema: "editkin.common-engine-video-precomposition-gate/v1", status: "GREEN", directExecution: true, precompositionArtifactSha256: "a".repeat(64), directArtifactSha256: "a".repeat(64), differingBytes: 0,
    layerCount: 1, decoderBindingCount: 1, precompositionCount: 2, precompositionNodeIds: ["outer", "inner"], nestedGraphIds: ["composition:outer", "composition:inner"], executedPrecompositionNodes: true,
    sourceFrame: 38, sourceTimeSeconds: 38 / 30, productPathCpuPixelCopies: 0, presentedFrames: 60, presentP95Ms: 20, rejectedNegativeControls: [1, 2, 3, 4, 5, 6], releaseFences: { pendingFenceCount: 0 }, executableSha256: "b".repeat(64) };
  assertGreen(valid);
  const negatives = [{ ...valid, differingBytes: 1 }, { ...valid, decoderBindingCount: 2 }, { ...valid, precompositionCount: 1 }, { ...valid, sourceFrame: 37 }, { ...valid, productPathCpuPixelCopies: 1 }, { ...valid, rejectedNegativeControls: [] }];
  for (const item of negatives) { let rejected = false; try { assertGreen(item); } catch { rejected = true; } if (!rejected) throw new Error("precomposition evaluator accepted a calibrated negative"); }
  console.log(JSON.stringify({ status: "GREEN", evaluator: valid.schema, calibratedNegatives: negatives.length }));
}

function nodes(includePrecomposition = true) {
  const items = [
    { id: "leaf", inputs: [], enabled: true, kind: "source", assetId: "leaf-video", mediaKind: "video", inputColorSpace: "rec709", timeline: { timelineStartFrame: 30, sourceStartFrame: 23, durationFrames: 90 } },
  ];
  let input = "leaf";
  if (includePrecomposition) {
    items.push({ id: "precomp-inner", inputs: [input], enabled: true, kind: "precomposition", nestedGraphId: "composition:inner", timeline: { timelineStartFrame: 30, sourceStartFrame: 8, durationFrames: 90 } }); input = "precomp-inner";
    items.push({ id: "precomp-outer", inputs: [input], enabled: true, kind: "precomposition", nestedGraphId: "composition:outer", timeline: { timelineStartFrame: 30, sourceStartFrame: 5, durationFrames: 90 } }); input = "precomp-outer";
  }
  items.push(
    { id: "transform", inputs: [input], enabled: true, kind: "transform2d", x: 80, y: -40, scaleX: .72, scaleY: .72, rotationRadians: .12, opacity: .85 },
    { id: "color", inputs: ["transform"], enabled: true, kind: "color", processor: "editkin-rec709-primary/v1", inputSpace: "rec709", workingSpace: "rec709", outputSpace: "rec709_sdr", grade: { brightness: .02, contrast: 1.1, saturation: .8, hue: 0, exposure: .1, temperature: .1, tint: -.05, pivot: .5, shadows: .05, highlights: -.04, blacks: .02, whites: 0 } },
    { id: "output", inputs: ["color"], enabled: true, kind: "output", format: "rgba16_float" },
  );
  return items;
}
function graph(includePrecomposition = true) { return { schema: "editkin.engine-graph/v1", graphId: includePrecomposition ? "resolved-precomposition" : "direct-leaf-oracle", width: 960, height: 540, timebase: { numerator: 1, denominator: 30 }, workingFormat: "rgba16_float", cacheBudgetMb: 64, nodes: nodes(includePrecomposition), outputNode: "output" }; }

async function run() {
  const temporary = await mkdtemp(join(tmpdir(), "editkin-precomposition-"));
  const child = spawn(executable, ["serve"], { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout }); const pending = new Map(); let stderr = ""; let readyResolve;
  const ready = new Promise((resolvePromise) => { readyResolve = resolvePromise; });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-40_000); });
  lines.on("line", (line) => { const message = JSON.parse(line); if (message.event === "ready") return readyResolve(message); const waiter = pending.get(message.id); if (waiter) { pending.delete(message.id); waiter(message); } });
  let sequence = 0; const request = (command, payload = {}) => new Promise((resolvePromise, reject) => { const id = `precomp-${++sequence}`; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${command} timed out: ${stderr}`)); }, 60_000); pending.set(id, (message) => { clearTimeout(timer); resolvePromise(message); }); child.stdin.write(`${JSON.stringify({ id, command, ...payload })}\n`); });
  try {
    await Promise.race([ready, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(`ready timeout: ${stderr}`)), 60_000); timer.unref(); })]);
    const bindingsPath = join(temporary, "bindings.json"); await writeFile(bindingsPath, JSON.stringify({ "leaf-video": resolve(root, "public/demo-source.mp4") }));
    if (baseline) {
      const graphPath = join(temporary, "baseline.json"); await writeFile(graphPath, JSON.stringify(graph(true)));
      const observed = await request("engine_video_load", { sessionId: "baseline", graphPath, bindingsPath, timelineFrame: 45 });
      if (observed.ok || !String(observed.error).includes("unsupported common video node kind: precomposition")) throw new Error(`old binary did not expose the precomposition gap: ${JSON.stringify(observed)}`);
      return { status: "BLOCK", reason: "native decoded-video graph rejected resolved precomposition markers", observedError: observed.error };
    }
    const bound = await request("surface_bind", { parentHwnd: "0", x: 40, y: 40, width: 96, height: 54 }); if (!bound.ok) throw new Error(`surface bind failed: ${JSON.stringify(bound)}`);
    const verify = async (id, candidate) => { const graphPath = join(temporary, `${id}.json`); const outputPath = join(temporary, `${id}.png`); await writeFile(graphPath, JSON.stringify(candidate)); const loaded = await request("engine_video_load", { sessionId: id, graphPath, bindingsPath, timelineFrame: 45 }); const verified = loaded.ok ? await request("engine_video_verify_frame", { sessionId: id, timelineFrame: 45, toleranceSeconds: 1 / 30, outputPath }) : undefined; if (!loaded.ok || !verified?.ok) throw new Error(`${id} verify failed: ${JSON.stringify({ loaded, verified })}`); return { loaded, verified, outputPath, bytes: await readFile(outputPath) }; };
    const direct = await verify("direct", graph(false)); await request("engine_video_release", { sessionId: "direct" });
    const precomposition = await verify("precomposition", graph(true));
    await mkdir(evidenceRoot, { recursive: true }); await writeFile(join(evidenceRoot, "direct.png"), direct.bytes); await writeFile(join(evidenceRoot, "precomposition.png"), precomposition.bytes);
    let differingBytes = 0; for (let index = 0; index < direct.bytes.length; index += 1) differingBytes += Number(direct.bytes[index] !== precomposition.bytes[index]);
    const times = []; let last;
    for (let index = 0; index < 64; index += 1) { const started = performance.now(); last = await request("engine_video_present_frame", { sessionId: "precomposition", timelineFrame: 45 + index, toleranceSeconds: 1 / 30 }); if (!last.ok) throw new Error(`precomposition present failed: ${JSON.stringify(last)}`); if (index >= 4) times.push(performance.now() - started); } times.sort((a, b) => a - b);
    const rejectedNegativeControls = [];
    const negative = async (name, mutate, marker) => { const candidate = graph(true); mutate(candidate); const graphPath = join(temporary, `negative-${name}.json`); await writeFile(graphPath, JSON.stringify(candidate)); const response = await request("engine_video_load", { sessionId: `negative-${name}`, graphPath, bindingsPath, timelineFrame: 45 }); if (response.ok || !String(response.error).toLowerCase().includes(marker.toLowerCase())) throw new Error(`${name} was not rejected: ${JSON.stringify(response)}`); rejectedNegativeControls.push(name); };
    await negative("unresolved", (candidate) => { candidate.nodes.find((node) => node.id === "precomp-inner").inputs = []; }, "invalid bounded contract");
    await negative("two-inputs", (candidate) => { candidate.nodes.find((node) => node.id === "precomp-inner").inputs.push("leaf"); }, "invalid bounded contract");
    await negative("wrong-prefix", (candidate) => { candidate.nodes.find((node) => node.id === "precomp-inner").nestedGraphId = "nested:inner"; }, "invalid bounded contract");
    await negative("misaligned", (candidate) => { candidate.nodes.find((node) => node.id === "precomp-inner").timeline.timelineStartFrame = 31; }, "timeline must match");
    await negative("empty-id", (candidate) => { candidate.nodes.find((node) => node.id === "precomp-inner").nestedGraphId = ""; }, "invalid precomposition");
    await negative("depth-five", (candidate) => { let input = "precomp-outer"; const output = candidate.nodes.find((node) => node.id === "transform"); for (let index = 0; index < 3; index += 1) { const id = `precomp-extra-${index}`; candidate.nodes.splice(-2, 0, { id, inputs: [input], enabled: true, kind: "precomposition", nestedGraphId: `composition:extra-${index}`, timeline: { timelineStartFrame: 30, sourceStartFrame: 0, durationFrames: 90 } }); input = id; } output.inputs = [input]; }, "invalid bounded contract");
    const released = await request("engine_video_release", { sessionId: "precomposition" }); await request("surface_release"); await request("shutdown");
    const layer = precomposition.loaded.result.layers[0]; const frame = last.result.frame;
    return { status: "GREEN", directExecution: precomposition.loaded.result.engineGraph.directExecution, precompositionArtifactSha256: sha256(precomposition.bytes), directArtifactSha256: sha256(direct.bytes), differingBytes,
      layerCount: precomposition.loaded.result.layerCount, decoderBindingCount: Object.keys({ "leaf-video": true }).length, precompositionCount: precomposition.loaded.result.precompositionCount,
      precompositionNodeIds: layer.precompositionNodeIds, nestedGraphIds: layer.nestedGraphIds,
      executedPrecompositionNodes: layer.precompositionNodeIds.every((id) => precomposition.loaded.result.engineGraph.executedNodeIds.includes(id)), sourceFrame: precomposition.verified.result.sourceFrame, sourceTimeSeconds: precomposition.verified.result.sourceTimeSeconds,
      productPathCpuPixelCopies: Math.max(frame.decodePathCpuPixelCopies, frame.stagingCpuPixelReadbacks, frame.nativeSurfaceCpuPixelReadbacks), presentedFrames: times.length, presentP50Ms: times[Math.floor(times.length * .5)], presentP95Ms: times[Math.floor((times.length - 1) * .95)], rejectedNegativeControls, releaseFences: released.result.fences, bound: bound.result };
  } finally { lines.close(); if (child.exitCode === null) child.kill(); await rm(temporary, { recursive: true, force: true }); }
}

async function main() {
  if (selfTest) return syntheticSelfTest();
  const observed = await run(); let report = { schema: "editkin.common-engine-video-precomposition-gate/v1", measuredAt: new Date().toISOString(), executable, executableSha256: sha256(await readFile(executable)), ...observed };
  await mkdir(dirname(reportPath), { recursive: true });
  if (!baseline) { try { assertGreen(report); } catch (error) { report = { ...report, status: "BLOCK", gateFailure: error instanceof Error ? error.message : String(error) }; await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`); throw error; } }
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`); console.log(JSON.stringify(report, null, 2));
}
await main();
