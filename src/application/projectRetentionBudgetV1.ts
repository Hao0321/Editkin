import { lstat, opendir, statfs } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { BigIntStats } from "node:fs";

const MiB = 1024 * 1024;
/** Admission only. These limits never grant permission to remove a file. */
export const PROJECT_RETENTION_LIMITS_V1 = Object.freeze({
  maximumRetainedNames: 16,
  maximumChargedBytes: 512 * MiB,
  minimumFreeBytes: 256 * MiB,
  maximumDirectoryEntries: 4096,
  maximumProjectBytes: 64 * MiB,
  reservedNamesPerAttempt: 5,
});

type CapacityReason = "count" | "bytes" | "disk" | "scan" | "inspection" | "projectSize";
const reasons: Record<CapacityReason, string> = {
  count: "這個專案的保留檔已達安全數量上限。",
  bytes: "這個專案的保留檔大小已達安全上限。",
  disk: "可用磁碟空間不足以安全完成存檔與復原副本。",
  scan: "資料夾項目太多，暫時無法完成安全的容量檢查。",
  inspection: "目前無法確認專案保留位置的容量。",
  projectSize: "專案內容超過 64 MiB 的存檔上限。",
};

export class ProjectRetentionCapacityError extends Error {
  readonly code = "EDITKIN_PROJECT_RETENTION_CAPACITY";
  constructor(readonly reason: CapacityReason) {
    super("EDITKIN_PROJECT_RETENTION_CAPACITY: " + reasons[reason]
      + "原有檔案都保留了，這次沒有建立新的專案暫存檔。請用「另存新檔」換到空間足夠的一般資料夾，或先確認並整理保留版本。");
    this.name = "ProjectRetentionCapacityError";
  }
}

function isRetentionName(name: string, projectName: string): boolean {
  const candidate = process.platform === "win32" ? name.toLowerCase() : name;
  const prefix = (process.platform === "win32" ? projectName.toLowerCase() : projectName) + ".";
  if (!candidate.startsWith(prefix)) return false;
  const suffix = candidate.slice(prefix.length);
  const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  return new RegExp("^retained-(?:current|previous|rollback|unsaved)-" + uuid + "\\.json$", "i").test(suffix)
    || new RegExp("^[0-9]+\\." + uuid + "\\.tmp$", "i").test(suffix)
    // Earlier Editkin writers used these raw recovery names. Charge their
    // presence conservatively; a matching name is never deletion authority.
    || new RegExp("^previous\\.[0-9]+\\." + uuid + "\\.rollback$", "i").test(suffix)
    || new RegExp("^corrupt-[0-9]+-" + uuid + "$", "i").test(suffix);
}

/**
 * Count existing raw retention files without opening their contents or following links.
 * Similar author filenames are never deleted or treated as ownership/authorization.
 * The existing project lease serializes cooperating saves. Concurrent foreign growth
 * or volume consumption is not an OS reservation and is not certified by this estimate.
 */
export async function assertProjectRetentionBudgetV1(projectPath: string, stagedByteLength: number): Promise<void> {
  const limits = PROJECT_RETENTION_LIMITS_V1;
  if (!Number.isSafeInteger(stagedByteLength) || stagedByteLength < 0 || stagedByteLength > limits.maximumProjectBytes) {
    throw new ProjectRetentionCapacityError("projectSize");
  }
  const directory = dirname(projectPath), projectName = basename(projectPath);
  const existing = new Map<string, Pick<BigIntStats, "size" | "blocks">>();
  let retainedNames = 0, entries = 0;
  const inspect = async (path: string, optional: boolean): Promise<BigIntStats | undefined> => {
    try {
      const value = await lstat(path, { bigint: true });
      if (!value.isFile() || value.isSymbolicLink()) throw new ProjectRetentionCapacityError("inspection");
      return value;
    } catch (error) {
      if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error instanceof ProjectRetentionCapacityError ? error : new ProjectRetentionCapacityError("inspection");
    }
  };
  try {
    const dir = await opendir(directory);
    for await (const entry of dir) {
      entries += 1;
      if (entries > limits.maximumDirectoryEntries) throw new ProjectRetentionCapacityError("scan");
      if (!isRetentionName(entry.name, projectName)) continue;
      retainedNames += 1;
      if (retainedNames + limits.reservedNamesPerAttempt > limits.maximumRetainedNames) {
        throw new ProjectRetentionCapacityError("count");
      }
      const path = join(directory, entry.name), value = await inspect(path, false);
      if (!value) throw new ProjectRetentionCapacityError("inspection");
      // Unknown/zero file IDs are charged per name instead of undercounting aliases.
      const key = value.ino > 0n ? String(value.dev) + ":" + String(value.ino) : path;
      const previous = existing.get(key);
      existing.set(key, { size: previous && previous.size > value.size ? previous.size : value.size,
        blocks: previous && previous.blocks > value.blocks ? previous.blocks : value.blocks });
    }
  } catch (error) {
    throw error instanceof ProjectRetentionCapacityError ? error : new ProjectRetentionCapacityError("inspection");
  }
  const primary = await inspect(projectPath, true), previous = await inspect(projectPath + ".previous", true);
  const volume = await statfs(directory, { bigint: true }).catch(() => { throw new ProjectRetentionCapacityError("inspection"); });
  const unit = volume.bsize;
  if (unit <= 0n || unit > 1024n * 1024n * 1024n || volume.bavail < 0n) throw new ProjectRetentionCapacityError("inspection");
  const rounded = (bytes: bigint) => ((bytes + unit - 1n) / unit) * unit + unit;
  const charge = (file: Pick<BigIntStats, "size" | "blocks"> | undefined): bigint => {
    if (!file) return 0n;
    const logical = rounded(file.size > 0n ? file.size : 0n);
    const allocated = file.blocks > 0n ? file.blocks * 512n + unit : 0n;
    return logical > allocated ? logical : allocated;
  };
  let retainedBytes = 0n;
  for (const file of existing.values()) retainedBytes += charge(file);
  // Reserve both independent staged+unsaved allocations, plus both public
  // generations that could become retained aliases if a late operation fails.
  const stage = rounded(BigInt(stagedByteLength));
  const worstRetainedBytes = retainedBytes + charge(primary) + charge(previous) + 2n * stage;
  if (worstRetainedBytes > BigInt(limits.maximumChargedBytes)) throw new ProjectRetentionCapacityError("bytes");
  if (volume.bavail * unit < BigInt(limits.minimumFreeBytes) + 2n * stage) throw new ProjectRetentionCapacityError("disk");
}
