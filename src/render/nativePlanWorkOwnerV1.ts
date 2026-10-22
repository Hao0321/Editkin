import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PendingNativeCloseError } from "../shared/pendingNativeClose";

// Reserve before creating work: unknown close or failed cleanup must stay bounded.
const NATIVE_PLAN_WORK_LIMIT = 2;
interface NativePlanWorkOwner {
  workspace?: string;
  waitingForClose: boolean;
  cleaning: boolean;
  cleanupFailed: boolean;
  pending?: PendingNativeCloseError;
  retirement?: Promise<void>;
}
const nativePlanWorkOwners = new Set<NativePlanWorkOwner>();
const nativePlanWorkCounts = { admitted: 0, refused: 0, retired: 0, cleanupAttempts: 0, cleanupFailures: 0 };
/** Process-local native-plan ownership only; returns no mutable owner or private paths. */
export function nativePlanWorkSnapshot() {
  return { limit: NATIVE_PLAN_WORK_LIMIT, active: nativePlanWorkOwners.size,
    pendingClose: [...nativePlanWorkOwners].filter(owner => owner.waitingForClose).length,
    cleaning: [...nativePlanWorkOwners].filter(owner => owner.cleaning).length,
    cleanupFailed: [...nativePlanWorkOwners].filter(owner => owner.cleanupFailed).length,
    ...nativePlanWorkCounts };
}
function reserveNativePlanWork(): NativePlanWorkOwner {
  if (nativePlanWorkOwners.size >= NATIVE_PLAN_WORK_LIMIT) {
    nativePlanWorkCounts.refused++;
    throw new Error("NATIVE_PLAN_CLEANUP_BUSY");
  }
  const owner: NativePlanWorkOwner = { waitingForClose: false, cleaning: false, cleanupFailed: false };
  nativePlanWorkOwners.add(owner); nativePlanWorkCounts.admitted++;
  return owner;
}
async function cleanupNativePlanWork(owner: NativePlanWorkOwner, pending?: PendingNativeCloseError): Promise<void> {
  owner.cleaning = true;
  try {
    if (owner.workspace) {
      nativePlanWorkCounts.cleanupAttempts++;
      // This is exactly the private mkdtemp directory created for this owner.
      await rm(owner.workspace, { recursive: true, force: true });
    }
    nativePlanWorkOwners.delete(owner); nativePlanWorkCounts.retired++;
  } catch (error) {
    owner.cleanupFailed = true; nativePlanWorkCounts.cleanupFailures++;
    // Keep its reservation and make late failure visible on the original public error.
    if (pending) pending.observeFailure(error); else throw error;
  } finally { owner.cleaning = false; }
}

export async function withNativePlanWorkOwnerV1<T>(operation: (workspace: string) => Promise<T>): Promise<T> {
  const owner = reserveNativePlanWork();
  let retained = false;
  try {
    const workspace = await mkdtemp(join(tmpdir(), "hao-core-plan-"));
    owner.workspace = workspace;
    return await operation(workspace);
  } catch (error) {
    if (error instanceof PendingNativeCloseError) {
      retained = true; owner.pending = error; owner.waitingForClose = true;
      owner.retirement = error.closed.then(() => {
        owner.waitingForClose = false;
        return cleanupNativePlanWork(owner, error);
      }).catch(cleanupError => {
        owner.cleanupFailed = true;
        error.observeFailure(cleanupError);
      });
    }
    throw error;
  } finally {
    if (!retained) await cleanupNativePlanWork(owner);
  }
}
