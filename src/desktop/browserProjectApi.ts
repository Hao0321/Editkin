import { editGraphFileName } from "../application/exportGraph";
import { parseProject } from "../application/parseProject";
import { parseRecoverySnapshot, RECOVERY_MAX_BYTES } from "../application/recoverySnapshot";
import type { EditProject, MediaAsset } from "../domain/types";
import type { HaoDesktopApi } from "./types";

// The browser build has no file system access, so a project file is a download,
// opening one is a file pick, and media is re-linked by file name because the
// project only stores `local://<name>` for browser imports.

export interface BrowserProjectStore {
  get(): Promise<unknown>;
  put(value: unknown): Promise<void>;
  clear(): Promise<void>;
}

export interface BrowserProjectDeps {
  store: BrowserProjectStore;
  pickFiles: (accept: string) => Promise<File[]>;
  download: (project: EditProject) => void;
}

export interface RelinkResult {
  runtimeUrls: Record<string, string>;
  unlinkedAssetNames: string[];
}

export interface BrowserProjectApi extends Pick<HaoDesktopApi, "openProject" | "saveProject" | "previewUrls" | "loadRecovery" | "saveRecovery" | "clearRecovery"> {
  relinkMedia: (assets: MediaAsset[]) => Promise<RelinkResult | undefined>;
}

const MEDIA_ACCEPT = "video/*,audio/*,image/*";

function assetFileName(asset: MediaAsset): string {
  if (!asset.uri.startsWith("local://")) return asset.name;
  try { return decodeURIComponent(asset.uri.slice("local://".length)); } catch { return asset.name; }
}

function linkMedia(assets: MediaAsset[], files: File[]): RelinkResult {
  const byName = new Map<string, File>();
  for (const file of files) if (!byName.has(file.name)) byName.set(file.name, file);
  const runtimeUrls: Record<string, string> = {};
  const unlinkedAssetNames: string[] = [];
  for (const asset of assets) {
    const file = byName.get(assetFileName(asset)) ?? byName.get(asset.name);
    if (file) runtimeUrls[asset.id] = URL.createObjectURL(file);
    else unlinkedAssetNames.push(asset.name);
  }
  return { runtimeUrls, unlinkedAssetNames };
}

export function createBrowserProjectApi({ store, pickFiles, download }: BrowserProjectDeps): BrowserProjectApi {
  return {
    openProject: async () => {
      const files = await pickFiles(`.json,${MEDIA_ACCEPT}`);
      if (!files.length) return { canceled: true };
      const projectFiles = files.filter((file) => /\.json$/i.test(file.name));
      if (projectFiles.length !== 1) throw new Error("請選擇一個 .editkin.json 專案檔；也可以同時選取原始素材來自動重新連結。");
      const [projectFile] = projectFiles;
      if (projectFile.size > RECOVERY_MAX_BYTES) throw new Error(`${projectFile.name} 超過 ${RECOVERY_MAX_BYTES / 1024 / 1024} MB，不像是 Editkin 專案檔。`);
      let project: EditProject;
      try { project = parseProject(JSON.parse(await projectFile.text())); }
      catch (error) { throw new Error(`${projectFile.name} 不是有效的 Editkin 專案檔，目前專案未被更動。`, { cause: error }); }
      const { runtimeUrls, unlinkedAssetNames } = linkMedia(project.assets, files.filter((file) => file !== projectFile));
      return { canceled: false, path: projectFile.name, project, runtimeUrls, unlinkedAssetNames };
    },
    saveProject: async (project) => {
      const valid = parseProject(project);
      const saved: EditProject = { ...valid, revision: valid.revision + 1, updatedAt: new Date().toISOString() };
      download(saved);
      return { canceled: false, path: editGraphFileName(saved), project: saved };
    },
    relinkMedia: async (assets) => {
      const files = await pickFiles(MEDIA_ACCEPT);
      return files.length ? linkMedia(assets, files) : undefined;
    },
    // Blob URLs do not survive a reload; media is re-linked from the menu.
    previewUrls: async () => ({}),
    loadRecovery: async () => {
      const raw = await store.get();
      if (raw === undefined) return { found: false, reason: "missing" };
      try { return { found: true, source: "primary", snapshot: parseRecoverySnapshot(raw) }; }
      catch (error) { return { found: false, reason: (error as { code?: string }).code === "STALE" ? "stale" : "corrupt" }; }
    },
    saveRecovery: (project, projectPath, cleanUpdatedAt) => store.put({
      schemaVersion: 1, savedAt: new Date().toISOString(), cleanUpdatedAt,
      ...(projectPath ? { projectPath } : {}), project,
    }),
    clearRecovery: () => store.clear(),
  };
}

export function pickBrowserFiles(accept: string): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = accept;
    input.hidden = true;
    const finish = (files: File[]) => { input.remove(); resolve(files); };
    input.addEventListener("change", () => finish([...(input.files ?? [])]), { once: true });
    input.addEventListener("cancel", () => finish([]), { once: true });
    // Safari can drop events from a detached input.
    document.body.append(input);
    input.click();
  });
}

const DB_NAME = "editkin-web";
const STORE_NAME = "recovery";
const RECOVERY_KEY = "current";

export function createIndexedDbProjectStore(): BrowserProjectStore {
  let opened: Promise<IDBDatabase> | undefined;
  const open = () => opened ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { opened = undefined; reject(request.error); };
  });
  const run = async <T,>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const transaction = (await open()).transaction(STORE_NAME, mode);
    const request = action(transaction.objectStore(STORE_NAME));
    return new Promise<T>((resolve, reject) => {
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = transaction.onabort = () => reject(transaction.error);
    });
  };
  return {
    get: () => run<unknown>("readonly", (store) => store.get(RECOVERY_KEY)),
    put: async (value) => { await run("readwrite", (store) => store.put(value, RECOVERY_KEY)); },
    clear: async () => { await run("readwrite", (store) => store.delete(RECOVERY_KEY)); },
  };
}
