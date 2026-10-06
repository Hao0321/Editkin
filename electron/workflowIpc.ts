import type { IpcMainInvokeEvent } from "electron";
import { randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { inspectMedia } from "../src/application/inspectMedia";
import { mediaUtilityInputOptions } from "../src/application/mediaUtilityInputPolicy";
import type { PickedMedia } from "../src/desktop/types";
import { compilePluginCommands, discoverInstalledPlugins, findInstalledCapability } from "../src/plugins/registry";
import { readHostWorkflowProfile, writeHostWorkflowProfileAtomic } from "../src/plugins/workflowProfileFileStore";
import { assertLocalMediaPath } from "../src/shared/localMediaPath";

export const ELECTRON_MEDIA_IMPORT_MAX_PATHS = 256;
export const ELECTRON_MEDIA_IMPORT_MAX_PATH_LENGTH = 4096;
export const ELECTRON_MEDIA_IMPORT_MAX_REQUESTS = 8;
export const ELECTRON_MEDIA_IMPORT_DEADLINE_MS = 120_000;
export const ELECTRON_MEDIA_IMPORT_MAX_ANCESTORS = 64;
const MAX_PROFILE_OPERATIONS = 32;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".aac", ".flac"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".webm", ".m4v"]);

export interface ElectronWorkflowPaths {
  readonly workflowProfilePath: string;
  readonly userPluginRoot: string;
  readonly pluginRoots: readonly string[];
}

/** Host-derived roots only. The renderer never supplies a profile/plugin path. */
export function electronWorkflowPaths(userDataRoot: string, bundledPluginRoot: string): ElectronWorkflowPaths {
  for (const root of [userDataRoot, bundledPluginRoot]) {
    if (typeof root !== "string" || !isAbsolute(root)) throw new Error("Electron host 資源根目錄必須是絕對路徑");
    assertLocalMediaPath(root);
  }
  const userPluginRoot = join(resolve(userDataRoot), "plugins");
  return Object.freeze({
    workflowProfilePath: join(resolve(userDataRoot), "workflow", "workflow-profile.json"),
    userPluginRoot,
    pluginRoots: Object.freeze([...new Set([resolve(bundledPluginRoot), userPluginRoot])]),
  });
}

interface ElectronWorkflowDependencies {
  readonly ffprobePath: string;
  readonly previewUrl: (path: string) => string;
  readonly openPath: (path: string) => Promise<string>;
  readonly inspect?: typeof inspectMedia;
  /** Host/test clock only; never accepted from the renderer request. */
  readonly now?: () => number;
}

/** Validate the complete request before probing or approving any media URL. */
function selectedMediaPaths(input: unknown): string[] {
  if (!Array.isArray(input) || input.length > ELECTRON_MEDIA_IMPORT_MAX_PATHS) {
    throw new Error(`一次最多匯入 ${ELECTRON_MEDIA_IMPORT_MAX_PATHS} 份媒體素材`);
  }
  const paths: string[] = [];
  for (const raw of input) {
    if (typeof raw !== "string" || !raw.length || raw.length > ELECTRON_MEDIA_IMPORT_MAX_PATH_LENGTH
      || raw.includes("\0") || !isAbsolute(raw)) throw new Error("匯入項目必須是有界的本機絕對路徑");
    // Run before lstat/probe: an untrusted UNC path must not initiate SMB I/O.
    assertLocalMediaPath(raw);
    const extension = extname(raw).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(extension) && !AUDIO_EXTENSIONS.has(extension) && !VIDEO_EXTENSIONS.has(extension)) {
      throw new Error("不支援的媒體格式");
    }
    paths.push(resolve(raw));
  }
  return paths;
}

type DeadlineCheck = () => void;
interface DirectoryReceipt { readonly path: string; readonly stat: BigIntStats; }
interface MediaReceipt { readonly path: string; readonly stat: BigIntStats; readonly directories: readonly DirectoryReceipt[]; }

async function boundary<T>(check: DeadlineCheck, operation: () => Promise<T>): Promise<T> {
  check();
  let result: T;
  try { result = await operation(); }
  catch (error) {
    try { check(); }
    catch (expired) { throw new Error(String(expired), { cause: error }); }
    throw error;
  }
  check();
  return result;
}
function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right);
}
function sameObject(before: BigIntStats, after: BigIntStats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.birthtimeNs === after.birthtimeNs;
}
function sameFile(before: BigIntStats, after: BigIntStats): boolean {
  return sameObject(before, after) && before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
}
async function fixedDirectory(path: string, check: DeadlineCheck): Promise<DirectoryReceipt> {
  assertLocalMediaPath(path);
  const stat = await boundary(check, () => lstat(path, { bigint: true }));
  // Check each parent before touching the next component, including Windows
  // junction/reparse aliases exposed as links by lstat.
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("媒體祖先必須是固定一般目錄，不能是 junction/reparse/symlink");
  const actual = await boundary(check, () => realpath(path));
  assertLocalMediaPath(actual);
  if (!samePath(actual, path)) throw new Error("媒體祖先 realpath 不是原本本機目錄");
  return { path, stat };
}
async function fixedMediaFile(path: string, check: DeadlineCheck): Promise<BigIntStats> {
  assertLocalMediaPath(path);
  const stat = await boundary(check, () => lstat(path, { bigint: true }));
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("匯入項目必須是一般媒體檔案，不能是 symlink 或資料夾");
  const actual = await boundary(check, () => realpath(path));
  assertLocalMediaPath(actual);
  if (!samePath(actual, path)) throw new Error("媒體檔案 realpath 不是原本本機路徑");
  return stat;
}
function ancestorPaths(path: string): string[] {
  const parent = dirname(path), anchor = parse(parent).root;
  const components = relative(anchor, parent).split(sep).filter(Boolean);
  if (components.length + 1 > ELECTRON_MEDIA_IMPORT_MAX_ANCESTORS) throw new Error("媒體祖先目錄鏈超過安全界限");
  const paths = [anchor];
  let current = anchor;
  for (const component of components) { current = join(current, component); paths.push(current); }
  return paths;
}
async function selectedMediaReceipts(paths: readonly string[], check: DeadlineCheck): Promise<MediaReceipt[]> {
  const directories = new Map<string, DirectoryReceipt>(), files = new Map<string, MediaReceipt>();
  const selected: MediaReceipt[] = [];
  for (const path of paths) {
    const previous = files.get(path);
    if (previous) { selected.push(previous); continue; }
    const chain: DirectoryReceipt[] = [];
    for (const parent of ancestorPaths(path)) {
      let receipt = directories.get(parent);
      if (!receipt) { receipt = await fixedDirectory(parent, check); directories.set(parent, receipt); }
      chain.push(receipt);
    }
    const receipt = { path, directories: chain, stat: await fixedMediaFile(path, check) };
    files.set(path, receipt); selected.push(receipt);
  }
  return selected;
}
async function assertMediaUnchanged(receipt: MediaReceipt, check: DeadlineCheck): Promise<void> {
  for (const before of receipt.directories) {
    const after = await fixedDirectory(before.path, check);
    // Directory timestamps/length change when unrelated siblings are added.
    if (!sameObject(before.stat, after.stat)) throw new Error("媒體祖先目錄在匯入期間被替換");
  }
  const after = await fixedMediaFile(receipt.path, check);
  if (!sameFile(receipt.stat, after)) throw new Error("媒體檔案在匯入期間被替換或修改");
}

export function createElectronWorkflowServices(paths: ElectronWorkflowPaths, dependencies: ElectronWorkflowDependencies) {
  const inspect = dependencies.inspect ?? inspectMedia;
  const now = dependencies.now ?? Date.now;
  const readPluginRegistry = () => discoverInstalledPlugins([...paths.pluginRoots]);
  let profileTail: Promise<void> = Promise.resolve();
  let profileOperations = 0;
  let mediaTail: Promise<void> = Promise.resolve();
  let mediaOperations = 0;
  // The shared atomic file store owns recovery/validation. Serializing reads and
  // writes here prevents two IPC requests from racing its .previous transaction.
  const profileOperation = <T>(operation: () => Promise<T>): Promise<T> => {
    if (profileOperations >= MAX_PROFILE_OPERATIONS) return Promise.reject(new Error("Workflow Profile 請求佇列已滿"));
    profileOperations += 1;
    const result = profileTail.then(operation);
    profileTail = result.then(() => undefined, () => undefined);
    return result.finally(() => { profileOperations -= 1; });
  };
  return {
    readPluginRegistry,
    async importMediaPaths(input: unknown): Promise<PickedMedia[]> {
      const requestedAt = now();
      // Own and validate the bounded path strings before retaining a request.
      const selected = selectedMediaPaths(input);
      if (!selected.length) return [];
      const checkDeadline = () => {
        const current = now();
        if (!Number.isFinite(requestedAt) || !Number.isFinite(current) || current < requestedAt
          || current - requestedAt >= ELECTRON_MEDIA_IMPORT_DEADLINE_MS) throw new Error("媒體匯入超過 120 秒合作式期限");
      };
      checkDeadline();
      if (mediaOperations >= ELECTRON_MEDIA_IMPORT_MAX_REQUESTS) throw new Error("媒體匯入請求佇列已滿");
      mediaOperations += 1;
      const result = mediaTail.then(async () => {
        checkDeadline();
        const receipts = await selectedMediaReceipts(selected, checkDeadline);
        const picked: PickedMedia[] = [];
        // main.ts owns one shared service for picker and path IPC: requests as
        // well as their probes are serialized. A running probe retains its slot
        // until actual settlement; this API does not invent cancellation.
        for (const receipt of receipts) {
          await assertMediaUnchanged(receipt, checkDeadline);
          const path = receipt.path;
          const extension = extname(path).toLowerCase();
          const kind = IMAGE_EXTENSIONS.has(extension) ? "image" : AUDIO_EXTENSIONS.has(extension) ? "audio" : "video";
          // Same self-contained file-only FFmpeg input policy as conversion and audio gain.
          const metadata = await boundary(checkDeadline, () => inspect(path, dependencies.ffprobePath, mediaUtilityInputOptions(path)));
          await assertMediaUnchanged(receipt, checkDeadline);
          const duration = kind === "image" ? 5 : metadata.duration;
          if (!Number.isFinite(duration) || duration <= 0) throw new Error("媒體 duration 不合法");
          checkDeadline();
          picked.push({
            asset: { id: `asset-${randomUUID()}`, name: basename(path), kind, uri: path, duration,
              width: metadata.width, height: metadata.height, displayAspectRatio: metadata.displayAspectRatio },
            previewUrl: dependencies.previewUrl(path),
          });
        }
        checkDeadline();
        return picked;
      });
      mediaTail = result.then(() => undefined, () => undefined);
      return result.finally(() => { mediaOperations -= 1; });
    },
    getWorkflowProfile: () => profileOperation(() => readHostWorkflowProfile(paths.workflowProfilePath)),
    saveWorkflowProfile: (profile: unknown) => profileOperation(async () => {
      const registry = await readPluginRegistry();
      const saved = await writeHostWorkflowProfileAtomic(profile, registry, paths.workflowProfilePath);
      return { configured: true as const, path: paths.workflowProfilePath, profile: saved.profile };
    }),
    async openPluginFolder(): Promise<{ path: string; opened: boolean }> {
      await mkdir(paths.userPluginRoot, { recursive: true });
      const metadata = await lstat(paths.userPluginRoot);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error("使用者外掛根目錄必須是一般資料夾");
      const error = await dependencies.openPath(paths.userPluginRoot);
      if (error) throw new Error(`無法開啟使用者外掛資料夾：${error}`);
      return { path: paths.userPluginRoot, opened: true };
    },
    async compilePluginTool(pluginId: string, capabilityId: string, targetClipId: string, parameters: Record<string, unknown> = {}) {
      const registry = await readPluginRegistry();
      const { capability } = findInstalledCapability(registry, pluginId, capabilityId);
      return compilePluginCommands(capability, targetClipId, parameters);
    },
  };
}

type WorkflowHandler = (event: IpcMainInvokeEvent, payload?: unknown) => unknown;
function onlyField(payload: unknown, field: string): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)
    || Object.keys(payload).length !== 1 || !Object.prototype.hasOwnProperty.call(payload, field)) {
    throw new Error(`Electron request must contain only ${field}`);
  }
  return Reflect.get(payload, field);
}
function noPayload(payload: unknown): void {
  if (payload !== undefined) throw new Error("Electron request does not accept a renderer path or payload");
}

/** Every registration must pass through main.ts's existing trusted sender gate. */
export function registerElectronWorkflowIpc(
  secureIpcHandle: (channel: string, handler: WorkflowHandler) => void,
  services: ReturnType<typeof createElectronWorkflowServices>,
): void {
  secureIpcHandle("hao:import-media-paths", (_event, payload) => services.importMediaPaths(onlyField(payload, "paths")));
  secureIpcHandle("hao:get-workflow-profile", (_event, payload) => { noPayload(payload); return services.getWorkflowProfile(); });
  secureIpcHandle("hao:save-workflow-profile", (_event, payload) => services.saveWorkflowProfile(onlyField(payload, "profile")));
  secureIpcHandle("hao:open-plugin-folder", (_event, payload) => { noPayload(payload); return services.openPluginFolder(); });
}
