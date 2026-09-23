export const REQUIRED_MATRIX_CASE_IDS = [
  "h264-1080p-d3d11va",
  "hevc-1080p-d3d11va",
  "h264-4k-source-a-d3d11va-wgpu",
  "h264-4k-source-b-d3d11va-wgpu",
];

const REQUIRED_RESIDENT_CHECK_IDS = [
  "advertisedResidentVideoProtocol",
  "dx12VideoBackend",
  "decoderStayedResident",
  "tripleFrameRingAllocated",
  "tripleFrameRingReused",
  "producerConsumerParity",
  "noDecodePathCpuPixelCopies",
  "nativeSwapChainPresentation",
  "sixLayer1080pStagingAdvertised",
  "sixtySecondSixLayerRunCompleted",
  "stagingStayedGpuResident",
  "stagingFenceRingOwned",
  "crossApiSharedFenceOwned",
  "stagingClockStayedSynchronized",
  "stagingMetRealtimeBudget",
  "stagingNegativeControls",
  "variableFrameRatePtsPreserved",
  "recoveryInvalidatedSession",
];

export const REQUIRED_EVIDENCE_IDS = [
  "source-a",
  "source-b",
  "native-a",
  "native-b",
  "hardware-decode",
  "resident-runtime",
  "closure-runner",
  "closure-evaluator",
  "hardware-decode-runner",
  "resident-runtime-runner",
  "native-executable",
  "native-windows-video-source",
  "node-executable",
  "ffmpeg-executable",
];

function fail(findings, code, message, caseId) {
  findings.push({ status: "FAIL", code, message, ...(caseId ? { caseId } : {}) });
}

export function evaluateHardwareZeroCopyClosure(report) {
  const findings = [];
  if (report?.schema !== "editkin.hardware-zero-copy-closure/v1") {
    fail(findings, "schema", "closure schema 必須是 editkin.hardware-zero-copy-closure/v1");
  }
  if (report?.platform !== "win32") fail(findings, "platform", "internal closure 目前只接受實測 Windows host");
  if (typeof report?.adapterName !== "string" || !report.adapterName.trim()) {
    fail(findings, "adapter", "缺少真實 GPU adapter identity");
  }
  if (report?.claimBoundary?.fullInteropCodecs?.join(",") !== "h264") {
    fail(findings, "claim-boundary", "full interop codec 邊界必須明確限制為 H.264");
  }
  if (report?.claimBoundary?.directHardwareEncode !== false) {
    fail(findings, "encoder-overclaim", "closure 不得冒充直接硬體編碼 surface interop");
  }
  if (report?.claimBoundary?.macosParity !== "unmeasured") {
    fail(findings, "macos-overclaim", "macOS parity 必須保持 unmeasured");
  }

  const matrix = Array.isArray(report?.matrix) ? report.matrix : [];
  const ids = matrix.map((item) => item?.id);
  if (new Set(ids).size !== ids.length) fail(findings, "duplicate-case", "能力矩陣包含重複 case ID");
  for (const id of REQUIRED_MATRIX_CASE_IDS) {
    if (!ids.includes(id)) fail(findings, "missing-case", `缺少必要 case：${id}`, id);
  }
  for (const item of matrix) {
    if (!REQUIRED_MATRIX_CASE_IDS.includes(item.id)) fail(findings, "unexpected-case", `出現未宣告 case：${item.id}`, item.id);
    if (item.status !== "GREEN") fail(findings, "case-blocked", `case 未通過：${item.id}`, item.id);
    if (!Number.isInteger(item.decodedFrames) || item.decodedFrames < item.minimumFrames) {
      fail(findings, "frame-count", `case frame 數不足：${item.id}`, item.id);
    }
    if (item.cpuPixelCopies !== 0) fail(findings, "cpu-pixel-copy", `case 發生 CPU pixel copy：${item.id}`, item.id);
    if (item.fullInterop === true) {
      if (item.width !== 3840 || item.height !== 2160) fail(findings, "not-4k", `full interop case 不是 4K：${item.id}`, item.id);
      if (item.producerConsumerParity !== true) fail(findings, "pixel-parity", `producer/consumer pixel 不一致：${item.id}`, item.id);
      if (item.temporalFramesChanged !== true) fail(findings, "frozen-frames", `full interop case 沒有時序像素變化：${item.id}`, item.id);
      if (item.gpuProcessingPassesPerFrame !== 2) fail(findings, "gpu-pass-budget", `GPU pass 數不符合 contract：${item.id}`, item.id);
    }
  }
  const fullInterop = matrix.filter((item) => item.fullInterop === true);
  if (fullInterop.length !== 2 || new Set(fullInterop.map((item) => item.sourceSha256)).size !== 2) {
    fail(findings, "distinct-source-coverage", "必須有兩個不同 source hash 的 4K full-interop cases");
  }

  if (report?.resident?.decision !== "GREEN") fail(findings, "resident-decision", "resident runtime gate 未通過");
  for (const id of REQUIRED_RESIDENT_CHECK_IDS) {
    if (report?.resident?.checks?.[id] !== true) fail(findings, "resident-check", `resident check 未通過：${id}`, id);
  }
  if (report?.negativeControls?.corruptInputRejected !== true) {
    fail(findings, "corrupt-input", "壞檔負向控制沒有 fail closed");
  }
  if (report?.negativeControls?.releasedSessionRejected !== true) {
    fail(findings, "released-session", "釋放後 session 負向控制沒有 fail closed");
  }
  const evidence = Array.isArray(report?.evidence) ? report.evidence : [];
  const evidenceIds = evidence.map((item) => item?.id);
  if (new Set(evidenceIds).size !== evidenceIds.length) fail(findings, "duplicate-evidence", "closure evidence ID 不得重複");
  for (const id of REQUIRED_EVIDENCE_IDS) {
    if (!evidenceIds.includes(id)) fail(findings, "missing-evidence-id", `缺少必要 evidence identity：${id}`, id);
  }
  if (evidenceIds.some((id) => !REQUIRED_EVIDENCE_IDS.includes(id))) fail(findings, "unexpected-evidence-id", "closure evidence 含未宣告 identity");
  if (evidence.some((item) => typeof item?.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256))) {
    fail(findings, "evidence-identity", "closure evidence 必須含合法 SHA-256");
  }

  return {
    schema: "editkin.hardware-zero-copy-closure-decision/v1",
    status: findings.length ? "BLOCK" : "GREEN",
    findings: findings.length ? findings : [{ status: "PASS", code: "windows-h264-zero-copy-internal", message: "Windows H.264 1080p/4K decode→D3D12→wgpu internal cell 已閉環；HEVC full interop、硬體編碼與 macOS parity 不在本 claim 內" }],
  };
}
