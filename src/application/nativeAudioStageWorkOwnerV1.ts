import { randomUUID } from "node:crypto";
import { mkdir, rm, rmdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { PendingNativeCloseError } from "../shared/pendingNativeClose";
import { assertRenderWorkDirectoryOwnedV1, finishRenderWorkDirectoryV1 } from "../render/renderWorkspace";

export interface NativeAudioStageParentCleanupV1 {
  readonly workspaceRoot: string;
  run<T>(operation: () => Promise<T>): Promise<T>;
}
interface AudioParentStateV1 { workspaceRoot: string; cleanup: () => Promise<void>; owner?: AudioStageOwnerV1 }
interface AudioStageOwnerV1 {
  sessionRoot?: string;
  paths: string[];
  observations: string[];
  waitingForClose: boolean;
  cleanupFailed: boolean;
  primary?: unknown;
  parent?: AudioParentStateV1;
  retirement?: Promise<void>;
}
const AUDIO_STAGE_OWNER_LIMIT_V1 = 2;
const audioStageOwnersV1 = new Set<AudioStageOwnerV1>();
const audioParentStatesV1 = new WeakMap<NativeAudioStageParentCleanupV1, AudioParentStateV1>();
const audioStageCountsV1 = { admitted: 0, refused: 0, transferred: 0, parentTransfers: 0, retired: 0, cleanupAttempts: 0, cleanupFailures: 0 };
export function nativeAudioStageWorkSnapshotV1() {
  return { limit: AUDIO_STAGE_OWNER_LIMIT_V1, active: audioStageOwnersV1.size,
    pendingClose: [...audioStageOwnersV1].filter(owner => owner.waitingForClose).length,
    cleanupFailed: [...audioStageOwnersV1].filter(owner => owner.cleanupFailed).length,
    ...audioStageCountsV1, observations: [...audioStageOwnersV1].map(owner => [...owner.observations]) };
}
function observeAudioCleanupV1(owner: AudioStageOwnerV1, error: unknown): void {
  owner.cleanupFailed = true; audioStageCountsV1.cleanupFailures++;
  let message: string;
  try { message = String(error); } catch { message = "Unprintable audio cleanup error"; }
  if (owner.observations.length < 8) owner.observations.push(message.slice(0, 512));
  if (owner.primary instanceof PendingNativeCloseError) owner.primary.observeFailure(error);
}
async function cleanupAudioStageV1(owner: AudioStageOwnerV1): Promise<{ error: unknown } | undefined> {
  let failure: { error: unknown } | undefined;
  const observe = (error: unknown) => { failure ??= { error }; observeAudioCleanupV1(owner, error); };
  audioStageCountsV1.cleanupAttempts++;
  if (owner.parent) {
    try { await owner.parent.cleanup(); } catch (error) { observe(error); }
  } else {
    for (const path of [...owner.paths].reverse()) {
      try { await rm(path, { force: true }); } catch (error) { observe(error); }
    }
    if (owner.sessionRoot) {
      try { await rmdir(owner.sessionRoot); }
      catch (error) { if ((error as { code?: unknown }).code !== "ENOENT") observe(error); }
    }
  }
  if (!owner.cleanupFailed) { audioStageOwnersV1.delete(owner); audioStageCountsV1.retired++; }
  return failure;
}
function retainAudioCloseV1(owner: AudioStageOwnerV1, error: PendingNativeCloseError): void {
  if (owner.retirement) return;
  owner.primary = error; owner.waitingForClose = true;
  owner.retirement = error.closed.then(async () => {
    owner.waitingForClose = false;
    await cleanupAudioStageV1(owner);
  }).catch(cleanupError => observeAudioCleanupV1(owner, cleanupError));
}
/** Explicit parent identity is installed before staging; no ancestry is guessed. */
export function createNativeAudioStageParentCleanupV1(workspaceRoot: string, cleanup: () => Promise<void>): NativeAudioStageParentCleanupV1 {
  if (!isAbsolute(workspaceRoot)) throw Error("NATIVE_AUDIO_PARENT_ROOT_NOT_ABSOLUTE");
  assertRenderWorkDirectoryOwnedV1(workspaceRoot);
  const state: AudioParentStateV1 = { workspaceRoot: resolve(workspaceRoot), cleanup };
  const handle: NativeAudioStageParentCleanupV1 = { workspaceRoot: state.workspaceRoot,
    async run<T>(operation: () => Promise<T>): Promise<T> {
      let primary: unknown;
      let failed = false;
      try { return await operation(); }
      catch (error) {
        primary = error; failed = true;
        if (state.owner) {
          state.owner.primary = error;
          if (error instanceof PendingNativeCloseError) retainAudioCloseV1(state.owner, error);
        }
        throw error;
      } finally {
        if (state.owner) {
          if (!state.owner.retirement) {
            const cleanupFailure = await cleanupAudioStageV1(state.owner);
            if (!failed && cleanupFailure) throw cleanupFailure.error;
          }
        } else {
          await finishRenderWorkDirectoryV1(state.workspaceRoot, cleanup, failed, primary);
        }
      }
    },
  };
  audioParentStatesV1.set(handle, state);
  return handle;
}
export interface NativeAudioStageWorkV1 {
  readonly sessionRoot: string;
  trackManagedPath(path: string): void;
  pathsForReceipt(): string[];
}
/** Success transfers files to its caller, or retains this same reservation for its explicit render parent. */
export async function withNativeAudioStageWorkV1<T>(cacheRoot: string, maximumManagedPaths: number,
  operation: (work: NativeAudioStageWorkV1) => Promise<T>, parent?: NativeAudioStageParentCleanupV1): Promise<T> {
  if (!Number.isSafeInteger(maximumManagedPaths) || maximumManagedPaths <= 0 || maximumManagedPaths > 9) throw Error("NATIVE_AUDIO_MANAGED_PATH_BOUND_INVALID");
  const parentState = parent ? audioParentStatesV1.get(parent) : undefined;
  if (parent && !parentState) throw Error("NATIVE_AUDIO_PARENT_NOT_OWNED");
  if (parentState?.owner) throw Error("NATIVE_AUDIO_PARENT_ALREADY_OWNS_STAGE");
  if (audioStageOwnersV1.size >= AUDIO_STAGE_OWNER_LIMIT_V1) {
    audioStageCountsV1.refused++; throw Error("NATIVE_AUDIO_STAGE_CLEANUP_BUSY");
  }
  const owner: AudioStageOwnerV1 = { paths: [], observations: [], waitingForClose: false, cleanupFailed: false, parent: parentState };
  audioStageOwnersV1.add(owner); audioStageCountsV1.admitted++;
  if (parentState) parentState.owner = owner;
  try {
    const previewRoot = join(resolve(cacheRoot), "audio-preview");
    if (parentState) {
      const scope = relative(parentState.workspaceRoot, previewRoot);
      if (!scope || scope.startsWith("..") || isAbsolute(scope)) throw Error("NATIVE_AUDIO_SESSION_OUTSIDE_PARENT");
    }
    await mkdir(previewRoot, { recursive: true });
    const sessionRoot = join(previewRoot, randomUUID()); owner.sessionRoot = sessionRoot;
    await mkdir(sessionRoot);
    const result = await operation({ sessionRoot,
      trackManagedPath(path) {
        const absolute = resolve(path);
        if (dirname(absolute) !== resolve(sessionRoot) || owner.paths.length >= maximumManagedPaths || owner.paths.includes(absolute)) throw Error("NATIVE_AUDIO_MANAGED_PATH_INVALID");
        owner.paths.push(absolute);
      },
      pathsForReceipt() { return [...owner.paths]; },
    });
    if (parentState) audioStageCountsV1.parentTransfers++;
    else { audioStageOwnersV1.delete(owner); audioStageCountsV1.transferred++; }
    return result;
  } catch (error) {
    owner.primary = error;
    if (error instanceof PendingNativeCloseError) retainAudioCloseV1(owner, error);
    else if (!parentState) await cleanupAudioStageV1(owner);
    throw error;
  }
}
