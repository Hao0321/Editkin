import { readFile } from "node:fs/promises";
import { Console } from "node:console";
import { isAbsolute, resolve } from "node:path";
import { exportVideo } from "../application/exportVideo";
import { inspectMedia } from "../application/inspectMedia";
import { generateMediaDerivatives } from "../application/mediaDerivatives";
import { parseProject, readProjectFile, writeProjectFileAtomic } from "../application/projectFiles";
import { clearRecoveryFile, readRecoveryFile, writeRecoveryFileAtomic } from "../application/recoveryFiles";
import { analyzeSmartCut } from "../application/smartCut";
import { transcribeAutomaticCaptions } from "../application/automaticCaptions";
import { analyzeSceneCuts } from "../application/sceneDetection";
import { analyzeMotionTrack } from "../application/motionTracking";
import { analyzeProductAutoRoto } from "../application/autoRotoNativeProduct";
import { listCreativeLibrary, materializeCreativeAssets, resolveCreativeLibraryAsset, resolveCreativeLibraryPreviewAsset } from "../application/creativeLibrary";
import { assertUpdateManifestUrl, compareVersions, parseUpdateManifest, stageUpdate } from "../application/updateManager";
import { runBatchAutoEditItem } from "../application/batchAutoEdit";
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

interface ServiceRequest {
  command: "inspect_media" | "inspect_media_batch" | "prepare_media" | "analyze_smart_cut" | "transcribe_media" | "detect_scenes" | "analyze_motion_track" | "analyze_auto_roto" | "parse_project" | "read_project" | "write_project" | "read_recovery" | "write_recovery" | "clear_recovery" | "render_project" | "render_native_effect_preview" | "stage_native_audio_preview" | "stage_native_audio_project" | "batch_auto_edit_item" | "check_update" | "stage_update" | "list_creative_library" | "resolve_creative_asset" | "resolve_creative_preview" | "list_installed_plugins" | "compile_plugin_tool" | "resolve_gpu_effect_bindings" | "read_workflow_profile" | "write_workflow_profile";
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

async function dispatch(request: ServiceRequest): Promise<unknown> {
  const runtime = bindAutoRotoRuntimeToServiceArtifact(request.runtime ?? {});
  if (request.command === "inspect_media") {
    return inspectMedia(String(request.payload.path), runtime.ffprobe);
  }
  if (request.command === "list_creative_library") {
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
    if (!runtime.creativePackRoot) throw new Error("resolve_creative_asset 缺少 Creative Pack runtime");
    return resolveCreativeLibraryAsset(runtime.creativePackRoot, String(request.payload.assetId), runtime.personalMusicRoot, runtime.personalVisualRoot);
  }
  if (request.command === "resolve_creative_preview") {
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
      ? JSON.parse(await readFile(String(request.payload.path), "utf8"))
      : request.payload.project;
    return parseProject(input);
  }
  if (request.command === "read_project") {
    return readProjectFile(String(request.payload.path));
  }
  if (request.command === "write_project") {
    const expectedRevision = request.payload.expectedRevision;
    if (expectedRevision !== null && (!Number.isInteger(expectedRevision) || Number(expectedRevision) < 0)) {
      throw new Error("write_project.expectedRevision 必須是非負整數或 null");
    }
    return writeProjectFileAtomic(
      String(request.payload.path),
      parseProject(request.payload.project),
      expectedRevision === null ? null : Number(expectedRevision),
    );
  }
  if (request.command === "read_recovery") {
    return readRecoveryFile(String(request.payload.path));
  }
  if (request.command === "write_recovery") {
    return writeRecoveryFileAtomic(String(request.payload.path), {
      project: parseProject(request.payload.project),
      projectPath: typeof request.payload.projectPath === "string" ? request.payload.projectPath : undefined,
      cleanUpdatedAt: String(request.payload.cleanUpdatedAt),
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
    return transcribeAutomaticCaptions({ ...payload, sourcePath }, {
      ffmpegPath: runtime.ffmpeg,
      whisperCliPath: runtime.whisperCli,
      modelRoot: runtime.modelRoot,
      modelPath: process.env.EDITKIN_WHISPER_MODEL_PATH,
      cacheRoot: runtime.cacheRoot,
    });
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
    const parsed = parseProject(request.payload.project);
    const project = runtime.creativePackRoot ? await materializeCreativeAssets(parsed, runtime.creativePackRoot, runtime.personalMusicRoot, runtime.personalVisualRoot) : parsed;
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
      },
    });
  }
  if (request.command === "render_native_effect_preview") {
    if (!runtime.ffmpeg || !runtime.nativeCore || !runtime.cacheRoot) throw new Error("render_native_effect_preview 缺少 FFmpeg／Rust／cache runtime");
    const parsed = parseProject(request.payload.project);
    const project = runtime.creativePackRoot ? await materializeCreativeAssets(parsed, runtime.creativePackRoot, runtime.personalMusicRoot, runtime.personalVisualRoot) : parsed;
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
      ? await materializeCreativeAssets(parsed, runtime.creativePackRoot, runtime.personalMusicRoot, runtime.personalVisualRoot)
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
      ? await materializeCreativeAssets(parsed, runtime.creativePackRoot, runtime.personalMusicRoot, runtime.personalVisualRoot)
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
  if (request.command === "batch_auto_edit_item") {
    if (!runtime.ffmpeg || !runtime.ffprobe || !runtime.modelRoot) throw new Error("batch_auto_edit_item 缺少媒體 runtime");
    return runBatchAutoEditItem({
      jobId: String(request.payload.jobId),
      sourcePath: String(request.payload.sourcePath),
      outputRoot: String(request.payload.outputRoot),
      language: typeof request.payload.language === "string" ? request.payload.language : "auto",
      targetRatio: typeof request.payload.targetRatio === "number" ? request.payload.targetRatio : 0.65,
      addMusic: request.payload.addMusic !== false,
      analysisMode: request.payload.analysisMode === "smart_cut" ? "smart_cut" : "semantic",
      editorialProfile: typeof request.payload.editorialProfile === "string"
        ? request.payload.editorialProfile as Parameters<typeof runBatchAutoEditItem>[0]["editorialProfile"]
        : "auto",
    }, {
      ffmpegPath: runtime.ffmpeg,
      ffprobePath: runtime.ffprobe,
      nativeCorePath: runtime.nativeCore,
      cacheRoot: runtime.cacheRoot,
      modelRoot: runtime.modelRoot,
      creativePackRoot: runtime.creativePackRoot,
      personalMusicRoot: runtime.personalMusicRoot,
      fontRoot: runtime.fontRoot,
      colorRoot: runtime.colorRoot,
    });
  }
  if (request.command === "check_update" || request.command === "stage_update") {
    const manifestUrl = assertUpdateManifestUrl(String(request.payload.manifestUrl));
    const response = await fetch(manifestUrl);
    if (!response.ok) throw new Error(`更新 manifest 讀取失敗：HTTP ${response.status}`);
    const manifest = parseUpdateManifest(await response.json());
    if (compareVersions(manifest.version, String(request.payload.currentVersion)) <= 0) return undefined;
    if (manifest.minimumProjectSchema > 6) throw new Error("這個更新需要尚未支援的專案 schema");
    if (request.command === "check_update") return { version: manifest.version };
    return stageUpdate(manifest, {
      currentVersion: String(request.payload.currentVersion),
      currentProjectSchema: 6,
      cacheRoot: String(request.payload.cacheRoot),
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
