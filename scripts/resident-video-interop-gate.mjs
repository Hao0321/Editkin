import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const evidenceDirectory = resolve(root, ".rd", "benchmarks", "p0-resident-video-interop");
const evidence = resolve(evidenceDirectory, "report.json");
const cargoCandidate = join(
  homedir(),
  ".cargo",
  "bin",
  process.platform === "win32" ? "cargo.exe" : "cargo",
);
const cargo = process.env.CARGO ?? (existsSync(cargoCandidate) ? cargoCandidate : "cargo");
const executable = resolve(
  root,
  "spikes",
  "gpu-compositor",
  "target",
  "debug",
  `editkin-gpu-compositor${process.platform === "win32" ? ".exe" : ""}`,
);
const ffmpeg = resolve(root, "vendor", "ffmpeg", "win32-x64", "ffmpeg.exe");
const ffprobe = resolve(root, "vendor", "ffmpeg", "win32-x64", "ffprobe.exe");
const longPlayDurationSeconds = Number(process.env.EDITKIN_RESIDENT_LONG_SECONDS ?? 60);
if (!Number.isInteger(longPlayDurationSeconds) || longPlayDurationSeconds < 1 || longPlayDurationSeconds > 60) {
  throw new Error("EDITKIN_RESIDENT_LONG_SECONDS must be an integer within 1..60");
}

function run(executablePath, args, timeoutMs = 180_000) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executablePath, args, {
      cwd: root,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${executablePath} timeout`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-40_000); });
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
  });
}

await mkdir(evidenceDirectory, { recursive: true });
if (process.platform !== "win32") {
  const report = {
    schema: "hao.resident-video-interop-gate/v1",
    decision: "BLOCK",
    reason: "Resident VideoToolbox/Metal parity is not implemented yet.",
  };
  await writeFile(evidence, `${JSON.stringify(report, null, 2)}\n`);
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
}

const build = await run(
  cargo,
  ["build", "--locked", "--manifest-path", "spikes/gpu-compositor/Cargo.toml"],
);
if (build.code !== 0) throw new Error(build.stderr || build.stdout);

const longPlayFixture = resolve(evidenceDirectory, "six-layer-1080p-60s.mp4");
if (!existsSync(longPlayFixture)) {
  const fixture = await run(ffmpeg, [
    "-y", "-hide_banner", "-loglevel", "error", "-nostdin",
    "-stream_loop", "-1", "-i", resolve(root, "public", "demo-source.mp4"),
    "-t", "60", "-an", "-sn", "-dn",
    "-vf", "scale=1920:1080:flags=bilinear,format=yuv420p",
    "-r", "30", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
    "-g", "60", "-movflags", "+faststart", longPlayFixture,
  ], 240_000);
  if (fixture.code !== 0) throw new Error(`long-play fixture generation failed: ${fixture.stderr || fixture.stdout}`);
}
const variableRateFixture = resolve(evidenceDirectory, "vfr-24-30fps-6s.mp4");
if (!existsSync(variableRateFixture)) {
  const fixture = await run(ffmpeg, [
    "-y", "-hide_banner", "-loglevel", "error", "-nostdin",
    "-f", "lavfi", "-i", "testsrc2=size=960x540:rate=24:duration=3",
    "-f", "lavfi", "-i", "testsrc2=size=960x540:rate=30:duration=3",
    "-filter_complex", "[0:v]setpts=PTS-STARTPTS[v0];[1:v]setpts=PTS-STARTPTS[v1];[v0][v1]concat=n=2:v=1:a=0,format=yuv420p[v]",
    "-map", "[v]", "-fps_mode", "vfr", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
    "-g", "60", "-movflags", "+faststart", variableRateFixture,
  ], 120_000);
  if (fixture.code !== 0) throw new Error(`VFR fixture generation failed: ${fixture.stderr || fixture.stdout}`);
}
const variableRateProbe = await run(ffprobe, [
  "-v", "error", "-select_streams", "v:0", "-show_frames",
  "-show_entries", "frame=best_effort_timestamp_time", "-of", "json", variableRateFixture,
], 30_000);
if (variableRateProbe.code !== 0) throw new Error(`VFR fixture probe failed: ${variableRateProbe.stderr || variableRateProbe.stdout}`);
const variableRateTimestamps = JSON.parse(variableRateProbe.stdout).frames
  .map((frame) => Number(frame.best_effort_timestamp_time))
  .filter(Number.isFinite);

const child = spawn(executable, ["serve"], {
  cwd: root,
  windowsHide: true,
  stdio: ["pipe", "pipe", "pipe"],
});
const lines = createInterface({ input: child.stdout });
const pending = new Map();
let stderr = "";
let readyResolve;
const ready = new Promise((resolvePromise) => { readyResolve = resolvePromise; });
child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-40_000); });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.event === "ready") {
    readyResolve(message);
    return;
  }
  const waiter = pending.get(message.id);
  if (waiter) {
    pending.delete(message.id);
    waiter(message);
  }
});
child.once("exit", (code) => {
  for (const [id, waiter] of pending) {
    waiter({ id, ok: false, error: `resident engine exited ${code}: ${stderr}` });
  }
  pending.clear();
});

let sequence = 0;
function request(command, payload = {}) {
  const id = `video-gate-${++sequence}`;
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`resident command timeout: ${command}\n${stderr}`));
    }, 60_000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolvePromise(message);
    });
    child.stdin.write(`${JSON.stringify({ id, command, ...payload })}\n`);
  });
}

try {
  const readyReceipt = await Promise.race([
    ready,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`resident ready timeout: ${stderr}`)), 60_000);
      timer.unref();
    }),
  ]);
  const inputPath = resolve(root, "public", "demo-source.mp4");
  const opened = await request("video_open", { sessionId: "video-gate", inputPath });
  if (!opened.ok) throw new Error(`video_open failed: ${JSON.stringify(opened)}`);
  const duplicate = await request("video_open", { sessionId: "video-gate", inputPath });
  const liveStatus = await request("status");
  const frames = [];
  const previewFramePath = resolve(evidenceDirectory, "preview-frame.png");
  for (let index = 0; index < 30; index += 1) {
    const decoded = await request("video_decode_next", {
      sessionId: "video-gate",
      ...(index === 29 ? { outputPath: previewFramePath } : {}),
    });
    if (!decoded.ok || decoded.result.endOfStream) {
      throw new Error(`resident decode failed at frame ${index}: ${JSON.stringify(decoded)}`);
    }
    frames.push(decoded.result.frame);
  }
  const previewFrame = await readFile(previewFramePath);
  const seekForward = await request("video_seek", { sessionId: "video-gate", timeSeconds: 5 });
  const forwardFrame = await request("video_decode_next", { sessionId: "video-gate" });
  const seekBack = await request("video_seek", { sessionId: "video-gate", timeSeconds: 0 });
  const firstFrameAgain = await request("video_decode_next", { sessionId: "video-gate" });
  const released = await request("video_release", { sessionId: "video-gate" });
  const releasedStatus = await request("status");
  const afterRelease = await request("video_decode_next", { sessionId: "video-gate" });

  const invalidSurface = await request("surface_bind", {
    parentHwnd: "0",
    x: 24,
    y: 24,
    width: 0,
    height: 18,
  });
  const surfaceOpened = await request("video_open", { sessionId: "surface-gate", inputPath });
  const surfaceBound = await request("surface_bind", {
    parentHwnd: "0",
    x: 24,
    y: 24,
    width: 16,
    height: 16,
  });
  const firstPresented = await request("video_present_at", {
    sessionId: "surface-gate",
    timeSeconds: 0,
    toleranceSeconds: 1 / 60,
  });
  const surfaceResized = await request("surface_bind", {
    parentHwnd: "0",
    x: 28,
    y: 28,
    width: 24,
    height: 18,
  });
  const secondPresented = await request("video_present_at", {
    sessionId: "surface-gate",
    timeSeconds: 1 / 30,
    toleranceSeconds: 1 / 60,
  });
  const surfaceHidden = await request("surface_hide");
  const surfaceReleased = await request("surface_release");
  const surfaceVideoReleased = await request("video_release", { sessionId: "surface-gate" });
  const afterSurfaceRelease = await request("video_present_at", {
    sessionId: "surface-gate",
    timeSeconds: 0,
    toleranceSeconds: 1 / 60,
  });

  const clockSessionIds = Array.from({ length: 6 }, (_, index) => `clock-layer-${index + 1}`);
  const clockOpened = [];
  for (const sessionId of clockSessionIds) {
    clockOpened.push(await request("video_open", { sessionId, inputPath }));
  }
  const sixLayerStatus = await request("status");
  const clockFrames = [];
  for (const sessionId of clockSessionIds) {
    const first = await request("video_decode_at", {
      sessionId,
      timeSeconds: 1,
      toleranceSeconds: 1 / 60,
    });
    const sequential = await request("video_decode_at", {
      sessionId,
      timeSeconds: 31 / 30,
      toleranceSeconds: 1 / 60,
    });
    const catchUp = await request("video_decode_at", {
      sessionId,
      timeSeconds: 1.2,
      toleranceSeconds: 1 / 60,
    });
    clockFrames.push({ sessionId, first, sequential, catchUp });
  }
  const invalidClockTolerance = await request("video_decode_at", {
    sessionId: clockSessionIds[0],
    timeSeconds: 1,
    toleranceSeconds: 0,
  });
  const clockReleased = [];
  for (const sessionId of clockSessionIds) {
    clockReleased.push(await request("video_release", { sessionId }));
  }
  const clockReleasedStatus = await request("status");

  const stagingSessionIds = Array.from({ length: 6 }, (_, index) => `staging-layer-${index + 1}`);
  const stagingOpened = [];
  for (const sessionId of stagingSessionIds) {
    stagingOpened.push(await request("video_open", { sessionId, inputPath: longPlayFixture }));
  }
  const stagingStatus = await request("status");
  const stagingTimelineFrames = longPlayDurationSeconds * 30;
  const stagingLatenciesMs = [];
  const stagingTimelineLatenciesMs = [];
  const stagingDecoderPrepareMs = [];
  const stagingGpuSubmitCpuMs = [];
  const stagingSamples = [];
  let stagingMaxAbsDriftMs = 0;
  let stagingCpuPixelReadbacks = 0;
  let stagingUnexpectedSeeks = 0;
  let stagingFenceReuseErrors = 0;
  let stagingCrossApiFenceErrors = 0;
  let stagingCrossApiProducerCpuWaits = 0;
  let stagingRingReuseErrors = 0;
  let stagingEndOfStream = false;
  let stagingDroppedFrames = 0;
  const stagingStartedAt = performance.now();
  for (let frameIndex = 0; frameIndex < stagingTimelineFrames; frameIndex += 1) {
    const timelineStartedAt = performance.now();
    const targetSeconds = frameIndex / 30;
    const startedAt = performance.now();
    const stagedBatch = await request("video_stage_batch_at", {
      sessionIds: stagingSessionIds,
      timeSeconds: targetSeconds,
      toleranceSeconds: 1 / 60,
    });
    stagingLatenciesMs.push(performance.now() - startedAt);
    if (!stagedBatch.ok || stagedBatch.result.batchExecution !== "single-ipc-resident-video-stage/v1"
      || stagedBatch.result.frames.length !== stagingSessionIds.length) {
      throw new Error(`resident batch staging failed at frame ${frameIndex}: ${JSON.stringify(stagedBatch)}`);
    }
    for (const staged of stagedBatch.result.frames) {
      const sessionId = staged.sessionId;
      if (staged.endOfStream || !staged.frame) {
        stagingEndOfStream = true;
        throw new Error(`resident staging failed at ${sessionId} frame ${frameIndex}: ${JSON.stringify(staged)}`);
      }
      const frame = staged.frame;
      stagingDecoderPrepareMs.push(frame.decodePrepareMilliseconds);
      if (sessionId === stagingSessionIds[0]) stagingGpuSubmitCpuMs.push(frame.batchGpuSubmitCpuMilliseconds);
      stagingMaxAbsDriftMs = Math.max(stagingMaxAbsDriftMs, Math.abs(frame.clockDriftMilliseconds));
      stagingCpuPixelReadbacks += frame.stagingCpuPixelReadbacks;
      stagingDroppedFrames += frame.clockDroppedFrames;
      if (frame.clockSeeked) stagingUnexpectedSeeks += 1;
      if (frame.frameRingSlot !== frame.frameIndex % 3 || frame.residentFrameRingSize !== 3) {
        stagingRingReuseErrors += 1;
      }
      const expectedRetired = frame.gpuSubmissionSequence > 3 ? frame.gpuSubmissionSequence - 3 : null;
      if (frame.retiredSubmissionSequence !== expectedRetired) stagingFenceReuseErrors += 1;
      stagingCrossApiProducerCpuWaits += frame.crossApiProducerCpuWaits ?? Number.POSITIVE_INFINITY;
      if (frame.crossApiSharedFence !== true
        || frame.crossApiFenceValue !== frame.gpuSubmissionSequence) {
        stagingCrossApiFenceErrors += 1;
      }
      if (frameIndex < 12 || frameIndex % 300 === 0 || frameIndex === stagingTimelineFrames - 1) {
        stagingSamples.push({ sessionId, targetSeconds, frame });
      }
    }
    stagingTimelineLatenciesMs.push(performance.now() - timelineStartedAt);
  }
  const stagingElapsedMs = performance.now() - stagingStartedAt;
  const stagingDuplicateBatch = await request("video_stage_batch_at", {
    sessionIds: [stagingSessionIds[0], stagingSessionIds[0]],
    timeSeconds: 1,
    toleranceSeconds: 1 / 60,
  });
  const stagingInvalidBatchTolerance = await request("video_stage_batch_at", {
    sessionIds: stagingSessionIds,
    timeSeconds: 1,
    toleranceSeconds: 0,
  });
  const stagingInvalidTolerance = await request("video_stage_at", {
    sessionId: stagingSessionIds[0],
    timeSeconds: 1,
    toleranceSeconds: 0,
  });
  const stagingReleased = [];
  for (const sessionId of stagingSessionIds) {
    stagingReleased.push(await request("video_release", { sessionId }));
  }
  const stagingAfterRelease = await request("video_stage_at", {
    sessionId: stagingSessionIds[0],
    timeSeconds: 1,
    toleranceSeconds: 1 / 60,
  });
  const stagingReleasedStatus = await request("status");
  const percentile = (values, quantile) => {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)];
  };
  const stagingPerformance = {
    elapsedMs: stagingElapsedMs,
    realtimeFactor: longPlayDurationSeconds * 1_000 / stagingElapsedMs,
    requestP50Ms: percentile(stagingLatenciesMs, .5),
    requestP95Ms: percentile(stagingLatenciesMs, .95),
    requestContract: "single-ipc-resident-video-stage/v1",
    timelineFrameP50Ms: percentile(stagingTimelineLatenciesMs, .5),
    timelineFrameP95Ms: percentile(stagingTimelineLatenciesMs, .95),
    decoderPrepareP50Ms: percentile(stagingDecoderPrepareMs, .5),
    decoderPrepareP95Ms: percentile(stagingDecoderPrepareMs, .95),
    gpuSubmitCpuP50Ms: percentile(stagingGpuSubmitCpuMs, .5),
    gpuSubmitCpuP95Ms: percentile(stagingGpuSubmitCpuMs, .95),
    frameRingPhaseP95Ms: [0, 1, 2].map((phase) => percentile(
      stagingTimelineLatenciesMs.filter((_, index) => index % 3 === phase),
      .95,
    )),
  };

  const variableRateOpened = await request("video_open", { sessionId: "vfr-clock", inputPath: variableRateFixture });
  if (!variableRateOpened.ok) throw new Error(`VFR video_open failed: ${JSON.stringify(variableRateOpened)}`);
  const variableRateFrames = [];
  for (const targetSeconds of variableRateTimestamps) {
    const staged = await request("video_stage_at", {
      sessionId: "vfr-clock",
      timeSeconds: targetSeconds,
      toleranceSeconds: 1 / 120,
    });
    if (!staged.ok || staged.result.endOfStream) {
      throw new Error(`VFR staging failed at ${targetSeconds}: ${JSON.stringify(staged)}`);
    }
    variableRateFrames.push(staged.result.frame);
  }
  const variableRateReleased = await request("video_release", { sessionId: "vfr-clock" });
  const variableRateDeltas = variableRateTimestamps.slice(1).map((timestamp, index) => timestamp - variableRateTimestamps[index]);
  const variableRateUniqueCadences = new Set(variableRateDeltas.map((delta) => Math.round(delta * 10_000))).size;
  const variableRateMaxAbsDriftMs = Math.max(...variableRateFrames.map((frame) => Math.abs(frame.clockDriftMilliseconds)));
  const variableRateSampleIndexes = [0, 1, 2, 70, 71, 72, 73, variableRateFrames.length - 2, variableRateFrames.length - 1]
    .filter((index, position, values) => index >= 0 && index < variableRateFrames.length && values.indexOf(index) === position);

  const reopened = await request("video_open", { sessionId: "recovery-gate", inputPath });
  if (!reopened.ok) throw new Error(`recovery video_open failed: ${JSON.stringify(reopened)}`);
  const beforeRecovery = await request("video_decode_next", { sessionId: "recovery-gate" });
  if (!beforeRecovery.ok) throw new Error(`pre-recovery decode failed: ${JSON.stringify(beforeRecovery)}`);
  const recovered = await request("recover_device");
  const afterRecovery = await request("video_decode_next", { sessionId: "recovery-gate" });
  const recoveredStatus = await request("status");

  const checks = {
    advertisedResidentVideoProtocol:
      readyReceipt.videoInteropProtocol === "media-foundation-d3d11-d3d12-wgpu/v1",
    dx12VideoBackend: opened.result.backend === "Dx12" && liveStatus.result.videoBackend === "Dx12",
    decoderStayedResident:
      opened.result.decoder.resident === true && liveStatus.result.residentVideoSessions === 1,
    tripleFrameRingAllocated: opened.result.decoder.residentFrameRingSize === 3,
    duplicateSessionRejected:
      duplicate.ok === false && String(duplicate.error).includes("already exists"),
    thirtySequentialFrames:
      frames.length === 30 && frames.every((frame, index) => frame.frameIndex === index),
    tripleFrameRingReused:
      frames.every((frame, index) => frame.residentFrameRingSize === 3 && frame.frameRingSlot === index % 3),
    producerConsumerParity:
      frames.every((frame) => frame.producerConsumerParity && frame.producerHash === frame.outputHash),
    noDecodePathCpuPixelCopies:
      frames.every((frame) => frame.decodePathCpuPixelCopies === 0),
    boundedGpuPasses: frames.every((frame) => frame.gpuProcessingPasses === 2),
    visibleFramePreserved:
      frames.every((frame) => frame.width === 960 && frame.height === 540),
    previewArtifactWritten:
      frames[29].outputWritten === true && previewFrame.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    surfacePaddingAccountedFor:
      frames.every((frame) => frame.decoderSurfaceWidth >= frame.width && frame.decoderSurfaceHeight >= frame.height),
    temporalFramesChanged: new Set(frames.map((frame) => frame.outputHash)).size > 1,
    deterministicRandomSeek:
      seekForward.ok && seekBack.ok && forwardFrame.ok && firstFrameAgain.ok
        && forwardFrame.result.frame.timestampSeconds >= 5
        && forwardFrame.result.frame.outputHash !== frames[0].outputHash
        && firstFrameAgain.result.frame.timestampSeconds === frames[0].timestampSeconds
        && firstFrameAgain.result.frame.outputHash === frames[0].outputHash,
    releaseInvalidatedSession:
      released.ok && released.result.released && releasedStatus.result.residentVideoSessions === 0
        && afterRelease.ok === false && String(afterRelease.error).includes("unknown resident video session"),
    nativeSwapChainPresentation:
      surfaceOpened.ok && surfaceOpened.result.decoder.resident === true
        && surfaceBound.ok && surfaceBound.result.nativeSwapChain === true
        && surfaceBound.result.width === 16 && surfaceBound.result.height === 16
        && firstPresented.ok && firstPresented.result.endOfStream === false
        && firstPresented.result.frame.nativeSurfacePresented === true
        && firstPresented.result.frame.nativeSurfacePresentCount === 1
        && firstPresented.result.frame.nativeSurfaceCpuPixelReadbacks === 0
        && firstPresented.result.surface.presentCount === 1
        && surfaceResized.ok && surfaceResized.result.width === 24
        && surfaceResized.result.height === 18 && surfaceResized.result.presentCount === 1
        && secondPresented.ok && secondPresented.result.endOfStream === false
        && secondPresented.result.frame.nativeSurfacePresented === true
        && secondPresented.result.frame.nativeSurfacePresentCount === 2
        && secondPresented.result.frame.nativeSurfaceCpuPixelReadbacks === 0
        && secondPresented.result.surface.presentCount === 2
        && secondPresented.result.surface.cpuPixelReadbacks === 0
        && surfaceHidden.ok && surfaceHidden.result.hidden === true
        && surfaceReleased.ok && surfaceReleased.result.released === true
        && surfaceVideoReleased.ok && surfaceVideoReleased.result.released === true,
    nativeSurfaceNegativeControls:
      invalidSurface.ok === false && String(invalidSurface.error).includes("dimensions")
        && afterSurfaceRelease.ok === false
        && String(afterSurfaceRelease.error).includes("unknown resident video session"),
    sixResidentClockLayers:
      clockOpened.every((entry) => entry.ok && entry.result.decoder.resident === true)
        && sixLayerStatus.result.residentVideoSessions === 6,
    audioClockDirectedSelection:
      clockFrames.every(({ first, sequential, catchUp }) => first.ok && sequential.ok && catchUp.ok
        && first.result.frame.clockSeeked === true
        && first.result.frame.clockWithinTolerance === true
        && Math.abs(first.result.frame.clockDriftMilliseconds) <= 1000 / 60
        && sequential.result.frame.clockSeeked === false
        && sequential.result.frame.clockWithinTolerance === true
        && Math.abs(sequential.result.frame.clockDriftMilliseconds) <= 1000 / 60
        && catchUp.result.frame.clockSeeked === false
        && catchUp.result.frame.clockWithinTolerance === true
        && Math.abs(catchUp.result.frame.clockDriftMilliseconds) <= 1000 / 60),
    clockDropAccounting:
      clockFrames.every(({ first, sequential, catchUp }) => first.result.frame.clockDroppedFrames === 0
        && sequential.result.frame.clockDroppedFrames === 0
        && catchUp.result.frame.clockDroppedFrames > 0
        && catchUp.result.frame.totalClockDroppedFrames > sequential.result.frame.totalClockDroppedFrames),
    invalidClockToleranceRejected:
      invalidClockTolerance.ok === false && String(invalidClockTolerance.error).includes("toleranceSeconds"),
    sixClockLayersReleased:
      clockReleased.every((entry) => entry.ok && entry.result.released === true)
        && clockReleasedStatus.result.residentVideoSessions === 0,
    sixLayer1080pStagingAdvertised:
      stagingOpened.every((entry) => entry.ok
        && entry.result.decoder.width === 1920 && entry.result.decoder.height === 1080
        && entry.result.decoder.gpuResidentStaging === true
        && entry.result.decoder.stagingCpuPixelReadback === false
        && entry.result.decoder.stagingFenceRing === true
        && entry.result.decoder.crossApiSharedFence === true
        && entry.result.decoder.crossApiProducerCpuWaits === 0
        && entry.result.decoder.crossApiSynchronization === "ID3D11Fence shared handle -> ID3D12CommandQueue::Wait")
        && stagingStatus.result.residentVideoSessions === 6,
    sixtySecondSixLayerRunCompleted:
      !stagingEndOfStream && stagingLatenciesMs.length === stagingTimelineFrames,
    stagingStayedGpuResident:
      stagingCpuPixelReadbacks === 0
        && stagingSamples.every(({ frame }) => frame.gpuSurfaceResident === true
          && frame.verificationReadback === false && frame.outputWritten === false),
    stagingFenceRingOwned:
      stagingFenceReuseErrors === 0 && stagingRingReuseErrors === 0
        && stagingReleased.every((entry) => entry.ok && entry.result.released === true
          && entry.result.fences.retiredFenceCount === 3
          && entry.result.fences.pendingFenceCount === 0),
    crossApiSharedFenceOwned:
      stagingCrossApiFenceErrors === 0 && stagingCrossApiProducerCpuWaits === 0,
    stagingClockStayedSynchronized:
      stagingMaxAbsDriftMs <= 1000 / 60 && stagingUnexpectedSeeks === 0 && stagingDroppedFrames === 0,
    stagingMetRealtimeBudget:
      stagingPerformance.realtimeFactor >= 1
        && stagingPerformance.timelineFrameP95Ms <= 1000 / 30,
    stagingNegativeControls:
      stagingInvalidTolerance.ok === false && String(stagingInvalidTolerance.error).includes("toleranceSeconds")
        && stagingDuplicateBatch.ok === false && String(stagingDuplicateBatch.error).includes("must be unique")
        && stagingInvalidBatchTolerance.ok === false && String(stagingInvalidBatchTolerance.error).includes("toleranceSeconds")
        && stagingAfterRelease.ok === false && String(stagingAfterRelease.error).includes("unknown resident video session")
        && stagingReleasedStatus.result.residentVideoSessions === 0,
    variableFrameRatePtsPreserved:
      variableRateTimestamps.length > 100 && variableRateUniqueCadences >= 2
        && variableRateFrames.length === variableRateTimestamps.length
        && variableRateMaxAbsDriftMs <= 1000 / 120
        && variableRateFrames.every((frame, index) => frame.clockWithinTolerance === true
          && frame.stagingCpuPixelReadbacks === 0
          && frame.crossApiSharedFence === true
          && frame.crossApiFenceValue === frame.gpuSubmissionSequence
          && frame.crossApiProducerCpuWaits === 0
          && Math.abs(frame.timestampSeconds - variableRateTimestamps[index]) <= 1 / 120)
        && variableRateReleased.ok && variableRateReleased.result.released === true
        && variableRateReleased.result.fences.pendingFenceCount === 0,
    recoveryInvalidatedSession:
      recovered.ok && recovered.result.generation === readyReceipt.generation + 1
        && recovered.result.residentVideoSessions === 0 && recoveredStatus.result.residentVideoSessions === 0
        && afterRecovery.ok === false && String(afterRecovery.error).includes("unknown resident video session"),
  };
  const decision = Object.values(checks).every(Boolean) ? "GREEN" : "BLOCK";
  const report = {
    schema: "hao.resident-video-interop-gate/v1",
    decision,
    checks,
    frames: frames.length,
    uniqueFrameHashes: new Set(frames.map((frame) => frame.outputHash)).size,
    engine: readyReceipt.engine,
    imageBackend: readyReceipt.backend,
    videoBackend: opened.result.backend,
    generationAfterRecovery: recovered.result.generation,
    seekEvidence: {
      forward: forwardFrame,
      backToStart: firstFrameAgain,
    },
    audioClockEvidence: {
      concurrentResidentLayers: sixLayerStatus.result.residentVideoSessions,
      frames: clockFrames,
      invalidTolerance: invalidClockTolerance,
    },
    nativeSurfaceEvidence: {
      invalidSurface,
      surfaceOpened,
      surfaceBound,
      firstPresented,
      surfaceResized,
      secondPresented,
      surfaceHidden,
      surfaceReleased,
      surfaceVideoReleased,
      afterSurfaceRelease,
    },
    longPlayStagingEvidence: {
      fixture: longPlayFixture,
      durationSeconds: longPlayDurationSeconds,
      fps: 30,
      resolution: [1920, 1080],
      concurrentResidentLayers: stagingStatus.result.residentVideoSessions,
      timelineFrames: stagingTimelineFrames,
      stagedFrames: stagingLatenciesMs.length * stagingSessionIds.length,
      maxAbsDriftMs: stagingMaxAbsDriftMs,
      droppedFrames: stagingDroppedFrames,
      cpuPixelReadbacks: stagingCpuPixelReadbacks,
      unexpectedSeeks: stagingUnexpectedSeeks,
      fenceReuseErrors: stagingFenceReuseErrors,
      crossApiFenceErrors: stagingCrossApiFenceErrors,
      crossApiProducerCpuWaits: stagingCrossApiProducerCpuWaits,
      ringReuseErrors: stagingRingReuseErrors,
      performance: stagingPerformance,
      samples: stagingSamples,
      releases: stagingReleased,
      invalidTolerance: stagingInvalidTolerance,
      duplicateBatch: stagingDuplicateBatch,
      invalidBatchTolerance: stagingInvalidBatchTolerance,
      afterRelease: stagingAfterRelease,
    },
    variableRateEvidence: {
      fixture: variableRateFixture,
      expectedFrames: variableRateTimestamps.length,
      stagedFrames: variableRateFrames.length,
      uniqueCadences: variableRateUniqueCadences,
      maxAbsDriftMs: variableRateMaxAbsDriftMs,
      negotiatedFrameRate: variableRateOpened.result.decoder.frameRate,
      sourceTimestampOriginSeconds: variableRateOpened.result.decoder.sourceTimestampOriginSeconds,
      samples: variableRateSampleIndexes.map((index) => ({
        expectedTimestampSeconds: variableRateTimestamps[index],
        frame: variableRateFrames[index],
      })),
      release: variableRateReleased,
    },
    claimBoundary:
      "Proves a resident same-process decode session, deterministic seeking, calibrated source-PTS normalization with a real 24-to-30 fps VFR holdout, a reused triple GPU frame ring, six simultaneously resident 1080p clock-directed video layers over a 60-second continuous run, zero staging CPU pixel readback, a shared ID3D11Fence-to-ID3D12CommandQueue GPU handoff with zero producer CPU waits, explicit wgpu submission-fence retirement, incremental interop, and direct presentation of the resident texture into a resizeable native DX12 swap-chain surface. Binding that surface to the real Tauri preview region and validating it through the packaged application still remains required.",
  };
  await writeFile(evidence, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (decision !== "GREEN") process.exitCode = 1;

  const shutdown = await request("shutdown");
  if (!shutdown.ok) throw new Error(`resident shutdown failed: ${JSON.stringify(shutdown)}`);
  child.stdin.end();
  await new Promise((resolvePromise, reject) => {
    child.once("exit", (code) => code === 0
      ? resolvePromise()
      : reject(new Error(stderr || `resident engine exited ${code}`)));
  });
} finally {
  lines.close();
  if (!child.killed && child.exitCode === null) child.kill();
}
