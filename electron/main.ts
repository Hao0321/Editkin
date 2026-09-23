import { app, BrowserWindow, dialog, ipcMain, net, protocol, type IpcMainInvokeEvent } from "electron";
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AgentTarget } from "../src/application/agentSetup";
import { compactPluginRegistry, compilePluginCommands, discoverInstalledPlugins, findInstalledCapability } from "../src/plugins/registry";
import { exportVideo } from "../src/application/exportVideo";
import { inspectMedia } from "../src/application/inspectMedia";
import { generateMediaDerivatives } from "../src/application/mediaDerivatives";
import { analyzeSmartCut } from "../src/application/smartCut";
import { transcribeAutomaticCaptions } from "../src/application/automaticCaptions";
import { analyzeSceneCuts } from "../src/application/sceneDetection";
import { analyzeMotionTrack } from "../src/application/motionTracking";
import { creativeAssetIdFromUri, creativeAssetUri, listCreativeLibrary, materializeCreativeAssets, resolveCreativeLibraryAsset, resolveCreativeLibraryPreviewAsset } from "../src/application/creativeLibrary";
import { parseProject, readProjectFile, writeProjectFileAtomic } from "../src/application/projectFiles";
import { clearRecoveryFile, readRecoveryFile, writeRecoveryFileAtomic } from "../src/application/recoveryFiles";
import {
  markUpdateHealthy,
  readUpdateTransaction,
  recordUpdateLaunch,
  rollbackInstaller,
} from "../src/application/updateManager";
import type { EditProject, MediaAsset } from "../src/domain/types";
import { registerBatchIpc } from "./batchIpc";
import { registerUpdateIpc } from "./updateIpc";

protocol.registerSchemesAsPrivileged([{
  scheme: "editkin-media",
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
}]);

const approvedMediaPaths = new Set<string>();

function mediaPathKey(path: string): string {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function mediaUrl(path: string): string {
  const absolute = resolve(path);
  approvedMediaPaths.add(mediaPathKey(absolute));
  return `editkin-media://local/${Buffer.from(absolute, "utf8").toString("base64url")}`;
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const raw = event.senderFrame?.url || event.sender.getURL();
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new Error("拒絕來源不明的桌面命令"); }
  if (!app.isPackaged && process.env.HAO_EDITOR_DEV_URL) {
    if (url.origin === new URL(process.env.HAO_EDITOR_DEV_URL).origin) return;
    throw new Error("拒絕非開發伺服器來源的桌面命令");
  }
  if (url.protocol !== "file:") throw new Error("拒絕非本機頁面的桌面命令");
  const root = resolve(app.getAppPath(), "dist");
  const target = resolve(fileURLToPath(url));
  const relation = relative(root, target);
  if (relation.startsWith("..") || isAbsolute(relation)) throw new Error("拒絕超出 packaged UI 的桌面命令");
}

function secureIpcHandle(channel: string, listener: Parameters<typeof ipcMain.handle>[1]): void {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedSender(event);
    return listener(event, ...args);
  });
}

function runtimeUrls(assets: MediaAsset[]): Record<string, string> {
  const entries: Array<[string, string]> = [];
  for (const asset of assets) {
    if (isAbsolute(asset.uri)) entries.push([`${asset.id}:source`, mediaUrl(asset.uri)]);
    const proxy = asset.derivatives?.proxyUri;
    const preview = proxy && isAbsolute(proxy) ? proxy : asset.uri;
    if (isAbsolute(preview)) entries.push([asset.id, mediaUrl(preview)]);
    if (proxy && isAbsolute(proxy)) entries.push([`${asset.id}:proxy`, mediaUrl(proxy)]);
    const overlay = asset.derivatives?.overlayProxyUri;
    if (overlay && isAbsolute(overlay)) entries.push([`${asset.id}:overlay-proxy`, mediaUrl(overlay)]);
    if (asset.derivatives?.thumbnailUri && isAbsolute(asset.derivatives.thumbnailUri)) entries.push([`${asset.id}:thumbnail`, mediaUrl(asset.derivatives.thumbnailUri)]);
    if (asset.derivatives?.waveformUri && isAbsolute(asset.derivatives.waveformUri)) entries.push([`${asset.id}:waveform`, mediaUrl(asset.derivatives.waveformUri)]);
  }
  return Object.fromEntries(entries);
}

async function runtimeUrlsWithCreative(assets: MediaAsset[]): Promise<Record<string, string>> {
  const urls = runtimeUrls(assets);
  const paths = runtimePaths();
  for (const asset of assets) {
    const assetId = creativeAssetIdFromUri(asset.uri);
    if (!assetId) continue;
    const resolved = await resolveCreativeLibraryAsset(paths.creativePackRoot, assetId, paths.personalMusicRoot, paths.personalVisualRoot);
    const sourceUrl = mediaUrl(resolved.absolutePath);
    urls[`${asset.id}:source`] = sourceUrl;
    if (!urls[asset.id]) urls[asset.id] = sourceUrl;
  }
  return urls;
}

function runtimePaths() {
  if (app.isPackaged) {
    return {
      ffmpeg: join(process.resourcesPath, "runtime", "ffmpeg.exe"),
      ffprobe: join(process.resourcesPath, "runtime", "ffprobe.exe"),
      whisperCli: join(process.resourcesPath, "runtime", "whisper-cli.exe"),
      nativeCore: join(process.resourcesPath, "runtime", "hao-core.exe"),
      assetBase: join(process.resourcesPath, "runtime"),
      creativePackRoot: join(process.resourcesPath, "creative-packs", "hao-creator-library"),
      personalMusicRoot: join(process.resourcesPath, "personal-packs", "hao-music-library"),
      personalVisualRoot: join(process.resourcesPath, "personal-packs", "hao-visual-library"),
      fontRoot: join(process.resourcesPath, "font-packs", "editkin-open-fonts"),
      colorRoot: join(process.resourcesPath, "color", "aces2"),
      pluginRoot: join(process.resourcesPath, "plugins"),
    };
  }
  return {
    ffmpeg: process.env.HAO_FFMPEG_PATH ?? "ffmpeg",
    ffprobe: process.env.HAO_FFPROBE_PATH ?? "ffprobe",
    whisperCli: process.env.EDITKIN_WHISPER_CLI_PATH ?? resolve(app.getAppPath(), "vendor/whisper/win32-x64/whisper-cli.exe"),
    nativeCore: resolve(app.getAppPath(), "native/bin/win32-x64/hao-core.exe"),
    assetBase: resolve(app.getAppPath(), "public"),
    creativePackRoot: resolve(app.getAppPath(), ".creative-packs/hao-creator-library"),
    personalMusicRoot: resolve(app.getAppPath(), ".personal-packs/hao-music-library"),
    personalVisualRoot: resolve(app.getAppPath(), ".personal-packs/hao-visual-library"),
    fontRoot: resolve(app.getAppPath(), "public/fonts"),
    colorRoot: resolve(app.getAppPath(), "public/color/aces2"),
    pluginRoot: resolve(app.getAppPath(), "plugins"),
  };
}

function boundedColorAssetPath(colorRoot: string, relativePath: string): string {
  if (typeof relativePath !== "string" || relativePath.length > 128 || relativePath.includes("\\")) throw new Error("色彩資產路徑不合法");
  const match = relativePath.match(/^(gpu|luts)\/([a-z0-9][a-z0-9_-]*\.(?:json|cube))$/);
  if (!match || (match[1] === "gpu" && !match[2].endsWith(".json")) || (match[1] === "luts" && !match[2].endsWith(".cube"))) throw new Error("色彩資產不在允許清單");
  const target = resolve(colorRoot, match[1], match[2]);
  const relation = relative(resolve(colorRoot), target);
  if (!relation || relation.startsWith("..") || isAbsolute(relation)) throw new Error("色彩資產超出內建資源範圍");
  return target;
}

function registerIpc() {
  secureIpcHandle("hao:pick-media", async () => {
    const result = await dialog.showOpenDialog({
      title: "匯入影片、聲音或圖片",
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "媒體素材", extensions: ["mp4", "mov", "mkv", "webm", "m4v", "mp3", "wav", "m4a", "aac", "flac", "png", "jpg", "jpeg", "webp"] },
      ],
    });
    if (result.canceled) return [];
    const paths = runtimePaths();
    return Promise.all(result.filePaths.map(async (path, index) => {
      const kind = /\.(png|jpe?g|webp)$/i.test(path) ? "image" : /\.(mp3|wav|m4a|aac|flac)$/i.test(path) ? "audio" : "video";
      const probed = await inspectMedia(path, paths.ffprobe);
      const metadata = kind === "image" ? { ...probed, duration: 5 } : probed;
      return {
        asset: {
          id: `asset-${Date.now()}-${index}`,
          name: path.split(/[\\/]/).at(-1) ?? path,
          kind,
          uri: path,
          duration: metadata.duration,
          width: metadata.width,
          height: metadata.height,
        },
        previewUrl: mediaUrl(path),
      };
    }));
  });

  registerBatchIpc({ secureIpcHandle, runtimePaths, runtimeUrlsWithCreative });
  registerUpdateIpc(secureIpcHandle);

  secureIpcHandle("hao:list-creative-library", () => {
    const paths = runtimePaths();
    return listCreativeLibrary(paths.creativePackRoot, paths.personalMusicRoot, paths.personalVisualRoot);
  });

  secureIpcHandle("hao:read-color-asset", async (_event, payload: { relativePath: string }) => {
    const target = boundedColorAssetPath(runtimePaths().colorRoot, payload?.relativePath);
    const metadata = await stat(target);
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > 64 * 1024 * 1024) throw new Error("色彩資產超出安全大小");
    return readFile(target, "utf8");
  });

  secureIpcHandle("hao:list-installed-plugins", async () => compactPluginRegistry(await discoverInstalledPlugins([runtimePaths().pluginRoot])));
  secureIpcHandle("hao:compile-plugin-tool", async (_event, payload: { pluginId: string; capabilityId: string; targetClipId: string; parameters?: Record<string, unknown> }) => {
    const registry = await discoverInstalledPlugins([runtimePaths().pluginRoot]);
    const { capability } = findInstalledCapability(registry, payload.pluginId, payload.capabilityId);
    return compilePluginCommands(capability, payload.targetClipId, payload.parameters ?? {});
  });

  secureIpcHandle("hao:import-creative-asset", async (_event, payload: { assetId: string }) => {
    const paths = runtimePaths();
    const resolved = await resolveCreativeLibraryAsset(paths.creativePackRoot, payload.assetId, paths.personalMusicRoot, paths.personalVisualRoot);
    const probed = await inspectMedia(resolved.absolutePath, paths.ffprobe);
    const duration = resolved.asset.mediaKind === "image" ? 5 : probed.duration;
    if (duration <= 0) throw new Error("Creative Pack 素材 duration 不合法");
    return {
      asset: {
        id: `asset-creator-${Date.now()}`,
        name: resolved.asset.name,
        kind: resolved.asset.mediaKind,
        uri: creativeAssetUri(payload.assetId),
        duration,
        width: probed.width,
        height: probed.height,
        role: resolved.asset.role,
        bpm: resolved.asset.bpm,
        license: resolved.asset.license,
        provenance: resolved.asset.provenance,
        redistributable: resolved.asset.redistributable,
        rightsBasis: resolved.asset.rightsBasis,
        distributionScope: resolved.asset.distributionScope,
        color: {
          interpretation: "auto",
          primaries: probed.colorPrimaries,
          transfer: probed.colorTransfer,
          matrix: probed.colorMatrix,
          range: probed.colorRange,
        },
      },
      previewUrl: mediaUrl(resolved.absolutePath),
    };
  });

  secureIpcHandle("hao:preview-creative-asset", async (_event, payload: { assetId: string; mode?: "poster" | "media" }) => {
    const paths = runtimePaths();
    const mode = payload.mode ?? "media";
    if (mode !== "poster" && mode !== "media") throw new Error("不支援的素材預覽格式");
    const resolved = await resolveCreativeLibraryPreviewAsset(paths.creativePackRoot, payload.assetId, mode, paths.personalMusicRoot, paths.personalVisualRoot);
    return mediaUrl(resolved.absolutePath);
  });

  secureIpcHandle("hao:preview-urls", (_event, payload: { assets: MediaAsset[] }) => runtimeUrlsWithCreative(payload.assets));

  secureIpcHandle("hao:prepare-media", async (_event, payload: { asset: MediaAsset }) => {
    const paths = runtimePaths();
    const creativeId = creativeAssetIdFromUri(payload.asset.uri);
    const sourcePath = creativeId ? (await resolveCreativeLibraryAsset(paths.creativePackRoot, creativeId, paths.personalMusicRoot, paths.personalVisualRoot)).absolutePath : payload.asset.uri;
    if (!isAbsolute(sourcePath)) throw new Error("只有本機或 Creative Pack 素材能建立 proxy 與視覺快取");
    const probe = await inspectMedia(sourcePath, paths.ffprobe);
    const result = await generateMediaDerivatives({
      sourcePath,
      kind: payload.asset.kind,
      duration: payload.asset.duration,
      hasAudio: probe.hasAudio,
      cacheRoot: join(app.getPath("userData"), "media-cache"),
      ffmpegPath: paths.ffmpeg,
      ffprobePath: paths.ffprobe,
      sourceHeight: probe.height,
    });
    const withDerivatives = { ...payload.asset, derivatives: result.derivatives };
    return { assetId: payload.asset.id, derivatives: result.derivatives, runtimeUrls: await runtimeUrlsWithCreative([withDerivatives]), cacheHit: result.cacheHit };
  });

  secureIpcHandle("hao:smart-cut-media", async (_event, payload: { request: Parameters<typeof analyzeSmartCut>[0] }) => {
    const paths = runtimePaths();
    const request = { ...payload.request, sourcePath: isAbsolute(payload.request.sourcePath) ? payload.request.sourcePath : resolve(paths.assetBase, payload.request.sourcePath) };
    return analyzeSmartCut(request, { ffmpegPath: paths.ffmpeg, nativeCorePath: paths.nativeCore, cacheRoot: join(app.getPath("userData"), "media-cache") });
  });

  secureIpcHandle("hao:automatic-caption-media", async (_event, payload: { request: Parameters<typeof transcribeAutomaticCaptions>[0] }) => {
    const paths = runtimePaths();
    const creativeId = creativeAssetIdFromUri(payload.request.sourcePath);
    const sourcePath = creativeId
      ? (await resolveCreativeLibraryAsset(paths.creativePackRoot, creativeId, paths.personalMusicRoot, paths.personalVisualRoot)).absolutePath
      : isAbsolute(payload.request.sourcePath) ? payload.request.sourcePath : resolve(paths.assetBase, payload.request.sourcePath);
    return transcribeAutomaticCaptions({ ...payload.request, sourcePath }, {
      ffmpegPath: paths.ffmpeg,
      whisperCliPath: paths.whisperCli,
      modelRoot: join(app.getPath("userData"), "models"),
      modelPath: process.env.EDITKIN_WHISPER_MODEL_PATH,
      cacheRoot: join(app.getPath("userData"), "media-cache"),
    });
  });

  secureIpcHandle("hao:detect-scenes", async (_event, payload: { request: Parameters<typeof analyzeSceneCuts>[0] }) => {
    const paths = runtimePaths();
    const creativeId = creativeAssetIdFromUri(payload.request.sourcePath);
    const sourcePath = creativeId
      ? (await resolveCreativeLibraryAsset(paths.creativePackRoot, creativeId, paths.personalMusicRoot, paths.personalVisualRoot)).absolutePath
      : isAbsolute(payload.request.sourcePath) ? payload.request.sourcePath : resolve(paths.assetBase, payload.request.sourcePath);
    return analyzeSceneCuts({ ...payload.request, sourcePath }, {
      ffmpegPath: paths.ffmpeg,
      cacheRoot: join(app.getPath("userData"), "media-cache"),
    });
  });

  secureIpcHandle("hao:analyze-motion-track", async (_event, payload: { request: Parameters<typeof analyzeMotionTrack>[0] }) => {
    const paths = runtimePaths();
    const creativeId = creativeAssetIdFromUri(payload.request.sourcePath);
    const sourcePath = creativeId
      ? (await resolveCreativeLibraryAsset(paths.creativePackRoot, creativeId, paths.personalMusicRoot, paths.personalVisualRoot)).absolutePath
      : isAbsolute(payload.request.sourcePath) ? payload.request.sourcePath : resolve(paths.assetBase, payload.request.sourcePath);
    return analyzeMotionTrack({ ...payload.request, sourcePath }, { ffmpegPath: paths.ffmpeg, nativeCorePath: paths.nativeCore, cacheRoot: join(app.getPath("userData"), "media-cache") });
  });

  const recoveryPath = () => join(app.getPath("userData"), "recovery", "session.json");
  secureIpcHandle("hao:load-recovery", () => readRecoveryFile(recoveryPath()));
  secureIpcHandle("hao:save-recovery", async (_event, payload: { project: EditProject; projectPath?: string; cleanUpdatedAt: string }) => {
    await writeRecoveryFileAtomic(recoveryPath(), payload);
  });
  secureIpcHandle("hao:clear-recovery", () => clearRecoveryFile(recoveryPath()));

  secureIpcHandle("hao:copy-agent-setup", async (_event, payload: { target: AgentTarget }) => {
    const target = payload?.target;
    if (target !== "codex" && target !== "claude") throw new Error("不支援的 Agent 目標");
    throw new Error(
      "此舊版 Electron shell 已停用 Agent Connect 設定寫入，避免回寫 retired direct MCP entrypoint。請使用目前的 Editkin native app 連接 Codex／Claude Code。",
    );
  });

  secureIpcHandle("hao:open-project", async () => {
    const result = await dialog.showOpenDialog({ title: "開啟 Editkin 專案", properties: ["openFile"], filters: [{ name: "Editkin EditGraph", extensions: ["json"] }] });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    const path = result.filePaths[0];
    const project = await readProjectFile(path);
    return { canceled: false, path, project, runtimeUrls: await runtimeUrlsWithCreative(project.assets) };
  });

  secureIpcHandle("hao:save-project", async (_event, payload: { project: EditProject; currentPath?: string; saveAs?: boolean }) => {
    const regularSave = !payload.saveAs && Boolean(payload.currentPath);
    let path = regularSave ? payload.currentPath : undefined;
    if (!path) {
      const result = await dialog.showSaveDialog({ title: "儲存 Editkin 專案", defaultPath: `${payload.project.name}.editkin.json`, filters: [{ name: "Editkin EditGraph", extensions: ["editkin.json", "haoedit.json"] }] });
      if (result.canceled || !result.filePath) return { canceled: true };
      path = /\.(?:editkin|haoedit)\.json$/i.test(result.filePath) ? result.filePath : `${result.filePath}.editkin.json`;
    }
    const project = await writeProjectFileAtomic(path, payload.project, regularSave ? payload.project.revision : null);
    return { canceled: false, path, project };
  });

  secureIpcHandle("hao:render-project", async (_event, payload: { project: EditProject }) => {
    const parsed = parseProject(payload.project);
    const result = await dialog.showSaveDialog({ title: "輸出完成影片", defaultPath: `${parsed.name}.mp4`, filters: [{ name: "MP4 影片", extensions: ["mp4"] }] });
    if (result.canceled || !result.filePath) return { canceled: true };
    const paths = runtimePaths();
    const project = await materializeCreativeAssets(parsed, paths.creativePackRoot, paths.personalMusicRoot, paths.personalVisualRoot);
    const rendered = await exportVideo({
      project,
      outputPath: result.filePath,
      options: {
        ffmpegPath: paths.ffmpeg,
        ffprobePath: paths.ffprobe,
        nativeCorePath: paths.nativeCore,
        assetBase: paths.assetBase,
        preferGpu: true,
        fontRoot: paths.fontRoot,
        colorRoot: paths.colorRoot,
      },
    });
    return { canceled: false, ...rendered };
  });

  secureIpcHandle("hao:render-alpha-master", async (_event, payload: { project: EditProject }) => {
    const parsed = parseProject(payload.project);
    const result = await dialog.showSaveDialog({
      title: "輸出透明背景 ProRes 4444 Alpha 主檔",
      defaultPath: `${parsed.name}-Alpha.mov`,
      filters: [{ name: "ProRes 4444 Alpha", extensions: ["mov"] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    const outputPath = /\.mov$/i.test(result.filePath) ? result.filePath : `${result.filePath}.mov`;
    const paths = runtimePaths();
    const project = await materializeCreativeAssets(parsed, paths.creativePackRoot, paths.personalMusicRoot, paths.personalVisualRoot);
    const rendered = await exportVideo({
      project,
      outputPath,
      options: {
        ffmpegPath: paths.ffmpeg,
        ffprobePath: paths.ffprobe,
        nativeCorePath: paths.nativeCore,
        assetBase: paths.assetBase,
        preferGpu: false,
        fontRoot: paths.fontRoot,
        colorRoot: paths.colorRoot,
        deliveryProfile: "prores4444_alpha_10bit",
      },
    });
    return { canceled: false, ...rendered };
  });
}

async function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 720,
    show: process.env.HAO_EDITOR_SMOKE !== "1",
    backgroundColor: "#08090d",
    title: "Editkin",
    webPreferences: {
      preload: join(app.getAppPath(), "desktop-dist/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  if (!app.isPackaged && process.env.HAO_EDITOR_DEV_URL) await window.loadURL(process.env.HAO_EDITOR_DEV_URL);
  else await window.loadFile(join(app.getAppPath(), "dist/index.html"));
  return window;
}

app.whenReady().then(async () => {
  protocol.handle("editkin-media", (request) => {
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
    const encoded = new URL(request.url).pathname.slice(1);
    const path = Buffer.from(encoded, "base64url").toString("utf8");
    if (!isAbsolute(path) || !approvedMediaPaths.has(mediaPathKey(path))) return new Response("Media path not approved", { status: 403 });
    return net.fetch(pathToFileURL(path).toString());
  });
  registerIpc();
  const transactionPath = join(app.getPath("userData"), "updates", "transaction.json");
  const transaction = await readUpdateTransaction(transactionPath);
  let updateLaunchNeedsHealthMark = false;
  if (transaction && transaction.toVersion === app.getVersion() && ["staged", "applying"].includes(transaction.status)) {
    const launch = await recordUpdateLaunch(transactionPath);
    if (launch.status === "rollback_required") {
      const installer = await rollbackInstaller(transactionPath);
      if (installer) {
        spawn(installer, ["/S"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
        app.quit();
        return;
      }
    } else updateLaunchNeedsHealthMark = true;
  }
  const window = await createWindow();
  if (updateLaunchNeedsHealthMark) {
    await markUpdateHealthy(transactionPath, app.getVersion());
  }
  if (process.env.HAO_EDITOR_SMOKE === "1") {
    const bridge = await window.webContents.executeJavaScript("Boolean(window.haoDesktop?.isDesktop && typeof window.haoDesktop?.copyAgentSetup === 'function')");
    const renderer = await window.webContents.executeJavaScript(`(() => {
      const root = document.getElementById("root");
      return {
        title: document.title,
        rootChildren: root?.childElementCount ?? 0,
        visibleTextLength: root?.innerText?.trim().length ?? 0,
      };
    })()`);
    const green = bridge
      && (renderer.title === "Editkin" || renderer.title.endsWith("— Editkin"))
      && renderer.rootChildren > 0
      && renderer.visibleTextLength > 0;
    process.stdout.write(JSON.stringify({
      status: green ? "GREEN" : "BLOCK",
      bridge,
      renderer,
      electron: process.versions.electron,
    }));
    app.quit();
  }
});

app.on("window-all-closed", () => app.quit());
