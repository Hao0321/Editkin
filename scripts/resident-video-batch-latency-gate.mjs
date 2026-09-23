import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";

const root = resolve(import.meta.dirname, "..");
const executable = resolve(process.argv[2] ?? "spikes/gpu-compositor/target/debug/editkin-gpu-compositor.exe");
const inputPath = resolve(root, ".rd/benchmarks/p0-resident-video-interop/six-layer-1080p-60s.mp4");
const reportPath = resolve(root, ".rd/benchmarks/p0-resident-video-batch-latency/report.json");
const frameCount = Number(process.env.EDITKIN_BATCH_LATENCY_FRAMES ?? 300);
if (!Number.isSafeInteger(frameCount) || frameCount < 90 || frameCount > 1800) throw new Error("EDITKIN_BATCH_LATENCY_FRAMES must be 90..=1800");

const child = spawn(executable, ["serve"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
const lines = createInterface({ input: child.stdout });
let ready;
let stderr = "";
const waiting = new Map();
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => { stderr += chunk; });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  const id = message.event === "ready" ? "ready" : message.id;
  if (id === "ready") ready = message;
  waiting.get(id)?.(message);
});
const wait = (id, timeoutMs = 30_000) => new Promise((resolvePromise, reject) => {
  if (id === "ready" && ready) return resolvePromise(ready);
  const timer = setTimeout(() => reject(new Error(`${id} timed out: ${stderr.slice(-2000)}`)), timeoutMs);
  timer.unref();
  waiting.set(id, (value) => { clearTimeout(timer); waiting.delete(id); resolvePromise(value); });
});
let requestIndex = 0;
const request = (command, payload = {}) => {
  const id = `batch-latency-${++requestIndex}`;
  child.stdin.write(`${JSON.stringify({ id, command, ...payload })}\n`);
  return wait(id);
};
const percentile = (values, quantile) => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)];
};

try {
  await wait("ready");
  const sessionIds = Array.from({ length: 6 }, (_, index) => `batch-layer-${index + 1}`);
  for (const sessionId of sessionIds) {
    const opened = await request("video_open", { sessionId, inputPath });
    if (!opened.ok) throw new Error(`open failed: ${JSON.stringify(opened)}`);
  }
  const frameMs = [];
  const decoderMs = [];
  const submitMs = [];
  let invalidReceipts = 0;
  const startedAt = performance.now();
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const frameStartedAt = performance.now();
    const response = await request("video_stage_batch_at", {
      sessionIds, timeSeconds: frameIndex / 30, toleranceSeconds: 1 / 60,
    });
    frameMs.push(performance.now() - frameStartedAt);
    if (!response.ok || response.result.frames.length !== 6) throw new Error(`batch failed at ${frameIndex}: ${JSON.stringify(response)}`);
    for (const [layerIndex, entry] of response.result.frames.entries()) {
      const frame = entry.frame;
      decoderMs.push(frame.decodePrepareMilliseconds);
      if (layerIndex === 0) submitMs.push(frame.batchGpuSubmitCpuMilliseconds);
      if (entry.endOfStream || frame.gpuCopySubmissionMode !== "batched-copy/v1"
        || frame.gpuCopySubmissionLayerCount !== 6 || frame.stagingCpuPixelReadbacks !== 0
        || frame.frameIndex !== frameIndex || frame.frameRingSlot !== frameIndex % 3) invalidReceipts += 1;
    }
  }
  const elapsedMs = performance.now() - startedAt;
  const metrics = {
    elapsedMs,
    realtimeFactor: frameCount / 30 * 1_000 / elapsedMs,
    frameP50Ms: percentile(frameMs, .5),
    frameP95Ms: percentile(frameMs, .95),
    decoderP50Ms: percentile(decoderMs, .5),
    decoderP95Ms: percentile(decoderMs, .95),
    gpuSubmitCpuP50Ms: percentile(submitMs, .5),
    gpuSubmitCpuP95Ms: percentile(submitMs, .95),
    frameRingPhaseP95Ms: [0, 1, 2].map((phase) => percentile(frameMs.filter((_, index) => index % 3 === phase), .95)),
  };
  const releases = [];
  for (const sessionId of sessionIds) releases.push(await request("video_release", { sessionId }));
  const green = invalidReceipts === 0 && metrics.realtimeFactor >= 1 && metrics.frameP95Ms <= 1_000 / 30
    && releases.every((release) => release.ok && release.result.fences.pendingFenceCount === 0);
  const report = {
    schema: "editkin.resident-video-batch-latency-gate/v1", status: green ? "GREEN" : "BLOCK",
    executable, inputPath, frameCount, concurrentLayers: 6, invalidReceipts, metrics, releases,
    thresholds: { minimumRealtimeFactor: 1, maximumFrameP95Ms: 1_000 / 30 },
  };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status: report.status, metrics, invalidReceipts, reportPath }, null, 2));
  if (!green) process.exitCode = 1;
  await request("shutdown");
} finally {
  lines.close();
  child.stdin.end();
  if (child.exitCode === null) child.kill();
}
