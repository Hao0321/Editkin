import { contextBridge, ipcRenderer } from "electron";
import type { HaoDesktopApi } from "../src/desktop/types";

const api: HaoDesktopApi = {
  isDesktop: true,
  pickMedia: () => ipcRenderer.invoke("hao:pick-media"),
  pickBatchMedia: (editorialProfile: string) => ipcRenderer.invoke("hao:pick-batch-media", { editorialProfile }),
  getBatchSession: () => ipcRenderer.invoke("hao:get-batch-session"),
  runBatchAutoEditItem: (sessionId, jobId) => ipcRenderer.invoke("hao:run-batch-auto-edit-item", { sessionId, jobId }),
  openBatchProject: (sessionId, jobId) => ipcRenderer.invoke("hao:open-batch-project", { sessionId, jobId }),
  listCreativeLibrary: () => ipcRenderer.invoke("hao:list-creative-library"),
  importCreativeAsset: (assetId) => ipcRenderer.invoke("hao:import-creative-asset", { assetId }),
  previewCreativeAsset: (assetId, mode = "media") => ipcRenderer.invoke("hao:preview-creative-asset", { assetId, mode }),
  readColorAsset: (relativePath) => ipcRenderer.invoke("hao:read-color-asset", { relativePath }),
  listInstalledPlugins: () => ipcRenderer.invoke("hao:list-installed-plugins"),
  compilePluginTool: (pluginId, capabilityId, targetClipId, parameters = {}) => ipcRenderer.invoke("hao:compile-plugin-tool", { pluginId, capabilityId, targetClipId, parameters }),
  openProject: () => ipcRenderer.invoke("hao:open-project"),
  saveProject: (project, currentPath, saveAs) => ipcRenderer.invoke("hao:save-project", { project, currentPath, saveAs }),
  renderProject: (project) => ipcRenderer.invoke("hao:render-project", { project }),
  renderAlphaMaster: (project) => ipcRenderer.invoke("hao:render-alpha-master", { project }),
  previewUrls: (assets) => ipcRenderer.invoke("hao:preview-urls", { assets }),
  prepareMedia: (asset) => ipcRenderer.invoke("hao:prepare-media", { asset }),
  smartCutMedia: (request) => ipcRenderer.invoke("hao:smart-cut-media", { request }),
  automaticCaptionMedia: (request) => ipcRenderer.invoke("hao:automatic-caption-media", { request }),
  detectScenes: (request) => ipcRenderer.invoke("hao:detect-scenes", { request }),
  analyzeMotionTrack: (request) => ipcRenderer.invoke("hao:analyze-motion-track", { request }),
  loadRecovery: () => ipcRenderer.invoke("hao:load-recovery"),
  saveRecovery: (project, projectPath, cleanUpdatedAt) => ipcRenderer.invoke("hao:save-recovery", { project, projectPath, cleanUpdatedAt }),
  clearRecovery: () => ipcRenderer.invoke("hao:clear-recovery"),
  checkForUpdates: (options) => ipcRenderer.invoke("hao:check-updates", options),
  installUpdate: () => ipcRenderer.invoke("hao:install-update"),
  copyAgentSetup: (target) => ipcRenderer.invoke("hao:copy-agent-setup", { target }),
};

contextBridge.exposeInMainWorld("haoDesktop", api);
