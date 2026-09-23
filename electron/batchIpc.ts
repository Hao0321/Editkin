import { app, dialog, type IpcMainInvokeEvent } from "electron";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runBatchAutoEditItem } from "../src/application/batchAutoEdit";
import { inspectMedia } from "../src/application/inspectMedia";
import { readProjectFile } from "../src/application/projectFiles";
import type { EditorialProfileId, MediaAsset } from "../src/domain/types";
import type { BatchAutoEditSession } from "../src/desktop/types";

type SecureIpcHandle = (
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown,
) => void;

export interface BatchRuntimePaths {
  ffmpeg: string;
  ffprobe: string;
  nativeCore: string;
  assetBase: string;
  creativePackRoot: string;
  personalMusicRoot: string;
  fontRoot: string;
  colorRoot: string;
}

interface BatchIpcDependencies {
  secureIpcHandle: SecureIpcHandle;
  runtimePaths: () => BatchRuntimePaths;
  runtimeUrlsWithCreative: (assets: MediaAsset[]) => Promise<Record<string, string>>;
}

export function registerBatchIpc({
  secureIpcHandle,
  runtimePaths,
  runtimeUrlsWithCreative,
}: BatchIpcDependencies): void {
  let batchSession: BatchAutoEditSession | undefined;
  const batchSessionPath = () => join(app.getPath("userData"), "batch", "current-session.json");
  const editorialProfiles = new Set<EditorialProfileId>(["auto", "gaming", "food", "travel", "podcast_on_camera", "podcast_no_face"]);

  const persistBatchSession = async () => {
    if (!batchSession) return;
    const path = batchSessionPath();
    await mkdir(resolve(path, ".."), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(batchSession, null, 2)}\n`, "utf8");
    await rm(path, { force: true });
    await rename(temporary, path);
  };

  const loadBatchSession = async () => {
    if (batchSession) return batchSession;
    try {
      batchSession = JSON.parse(await readFile(batchSessionPath(), "utf8")) as BatchAutoEditSession;
      batchSession.editorialProfile = editorialProfiles.has(batchSession.editorialProfile) ? batchSession.editorialProfile : "auto";
      for (const job of batchSession.jobs) if (job.status === "running") {
        job.status = "queued";
        job.error = "上次執行中斷，已排回佇列等待重試";
      }
      await persistBatchSession();
      return batchSession;
    } catch {
      return undefined;
    }
  };

  secureIpcHandle("hao:pick-batch-media", async (_event, payload?: { editorialProfile?: EditorialProfileId }) => {
    const editorialProfile = payload?.editorialProfile ?? "auto";
    if (!editorialProfiles.has(editorialProfile)) throw new Error("未知的剪輯類型");
    const picked = await dialog.showOpenDialog({
      title: "選取要批量自動剪輯的新影片",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "影片素材", extensions: ["mp4", "mov", "mkv", "webm", "m4v"] }],
    });
    if (picked.canceled || !picked.filePaths.length) return { canceled: true };
    const target = await dialog.showOpenDialog({
      title: "選擇批量成片與可編輯專案的儲存資料夾",
      properties: ["openDirectory", "createDirectory"],
    });
    if (target.canceled || !target.filePaths[0]) return { canceled: true };
    const paths = runtimePaths();
    for (const source of picked.filePaths) {
      const probe = await inspectMedia(source, paths.ffprobe);
      if (!probe.hasVideo || probe.duration <= 0) throw new Error(`${source} 不是可解碼的影片，批次尚未開始`);
    }
    const now = Date.now().toString();
    batchSession = {
      schemaVersion: 1,
      id: `batch-${now}`,
      editorialProfile,
      outputRoot: target.filePaths[0],
      createdAt: now,
      updatedAt: now,
      jobs: picked.filePaths.map((sourcePath, index) => ({
        id: `job-${String(index + 1).padStart(3, "0")}`,
        sourcePath,
        sourceName: sourcePath.split(/[\\/]/).at(-1) ?? "新影片",
        status: "queued",
        warnings: [],
      })),
    };
    await persistBatchSession();
    return { canceled: false, session: batchSession };
  });

  secureIpcHandle("hao:get-batch-session", async () => ({ session: await loadBatchSession() }));

  secureIpcHandle("hao:run-batch-auto-edit-item", async (_event, payload: { sessionId: string; jobId: string }) => {
    const session = await loadBatchSession();
    if (!session || session.id !== payload.sessionId) throw new Error("批次 session 身分不一致");
    const job = session.jobs.find((item) => item.id === payload.jobId);
    if (!job) throw new Error("找不到批次項目");
    if (job.status === "completed") return { session };
    job.status = "running";
    job.error = undefined;
    session.updatedAt = Date.now().toString();
    await persistBatchSession();
    const paths = runtimePaths();
    const result = await runBatchAutoEditItem({
      jobId: job.id,
      sourcePath: job.sourcePath,
      outputRoot: session.outputRoot,
      language: "auto",
      targetRatio: 0.65,
      addMusic: true,
      editorialProfile: session.editorialProfile,
    }, {
      ffmpegPath: paths.ffmpeg,
      ffprobePath: paths.ffprobe,
      nativeCorePath: paths.nativeCore,
      cacheRoot: join(app.getPath("userData"), "media-cache"),
      modelRoot: join(app.getPath("userData"), "models"),
      creativePackRoot: paths.creativePackRoot,
      personalMusicRoot: paths.personalMusicRoot,
      fontRoot: paths.fontRoot,
      colorRoot: paths.colorRoot,
    });
    job.status = result.status;
    job.projectPath = result.projectPath;
    job.outputPath = result.outputPath;
    job.receiptPath = result.receiptPath;
    job.warnings = result.warnings;
    job.error = result.error;
    session.updatedAt = Date.now().toString();
    await persistBatchSession();
    return { session };
  });

  secureIpcHandle("hao:open-batch-project", async (_event, payload: { sessionId: string; jobId: string }) => {
    const session = await loadBatchSession();
    if (!session || session.id !== payload.sessionId) throw new Error("批次 session 身分不一致");
    const job = session.jobs.find((item) => item.id === payload.jobId);
    if (!job?.projectPath) throw new Error("這個批次項目尚未產生可編輯專案");
    const project = await readProjectFile(job.projectPath);
    return {
      canceled: false,
      path: job.projectPath,
      project,
      runtimeUrls: await runtimeUrlsWithCreative(project.assets),
    };
  });
}
