import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const root = resolve(import.meta.dirname, "..");
const executable = resolve(process.argv.find((value, index) => index > 1 && !value.startsWith("--")) ?? join(root, "native/bin/win32-x64/editkin-gpu-compositor.exe"));
const evidenceRoot = resolve(root, "../..", ".rd/benchmarks/editkin-vfx-seek-snapshot");
const baseline = process.argv.includes("--baseline");
const selfTest = process.argv.includes("--self-test");
const reportPath = join(evidenceRoot, baseline ? "baseline-report.json" : "report.json");
const schema = "editkin.vfx-seek-snapshot-gate/v1";
const fixture = resolve(root, "public/benchmarks/layer-base.mp4");

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

function graphFor(cacheBudgetMb = 64, graphId = "vfx-seek-snapshot") {
  return {
    schema: "editkin.engine-graph/v1", graphId, width: 320, height: 180,
    timebase: { numerator: 1, denominator: 30 }, workingFormat: "rgba16_float", cacheBudgetMb,
    nodes: [
      { id: "source", inputs: [], enabled: true, kind: "source", assetId: "video", mediaKind: "video", inputColorSpace: "rec709", timeline: { timelineStartFrame: 0, sourceStartFrame: 0, durationFrames: 90 } },
      { id: "transform", inputs: ["source"], enabled: true, kind: "transform2d", x: 0, y: 0, scaleX: 1, scaleY: 1, rotationRadians: 0, opacity: 1 },
      { id: "color", inputs: ["transform"], enabled: true, kind: "color", processor: "editkin-rec709-primary/v1", inputSpace: "rec709", workingSpace: "rec709", outputSpace: "rec709_sdr" },
      { id: "particles", inputs: [], enabled: true, kind: "particle_emitter", timeline: { timelineStartFrame: 18, sourceStartFrame: 0, durationFrames: 42 }, seed: 32021, ratePerSecond: 48, lifetimeSeconds: 1.25, initialVelocity: [18, -76, 0], gravity: [0, 82, 0], maxParticles: 64, emitterPosition: [.5, .72], radiusPixels: 3.25, color: [1, .42, .06, .92] },
      { id: "composite", inputs: ["color", "particles"], enabled: true, kind: "composite", blendMode: "normal", opacity: 1 },
      { id: "output", inputs: ["composite"], enabled: true, kind: "output", format: "rgba16_float" },
    ],
    outputNode: "output",
  };
}

function assertGreen(report) {
  if (report.schema !== schema || report.status !== "GREEN") throw new Error("VFX seek snapshot report is not GREEN");
  if (!report.randomAccessPixelExact || report.snapshotCapacity !== 2 || report.cacheHits !== 1 || report.cacheMisses !== 4 || !report.evictionDeterministic) throw new Error("VFX seek snapshot cache oracle failed");
  if (report.computeTextureWrites !== 4 || report.snapshotCopies !== 4 || report.hitComputeWriteDelta !== 0) throw new Error("VFX seek snapshot did not suppress recompute on cache hit");
  if (report.cpuPixelUploads !== 0 || report.productPathCpuPixelCopies !== 0 || report.particleSnapshotBytes <= 0) throw new Error("VFX seek snapshot is not a budgeted GPU-resident path");
  if (report.rejectedNegativeControls.join(",") !== "snapshot-budget") throw new Error("VFX seek snapshot negative control is incomplete");
}

function syntheticSelfTest() {
  const valid = { schema, status: "GREEN", randomAccessPixelExact: true, snapshotCapacity: 2, cacheHits: 1, cacheMisses: 4, evictionDeterministic: true, computeTextureWrites: 4, snapshotCopies: 4, hitComputeWriteDelta: 0, cpuPixelUploads: 0, productPathCpuPixelCopies: 0, particleSnapshotBytes: 460800, rejectedNegativeControls: ["snapshot-budget"] };
  assertGreen(valid);
  let calibratedNegatives = 0;
  for (const negative of [{ ...valid, randomAccessPixelExact: false }, { ...valid, snapshotCapacity: 0 }, { ...valid, hitComputeWriteDelta: 1 }, { ...valid, particleSnapshotBytes: 0 }, { ...valid, productPathCpuPixelCopies: 1 }]) {
    let rejected = false; try { assertGreen(negative); } catch { rejected = true; calibratedNegatives += 1; }
    if (!rejected) throw new Error("VFX seek snapshot evaluator accepted a calibrated negative");
  }
  console.log(JSON.stringify({ status: "GREEN", evaluator: schema, calibratedNegatives }));
}

async function run() {
  const temporary = await mkdtemp(join(tmpdir(), "editkin-vfx-seek-snapshot-"));
  const child = spawn(executable, ["serve"], { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout }); const pending = new Map(); let stderr = ""; let readyResolve;
  const ready = new Promise((resolvePromise) => { readyResolve = resolvePromise; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  lines.on("line", (line) => { const message = JSON.parse(line); if (message.event === "ready") readyResolve(message); else { const handler = pending.get(message.id); if (handler) { pending.delete(message.id); handler(message); } } });
  let sequence = 0;
  const request = (command, payload = {}) => new Promise((resolvePromise, reject) => { const id = `snapshot-${++sequence}`; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${command} timed out: ${stderr}`)); }, 60_000); pending.set(id, (message) => { clearTimeout(timer); resolvePromise(message); }); child.stdin.write(`${JSON.stringify({ id, command, ...payload })}\n`); });
  try {
    await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error(`sidecar did not become ready: ${stderr}`)), 30_000))]);
    const graphPath = join(temporary, "graph.json"); const bindingsPath = join(temporary, "bindings.json");
    await writeFile(graphPath, JSON.stringify(graphFor())); await writeFile(bindingsPath, JSON.stringify({ video: fixture }));
    const loaded = await request("engine_video_load", { sessionId: "snapshot", graphPath, bindingsPath, timelineFrame: 30 });
    if (!loaded.ok) throw new Error(`VFX seek snapshot load failed: ${JSON.stringify(loaded)}`);
    const bound = await request("surface_bind", { parentHwnd: "0", x: 40, y: 40, width: 96, height: 54 });
    if (!bound.ok) throw new Error(`surface bind failed: ${JSON.stringify(bound)}`);
    const frames = [30, 31, 30, 32, 31];
    const receipts = [];
    const frameResults = [];
    const hashes = [];
    for (const [index, timelineFrame] of frames.entries()) {
      const outputPath = join(temporary, `frame-${index}-${timelineFrame}.png`);
      const response = await request("engine_video_verify_frame", { sessionId: "snapshot", timelineFrame, toleranceSeconds: 1 / 30, outputPath });
      if (!response.ok) throw new Error(`VFX seek snapshot frame failed: ${JSON.stringify(response)}`);
      frameResults.push(response.result);
      receipts.push(response.result.activeParticles);
      hashes.push(sha256(await readFile(outputPath)));
    }
    const caches = receipts.map((receipt) => receipt?.snapshotCache);
    const supported = caches.every(Boolean);
    const randomAccessPixelExact = hashes[0] === hashes[2];
    const cacheHits = caches.filter((cache) => cache?.hit === true).length;
    const cacheMisses = caches.filter((cache) => cache?.hit === false).length;
    const hitComputeWriteDelta = supported ? caches[2].computeTextureWrites - caches[1].computeTextureWrites : null;
    const evictionDeterministic = supported && caches[2].cachedLocalFrames.join(",") === "12,13" && caches[4].hit === false && caches[4].cachedLocalFrames.join(",") === "13,14";
    const budgetGraph = graphFor(64, "negative-snapshot-budget");
    budgetGraph.width = 1920; budgetGraph.height = 1080;
    const budgetPath = join(temporary, "budget.json"); await writeFile(budgetPath, JSON.stringify(budgetGraph));
    const budgetResponse = await request("engine_video_load", { sessionId: "negative-budget", graphPath: budgetPath, bindingsPath, timelineFrame: 30 });
    const rejectedNegativeControls = !budgetResponse.ok && String(budgetResponse.error).includes("resource budget is insufficient") ? ["snapshot-budget"] : [];
    const released = await request("engine_video_release", { sessionId: "snapshot" }); await request("surface_release"); await request("shutdown");
    const observed = {
      status: supported ? "GREEN" : "BLOCK",
      reason: supported ? undefined : "resident particle textures do not retain bounded GPU seek snapshots",
      randomAccessPixelExact,
      snapshotCapacity: caches[0]?.capacity ?? 0,
      cacheHits,
      cacheMisses,
      evictionDeterministic,
      computeTextureWrites: caches.at(-1)?.computeTextureWrites ?? receipts.at(-1)?.gpuTextureWrites ?? 0,
      snapshotCopies: caches.at(-1)?.snapshotCopies ?? 0,
      hitComputeWriteDelta,
      cpuPixelUploads: Math.max(...receipts.map((receipt) => receipt?.cpuPixelUploads ?? 0)),
      productPathCpuPixelCopies: Math.max(...frameResults.map((result) => result.productPathCpuPixelCopies ?? -1)),
      particleSnapshotBytes: loaded.result.resourcePlan?.particleSnapshotBytes ?? 0,
      cachedLocalFrames: caches.map((cache) => cache?.cachedLocalFrames ?? []),
      outputHashes: hashes,
      rejectedNegativeControls,
      snapshotBudgetObservedError: budgetResponse.error ?? null,
      releaseFences: released.result.fences,
    };
    return observed;
  } finally {
    lines.close(); if (child.exitCode === null) child.kill(); await rm(temporary, { recursive: true, force: true });
  }
}

async function main() {
  if (selfTest) return syntheticSelfTest();
  const observed = await run();
  const report = { schema, measuredAt: new Date().toISOString(), executable, executableSha256: sha256(await readFile(executable)), ...observed };
  await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  if (!baseline) assertGreen(report);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => { console.error(error.stack ?? error); process.exitCode = 1; });
