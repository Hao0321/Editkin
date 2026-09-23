export const REQUIRED_GPU_RUNTIME_EVIDENCE_IDS = [
  "tauri-report",
  "resident-report",
  "closure-runner",
  "closure-evaluator",
  "tauri-runner",
  "resident-runner",
  "tauri-executable",
  "node-executable",
  "rust-resident-server",
  "rust-native-surface",
  "tauri-host-bridge",
  "frontend-preview-runtime",
];

function fail(findings, code, message) {
  findings.push({ status: "FAIL", code, message });
}

function directGraphValid(graph) {
  return graph?.graphSchema === "editkin.engine-graph/v1"
    && graph.directExecution === true
    && graph.executionFormat === "rgba32_float"
    && Array.isArray(graph.blockedNodeIds) && graph.blockedNodeIds.length === 0
    && Array.isArray(graph.ignoredNodeIds) && graph.ignoredNodeIds.length === 0
    && Array.isArray(graph.executedNodeIds) && graph.executedNodeIds.length >= 4;
}

export function evaluateGpuRuntimeClosure(report) {
  const findings = [];
  if (report?.schema !== "editkin.gpu-runtime-closure/v1") fail(findings, "schema", "GPU runtime closure schema 不合法");
  if (report?.platform !== "win32") fail(findings, "platform", "internal closure 目前只接受 Windows 實機");
  if (typeof report?.adapter !== "string" || !report.adapter.trim()) fail(findings, "adapter", "缺少實測 GPU adapter identity");
  const boundary = report?.claimBoundary;
  if (boundary?.scope !== "internal" || boundary?.aggregate !== "planned" || boundary?.public !== "planned" || boundary?.parity !== "unmeasured") {
    fail(findings, "claim-boundary", "internal closure 不得冒充 aggregate/public/parity 完成");
  }

  const tauri = report?.tauri;
  if (tauri?.status !== "GREEN" || tauri?.buildManifestStatus !== "GREEN" || tauri?.product !== "Editkin") {
    fail(findings, "tauri-product", "正式 Tauri 產品 journey 或 build identity 未通過");
  }
  if (tauri?.rootMounted !== true || tauri?.timelineInteractive !== true || tauri?.renderInteractive !== true) {
    fail(findings, "window-lifecycle", "實體視窗沒有維持可互動 editor lifecycle");
  }
  if (tauri?.typedImage?.status !== "GREEN" || !directGraphValid(tauri?.typedImage?.graph)
    || tauri?.typedImage?.timelineChanged !== true || tauri?.typedImage?.legacyOverrideRejected !== true) {
    fail(findings, "typed-image-graph", "typed image graph 沒有直接執行、逐時更新或拒絕 legacy override");
  }
  const video = tauri?.typedVideo;
  if (video?.status !== "GREEN" || !directGraphValid(video?.graph)
    || video?.resourcePlan?.schema !== "editkin.resident-video-resource-plan/v1"
    || !(video?.resourcePlan?.requiredBytes > 0) || !(video?.resourcePlan?.remainingBytes >= 0)
    || !(video?.residentFrameRingSize >= 3) || video?.decodePathCpuPixelCopies !== 0
    || video?.stagingCpuPixelReadbacks !== 0 || video?.nativeSurfaceCpuPixelReadbacks !== 0
    || video?.nativeSurfacePresented !== true) {
    fail(findings, "typed-video-graph", "typed video graph 的資源預算、frame ring 或零拷貝 surface receipt 不完整");
  }
  const multitrack = tauri?.multitrack;
  if (multitrack?.status !== "GREEN" || multitrack?.coverageComplete !== true
    || multitrack?.resourcePlanGreen !== true || multitrack?.scheduleGreen !== true
    || multitrack?.decoderGroupingGreen !== true || multitrack?.dirtyFallbackGreen !== true
    || multitrack?.direct !== true || multitrack?.missingBindingRejected !== true
    || multitrack?.extraBindingRejected !== true) {
    fail(findings, "multitrack-resource-dirty", "多軌資源治理、dirty fallback 或 binding 負向控制未閉環");
  }
  const surface = tauri?.surface;
  if (surface?.status !== "GREEN" || surface?.invalidRejected !== true || surface?.dimensionsMatchDpi !== true
    || surface?.nativeSwapChain !== true || surface?.backend !== "Dx12"
    || surface?.firstPresentCount !== 1 || surface?.secondPresentCount !== 2
    || surface?.cpuPixelReadbacks !== 0 || surface?.rejectedAfterRelease !== true
    || surface?.released !== true) {
    fail(findings, "native-surface", "DX12 swap-chain bind/resize/present/release journey 不完整");
  }
  const recovery = tauri?.typedRecovery;
  if (recovery?.status !== "GREEN" || recovery?.coverageComplete !== true
    || recovery?.loadHandshake !== true || recovery?.activeHandshake !== true
    || recovery?.armed !== true || recovery?.rejectedWithDeviceLost !== true
    || recovery?.replayHandshake !== true || !(recovery?.generationAfter > recovery?.generationBefore)) {
    fail(findings, "typed-device-recovery", "typed graph device-loss recovery 沒有清空並重播新 generation");
  }
  const rawRecovery = tauri?.surfaceRecovery;
  if (rawRecovery?.status !== "GREEN" || rawRecovery?.armed !== true
    || rawRecovery?.rejectedWithDeviceLost !== true || rawRecovery?.residentSessionsAfter !== 0
    || rawRecovery?.residentVideoSessionsAfter !== 0 || rawRecovery?.residentEngineVideoSessionsAfter !== 0
    || !(rawRecovery?.generationAfter > rawRecovery?.generationBefore)
    || rawRecovery?.reopenedGeneration !== rawRecovery?.generationAfter
    || rawRecovery?.nativeSurfacePresented !== true || rawRecovery?.cpuPixelReadbacks !== 0) {
    fail(findings, "surface-device-recovery", "native surface device-loss recovery 或舊 resource invalidation 不完整");
  }
  const fallback = tauri?.productFallback;
  if (fallback?.status !== "GREEN" || fallback?.acceleratedBefore !== true || !(fallback?.forcedCalls >= 1)
    || fallback?.compatiblePreview !== true || fallback?.acceleratedRestored !== true
    || fallback?.projectTruthStable !== true || fallback?.projectWriteDelta !== 0
    || fallback?.runtimeStable !== true || !(fallback?.generationAfter > fallback?.generationBefore)
    || fallback?.videoBackend !== "Dx12") {
    fail(findings, "product-fallback", "產品層 GPU 不支援 fallback、專案真相或恢復 journey 未閉環");
  }

  const resident = report?.resident;
  if (resident?.status !== "GREEN" || resident?.engine !== "editkin-wgpu-resident-engine/v1"
    || !(resident?.frames >= 12) || typeof resident?.outputHash !== "string"
    || !/^[a-f0-9]{64}$/.test(resident.outputHash)
    || resident?.faultInjection?.armed !== true || resident?.faultInjection?.rejectedWithDeviceLost !== true
    || resident?.faultInjection?.deterministicRenderRestored !== true
    || resident?.negativeControl !== "unknown-session-rejected") {
    fail(findings, "resident-runtime", "獨立 resident runtime deterministic recovery gate 未通過");
  }

  const evidence = Array.isArray(report?.evidence) ? report.evidence : [];
  const ids = evidence.map((item) => item?.id);
  if (new Set(ids).size !== ids.length) fail(findings, "duplicate-evidence", "evidence ID 不得重複");
  for (const id of REQUIRED_GPU_RUNTIME_EVIDENCE_IDS) {
    if (!ids.includes(id)) fail(findings, "missing-evidence-id", `缺少 evidence identity：${id}`);
  }
  if (ids.some((id) => !REQUIRED_GPU_RUNTIME_EVIDENCE_IDS.includes(id))) fail(findings, "unexpected-evidence-id", "evidence 含未宣告 identity");
  if (evidence.some((item) => typeof item?.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256))) {
    fail(findings, "evidence-identity", "所有 evidence 都必須有 SHA-256 identity");
  }

  return {
    schema: "editkin.gpu-runtime-closure-decision/v1",
    status: findings.length ? "BLOCK" : "GREEN",
    findings: findings.length ? findings : [{
      status: "PASS",
      code: "windows-gpu-runtime-internal",
      message: "Windows internal 的 Tauri window→typed graph→DX12 surface→device recovery→safe fallback 已閉環；aggregate/public/parity 仍保持開放",
    }],
  };
}
