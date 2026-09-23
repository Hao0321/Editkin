import { strict as assert } from "node:assert";

function check(findings, condition, code, message) {
  findings.push({ status: condition ? "PASS" : "FAIL", code, message });
}

export function evaluateNativeAudioEndurance(report) {
  const findings = [];
  const receipt = report?.receipt ?? {};
  const duration = receipt?.duration ?? {};
  const endpoint = receipt?.endpoint ?? {};
  const format = receipt?.format ?? {};
  const device = receipt?.device ?? {};
  const transport = receipt?.transport ?? {};
  const graph = receipt?.graphToDevice ?? {};
  const negative = receipt?.negativeControls ?? {};
  const requestedSeconds = Number(duration.requestedSeconds ?? 0);
  const bufferFrames = Number(device.bufferFrames ?? 0);
  const eventCallbacks = Number(device.eventCallbacks ?? 0);
  const callbackFramesTotal = Number(device.callbackFramesTotal ?? 0);
  const masterFrame = Number(transport.masterFrame ?? 0);

  check(findings, report?.schema === "editkin.native-audio-endurance-closure/v1", "closure-schema", "closure schema is exact");
  check(findings, report?.platform === "win32", "windows-host", "the measured host is Windows");
  check(findings, /^sha256:[a-f0-9]{64}$/.test(report?.runtime?.sha256 ?? ""), "runtime-sha", "staged hao-core runtime has a SHA-256 identity");
  check(findings, Number(report?.runtime?.bytes ?? 0) > 0, "runtime-bytes", "staged hao-core runtime is non-empty");
  check(findings, receipt?.schema === "editkin.wasapi-endurance-gate/v1", "receipt-schema", "native receipt schema is exact");
  check(findings, receipt?.status === "GREEN", "native-status", "native runtime reported GREEN");
  check(findings, receipt?.backend === "WASAPI shared event-driven", "backend", "shared event-driven WASAPI is the measured backend");
  check(findings, requestedSeconds >= 60, "duration-request", "requested duration is at least 60 seconds");
  check(findings, Number(duration.actualMs ?? 0) >= requestedSeconds * 1_000 - 250, "duration-observed", "observed duration reaches the requested interval");
  check(findings, Number(endpoint.activeCount ?? 0) >= 1 && endpoint.state === 1, "physical-endpoint", "an active physical render endpoint was selected");
  check(findings, /^sha256:[a-f0-9]{64}$/.test(endpoint.selectedIdHash ?? ""), "endpoint-id", "endpoint identity is retained as a privacy-safe hash");
  check(findings, format.negotiatedFromEndpoint === true && Number(format.sampleRate ?? 0) >= 8_000 && Number(format.channels ?? 0) >= 1, "endpoint-format", "runtime uses the negotiated endpoint format");
  check(findings, bufferFrames > 0, "buffer", "WASAPI exposes a non-empty render buffer");
  check(findings, eventCallbacks >= requestedSeconds * 5, "callback-density", "hardware event callbacks continue throughout the run");
  check(findings, callbackFramesTotal >= Number(format.sampleRate ?? 0) * Math.max(0, requestedSeconds - 1), "callback-coverage", "callback frames cover the sustained interval");
  check(findings, Number(device.p50CallbackWaitMicros ?? 0) > 0 && Number(device.p95CallbackWaitMicros ?? 0) < 1_000_000, "callback-pacing", "callback p50/p95 are finite and stay below the timeout");
  check(findings, device.clockMonotonic === true && Number(device.finalClockPosition ?? 0) > Number(device.firstClockPosition ?? 0), "clock-monotonic", "physical audio clock advances monotonically");
  check(findings, Number(device.clockFrequency ?? 0) > 0 && Number(device.hardwareElapsedMs ?? 0) > 0 && Number(device.qpcElapsedMs ?? 0) > 0, "clock-sampled", "hardware and independent QPC intervals were sampled");
  check(findings, Number(device.hardwareQpcDriftMs ?? Infinity) <= 50, "clock-drift", "hardware clock remains within 50ms of QPC over the run");
  check(findings, Number(device.finalClockLeadFrames ?? -1) >= 0 && Number(device.finalClockLeadFrames ?? Infinity) <= bufferFrames * 2, "final-clock-bound", "final sample-master lead stays inside two buffers");
  check(findings, Number(device.maxClockLeadFrames ?? -1) >= 0 && Number(device.maxClockLeadFrames ?? Infinity) <= bufferFrames * 2, "max-clock-bound", "maximum sample-master lead stays inside two buffers");
  check(findings, masterFrame === bufferFrames + callbackFramesTotal, "sample-master", "sample master equals the exact primed plus callback frame count");
  check(findings, transport.underrunSamples === 0 && negative.unexpectedUnderrunSamples === 0, "zero-underrun", "the sustained interval inserted no unexpected silence");
  check(findings, transport.callbackLocks === 0 && transport.callbackAllocations === 0, "realtime-callback", "the callback contract retains zero locks and allocations");
  check(findings, graph.nodeCount === 5 && graph.sidechainRouting === true && graph.sampleAutomation === true && graph.subAudible === true, "graph-to-device", "the native five-node graph reaches the device with sub-audible safety");
  check(findings, device.started === true && device.stopped === true && device.reset === true, "device-lifecycle", "Start, Stop and Reset all completed");
  check(findings, negative.callbackTimeouts === 0 && negative.clockRegressionDetected === false, "negative-controls", "no callback timeout or clock regression was hidden");

  return {
    schema: "editkin.native-audio-endurance-decision/v1",
    status: findings.every((finding) => finding.status === "PASS") ? "GREEN" : "BLOCK",
    checks: findings.length,
    findings,
  };
}

export function selfTestNativeAudioEnduranceEvaluator() {
  const fixture = {
    schema: "editkin.native-audio-endurance-closure/v1",
    platform: "win32",
    runtime: { sha256: `sha256:${"a".repeat(64)}`, bytes: 10 },
    receipt: {
      schema: "editkin.wasapi-endurance-gate/v1",
      status: "GREEN",
      backend: "WASAPI shared event-driven",
      duration: { requestedSeconds: 60, actualMs: 60_010 },
      endpoint: { activeCount: 1, selectedIdHash: `sha256:${"b".repeat(64)}`, state: 1 },
      format: { sampleRate: 48_000, channels: 2, negotiatedFromEndpoint: true },
      device: {
        bufferFrames: 480,
        eventCallbacks: 6_000,
        callbackFramesTotal: 2_880_000,
        p50CallbackWaitMicros: 10_000,
        p95CallbackWaitMicros: 12_000,
        clockFrequency: 48_000,
        firstClockPosition: 480,
        finalClockPosition: 2_880_000,
        clockMonotonic: true,
        hardwareElapsedMs: 59_990,
        qpcElapsedMs: 59_991,
        hardwareQpcDriftMs: 1,
        finalClockLeadFrames: 480,
        maxClockLeadFrames: 480,
        started: true,
        stopped: true,
        reset: true,
      },
      transport: { masterFrame: 2_880_480, underrunSamples: 0, callbackLocks: 0, callbackAllocations: 0 },
      graphToDevice: { nodeCount: 5, sidechainRouting: true, sampleAutomation: true, subAudible: true },
      negativeControls: { callbackTimeouts: 0, unexpectedUnderrunSamples: 0, clockRegressionDetected: false },
    },
  };
  assert.equal(evaluateNativeAudioEndurance(fixture).status, "GREEN");
  const mutations = [
    (value) => { value.schema = "wrong"; },
    (value) => { value.platform = "darwin"; },
    (value) => { value.runtime.sha256 = "stale"; },
    (value) => { value.runtime.bytes = 0; },
    (value) => { value.receipt.schema = "wrong"; },
    (value) => { value.receipt.status = "BLOCK"; },
    (value) => { value.receipt.backend = "timer"; },
    (value) => { value.receipt.duration.requestedSeconds = 59; },
    (value) => { value.receipt.duration.actualMs = 58_000; },
    (value) => { value.receipt.endpoint.activeCount = 0; },
    (value) => { value.receipt.endpoint.selectedIdHash = "raw-device-id"; },
    (value) => { value.receipt.format.negotiatedFromEndpoint = false; },
    (value) => { value.receipt.device.bufferFrames = 0; },
    (value) => { value.receipt.device.eventCallbacks = 10; },
    (value) => { value.receipt.device.callbackFramesTotal = 10; },
    (value) => { value.receipt.device.p95CallbackWaitMicros = 1_000_000; },
    (value) => { value.receipt.device.clockMonotonic = false; },
    (value) => { value.receipt.device.clockFrequency = 0; },
    (value) => { value.receipt.device.hardwareQpcDriftMs = 51; },
    (value) => { value.receipt.device.finalClockLeadFrames = 961; },
    (value) => { value.receipt.device.maxClockLeadFrames = 961; },
    (value) => { value.receipt.transport.masterFrame += 1; },
    (value) => { value.receipt.transport.underrunSamples = 2; },
    (value) => { value.receipt.transport.callbackAllocations = 1; },
    (value) => { value.receipt.graphToDevice.nodeCount = 4; },
    (value) => { value.receipt.device.reset = false; },
    (value) => { value.receipt.negativeControls.callbackTimeouts = 1; },
  ];
  for (const mutate of mutations) {
    const candidate = structuredClone(fixture);
    mutate(candidate);
    assert.equal(evaluateNativeAudioEndurance(candidate).status, "BLOCK");
  }
  return { status: "GREEN", mutationsDetected: mutations.length };
}
