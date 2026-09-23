import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

const root = resolve(import.meta.dirname, "..");
const cargo = process.env.CARGO || join(homedir(), ".cargo", "bin", process.platform === "win32" ? "cargo.exe" : "cargo");
if (!existsSync(cargo)) throw new Error(`Cargo 不存在：${cargo}`);

function run(executable, args, timeoutMs = 180_000) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${executable} timeout`)); }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-20_000); });
    child.once("error", reject);
    child.once("exit", (code) => { clearTimeout(timer); resolvePromise({ code, stdout, stderr }); });
  });
}

const built = await run(cargo, ["build", "--locked", "--manifest-path", "spikes/gpu-compositor/Cargo.toml"]);
if (built.code !== 0) throw new Error(built.stderr || built.stdout);
const executable = resolve(`spikes/gpu-compositor/target/debug/editkin-gpu-compositor${process.platform === "win32" ? ".exe" : ""}`);
const graphPath = resolve("spikes/gpu-compositor/fixtures/layer-stack.json");
const graph = JSON.parse(await readFile(graphPath, "utf8"));
const temporary = await mkdtemp(join(tmpdir(), "editkin-resident-gpu-"));
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
child.once("exit", (code) => {
  for (const [id, waiter] of pending) waiter({ id, ok: false, error: `GPU server exited ${code}: ${stderr}` });
  pending.clear();
});
function request(command, payload = {}) {
  const id = `gate-${++sequence}`;
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`resident command timeout: ${command}`)); }, 60_000);
    pending.set(id, (message) => { clearTimeout(timer); resolvePromise(message); });
    child.stdin.write(`${JSON.stringify({ id, command, ...payload })}\n`);
  });
}

try {
  const readyReceipt = await Promise.race([ready, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(`GPU ready timeout: ${stderr}`)), 60_000);
    timer.unref();
  })]);
  const loaded = await request("load", { sessionId: "gate", graphPath });
  if (!loaded.ok || !loaded.result.resident) throw new Error(`resident load failed: ${JSON.stringify(loaded)}`);
  const params = graph.layers.map((layer) => ({
    opacity: layer.opacity ?? 1, translateX: layer.transform?.x ?? 0, translateY: layer.transform?.y ?? 0,
    scale: layer.transform?.scale ?? 1, rotation: layer.transform?.rotation ?? 0,
    blendMode: { normal: 0, add: 1, screen: 2, multiply: 3, overlay: 4, soft_light: 5, hard_light: 6, difference: 7, darken: 8, lighten: 9, color_dodge: 10, color_burn: 11 }[layer.blendMode ?? "normal"], enabled: layer.enabled === false ? 0 : 1,
  }));
  const updated = await request("update_params", { sessionId: "gate", params });
  if (!updated.ok || updated.result.layers !== graph.layers.length) throw new Error("resident property buffer update failed");
  const times = [];
  let outputHash;
  for (let index = 0; index < 12; index += 1) {
    const rendered = await request("render", { sessionId: "gate", ...(index === 11 ? { outputPath: join(temporary, "frame.png") } : {}) });
    if (!rendered.ok) throw new Error(JSON.stringify(rendered));
    times.push(rendered.result.renderMilliseconds); outputHash = rendered.result.outputHash;
  }
  const injected = await request("inject_device_loss");
  const injectedFailure = await request("render", { sessionId: "gate" });
  if (!injected.ok || injected.result.nextAffectedRequestWillFail !== true
    || injectedFailure.ok || !String(injectedFailure.error).includes("GPU_DEVICE_LOST")) {
    throw new Error(`device-loss fault injection did not fail the affected request: ${JSON.stringify({ injected, injectedFailure })}`);
  }
  const recovered = await request("recover_device");
  if (!recovered.ok || recovered.result.generation !== readyReceipt.generation + 1 || recovered.result.residentSessions !== 0) throw new Error("device recovery did not invalidate resident resources");
  const reloaded = await request("load", { sessionId: "gate-after-recovery", graphPath });
  const renderedAfterRecovery = await request("render", { sessionId: "gate-after-recovery" });
  if (!reloaded.ok || !renderedAfterRecovery.ok || renderedAfterRecovery.result.outputHash !== outputHash) {
    throw new Error(`device recovery did not restore deterministic rendering: ${JSON.stringify({ reloaded, renderedAfterRecovery })}`);
  }
  const negative = await request("render", { sessionId: "missing" });
  if (negative.ok || !String(negative.error).includes("unknown resident session")) throw new Error("resident session negative control did not fail closed");
  const shutdown = await request("shutdown");
  if (!shutdown.ok) throw new Error("resident engine refused shutdown");
  child.stdin.end();
  await new Promise((resolvePromise, reject) => { child.once("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(stderr || `GPU server exit ${code}`))); });
  lines.close();
  times.sort((a, b) => a - b);
  const evidenceDirectory = resolve(root, "..", "..", ".rd", "benchmarks", "editkin-gpu-resident-engine");
  const report = {
    schemaVersion: 1, status: "GREEN", engine: "editkin-wgpu-resident-engine/v1", adapter: readyReceipt.adapter,
    backend: readyReceipt.backend, deviceType: readyReceipt.deviceType, frames: times.length,
    p50Ms: times[Math.floor(times.length * 0.5)], p95Ms: times[Math.floor((times.length - 1) * 0.95)],
    outputHash, graphSha256: createHash("sha256").update(await readFile(graphPath)).digest("hex"),
    residentPropertyBuffer: true, recoveryGeneration: recovered.result.generation,
    faultInjection: { armed: injected.result.armed, rejectedWithDeviceLost: true, deterministicRenderRestored: true },
    negativeControl: "unknown-session-rejected",
    evidence: join(evidenceDirectory, "report.json"),
  };
  await mkdir(evidenceDirectory, { recursive: true });
  await writeFile(report.evidence, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  lines.close();
  if (!child.killed && child.exitCode === null) child.kill();
  await rm(temporary, { recursive: true, force: true });
}
