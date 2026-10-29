import { Console } from "node:console";
import { isAbsolute, resolve } from "node:path";
import { exportVideo } from "../application/exportVideo";
import { inspectMedia } from "../application/inspectMedia";
import { generateMediaDerivatives } from "../application/mediaDerivatives";
import { generateClipMediaDerivative, type ClipMediaDerivativeRequest } from "../application/clipMediaDerivatives";
import { parseProject, readProjectText } from "../application/projectFiles";
import { inspectDesktopProjectV1, readDesktopProjectV1, writeDesktopProjectV1, writeDesktopProjectRecoverableV1 } from "./projectFileDesktopV1";
import { clearRecoveryFile, commitRecoveryProjectFileV1, verifyRecoveryProjectBaseV1, readRecoveryFile, writeRecoveryFileAtomic } from "../application/recoveryFiles";
import { analyzeSmartCut } from "../application/smartCut";
import { transcribeAutomaticCaptions } from "../application/automaticCaptions";
import { analyzeSceneCuts } from "../application/sceneDetection";
import { analyzeMotionTrack } from "../application/motionTracking";
import { analyzeProductAutoRoto } from "../application/autoRotoNativeProduct";
import { listCreativeLibrary, resolveCreativeLibraryAsset, resolveCreativeLibraryPreviewAsset } from "../application/creativeLibrary";
import { compareVersions, loadUpdateManifest, stageUpdate, UPDATE_PUBLISHER_PIN } from "../application/updateManager";
import { runBatchAutoEditItem } from "../application/batchAutoEdit";
import { inspectBatchAutoEditItemV1 } from "../application/batchAutoEditStatusV1";
import { desktopBatchHostInputSchemaV1 } from "../application/desktopBatchTaskContractV1";
import { inspectDesktopBatchSessionV1 } from "./desktopBatchSessionStatusV1";
import { compactPluginRegistry, compilePluginApplication, discoverInstalledPlugins, findInstalledCapability, resolveGpuEffectGraphBindings } from "../plugins/registry";
import { renderNativeEffectPreviewProxy } from "../plugins/nativeEffectRender";
import { assertWorkflowProfileMatchesRegistry, readHostWorkflowProfile, writeHostWorkflowProfileAtomic } from "../plugins/workflowProfileFileStore";
import { stageNativeAudioPreview } from "../application/nativeAudioPreview";
import { stageNativeAudioProjectPlan } from "../application/nativeAudioProjectPlan";
import {
  autoRotoServiceArtifactReceipt,
  assertProductServiceAutoRotoRuntime,
  bindAutoRotoRuntimeToServiceArtifact,
} from "./autoRotoServiceArtifact";
import { runResidentService, ServiceProtocolError } from "./residentProtocol";
import { startupRenderWorkSweepRoots, sweepStaleRenderWorkDirectories } from "../render/renderWorkspace";
import { replayLongRenderJournalsV1 } from "../render/longRenderOwnerJournalV1";
import { withRenderProgress } from "../render/renderProgress";
import { openRenderJobControl } from "./renderJobControl";
import { dispatchColorLutDesktopV1 } from "./colorLutDesktopServiceV1";
import { originalSfxListRequestedV1, listOriginalSfxCandidatesV1, resolveOriginalSfxCandidateV1, materializeOriginalSfxCandidatesV1 } from "./originalSfxCandidateServiceV1";
import { isOriginalSfxCandidateIdV1 } from "../domain/originalSfxCandidateContractV1";
import { dispatchEngineTaskV1 } from "./engineTaskRegistryV1";
import { serviceBatchAutoEditRuntimeV1, serviceCaptionRuntimeV1 } from "./serviceMediaRuntimeV1";

interface ServiceRequest {
  command: "batch_auto_edit_status" | "batch_auto_edit_session_status" | "inspect_media" | "inspect_media_batch" | "prepare_media" | "clip_media_derivative" | "analyze_smart_cut" | "transcribe_media" | "detect_scenes" | "analyze_motion_track" | "analyze_auto_roto" | "parse_project" | "read_project" | "write_project" | "inspect_project_file" | "verify_recovery_project" | "commit_recovery_project" | "read_recovery" | "write_recovery" | "clear_recovery" | "render_project" | "render_native_effect_preview" | "stage_native_audio_preview" | "stage_native_audio_project" | "batch_auto_edit_item" | "check_update" | "stage_update" | "list_creative_library" | "resolve_creative_asset" | "resolve_creative_preview" | "list_installed_plugins" | "compile_plugin_tool" | "resolve_gpu_effect_bindings" | "read_workflow_profile" | "write_workflow_profile"
    // In-app template Shorts (M1 wave 4.2): one-shot children only, each with the closed environment the desktop builds.
    | "template_short_run" | "template_short_write_defaults" | "color_lut_library_v1" | "engine_task_v1";
  payload: Record<string, unknown>;
  runtime?: {
    ffmpeg?: string;
    ffprobe?: string;
    whisperCli?: string;
    nativeCore?: string;
    gpuCompositor?: string;
    assetBase?: string;
    cacheRoot?: string;
    modelRoot?: string;
    autoRotoDistributionMode?: "product" | "debug-research";
    autoRotoExternalResearchEnabled?: boolean;
    creativePackRoot?: string;
    personalMusicRoot?: string;
    personalVisualRoot?: string;
    personalColorLutRoot?: string;
    fontRoot?: string;
    colorRoot?: string;
    pluginRoots?: string[];
    pluginRoot?: string;
  };
}

function configuredPluginRoots(runtime: NonNullable<ServiceRequest["runtime"]>): string[] {
  return [...new Set([...(runtime.pluginRoots ?? []), runtime.pluginRoot].filter((value): value is string => Boolean(value)))];
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

const residentMode = process.argv.includes("--resident");

async function dispatch(request: ServiceRequest): Promise<unknown> {
  if (request.command === "template_short_run" || request.command === "template_short_write_defaults") {
    // A template Short is one job per child: fresh HMAC secret and receipts, the run's own environment, and a kill that
    // takes its whole process tree. The resident pool never runs one.
    if (residentMode) throw new Error(`${request.command} 只在單次子程序執行（每個工作一個子程序、固定環境變數）`);
    const { dispatchTemplateShortServiceCommand, redirectConsoleToStderr } = await import("./templateShortService");
    redirectConsoleToStderr();
    return dispatchTemplateShortServiceCommand(request.command, request.payload);
  }
  const runtime = bindAutoRotoRuntimeToServiceArtifact(request.runtime ?? {});
  if (request.command === "engine_task_v1") return dispatchEngineTaskV1(request.payload, runtime);
  if (request.command === "color_lut_library_v1") return dispatchColorLutDesktopV1(request.payload, runtime);
  if (request.command === "inspect_media") {
    return inspectMedia(String(request.payload.path), runtime.ffprobe);
  }
  if (request.command === "list_creative_library") {
    if (originalSfxListRequestedV1(request.payload)) return listOriginalSfxCandidatesV1(runtime);
    if (!runtime.creativePackRoot) throw new Error("list_creative_library 缺少 Creative Pack runtime");
    return listCreativeLibrary(runtime.creativePackRoot, runtime.personalMusicRoot, runtime.personalVisualRoot);
  }
  if (request.command === "list_installed_plugins") {
    const roots = configuredPluginRoots(runtime);
    if (!roots.length) throw new Error("list_installed_plugins 缺少 Plugin runtime");
    return compactPluginRegistry(await discoverInstalledPlugins(roots));
  }
  if (request.command === "read_workflow_profile") {
    const roots = configuredPluginRoots(runtime);
    if (!roots.length) throw new Error("read_workflow_profile 缺少 Plugin runtime");
    const registry = await discoverInstalledPlugins(roots);
    const host = await readHostWorkflowProfile(String(request.payload.path));
    return { ...host, profile: assertWorkflowProfileMatchesRegistry(host.profile, registry) };
  }
  if (request.command === "write_workflow_profile") {
    const roots = configuredPluginRoots(runtime);
    if (!roots.length) throw new Error("write_workflow_profile 缺少 Plugin runtime");
    const registry = await discoverInstalledPlugins(roots);
    return writeHostWorkflowProfileAtomic(request.payload.profile, registry, String(request.payload.path));
  }
  if (request.command === "compile_plugin_tool") {
    const roots = configuredPluginRoots(runtime);
    if (!roots.length) throw new Error("compile_plugin_tool 缺少 Plugin runtime");
    const registry = await discoverInstalledPlugins(roots);
    const { plugin, capability } = findInstalledCapability(registry, String(request.payload.pluginId), String(request.payload.capabilityId));
    return compilePluginApplication(plugin, capability, String(request.payload.targetClipId), (request.payload.parameters ?? {}) as Record<string, unknown>);
  }
  if (request.command === "resolve_gpu_effect_bindings") {
    const roots = configuredPluginRoots(runtime);
    if (!roots.length) throw new Error("resolve_gpu_effect_bindings 缺少 Plugin runtime");
    return resolveGpuEffectGraphBindings(request.payload.graph, roots);
  }
  if (request.command === "resolve_creative_asset") {
    if (isOriginalSfxCandidateIdV1(String(request.payload.assetId))) return resolveOriginalSfxCandidateV1(request.payload, runtime);
    if (!runtime.creativePackRoot) throw new Error("resolve_creative_asset 缺少 Creative Pack runtime");
    return resolveCreativeLibraryAsset(runtime.creativePackRoot, String(request.payload.assetId), runtime.personalMusicRoot, runtime.personalVisualRoot);
  }
  if (request.command === "resolve_creative_preview") {
    if (isOriginalSfxCandidateIdV1(String(request.payload.assetId))) return resolveOriginalSfxCandidateV1(request.payload, runtime);
    if (!runtime.creativePackRoot) throw new Error("resolve_creative_preview 缺少 Creative Pack runtime");
    const mode = request.payload.mode ?? "media";
    if (mode !== "poster" && mode !== "media") throw new Error("Creative preview mode 不合法");
    return resolveCreativeLibraryPreviewAsset(runtime.creativePackRoot, String(request.payload.assetId), mode, runtime.personalMusicRoot, runtime.personalVisualRoot);
  }
  if (request.command === "inspect_media_batch") {
    const paths = request.payload.paths as string[];
    return Promise.all(paths.map((path) => inspectMedia(path, runtime.ffprobe)));
  }
  if (request.command === "parse_project") {
    const input = request.payload.path
      ? JSON.parse(await readProjectText(String(request.payload.path)))
      : request.payload.project;
    return parseProject(input);
  }
  if (request.command === "inspect_project_file") {
    return inspectDesktopProjectV1(String(request.payload.path));
  }
  if (request.command === "read_project") {
    return readDesktopProjectV1(String(request.payload.path), request.payload.captureFileIdentity === true);
  }
  if (request.command === "write_project") {
    const expectedRevision = request.payload.expectedRevision;
    if (expectedRevision !== null && (!Number.isInteger(expectedRevision) || Number(expectedRevision) < 0)) {
      throw new Error("write_project.expectedRevision 必須是非負整數或 null");
    }
    return (request.payload.captureRetainedProjectV1 === true ? writeDesktopProjectRecoverableV1 : writeDesktopProjectV1)(
      String(request.payload.path),
      parseProject(request.payload.project),
      expectedRevision === null ? null : Number(expectedRevision),
      request.payload.captureFileIdentity === true,
      request.payload.expectedFileIdentity,
    );
  }
  if (request.command === "verify_recovery_project") return verifyRecoveryProjectBaseV1(String(request.payload.path), request.payload.snapshot);
  if (request.command === "commit_recovery_project") return commitRecoveryProjectFileV1(String(request.payload.path), request.payload.snapshot);
  if (request.command === "read_recovery") {
    return readRecoveryFile(String(request.payload.path));
  }
  if (request.command === "write_recovery") {
    return writeRecoveryFileAtomic(String(request.payload.path), {
      project: parseProject(request.payload.project),
      projectPath: typeof request.payload.projectPath === "string" ? request.payload.projectPath : undefined,
      cleanUpdatedAt: String(request.payload.cleanUpdatedAt),
      baseFileIdentity: request.payload.baseFileIdentity as import("../domain/projectFileIdentityV1").ProjectFileIdentityV1 | undefined,
    });
  }
  if (request.command === "clear_recovery") {
    await clearRecoveryFile(String(request.payload.path));
    return { cleared: true };
  }
  if (request.command === "prepare_media") {
    if (!runtime.cacheRoot) throw new Error("prepare_media 缺少 cacheRoot");
    return generateMediaDerivatives({
      sourcePath: String(request.payload.sourcePath),
      kind: request.payload.kind as "video" | "audio" | "image",
      duration: Number(request.payload.duration),
      hasAudio: Boolean(request.payload.hasAudio),
      cacheRoot: runtime.cacheRoot,
      ffmpegPath: runtime.ffmpeg,
      ffprobePath: runtime.ffprobe,
      sourceHeight: Number(request.payload.sourceHeight),
    });
  }
  if (request.command === "clip_media_derivative") {
    if (!runtime.cacheRoot || !runtime.ffmpeg || !runtime.ffprobe) throw new Error("clip_media_derivative 缺少 FFmpeg 或快取設定");
    return generateClipMediaDerivative(request.payload as unknown as ClipMediaDerivativeRequest, { cacheRoot: runtime.cacheRoot, ffmpegPath: runtime.ffmpeg, ffprobePath: runtime.ffprobe });
  }
  if (request.command === "analyze_smart_cut") {
    if (!runtime.ffmpeg) throw new Error("analyze_smart_cut 缺少 FFmpeg runtime");
    const payload = request.payload as unknown as Parameters<typeof analyzeSmartCut>[0];
    const sourcePath = isAbsolute(payload.sourcePath) ? payload.sourcePath : resolve(runtime.assetBase ?? process.cwd(), payload.sourcePath);
    return analyzeSmartCut({ ...payload, sourcePath }, {
      ffmpegPath: runtime.ffmpeg,
      nativeCorePath: runtime.nativeCore,
      cacheRoot: runtime.cacheRoot,
    });
  }
  if (request.command === "transcribe_media") {
    if (!runtime.ffmpeg || !runtime.modelRoot) throw new Error("transcribe_media 缺少 FFmpeg／modelRoot runtime");
    const payload = request.payload as unknown as Parameters<typeof transcribeAutomaticCaptions>[0];
    const sourcePath = isAbsolute(payload.sourcePath) ? payload.sourcePath : resolve(runtime.assetBase ?? process.cwd(), payload.sourcePath);
    return transcribeAutomaticCaptions({ ...payload, sourcePath }, serviceCaptionRuntimeV1({ ...runtime, ffmpeg: runtime.ffmpeg, modelRoot: runtime.modelRoot }));
  }
  if (request.command === "detect_scenes") {
    if (!runtime.ffmpeg) throw new Error("detect_scenes 缺少 FFmpeg runtime");
    const payload = request.payload as unknown as Parameters<typeof analyzeSceneCuts>[0];
    const sourcePath = isAbsolute(payload.sourcePath) ? payload.sourcePath : resolve(runtime.assetBase ?? process.cwd(), payload.sourcePath);
    return analyzeSceneCuts({ ...payload, sourcePath }, { ffmpegPath: runtime.ffmpeg, cacheRoot: runtime.cacheRoot });
  }
  if (request.command === "analyze_motion_track") {
    if (!runtime.ffmpeg || !runtime.nativeCore) throw new Error("analyze_motion_track 缺少 FFmpeg／Rust runtime");
    const payload = request.payload as unknown as Parameters<typeof analyzeMotionTrack>[0];
    const sourcePath = isAbsolute(payload.sourcePath) ? payload.sourcePath : resolve(runtime.assetBase ?? process.cwd(), payload.sourcePath);
    return analyzeMotionTrack({ ...payload, sourcePath }, { ffmpegPath: runtime.ffmpeg, nativeCorePath: runtime.nativeCore, cacheRoot: runtime.cacheRoot });
  }
  if (request.command === "analyze_auto_roto") {
    assertProductServiceAutoRotoRuntime(runtime);
    if (!runtime.ffmpeg || !runtime.nativeCore || !runtime.cacheRoot) throw new Error("analyze_auto_roto 缺少 FFmpeg／Rust／cache runtime");
    const payload = request.payload as unknown as Parameters<typeof analyzeProductAutoRoto>[0];
    const sourcePath = isAbsolute(payload.sourcePath) ? payload.sourcePath : resolve(runtime.assetBase ?? process.cwd(), payload.sourcePath);
    return analyzeProductAutoRoto({ ...payload, sourcePath }, { ffmpegPath: runtime.ffmpeg, nativeCorePath: runtime.nativeCore, cacheRoot: runtime.cacheRoot });
  }
  if (request.command === "render_project") {
    // A desktop export job (progressPath/cancelPath from the Tauri host) reports its stage and FFmpeg-measured
    // progress, and stops when the creator cancels; without those paths this renders exactly as before.
    const job = openRenderJobControl(request.payload);
    try {
      return await withRenderProgress(job.sink, async () => {
        const parsed = parseProject(request.payload.project);
        const project = runtime.creativePackRoot ? await materializeOriginalSfxCandidatesV1(parsed, runtime) : parsed;
        return exportVideo({
          project,
          outputPath: String(request.payload.outputPath),
          options: {
            ffmpegPath: runtime.ffmpeg,
            ffprobePath: runtime.ffprobe,
            nativeCorePath: runtime.nativeCore,
            gpuCompositorPath: runtime.gpuCompositor,
            assetBase: runtime.assetBase,
            autoRotoCacheRoot: runtime.cacheRoot,
            preferGpu: true,
            fontRoot: runtime.fontRoot,
            colorRoot: runtime.colorRoot,
            pluginRoots: configuredPluginRoots(runtime),
            deliveryProfile: request.payload.deliveryProfile === "prores4444_alpha_10bit" ? "prores4444_alpha_10bit" : "standard_mp4",
            signal: job.signal,
          },
        });
      });
    } finally {
      await job.dispose();
    }
  }
  if (request.command === "render_native_effect_preview") {
    if (!runtime.ffmpeg || !runtime.nativeCore || !runtime.cacheRoot) throw new Error("render_native_effect_preview 缺少 FFmpeg／Rust／cache runtime");
    const parsed = parseProject(request.payload.project);
    const project = runtime.creativePackRoot ? await materializeOriginalSfxCandidatesV1(parsed, runtime) : parsed;
    const pluginRoots = configuredPluginRoots(runtime);
    if (!pluginRoots.length) throw new Error("render_native_effect_preview 缺少 Plugin runtime");
    return renderNativeEffectPreviewProxy(project, String(request.payload.clipId), {
      ffmpegPath: runtime.ffmpeg,
      nativeCorePath: runtime.nativeCore,
      pluginRoots,
      cacheRoot: runtime.cacheRoot,
      assetBase: runtime.assetBase,
      timeoutMs: 15 * 60_000,
    });
  }
  if (request.command === "stage_native_audio_project") {
    if (!runtime.ffprobe || !runtime.cacheRoot) throw new Error("stage_native_audio_project 缺少 ffprobe／cache runtime");
    const parsed = parseProject(request.payload.project);
    const project = runtime.creativePackRoot
      ? await materializeOriginalSfxCandidatesV1(parsed, runtime)
      : parsed;
    return stageNativeAudioProjectPlan(project, {ffprobePath: runtime.ffprobe, cacheRoot: runtime.cacheRoot,
      assetBase: runtime.assetBase, generation: Number(request.payload.generation), timelineStartSeconds: Number(request.payload.timelineStartSeconds)});
  }
  if (request.command === "stage_native_audio_preview") {
    if (!runtime.ffmpeg || !runtime.ffprobe || !runtime.cacheRoot) {
      throw new Error("stage_native_audio_preview 缺少 FFmpeg／ffprobe／cache runtime");
    }
    const parsed = parseProject(request.payload.project);
    const project = runtime.creativePackRoot
      ? await materializeOriginalSfxCandidatesV1(parsed, runtime)
      : parsed;
    return stageNativeAudioPreview(project, {
      ffmpegPath: runtime.ffmpeg,
      ffprobePath: runtime.ffprobe,
      cacheRoot: runtime.cacheRoot,
      assetBase: runtime.assetBase,
      timelineStartSeconds: Number(request.payload.timelineStartSeconds),
      maxDurationSeconds: Number(request.payload.maxDurationSeconds ?? 30),
      timeoutMs: 45_000,
    });
  }
  if (request.command === "batch_auto_edit_status") return inspectBatchAutoEditItemV1(desktopBatchHostInputSchemaV1.parse(request.payload) as Parameters<typeof inspectBatchAutoEditItemV1>[0]);
  if (request.command === "batch_auto_edit_session_status") return inspectDesktopBatchSessionV1(request.payload.session);
  if (request.command === "batch_auto_edit_item") {
    if (!runtime.ffmpeg || !runtime.ffprobe || !runtime.modelRoot || !runtime.cacheRoot) throw new Error("batch_auto_edit_item 缺少媒體／cache owner runtime");
    return runBatchAutoEditItem({
      jobId: String(request.payload.jobId),
      sessionId: typeof request.payload.sessionId === "string" ? request.payload.sessionId : undefined,
      sourcePath: String(request.payload.sourcePath),
      outputRoot: String(request.payload.outputRoot),
      language: typeof request.payload.language === "string" ? request.payload.language : "auto",
      targetRatio: typeof request.payload.targetRatio === "number" ? request.payload.targetRatio : 0.65,
      addMusic: request.payload.addMusic !== false,
      analysisMode: request.payload.analysisMode === "smart_cut" ? "smart_cut" : "semantic",
      editorialProfile: typeof request.payload.editorialProfile === "string"
        ? request.payload.editorialProfile as Parameters<typeof runBatchAutoEditItem>[0]["editorialProfile"]
        : "auto",
    }, serviceBatchAutoEditRuntimeV1({ ...runtime, ffmpeg: runtime.ffmpeg, ffprobe: runtime.ffprobe, modelRoot: runtime.modelRoot }));
  }
  if (request.command === "check_update" || request.command === "stage_update") {
    const manifest = await loadUpdateManifest(String(request.payload.manifestUrl), { publisher: UPDATE_PUBLISHER_PIN });
    if (compareVersions(manifest.version, String(request.payload.currentVersion)) <= 0) return undefined;
    if (manifest.minimumProjectSchema > 6) throw new Error("這個更新需要尚未支援的專案 schema");
    if (request.command === "check_update") return { version: manifest.version };
    return stageUpdate(manifest, {
      currentVersion: String(request.payload.currentVersion),
      currentProjectSchema: 6,
      cacheRoot: String(request.payload.cacheRoot),
      publisher: UPDATE_PUBLISHER_PIN,
    });
  }
  throw new Error(`未知 service command：${String(request.command)}`);
}

async function runResidentCli(): Promise<void> {
  const args = process.argv.slice(2);
  let parentPid: number | undefined;
  let residentSeen = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--resident" && !residentSeen) residentSeen = true;
    else if (args[index] === "--parent-pid" && parentPid === undefined && /^[1-9][0-9]*$/u.test(args[index + 1] ?? "")) {
      parentPid = Number(args[++index]);
      if (!Number.isSafeInteger(parentPid) || parentPid !== process.ppid) throw new ServiceProtocolError("parent pid mismatch");
    } else throw new ServiceProtocolError("unsupported resident argument");
  }
  const diagnostics = new Console({ stdout: process.stderr, stderr: process.stderr });
  console.log = diagnostics.log.bind(diagnostics);
  console.info = diagnostics.info.bind(diagnostics);
  console.debug = diagnostics.debug.bind(diagnostics);
  // Older builds rendered into the OS temp folder; remove only Editkin's own orphaned render work directories.
  void sweepStaleRenderWorkDirectories(startupRenderWorkSweepRoots()).then(result => {
    if (result.removed.length || result.failures.length) console.info(`[render-work-sweep] removed=${result.removed.length} failed=${result.failures.length}`);
  }, error => console.info(`[render-work-sweep] skipped: ${error instanceof Error ? error.message : String(error)}`));
  // LONG renders journal their exact owned paths; replay only journals whose owner process on this host is gone.
  void replayLongRenderJournalsV1().then(result => {
    if (result.removed.length || result.leftovers.length || result.failures.length) console.info(`[long-render-journal] removed=${result.removed.length} leftovers=${result.leftovers.length} failed=${result.failures.length}`);
  }, error => console.info(`[long-render-journal] skipped: ${error instanceof Error ? error.message : String(error)}`));
  const lifetime = new AbortController();
  const timer = parentPid === undefined ? undefined : setInterval(() => {
    try { process.kill(parentPid, 0); } catch { lifetime.abort(); }
  }, 1_000);
  timer?.unref();
  try {
    await runResidentService({
      input: process.stdin,
      output: process.stdout,
      dispatch,
      serviceArtifact: autoRotoServiceArtifactReceipt,
      signal: lifetime.signal,
    });
  } finally {
    if (timer) clearInterval(timer);
  }
}

if (process.argv.includes("--resident")) {
  try {
    await runResidentCli();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    // Dispatch may still own subprocesses. No response claims cancellation or
    // completion; the native host tears down its worker process tree.
    process.exit(1);
  }
} else try {
  const request = JSON.parse(await readStdin()) as ServiceRequest;
  const result = await dispatch(request);
  process.stdout.write(JSON.stringify({ ok: true, result, serviceArtifact: autoRotoServiceArtifactReceipt() }));
} catch (error) {
  process.stdout.write(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    serviceArtifact: autoRotoServiceArtifactReceipt(),
  }));
  process.exitCode = 1;
}
