import { Channel, convertFileSrc, invoke } from "@tauri-apps/api/core";
import { createTauriGpuPreviewApi, createTauriGpuPreviewOwner } from "./tauriGpuPreview";
import type { NativeAudioPreviewStatus } from "./nativeAudioTypes";
import type { ResidentAudioStatus } from "./residentAudioTypes";
import type { MediaAsset } from "../domain/types";
import type { HaoDesktopApi, OpenProjectResult, PickedMedia, PrepareMediaResult, UpdateCheckResult } from "./types";
import { buildOpenExrSequenceRenderRequest } from "../render/openExrSequence";
import { dehydrateAutoRotoFramePreviews, hydrateAutoRotoFramePreviews } from "../domain/autoRotoPreviewProjection";
import { parseRemoteAgentLaunchResult, parseRemoteAgentLaunchStatus } from "./remoteAgentLaunchStore";

declare global {
  interface Window { __TAURI_INTERNALS__?: unknown }
}

function urls(paths: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, convertFileSrc(path)]));
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
  const api: HaoDesktopApi = {
    isDesktop: true,
    pickMedia: async () => {
      const picked = await invoke<Array<{ asset: MediaAsset; previewPath: string }>>("pick_media");
      return picked.map(({ asset, previewPath }): PickedMedia => ({ asset, previewUrl: convertFileSrc(previewPath) }));
    },
    importMediaPaths: async (paths) => {
      const picked = await invoke<Array<{ asset: MediaAsset; previewPath: string }>>("import_media_paths", { paths });
      return picked.map(({ asset, previewPath }): PickedMedia => ({ asset, previewUrl: convertFileSrc(previewPath) }));
    },
    pickBatchMedia: (editorialProfile) => invoke("pick_batch_media", { editorialProfile }),
    getBatchSession: () => invoke("get_batch_session"),
    runBatchAutoEditItem: (sessionId, jobId) => invoke("run_batch_auto_edit_item", { sessionId, jobId }),
    openBatchProject: async (sessionId, jobId) => {
      const opened = await invoke<Omit<OpenProjectResult, "runtimeUrls"> & { runtimePaths?: Record<string, string>; mattePreviewPaths?: string[] }>("open_batch_project", { sessionId, jobId });
      return { ...opened, project: opened.project ? hydrateAutoRotoFramePreviews(opened.project, opened.mattePreviewPaths ?? [], convertFileSrc) : undefined, runtimeUrls: opened.runtimePaths ? urls(opened.runtimePaths) : undefined };
    },
    listCreativeLibrary: () => invoke("list_creative_library"),
    importCreativeAsset: async (assetId) => {
      const picked = await invoke<{ asset: MediaAsset; previewPath: string }>("import_creative_asset", { assetId });
      return { asset: picked.asset, previewUrl: convertFileSrc(picked.previewPath) };
    },
    previewCreativeAsset: async (assetId, mode = "media") => convertFileSrc(await invoke<string>("preview_creative_asset", { assetId, mode })),
    readColorAsset: (relativePath) => invoke("read_color_asset", { relativePath }),
    listInstalledPlugins: () => invoke("list_installed_plugins"),
    getWorkflowProfile: () => invoke("get_workflow_profile"),
    saveWorkflowProfile: (profile) => invoke("save_workflow_profile", { profile }),
    openPluginFolder: () => invoke("open_plugin_folder"),
    compilePluginTool: (pluginId, capabilityId, targetClipId, parameters = {}) => invoke("compile_plugin_tool", { pluginId, capabilityId, targetClipId, parameters }),
    openProject: async () => {
      const opened = await invoke<Omit<OpenProjectResult, "runtimeUrls"> & { runtimePaths?: Record<string, string>; mattePreviewPaths?: string[] }>("open_project");
      return { ...opened, project: opened.project ? hydrateAutoRotoFramePreviews(opened.project, opened.mattePreviewPaths ?? [], convertFileSrc) : undefined, runtimeUrls: opened.runtimePaths ? urls(opened.runtimePaths) : undefined };
    },
    saveProject: async (project, currentPath, saveAs) => {
      const saved = await invoke<import("./types").SaveProjectResult & { mattePreviewPaths?: string[] }>("save_project", { project: dehydrateAutoRotoFramePreviews(project), currentPath, saveAs });
      return { ...saved, project: saved.project ? hydrateAutoRotoFramePreviews(saved.project, saved.mattePreviewPaths ?? [], convertFileSrc) : undefined };
    },
    renderProject: (project) => invoke("render_project", { project: dehydrateAutoRotoFramePreviews(project) }),
    renderAlphaMaster: (project) => invoke("render_alpha_master", { project: dehydrateAutoRotoFramePreviews(project) }),
    renderOpenExrSequence: (project) => invoke("render_openexr_sequence", { ...buildOpenExrSequenceRenderRequest(project) }),
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
    saveRecovery: async (project, projectPath, cleanUpdatedAt) => { await invoke("save_recovery", { project: dehydrateAutoRotoFramePreviews(project), projectPath, cleanUpdatedAt }); },
    clearRecovery: async () => { await invoke("clear_recovery"); },
    integrationSmokeEnabled: () => invoke("integration_smoke_enabled"),
    checkForUpdates: (options) => pollUpdateJob(options?.download !== false),
    installUpdate: () => invoke("install_update"),
    copyAgentSetup: (target) => invoke("copy_agent_setup", { target }),
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
  };
  window.haoDesktop = api;
  void invoke("smoke_ready");
}

export {};
