import { strict as assert } from "node:assert";

function check(findings, condition, code, message) {
  findings.push({ status: condition ? "PASS" : "FAIL", code, message });
}

function isFormat(value) {
  return Number(value?.sampleRate) >= 8_000
    && Number(value?.sampleRate) <= 192_000
    && Number(value?.channels) >= 1
    && Number(value?.channels) <= 2
    && Number(value?.bitsPerSample) >= 16
    && typeof value?.sampleFormat === "string";
}

export function evaluateNativeAudioRecovery(report) {
  const findings = [];
  const receipt = report?.receipt ?? {};
  const events = receipt?.events ?? {};
  const recovery = receipt?.recovery ?? {};
  const transition = receipt?.formatTransitionOracle ?? {};
  const transport = receipt?.transport ?? {};
  const lifecycle = receipt?.lifecycle ?? {};
  const negative = receipt?.negativeControls ?? {};
  const sourceFrames = Number(receipt?.source?.frames ?? 0);
  const resumedSourceFrame = Number(recovery?.resumedSourceFrame ?? 0);
  const eventKinds = Array.isArray(events.kinds) ? events.kinds : [];

  check(findings, report?.schema === "editkin.native-audio-recovery-product-gate/v1", "closure-schema", "closure schema is exact");
  check(findings, report?.platform === "win32", "windows-host", "the measured host is Windows");
  check(findings, /^sha256:[a-f0-9]{64}$/.test(report?.runtime?.sha256 ?? ""), "runtime-sha", "runtime has an exact SHA-256 identity");
  check(findings, Number(report?.runtime?.bytes ?? 0) > 0, "runtime-bytes", "runtime is non-empty");
  check(findings, receipt?.schema === "editkin.wasapi-preview-recovery-gate/v1", "receipt-schema", "native receipt schema is exact");
  check(findings, receipt?.status === "GREEN", "native-status", "native recovery self-test reports GREEN");
  check(findings, receipt?.backend === "WASAPI shared event-driven", "backend", "the real shared event-driven WASAPI backend is exercised");
  check(findings, receipt?.productPath === "physical_output_play_preview_pcm/v2", "product-path", "the recovery probe uses the same preview playback implementation as the product");
  check(findings, Number(receipt?.source?.sampleRate) === 48_000 && Number(receipt?.source?.channels) === 2 && sourceFrames >= 48_000, "bounded-source", "a bounded canonical source is retained");
  check(findings, isFormat(receipt?.formats?.initial) && isFormat(receipt?.formats?.final), "physical-formats", "initial and final formats are negotiated physical formats");
  check(findings, /^sha256:[a-f0-9]{64}$/.test(receipt?.endpoint?.initialIdHash ?? "") && /^sha256:[a-f0-9]{64}$/.test(receipt?.endpoint?.finalIdHash ?? ""), "endpoint-identities", "endpoint identities are privacy-safe hashes");
  check(findings, receipt?.endpoint?.rawIdsExposed === false, "endpoint-redaction", "raw endpoint identifiers are not exposed");
  check(findings, eventKinds.includes("started") && eventKinds.includes("recovering") && eventKinds.includes("recovered") && eventKinds.includes("ended"), "recovery-events", "started/recovering/recovered/ended events are all observed");
  check(findings, Number(events.progressCount ?? 0) >= 2 && events.progressAfterRecovery === true, "post-recovery-progress", "progress continues after recovery");
  check(findings, events.timelineMonotonic === true && Number(events.timelineRegressionSeconds ?? Infinity) === 0, "timeline-monotonic", "Timeline time never regresses");
  check(findings, events.sampleMasterMonotonic === true && Number(events.sampleMasterRegressionFrames ?? Infinity) === 0, "sample-master-monotonic", "canonical sample master never regresses");
  check(findings, Number(events.endedSourceFrame ?? 0) === sourceFrames, "timeline-completion", "the recovered session reaches the exact source tail");
  check(findings, recovery.notificationRegistered === true && recovery.notificationUnregistered === true, "notification-lifecycle", "IMMNotificationClient registration is balanced");
  check(findings, recovery.forcedControl === true && recovery.trigger === "IMMNotificationClient.OnDefaultDeviceChanged(eRender,eConsole)", "notification-trigger", "the calibrated control enters through the render-default notification callback");
  check(findings, Number(recovery.recoveryEvents ?? 0) === 1 && Number(recovery.physicalStreamReopens ?? 0) === 1, "single-reopen", "one notification causes exactly one physical stream reopen");
  check(findings, Number(recovery.initialOpenAttempts ?? 0) >= 1
    && Number(recovery.initialOpenAttempts ?? Infinity) <= Number(recovery.maxAttemptsPerOpen ?? 0)
    && Number(recovery.recoveryOpenAttempts ?? 0) >= 1
    && Number(recovery.recoveryOpenAttempts ?? Infinity) <= Number(recovery.maxAttemptsPerOpen ?? 0)
    && Number(recovery.openAttempts ?? 0) === Number(recovery.initialOpenAttempts ?? -1) + Number(recovery.recoveryOpenAttempts ?? -1), "bounded-attempts", "each endpoint open stays inside the cap and total attempts reconcile");
  check(findings, Number(recovery.maxAttemptsPerOpen ?? 0) === 6 && Number(recovery.deadlineMs ?? 0) === 5_000 && Number(recovery.maxObservedOutageMs ?? Infinity) <= 5_000, "bounded-outage", "recovery has a five-second wall-clock deadline and six-attempt cap per open");
  check(findings, resumedSourceFrame > 0 && resumedSourceFrame < sourceFrames, "resume-position", "recovery resumes from a non-trivial canonical source position");
  check(findings, Number(recovery.maxReplayFrames ?? Infinity) <= Number(recovery.replayBoundFrames ?? -1) && Number(recovery.replayBoundFrames ?? -1) >= 0, "replay-bound", "stale-clock replay is bounded to the declared buffer-derived guardrail");
  check(findings, recovery.resampleRemixOnEveryOpen === true, "reopen-conversion", "remaining canonical PCM is resampled/remixed after every open");
  check(findings, transition.formatsDiffer === true && transition.finite === true && transition.continuityPreserved === true, "format-change-oracle", "a differing-rate/channel transition preserves finite PCM continuity");
  check(findings, Number(transition.resumedSourceFrame ?? 0) > 0 && Number(transition.recoveredDeviceFrames ?? 0) === Number(transition.expectedRecoveredDeviceFrames ?? -1), "format-change-frame-accounting", "changed-format frame accounting is exact");
  check(findings, Number(transport.segments ?? 0) === 2 && Number(transport.unexpectedUnderrunSamples ?? Infinity) === 0, "transport-continuity", "two transport segments finish without unexpected underrun");
  check(findings, Number(transport.callbackLocks ?? Infinity) === 0 && Number(transport.callbackAllocations ?? Infinity) === 0, "realtime-callback", "callbacks retain zero locks and allocations");
  check(findings, Number(lifecycle.segmentsStarted ?? 0) === 2 && Number(lifecycle.segmentsStopped ?? 0) === 2 && Number(lifecycle.segmentsReset ?? 0) === 2 && lifecycle.handlesClosed === true, "balanced-lifecycle", "both physical segments stop/reset and owned handles close");
  check(findings, negative.captureDefaultChangeIgnored === true && negative.invalidPcmRejected === true && negative.retryPolicyRejected === true, "negative-controls", "irrelevant notification, invalid PCM, and invalid retry policy controls are rejected");

  return {
    schema: "editkin.native-audio-recovery-decision/v1",
    status: findings.every((finding) => finding.status === "PASS") ? "GREEN" : "BLOCK",
    checks: findings.length,
    findings,
  };
}

export function selfTestNativeAudioRecoveryEvaluator() {
  const fixture = {
    schema: "editkin.native-audio-recovery-product-gate/v1",
    platform: "win32",
    runtime: { sha256: `sha256:${"a".repeat(64)}`, bytes: 1 },
    receipt: {
      schema: "editkin.wasapi-preview-recovery-gate/v1",
      status: "GREEN",
      backend: "WASAPI shared event-driven",
      productPath: "physical_output_play_preview_pcm/v2",
      source: { sampleRate: 48_000, channels: 2, frames: 96_000 },
      endpoint: { initialIdHash: `sha256:${"b".repeat(64)}`, finalIdHash: `sha256:${"c".repeat(64)}`, rawIdsExposed: false },
      formats: {
        initial: { sampleRate: 48_000, channels: 2, bitsPerSample: 32, sampleFormat: "f32" },
        final: { sampleRate: 48_000, channels: 2, bitsPerSample: 32, sampleFormat: "f32" },
      },
      events: { kinds: ["started", "progress", "recovering", "recovered", "progress", "ended"], progressCount: 2, progressAfterRecovery: true, timelineMonotonic: true, timelineRegressionSeconds: 0, sampleMasterMonotonic: true, sampleMasterRegressionFrames: 0, endedSourceFrame: 96_000 },
      recovery: { notificationRegistered: true, notificationUnregistered: true, forcedControl: true, trigger: "IMMNotificationClient.OnDefaultDeviceChanged(eRender,eConsole)", recoveryEvents: 1, physicalStreamReopens: 1, initialOpenAttempts: 1, recoveryOpenAttempts: 1, openAttempts: 2, maxAttemptsPerOpen: 6, deadlineMs: 5_000, maxObservedOutageMs: 20, resumedSourceFrame: 24_000, maxReplayFrames: 240, replayBoundFrames: 480, resampleRemixOnEveryOpen: true },
      formatTransitionOracle: { formatsDiffer: true, finite: true, continuityPreserved: true, resumedSourceFrame: 24_000, recoveredDeviceFrames: 66_150, expectedRecoveredDeviceFrames: 66_150 },
      transport: { segments: 2, unexpectedUnderrunSamples: 0, callbackLocks: 0, callbackAllocations: 0 },
      lifecycle: { segmentsStarted: 2, segmentsStopped: 2, segmentsReset: 2, handlesClosed: true },
      negativeControls: { captureDefaultChangeIgnored: true, invalidPcmRejected: true, retryPolicyRejected: true },
    },
  };
  assert.equal(evaluateNativeAudioRecovery(fixture).status, "GREEN");
  const mutations = [
    ["wrong-schema", (value) => { value.schema = "wrong"; }],
    ["wrong-platform", (value) => { value.platform = "darwin"; }],
    ["missing-runtime", (value) => { value.runtime.sha256 = "stale"; }],
    ["forged-status", (value) => { value.receipt.status = "BLOCK"; }],
    ["wrong-product-path", (value) => { value.receipt.productPath = "test-only"; }],
    ["raw-endpoint", (value) => { value.receipt.endpoint.rawIdsExposed = true; }],
    ["missing-recovery-event", (value) => { value.receipt.events.kinds = ["started", "progress", "ended"]; }],
    ["no-post-progress", (value) => { value.receipt.events.progressAfterRecovery = false; }],
    ["timeline-regression", (value) => { value.receipt.events.timelineMonotonic = false; }],
    ["master-regression", (value) => { value.receipt.events.sampleMasterMonotonic = false; }],
    ["truncated-tail", (value) => { value.receipt.events.endedSourceFrame -= 1; }],
    ["unbalanced-notification", (value) => { value.receipt.recovery.notificationUnregistered = false; }],
    ["forged-trigger", (value) => { value.receipt.recovery.trigger = "atomic-counter"; }],
    ["duplicate-reopen", (value) => { value.receipt.recovery.physicalStreamReopens = 2; }],
    ["unbounded-attempts", (value) => { value.receipt.recovery.recoveryOpenAttempts = 7; value.receipt.recovery.openAttempts = 8; }],
    ["unbounded-outage", (value) => { value.receipt.recovery.maxObservedOutageMs = 5_001; }],
    ["resume-at-start", (value) => { value.receipt.recovery.resumedSourceFrame = 0; }],
    ["replay-over-bound", (value) => { value.receipt.recovery.maxReplayFrames = 481; }],
    ["conversion-bypass", (value) => { value.receipt.recovery.resampleRemixOnEveryOpen = false; }],
    ["same-format-oracle", (value) => { value.receipt.formatTransitionOracle.formatsDiffer = false; }],
    ["format-frame-drift", (value) => { value.receipt.formatTransitionOracle.recoveredDeviceFrames += 1; }],
    ["underrun-hidden", (value) => { value.receipt.transport.unexpectedUnderrunSamples = 2; }],
    ["callback-allocation", (value) => { value.receipt.transport.callbackAllocations = 1; }],
    ["unbalanced-segment", (value) => { value.receipt.lifecycle.segmentsReset = 1; }],
    ["negative-missing", (value) => { value.receipt.negativeControls.retryPolicyRejected = false; }],
  ];
  const detected = {};
  for (const [name, mutate] of mutations) {
    const candidate = structuredClone(fixture);
    mutate(candidate);
    const decision = evaluateNativeAudioRecovery(candidate);
    assert.equal(decision.status, "BLOCK", `${name} mutation escaped`);
    detected[name] = decision.findings.filter((finding) => finding.status === "FAIL").map((finding) => finding.code);
  }
  return { status: "GREEN", mutationsDetected: mutations.length, detected };
}
