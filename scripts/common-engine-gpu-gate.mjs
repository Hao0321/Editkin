import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { PNG } from "pngjs";

const root = resolve(import.meta.dirname, "..");
const defaultExecutable = resolve(root, "native", "bin", process.platform === "win32" ? "win32-x64/editkin-gpu-compositor.exe" : process.platform === "darwin" ? "darwin-universal/editkin-gpu-compositor" : "linux-x64/editkin-gpu-compositor");
const defaultReport = resolve(root, "..", "..", ".rd", "benchmarks", "editkin-common-engine-gpu", "report.json");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertReport(report) {
  if (report.schema !== "editkin.common-engine-gpu-gate/v1") throw new Error("wrong report schema");
  if (report.status !== "GREEN") throw new Error("report is not GREEN");
  if (report.graphSchema !== "editkin.engine-graph/v1" || report.directExecution !== true) throw new Error("common graph was not executed directly");
  if (report.executionFormat !== "rgba32_float" || report.artifactFormat !== "rgba8") throw new Error("float execution/output contract is missing");
  if (report.parityMaxChannelError !== 0 || report.referencePixelHash !== report.candidatePixelHash) throw new Error(`reference/candidate pixel parity failed: ${JSON.stringify({ parityMaxChannelError: report.parityMaxChannelError, referencePixelHash: report.referencePixelHash, candidatePixelHash: report.candidatePixelHash, referenceArtifactSha256: report.referenceArtifactSha256, candidateArtifactSha256: report.candidateArtifactSha256 })}`);
  if (!/^[0-9a-f]{64}$/.test(report.referenceArtifactSha256) || report.referenceArtifactSha256 !== report.candidateArtifactSha256) {
    throw new Error("reference/common artifact SHA-256 parity failed");
  }
  if (report.effectDirectExecution !== true || !Number.isInteger(report.effectParityMaxChannelError) || report.effectParityMaxChannelError > 1 || !/^[0-9a-f]{64}$/.test(report.effectCpuArtifactSha256)
    || report.effectGpuArtifactSha256 !== report.residentArtifactSha256
    || report.effectGpuArtifactSha256 === report.candidateArtifactSha256) {
    throw new Error(`common effect CPU/GPU/resident execution parity failed: ${JSON.stringify({
      direct: report.effectDirectExecution, maxError: report.effectParityMaxChannelError,
      cpu: report.effectCpuArtifactSha256, gpu: report.effectGpuArtifactSha256,
      resident: report.residentArtifactSha256, unchanged: report.candidateArtifactSha256,
    })}`);
  }
  if (report.residentDirectExecution !== true || report.timelineFrameUpdate !== true || report.legacyPropertyOverrideRejected !== true) throw new Error("resident common-graph journey is incomplete");
  if (report.residentFrames < 60 || !Number.isFinite(report.residentP95Ms) || report.residentP95Ms > 8) throw new Error("resident common-graph performance ceiling failed");
  if (!Array.isArray(report.executedNodeIds) || report.executedNodeIds.length !== report.requiredNodeIds.length) throw new Error("closed-world node coverage is incomplete");
  if (report.requiredNodeIds.some((id) => !report.executedNodeIds.includes(id))) throw new Error("required node was not executed");
  if (!Array.isArray(report.rejectedNegativeControls) || report.rejectedNegativeControls.length !== 5) throw new Error("negative controls are incomplete");
  if (report.blockedNodeIds.length !== 0 || report.ignoredNodeIds.length !== 0) throw new Error("node was blocked or silently ignored on the accepted graph");
}

function selfTest() {
  const valid = {
    schema: "editkin.common-engine-gpu-gate/v1", status: "GREEN", graphSchema: "editkin.engine-graph/v1",
    directExecution: true, residentDirectExecution: true, timelineFrameUpdate: true, legacyPropertyOverrideRejected: true, residentFrames: 60, residentP50Ms: 2, residentP95Ms: 3,
    executionFormat: "rgba32_float", artifactFormat: "rgba8", parityMaxChannelError: 0,
    referencePixelHash: "a", candidatePixelHash: "a", referenceArtifactSha256: "a".repeat(64), candidateArtifactSha256: "a".repeat(64),
    effectDirectExecution: true, effectParityMaxChannelError: 1, effectCpuArtifactSha256: "c".repeat(64), effectGpuArtifactSha256: "b".repeat(64), residentArtifactSha256: "b".repeat(64),
    requiredNodeIds: ["source", "transform", "color", "effect", "output"],
    executedNodeIds: ["source", "transform", "color", "effect", "output"], blockedNodeIds: [], ignoredNodeIds: [],
    rejectedNegativeControls: ["unsupported-caption", "non-identity-color", "missing-binding", "cycle", "unknown-effect"],
  };
  assertReport(valid);
  const negatives = [
    { ...valid, directExecution: false },
    { ...valid, executedNodeIds: valid.executedNodeIds.slice(0, -1) },
    { ...valid, parityMaxChannelError: 1 },
    { ...valid, ignoredNodeIds: ["color"] },
    { ...valid, effectParityMaxChannelError: 2 },
  ];
  for (const fixture of negatives) {
    let rejected = false;
    try { assertReport(fixture); } catch { rejected = true; }
    if (!rejected) throw new Error("gate self-test accepted a calibrated negative");
  }
  process.stdout.write(`${JSON.stringify({ status: "GREEN", evaluator: "editkin.common-engine-gpu-gate/v1", calibratedNegatives: negatives.length })}\n`);
}

function run(executable, args, timeoutMs = 120_000) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${args[0]} timed out`)); }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-20_000); });
    child.once("error", reject);
    child.once("exit", (code) => { clearTimeout(timer); resolvePromise({ code, stdout, stderr }); });
  });
}

function parsedReceipt(result, label) {
  if (result.code !== 0) throw new Error(`${label} failed: ${result.stderr || result.stdout}`);
  try { return JSON.parse(result.stdout); }
  catch (error) { throw new Error(`${label} returned invalid JSON: ${error}`); }
}

async function pngMaxChannelError(leftPath, rightPath) {
  const left = PNG.sync.read(await readFile(leftPath));
  const right = PNG.sync.read(await readFile(rightPath));
  if (left.width !== right.width || left.height !== right.height || left.data.length !== right.data.length) return 255;
  let maximum = 0;
  for (let index = 0; index < left.data.length; index += 1) maximum = Math.max(maximum, Math.abs(left.data[index] - right.data[index]));
  return maximum;
}

function legacyGraph(width, height, layers) {
  return { schema: "hao.gpu-render-graph/v1", width, height, layers };
}

function baseLayer(id, source, overrides = {}) {
  return {
    id, source, blendMode: "normal", opacity: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0 }, enabled: true, ...overrides,
  };
}

function engineGraph() {
  const timeline = { timelineStartFrame: 0, sourceStartFrame: 0, durationFrames: 30 };
  return {
    schema: "editkin.engine-graph/v1", graphId: "common-gpu-parity", width: 960, height: 540,
    timebase: { numerator: 1, denominator: 30 }, workingFormat: "rgba16_float", cacheBudgetMb: 64,
    nodes: [
      { id: "source:a", inputs: [], enabled: true, kind: "source", assetId: "asset-a", mediaKind: "image", inputColorSpace: "rec709", timeline },
      { id: "transform:a", inputs: ["source:a"], enabled: true, kind: "transform2d", x: 0, y: 0, scaleX: 1, scaleY: 1, rotationRadians: 0, opacity: 1 },
      { id: "color:a", inputs: ["transform:a"], enabled: true, kind: "color", processor: "editkin-rec709-primary/v1", inputSpace: "rec709", workingSpace: "rec709", outputSpace: "rec709_sdr" },
      { id: "source:b", inputs: [], enabled: true, kind: "source", assetId: "asset-b", mediaKind: "image", inputColorSpace: "rec709", timeline },
      { id: "transform:b", inputs: ["source:b"], enabled: true, kind: "transform2d", x: 11, y: -7, scaleX: 0.84, scaleY: 0.84, rotationRadians: -0.08, opacity: 0.72 },
      { id: "color:b", inputs: ["transform:b"], enabled: true, kind: "color", processor: "editkin-rec709-primary/v1", inputSpace: "rec709", workingSpace: "rec709", outputSpace: "rec709_sdr" },
      { id: "composite", inputs: ["color:a", "color:b"], enabled: true, kind: "composite", blendMode: "screen", opacity: 1 },
      { id: "output", inputs: ["composite"], enabled: true, kind: "output", format: "rgba16_float" },
    ],
    outputNode: "output",
  };
}

function engineEffectGraph() {
  const graph = engineGraph();
  graph.graphId = "common-gpu-effect";
  const composite = graph.nodes.find((node) => node.id === "composite");
  graph.nodes.splice(graph.nodes.findIndex((node) => node.id === "composite"), 0, {
    id: "effect:mono", inputs: ["color:b"], enabled: true, kind: "effect",
    pluginId: "editkin.builtin.mono_halftone", abiVersion: 1, temporalRadius: 0, parameters: {},
  });
  composite.inputs[1] = "effect:mono";
  return graph;
}

async function expectRejected(executable, args, marker) {
  const result = await run(executable, args);
  if (result.code === 0 || !`${result.stderr}\n${result.stdout}`.includes(marker)) {
    throw new Error(`negative control was not rejected with ${marker}`);
  }
}

async function residentJourney(executable, graphPath, bindingsPath, referencePixelHash, requiredNodeIds, temporary) {
  const child = spawn(executable, ["serve"], { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-20_000); });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let readyResolve;
  const ready = new Promise((resolvePromise) => { readyResolve = resolvePromise; });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.event === "ready") { readyResolve(message); return; }
    const waiter = pending.get(message.id);
    if (waiter) { pending.delete(message.id); waiter(message); }
  });
  let sequence = 0;
  const request = (command, payload = {}) => {
    const id = `common-${++sequence}`;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`resident ${command} timed out`)); }, 60_000);
      pending.set(id, (message) => { clearTimeout(timer); resolvePromise(message); });
      child.stdin.write(`${JSON.stringify({ id, command, ...payload })}\n`);
    });
  };
  try {
    await Promise.race([ready, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`resident ready timeout: ${stderr}`)), 60_000);
      timer.unref();
    })]);
    const loaded = await request("engine_load", { sessionId: "common-gate", graphPath, bindingsPath, timelineFrame: 0 });
    const coverage = loaded.result?.engineGraph;
    if (!loaded.ok || coverage?.directExecution !== true || requiredNodeIds.some((id) => !coverage.executedNodeIds.includes(id))) {
      throw new Error(`resident engine_load did not preserve common graph coverage: ${JSON.stringify(loaded)}`);
    }
    const residentOutput = join(temporary, "resident.png");
    const rendered = await request("render", { sessionId: "common-gate", outputPath: residentOutput });
    if (!rendered.ok || rendered.result.outputHash !== referencePixelHash || rendered.result.engineGraph?.directExecution !== true) {
      throw new Error(`resident render parity failed: ${JSON.stringify(rendered)}`);
    }
    const times = [];
    for (let index = 0; index < 64; index += 1) {
      const sample = await request("render", { sessionId: "common-gate" });
      if (!sample.ok) throw new Error(`resident performance sample failed: ${JSON.stringify(sample)}`);
      if (index >= 4) times.push(sample.result.renderMilliseconds);
    }
    times.sort((left, right) => left - right);
    const updated = await request("engine_update_frame", { sessionId: "common-gate", timelineFrame: 40 });
    const outside = await request("render", { sessionId: "common-gate" });
    if (!updated.ok || !outside.ok || outside.result.outputHash === referencePixelHash) throw new Error("resident timeline frame update did not change inactive-layer output");
    const override = await request("update_params", { sessionId: "common-gate", params: [{ opacity: 1, translateX: 0, translateY: 0, scale: 1, rotation: 0, blendMode: 0, enabled: 1 }] });
    if (override.ok || !String(override.error).includes("typed graph commands")) throw new Error("legacy property buffer overrode a common graph session");
    const released = await request("release", { sessionId: "common-gate" });
    const shutdown = await request("shutdown");
    if (!released.ok || !shutdown.ok) throw new Error("resident common graph did not release cleanly");
    child.stdin.end();
    await new Promise((resolvePromise, reject) => child.once("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(stderr || `resident exit ${code}`))));
    return {
      residentDirectExecution: true, timelineFrameUpdate: true, legacyPropertyOverrideRejected: true,
      residentFrames: times.length, residentP50Ms: times[Math.floor(times.length * .5)], residentP95Ms: times[Math.floor((times.length - 1) * .95)],
      residentArtifactSha256: sha256(await readFile(residentOutput)),
    };
  } finally {
    lines.close();
    if (child.exitCode === null) child.kill();
  }
}

async function main(executable, reportPath) {
  const temporary = await mkdtemp(join(tmpdir(), "editkin-common-engine-gpu-"));
  try {
    const aGraphPath = join(temporary, "source-a.json");
    const bGraphPath = join(temporary, "source-b.json");
    const aPath = join(temporary, "source-a.png");
    const bPath = join(temporary, "source-b.png");
    await writeFile(aGraphPath, JSON.stringify(legacyGraph(960, 540, [baseLayer("a", { kind: "gradient", start: [9, 14, 28, 255], end: [36, 82, 126, 255], horizontal: false })])));
    await writeFile(bGraphPath, JSON.stringify(legacyGraph(960, 540, [baseLayer("b", { kind: "radial", inner: [188, 255, 54, 238], outer: [255, 44, 30, 0], center: [0.66, 0.42], radius: 0.34 })])));
    parsedReceipt(await run(executable, ["render", aGraphPath, aPath, "cpu"]), "source A generation");
    parsedReceipt(await run(executable, ["render", bGraphPath, bPath, "cpu"]), "source B generation");

    const referenceGraphPath = join(temporary, "reference.json");
    const referenceOutput = join(temporary, "reference.png");
    await writeFile(referenceGraphPath, JSON.stringify(legacyGraph(960, 540, [
      baseLayer("a", { kind: "image", path: aPath }),
      baseLayer("b", { kind: "image", path: bPath }, { blendMode: "screen", opacity: 0.72, transform: { x: 11, y: -7, scale: 0.84, rotation: -0.08 } }),
    ])));
    const reference = parsedReceipt(await run(executable, ["render", referenceGraphPath, referenceOutput, "gpu"]), "legacy reference render");

    const graph = engineGraph();
    const graphPath = join(temporary, "engine-graph.json");
    const bindingsPath = join(temporary, "asset-bindings.json");
    const candidateOutput = join(temporary, "candidate.png");
    await writeFile(graphPath, JSON.stringify(graph));
    await writeFile(bindingsPath, JSON.stringify({ "asset-a": aPath, "asset-b": bPath }));
    const candidate = parsedReceipt(await run(executable, ["engine-render", graphPath, bindingsPath, "0", candidateOutput, "gpu"]), "common graph render");

    const effect = engineEffectGraph();
    const effectPath = join(temporary, "engine-effect-graph.json");
    const effectCpuOutput = join(temporary, "effect-cpu.png");
    const effectGpuOutput = join(temporary, "effect-gpu.png");
    await writeFile(effectPath, JSON.stringify(effect));
    const effectCpu = parsedReceipt(await run(executable, ["engine-render", effectPath, bindingsPath, "0", effectCpuOutput, "cpu"]), "common effect CPU render");
    const effectGpu = parsedReceipt(await run(executable, ["engine-render", effectPath, bindingsPath, "0", effectGpuOutput, "gpu"]), "common effect GPU render");

    const caption = structuredClone(graph);
    caption.nodes.splice(-1, 0,
      { id: "caption", inputs: [], enabled: true, kind: "caption", cueId: "cue", text: "must reject", timeline: { timelineStartFrame: 0, sourceStartFrame: 0, durationFrames: 10 }, fontFamily: "sans", fontSize: 20, textColor: "#FFFFFFFF", outlineColor: "#000000FF", outlineWidth: 1, backgroundColor: "#00000000", alignment: 2, marginVertical: 4, bold: false, italic: false },
      { id: "caption-composite", inputs: ["composite", "caption"], enabled: true, kind: "composite", blendMode: "normal", opacity: 1 },
    );
    caption.nodes.at(-1).inputs = ["caption-composite"];
    const captionPath = join(temporary, "unsupported-caption.json");
    await writeFile(captionPath, JSON.stringify(caption));
    await expectRejected(executable, ["engine-render", captionPath, bindingsPath, "0", join(temporary, "caption.png"), "gpu"], "unsupported engine node kind: caption");

    const grade = structuredClone(graph);
    grade.nodes.find((node) => node.id === "color:a").grade = { brightness: 0, contrast: 1, saturation: 1, hue: 0, exposure: 1, temperature: 0, tint: 0, pivot: .5, shadows: 0, highlights: 0, blacks: 0, whites: 0 };
    const gradePath = join(temporary, "non-identity-color.json");
    await writeFile(gradePath, JSON.stringify(grade));
    await expectRejected(executable, ["engine-render", gradePath, bindingsPath, "0", join(temporary, "grade.png"), "gpu"], "unsupported color grade");

    const missingBindingsPath = join(temporary, "missing-bindings.json");
    await writeFile(missingBindingsPath, JSON.stringify({ "asset-a": aPath }));
    await expectRejected(executable, ["engine-render", graphPath, missingBindingsPath, "0", join(temporary, "missing.png"), "gpu"], "missing asset binding: asset-b");

    const cycle = structuredClone(graph);
    cycle.nodes.find((node) => node.id === "source:a").inputs = ["output"];
    const cyclePath = join(temporary, "cycle.json");
    await writeFile(cyclePath, JSON.stringify(cycle));
    await expectRejected(executable, ["engine-render", cyclePath, bindingsPath, "0", join(temporary, "cycle.png"), "gpu"], "cycle");

    const unknownEffect = structuredClone(effect);
    unknownEffect.nodes.find((node) => node.id === "effect:mono").pluginId = "third.party.unknown";
    const unknownEffectPath = join(temporary, "unknown-effect.json");
    await writeFile(unknownEffectPath, JSON.stringify(unknownEffect));
    await expectRejected(executable, ["engine-render", unknownEffectPath, bindingsPath, "0", join(temporary, "unknown-effect.png"), "gpu"], "unsupported GPU effect plugin");

    const requiredNodeIds = effect.nodes.map((node) => node.id);
    const resident = await residentJourney(executable, effectPath, bindingsPath, effectGpu.outputSha256, requiredNodeIds, temporary);
    const report = {
      schema: "editkin.common-engine-gpu-gate/v1", status: "GREEN", graphSchema: candidate.graphSchema,
      graphId: candidate.graphId, directExecution: candidate.directExecution, executionFormat: candidate.executionFormat,
      ...resident,
      artifactFormat: candidate.artifactFormat, referencePixelHash: reference.outputSha256,
      candidatePixelHash: candidate.outputSha256,
      referenceArtifactSha256: sha256(await readFile(referenceOutput)),
      candidateArtifactSha256: sha256(await readFile(candidateOutput)),
      parityMaxChannelError: reference.outputSha256 === candidate.outputSha256 ? 0 : 255,
      effectDirectExecution: effectGpu.directExecution,
      effectCpuArtifactSha256: sha256(await readFile(effectCpuOutput)),
      effectGpuArtifactSha256: sha256(await readFile(effectGpuOutput)),
      effectParityMaxChannelError: await pngMaxChannelError(effectCpuOutput, effectGpuOutput),
      requiredNodeIds, executedNodeIds: effectGpu.executedNodeIds, blockedNodeIds: effectGpu.blockedNodeIds,
      ignoredNodeIds: effectGpu.ignoredNodeIds, rejectedNegativeControls: ["unsupported-caption", "non-identity-color", "missing-binding", "cycle", "unknown-effect"],
      executable: { path: executable, bytes: (await readFile(executable)).length, sha256: sha256(await readFile(executable)) },
      graphSha256: sha256(await readFile(graphPath)), assetHashes: { a: sha256(await readFile(aPath)), b: sha256(await readFile(bPath)) },
    };
    assertReport(report);
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } finally {
    if (process.env.EDITKIN_KEEP_COMMON_GATE_TEMP === "1") process.stderr.write(`kept common gate artifacts: ${temporary}\n`);
    else await rm(temporary, { recursive: true, force: true });
  }
}

const args = process.argv.slice(2);
if (args.includes("--self-test")) selfTest();
else {
  const executableIndex = args.indexOf("--executable");
  const outputIndex = args.indexOf("--output");
  const executable = executableIndex >= 0 ? resolve(args[executableIndex + 1]) : defaultExecutable;
  const reportPath = outputIndex >= 0 ? resolve(args[outputIndex + 1]) : defaultReport;
  try { await main(executable, reportPath); }
  catch (error) {
    const report = { schema: "editkin.common-engine-gpu-gate/v1", status: "BLOCK", error: String(error?.stack ?? error), executable };
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stderr.write(`${report.error}\n`);
    process.exitCode = 1;
  }
}
