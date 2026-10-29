import { isRetainedProjectV1 } from "../domain/projectSaveRetentionV1";
import { Channel, convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { listen } from "@tauri-apps/api/event";
import { ownAsyncListenerV1 } from "./asyncListenerOwnerV1";
import { createTauriGpuPreviewApi, createTauriGpuPreviewOwner } from "./tauriGpuPreview";
import type { NativeAudioPreviewStatus } from "./nativeAudioTypes";
import type { ResidentAudioStatus } from "./residentAudioTypes";
import type { MediaAsset } from "../domain/types";
import type { DesktopRenderResult, HaoDesktopApi, OpenProjectResult, PickedMedia, PrepareMediaResult, UpdateCheckResult } from "./types";
import type { TemplateShortJobStatus } from "./templateShortTypes";
import { buildOpenExrSequenceRenderRequest } from "../render/openExrSequence";
import { dehydrateAutoRotoFramePreviews, hydrateAutoRotoFramePreviews } from "../domain/autoRotoPreviewProjection";
import { createEngineTaskHostV1 } from "./engineTaskHostV1";
import { createStyleTemplateDesktopApiV1 } from "./styleTemplateDesktopV1";
import { parseRemoteAgentLaunchResult, parseRemoteAgentLaunchStatus } from "./remoteAgentLaunchStore";
import { normalizeUiLocale, type UiLocale } from "../shared/uiLocaleContract";
import { isOriginalSfxCandidateIdV1 } from "../domain/originalSfxCandidateContractV1";
import { decodeColorLutBytesV1 } from "./colorLutApiV1";

declare global {
  interface Window { __TAURI_INTERNALS__?: unknown }
}

function urls(paths: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, convertFileSrc(path)]));
}

function nativeDialogLocale(): UiLocale {
  return normalizeUiLocale(typeof document === "undefined" ? undefined : document.documentElement.lang);
}

/** The finished export for the in-app player; the host allowed the path when the render completed. */
function withOutputUrl(result: DesktopRenderResult): DesktopRenderResult {
  if (result.canceled || !result.outputPath) return result;
  const version = result.artifactIdentity?.outputSha256 ?? String(Date.now());
  return { ...result, outputUrl: `${convertFileSrc(result.outputPath)}?v=${encodeURIComponent(version)}` };
}

const delay = (milliseconds: number) => new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));

async function pollUpdateJob(download: boolean): Promise<UpdateCheckResult> {
  let result = await invoke<UpdateCheckResult>(download ? "check_for_updates" : "check_update_available", download ? { download: true } : undefined);
  for (let attempt = 0; attempt < 240 && (result.status === "checking" || result.status === "downloading"); attempt += 1) {
    await delay(250);
    result = await invoke<UpdateCheckResult>("get_update_job_result");
  }
  if (result.status === "checking" || result.status === "downloading") throw new Error("更新作業逾時，未阻塞剪輯介面。請稍後再試。");
  if (result.status === "error") throw new Error(result.message);
  if (download && result.status === "available") return pollUpdateJob(true);
  return result;
}

if (window.__TAURI_INTERNALS__) {
  const engineTasks = createEngineTaskHostV1(invoke, receive => new Channel<unknown>(receive));
  const api: HaoDesktopApi = {
    generateClipMediaDerivative: async (request) => {
      const result = await invoke<Awaited<ReturnType<NonNullable<HaoDesktopApi["generateClipMediaDerivative"]>>>>("clip_media_derivative", { request });
      return { ...result, previewUrl: convertFileSrc(result.asset.uri) };
    },
    isDesktop: true,
    ...engineTasks,
    renderMotionLibraryV1: async (input, options) => {
      const reply = await engineTasks.runMotionLibraryRenderTaskV1(input, options);
      const previewUrls = Object.fromEntries(Object.values(reply.result.assets).filter((asset): asset is MediaAsset => Boolean(asset))
        .map(asset => [asset.id, convertFileSrc(asset.uri)]));
      return { ...reply.result, previewUrls };
    },
    // 「模板片段」 inspector: re-render (engine task style_template_render_v1), the picture chooser and picture URLs.
    ...createStyleTemplateDesktopApiV1(engineTasks, { convertFileSrc,
      pickImageFiles: () => invoke<Array<{ asset: MediaAsset; previewPath: string }>>("pick_media", { uiLocale: nativeDialogLocale(), imageOnly: true }) }),
    setInterfaceScale: async scale => {
      if (!Number.isFinite(scale) || scale < 0.8 || scale > 2) throw new Error("Invalid interface scale");
      await getCurrentWebview().setZoom(scale);
    },
    pickMedia: async () => {
      const picked = await invoke<Array<{ asset: MediaAsset; previewPath: string }>>("pick_media", { uiLocale: nativeDialogLocale() });
      return picked.map(({ asset, previewPath }): PickedMedia => ({ asset, previewUrl: convertFileSrc(previewPath) }));
    },
    importMediaPaths: async (paths) => {
      const picked = await invoke<Array<{ asset: MediaAsset; previewPath: string }>>("import_media_paths", { paths });
      return picked.map(({ asset, previewPath }): PickedMedia => ({ asset, previewUrl: convertFileSrc(previewPath) }));
    },
    pickBatchMedia: (editorialProfile) => invoke("pick_batch_media", { editorialProfile, uiLocale: nativeDialogLocale() }),
    getBatchSession: () => invoke("get_batch_session"),
    runBatchAutoEditItem: async (sessionId, jobId, options) => {
      const reply = await engineTasks.runDesktopBatchTaskV1({ operationId: `batch-${crypto.randomUUID()}`, sessionId, jobId }, options);
      return { session: reply.result.session! };
    },
    openBatchProject: async (sessionId, jobId) => {
      const opened = await invoke<Omit<OpenProjectResult, "runtimeUrls"> & { runtimePaths?: Record<string, string>; mattePreviewPaths?: string[] }>("open_batch_project", { sessionId, jobId });
      return { ...opened, project: opened.project ? hydrateAutoRotoFramePreviews(opened.project, opened.mattePreviewPaths ?? [], convertFileSrc) : undefined, runtimeUrls: opened.runtimePaths ? urls(opened.runtimePaths) : undefined };
    },
    listCreativeLibrary: () => invoke("list_creative_library"),
    listOriginalSfxCandidates: () => invoke("list_creative_library", { includeOriginalSfxCandidates: true }),
    resolveOriginalSfxCandidate: async (assetId) => {
      if (!isOriginalSfxCandidateIdV1(assetId)) throw new Error("SFX_ID_NOT_IN_OWNED_CATALOGUE");
      const picked = await invoke<{ asset: MediaAsset; previewPath: string }>("import_creative_asset", { assetId });
      return { asset: picked.asset, absolutePath: picked.previewPath, previewUrl: convertFileSrc(picked.previewPath) };
    },
    importCreativeAsset: async (assetId) => {
      const picked = await invoke<{ asset: MediaAsset; previewPath: string }>("import_creative_asset", { assetId });
      return { asset: picked.asset, previewUrl: convertFileSrc(picked.previewPath) };
    },
    previewCreativeAsset: async (assetId, mode = "media") => convertFileSrc(await invoke<string>("preview_creative_asset", { assetId, mode })),
    readColorAsset: (relativePath) => invoke("read_color_asset", { relativePath }),
    listColorLutsV1: (offset = 0, limit = 100) => invoke("list_color_luts_v1", { offset, limit }),
    pickColorLutV1: () => invoke("pick_color_lut_v1", { uiLocale: nativeDialogLocale() }),
    importColorLutV1: (request) => invoke("import_color_lut_v1", { request }),
    readColorLutV1: async (ref, inputSpace) => decodeColorLutBytesV1(await invoke<ArrayBuffer>("read_color_lut_v1", { id: ref.id, sha256: ref.sha256, inputSpace })),
    readMesh3dFont: async (weight) => new Uint8Array(await invoke<ArrayBuffer>("read_mesh_3d_font", { weight })),
    readBundledFontFace: async (faceId) => {
      const bytes = await invoke<ArrayBuffer>("read_bundled_font_face", { faceId });
      if (!(bytes instanceof ArrayBuffer) || bytes.byteLength === 0 || bytes.byteLength > 16 * 1024 * 1024) {
        throw new Error("Bundled font IPC did not return bounded binary bytes");
      }
      return new Uint8Array(bytes);
    },
    listInstalledPlugins: () => invoke("list_installed_plugins"),
    getWorkflowProfile: () => invoke("get_workflow_profile"),
    saveWorkflowProfile: (profile) => invoke("save_workflow_profile", { profile }),
    openPluginFolder: () => invoke("open_plugin_folder"),
    compilePluginTool: (pluginId, capabilityId, targetClipId, parameters = {}) => invoke("compile_plugin_tool", { pluginId, capabilityId, targetClipId, parameters }),
    openProject: async () => {
      const opened = await invoke<Omit<OpenProjectResult, "runtimeUrls"> & { runtimePaths?: Record<string, string>; mattePreviewPaths?: string[] }>("open_project", { uiLocale: nativeDialogLocale() });
      return { ...opened, project: opened.project ? hydrateAutoRotoFramePreviews(opened.project, opened.mattePreviewPaths ?? [], convertFileSrc) : undefined, runtimeUrls: opened.runtimePaths ? urls(opened.runtimePaths) : undefined };
    },
    saveProject: async (project, currentPath, saveAs, expectedFileIdentity) => {
      const saved = await invoke<import("./types").SaveProjectResult & { mattePreviewPaths?: string[]; saveFailed?: boolean; message?: string; retainedProject?: unknown }>("save_project", { project: dehydrateAutoRotoFramePreviews(project), currentPath, saveAs, expectedFileIdentity, uiLocale: nativeDialogLocale() });
      if (saved.saveFailed) {
        const failure = new Error(saved.message ?? "無法儲存專案");
        if (isRetainedProjectV1(saved.retainedProject) && saved.retainedProject.fileIdentity.projectId === project.id) {
          Object.defineProperty(failure, "retainedProject", { value: Object.freeze({ ...saved.retainedProject, fileIdentity: Object.freeze({ ...saved.retainedProject.fileIdentity }) }) });
        }
        throw failure;
      }
      return { ...saved, project: saved.project ? hydrateAutoRotoFramePreviews(saved.project, saved.mattePreviewPaths ?? [], convertFileSrc) : undefined };
    },
    renderProject: async (project, options) => withOutputUrl(await invoke<DesktopRenderResult>("render_project", { project: dehydrateAutoRotoFramePreviews(project), uiLocale: nativeDialogLocale(), jobId: options?.jobId })),
    renderAlphaMaster: (project, options) => invoke("render_alpha_master", { project: dehydrateAutoRotoFramePreviews(project), uiLocale: nativeDialogLocale(), jobId: options?.jobId }),
    renderOpenExrSequence: (project) => invoke("render_openexr_sequence", { ...buildOpenExrSequenceRenderRequest(project), uiLocale: nativeDialogLocale() }),
    renderNativeEffectPreview: async (project, clipId) => {
      const result = await invoke<Omit<import("./types").NativeEffectPreviewResult, "previewUrl">>("render_native_effect_preview", { project, clipId });
      return { ...result, previewUrl: `${convertFileSrc(result.path)}?v=${encodeURIComponent(result.sha256)}` };
    },
    previewUrls: async (assets) => urls(await invoke<Record<string, string>>("preview_paths", { assets })),
    prepareMedia: async (asset) => {
      const prepared = await invoke<Omit<PrepareMediaResult, "runtimeUrls"> & { runtimePaths: Record<string, string> }>("prepare_media", { asset });
      return { ...prepared, runtimeUrls: urls(prepared.runtimePaths) };
    },
    smartCutMedia: (request) => invoke("smart_cut_media", { request }),
    automaticCaptionMedia: (request) => invoke("automatic_caption_media", { request }),
    detectScenes: (request) => invoke("detect_scenes", { request }),
    analyzeMotionTrack: (request) => invoke("analyze_motion_track", { request }),
    analyzeAutoRoto: async (request) => {
      const result = await invoke<import("./types").AutoRotoDesktopResult>("analyze_auto_roto", { request });
      return { ...result, frames: result.frames.map((frame) => ({ ...frame, previewUrl: convertFileSrc(frame.alphaPath) })) };
    },
    loadRecovery: async () => {
      const result = await invoke<import("../application/recoveryFiles").RecoveryReadResult & { mattePreviewPaths?: string[] }>("load_recovery");
      if (!result.found) return result;
      return { ...result, snapshot: { ...result.snapshot, project: hydrateAutoRotoFramePreviews(result.snapshot.project, result.mattePreviewPaths ?? [], convertFileSrc) } };
    },
    saveRecovery: async (project, projectPath, cleanUpdatedAt, baseFileIdentity) => { await invoke("save_recovery", { project: dehydrateAutoRotoFramePreviews(project), projectPath, cleanUpdatedAt, baseFileIdentity }); },
    clearRecovery: async () => { await invoke("clear_recovery"); },
    integrationSmokeEnabled: () => invoke("integration_smoke_enabled"),
    checkForUpdates: (options) => pollUpdateJob(options?.download !== false),
    installUpdate: () => invoke("install_update", { uiLocale: nativeDialogLocale() }),
    copyAgentSetup: (target, request) => invoke("copy_agent_setup", {
      target,
      uiLocale: nativeDialogLocale(),
      workspaceToken: request?.workspaceToken,
      onProgress: request?.onProgress ? new Channel<import("./mediaTypes").AgentSetupProgress>(request.onProgress) : undefined,
    }),
    suggestAgentWorkspace: () => invoke("suggest_agent_workspace"),
    pickAgentWorkspace: (startPath) => invoke("pick_agent_workspace", { startPath, uiLocale: nativeDialogLocale() }),
    openExternalUrl: async (url) => { await invoke("open_external_url", { url }); },
    inspectAgentConnections: () => invoke("inspect_agent_connections"),
    launchRemoteSetupAgent: async (target, jobId, consentRevision, scopeConfirmed) => parseRemoteAgentLaunchResult(
      await invoke<unknown>("launch_remote_setup_agent", { target, jobId, consentRevision, scopeConfirmed }),
    ),
    cancelRemoteSetupAgent: (jobId) => invoke("cancel_remote_setup_agent", { jobId }),
    getRemoteSetupAgentStatus: async () => parseRemoteAgentLaunchStatus(await invoke<unknown>("get_remote_setup_agent_status")),
    getMobileRemoteNetworkSummary: () => invoke("get_mobile_remote_network_summary"),
    listRemoteProviderConnectors: () => invoke("list_remote_provider_connectors"),
    startMobileRemote: (snapshot, options) => invoke("start_mobile_remote", {
      snapshot,
      externalTrafficConfirmed: options?.externalTrafficConfirmed ?? false,
      expectedCandidateRevision: options?.expectedCandidateRevision,
      expectedConfigurationId: options?.expectedConfigurationId,
    }),
    updateMobileSnapshot: (snapshot) => invoke("update_mobile_snapshot", { snapshot }),
    pollMobileCommands: () => invoke("poll_mobile_commands"),
    getMobileRemoteStatus: () => invoke("get_mobile_remote_status"),
    revokeMobileDevice: (deviceId) => invoke("revoke_mobile_device", { deviceId }),
    stopMobileRemote: () => invoke("stop_mobile_remote"),
    nativeAudioPreviewPushEvents: true,
    residentAudio: {
      capabilities: () => invoke("resident_audio_capabilities"),
      open: (onStatus) => invoke("open_resident_audio", {onEvent: new Channel<ResidentAudioStatus>(onStatus)}),
      replace: (ownerId, project, timelineStartSeconds) => invoke("replace_resident_audio", {ownerId, project, timelineStartSeconds}),
      control: (ownerId, generation, playing) => invoke("control_resident_audio", {ownerId, generation, playing}),
      close: (ownerId) => invoke("close_resident_audio", {ownerId}),
      status: (ownerId) => invoke("resident_audio_status", {ownerId}),
    },
    startNativeAudioPreview: (project, timelineStartSeconds, onStatus) => {
      const onEvent = onStatus ? new Channel<NativeAudioPreviewStatus>(onStatus) : undefined;
      return invoke("start_native_audio_preview", { project, timelineStartSeconds, onEvent });
    },
    nativeAudioPreviewStatus: () => invoke("native_audio_preview_status"),
    stopNativeAudioPreview: (expectedGeneration) => invoke("stop_native_audio_preview", { expectedGeneration }),
    gpuCompositorStatus: () => invoke("gpu_compositor_status"),
    gpuEngineStatus: () => invoke("gpu_engine_status"),
    ...createTauriGpuPreviewApi(),
    createGpuPreviewOwner: createTauriGpuPreviewOwner,
    renderGpuComposition: async (graph) => {
      const result = await invoke<import("./types").GpuCompositionResult>("render_gpu_composition", { graph });
      return { ...result, outputUrl: convertFileSrc(result.outputPath) };
    },
    templateShortPrepare: (sourcePath) => invoke("template_short_prepare", { sourcePath }),
    // `confirmed: true` is sent from this one call, which only the 「是，這是我自己拍的素材」 click reaches.
    templateShortConfirmRights: (sourcePath, brandMark) => invoke("template_short_confirm_rights", { sourcePath, brandMark: brandMark?.trim() || null, confirmed: true }),
    templateShortStart: (request) => invoke("start_template_short_job", { sourcePath: request.sourcePath, genre: request.genre, copy: request.copy }),
    templateShortStatus: async (jobId) => {
      const status = await invoke<TemplateShortJobStatus>("template_short_job_status", { jobId });
      return status.outputPath ? { ...status, outputUrl: `${convertFileSrc(status.outputPath)}?v=${encodeURIComponent(status.result?.outputSha256 ?? status.jobId)}` } : status;
    },
    templateShortCancel: (jobId) => invoke("cancel_template_short_job", { jobId }),
    templateShortSaveVideo: (jobId, fileName) => invoke("save_template_short_video", { jobId, fileName }),
    templateShortOpenProject: async (jobId) => {
      const opened = await invoke<Omit<OpenProjectResult, "runtimeUrls"> & { runtimePaths?: Record<string, string>; mattePreviewPaths?: string[] }>("open_template_short_project", { jobId });
      return { ...opened, project: opened.project ? hydrateAutoRotoFramePreviews(opened.project, opened.mattePreviewPaths ?? [], convertFileSrc) : undefined, runtimeUrls: opened.runtimePaths ? urls(opened.runtimePaths) : undefined };
    },
    revealInFolder: async (path) => { await invoke("reveal_in_folder", { path }); },
    renderJobProgress: (jobId) => invoke("render_job_progress", { jobId }),
    cancelRenderJob: (jobId) => invoke("cancel_render_job", { jobId }),
    appBuildInfo: () => invoke("app_build_info"),
    setCloseGuard: async (armed) => { await invoke("set_close_guard", { armed }); },
    acknowledgeCloseRequest: async () => { await invoke("acknowledge_close_request"); },
    closeWindowConfirmed: async () => { await invoke("close_window_confirmed"); },
    onCloseRequested: handler => ownAsyncListenerV1(callback => listen("editkin:close-requested", callback), handler),
    inspectProjectFile: path => invoke("inspect_project_file", { path }),
    openProjectPath: async (path) => {
      const opened = await invoke<Omit<OpenProjectResult, "runtimeUrls"> & { runtimePaths?: Record<string, string>; mattePreviewPaths?: string[] }>("open_project_path", { path });
      return { ...opened, project: opened.project ? hydrateAutoRotoFramePreviews(opened.project, opened.mattePreviewPaths ?? [], convertFileSrc) : undefined, runtimeUrls: opened.runtimePaths ? urls(opened.runtimePaths) : undefined };
    },
    checkMediaPaths: (paths) => invoke("check_media_paths", { paths }),
    pickRelinkMedia: () => invoke("pick_relink_media", { uiLocale: nativeDialogLocale() }),
    keepRecoveryAside: () => invoke("keep_recovery_aside"),
    inspectProjectOutsideMedia: (projectPath) => invoke("inspect_project_outside_media", { projectPath }),
    grantProjectOutsideMedia: (projectPath, paths) => invoke("grant_project_outside_media", { projectPath, paths }),
  };
  window.haoDesktop = api;
  void invoke("smoke_ready");
}

export {};
