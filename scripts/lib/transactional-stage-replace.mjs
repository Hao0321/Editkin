import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, rename, rm, rmdir } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

async function pathExists(path, lstatPath) {
  try {
    await lstatPath(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function assertStrictDescendant(root, path, label) {
  const relation = relative(root, path);
  if (!relation || relation.startsWith("..") || isAbsolute(relation)) {
    throw new Error(`${label} must stay inside the transaction envelope: ${path}`);
  }
}

function pathsOverlap(left, right) {
  const leftToRight = relative(left, right);
  const rightToLeft = relative(right, left);
  const isDescendant = (value) => !value || (!value.startsWith("..") && !isAbsolute(value));
  return isDescendant(leftToRight) || isDescendant(rightToLeft);
}

const TRANSIENT_RENAME_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);

async function wait(milliseconds) {
  await new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

async function renameWithBoundedRetry(renamePath, source, target, retries, retryDelayMs) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await renamePath(source, target);
    } catch (error) {
      if (attempt >= retries || !TRANSIENT_RENAME_CODES.has(error?.code)) throw error;
      await wait(Math.min(400, retryDelayMs * (attempt + 1)));
    }
  }
}

async function missingParents(path, envelopeRoot, lstatPath) {
  const missing = [];
  let current = resolve(path);
  while (current !== envelopeRoot && !(await pathExists(current, lstatPath))) {
    missing.push(current);
    current = dirname(current);
  }
  return missing;
}

export class TransactionalStageReplacementError extends Error {
  constructor(message, { cause, recoveryRoot, rollbackErrors = [] } = {}) {
    super(message, { cause });
    this.name = "TransactionalStageReplacementError";
    this.code = "EDITKIN_TRANSACTIONAL_STAGE_FAILED";
    this.recoveryRoot = recoveryRoot ?? null;
    this.rollbackComplete = rollbackErrors.length === 0;
    this.rollbackErrors = rollbackErrors.map((error) => String(error?.message ?? error));
  }
}

/**
 * Replaces a closed set of staged directories without deleting any live target
 * first. Existing targets are renamed into a transaction backup. If any backup
 * or install rename fails, every completed rename is reversed before rejecting.
 *
 * `fsOps` exists for deterministic fault-injection tests. Production callers
 * should not override it.
 */
export async function replaceStageDirectoriesTransactionally(replacementsInput, {
  envelopeRoot: envelopeRootInput,
  transactionLabel = randomUUID(),
  fsOps = {},
  transientRenameRetries,
  transientRenameDelayMs = 75,
} = {}) {
  const envelopeRoot = resolve(envelopeRootInput ?? "");
  const rawRenamePath = fsOps.rename ?? rename;
  const renameRetries = transientRenameRetries ?? (fsOps.rename ? 0 : 8);
  if (!Number.isInteger(renameRetries) || renameRetries < 0 || renameRetries > 20) {
    throw new Error("transientRenameRetries must be an integer between 0 and 20");
  }
  if (!Number.isFinite(transientRenameDelayMs) || transientRenameDelayMs < 0 || transientRenameDelayMs > 1_000) {
    throw new Error("transientRenameDelayMs must be between 0 and 1000 milliseconds");
  }
  const renamePath = (source, target) => renameWithBoundedRetry(
    rawRenamePath,
    source,
    target,
    renameRetries,
    transientRenameDelayMs,
  );
  const removePath = fsOps.rm ?? rm;
  const lstatPath = fsOps.lstat ?? lstat;
  const mkdirPath = fsOps.mkdir ?? mkdir;
  const rmdirPath = fsOps.rmdir ?? rmdir;
  const mkdtempPath = fsOps.mkdtemp ?? mkdtemp;
  const replacements = replacementsInput.map(([stagedInput, targetInput], index) => {
    const staged = resolve(stagedInput);
    const target = resolve(targetInput);
    assertStrictDescendant(envelopeRoot, staged, `Replacement ${index} staged path`);
    assertStrictDescendant(envelopeRoot, target, `Replacement ${index} target path`);
    if (staged === target) throw new Error(`Replacement ${index} staged and target paths are identical`);
    return {
      index,
      staged,
      target,
      backup: null,
      hadTarget: false,
      backedUp: false,
      installed: false,
    };
  });
  if (replacements.length === 0) throw new Error("Transactional stage requires at least one replacement");
  if (new Set(replacements.map(({ staged }) => staged)).size !== replacements.length) {
    throw new Error("Transactional stage contains duplicate staged paths");
  }
  if (new Set(replacements.map(({ target }) => target)).size !== replacements.length) {
    throw new Error("Transactional stage contains duplicate target paths");
  }
  for (let left = 0; left < replacements.length; left += 1) {
    for (let right = left + 1; right < replacements.length; right += 1) {
      if (pathsOverlap(replacements[left].staged, replacements[right].staged)) {
        throw new Error(`Transactional stage contains overlapping staged paths at replacements ${left} and ${right}`);
      }
      if (pathsOverlap(replacements[left].target, replacements[right].target)) {
        throw new Error(`Transactional stage contains overlapping target paths at replacements ${left} and ${right}`);
      }
    }
    for (let targetIndex = 0; targetIndex < replacements.length; targetIndex += 1) {
      if (pathsOverlap(replacements[left].staged, replacements[targetIndex].target)) {
        throw new Error(`Replacement ${left} staged path overlaps replacement ${targetIndex} target path`);
      }
    }
  }

  // Complete every source and topology check before the first live target rename.
  for (const { index, staged } of replacements) {
    if (!(await pathExists(staged, lstatPath))) {
      throw new Error(`Replacement ${index} staged path is missing before commit: ${staged}`);
    }
  }
  await mkdirPath(envelopeRoot, { recursive: true });
  const safeLabel = String(transactionLabel).replace(/[^a-z0-9._-]/giu, "-").slice(0, 48) || "transaction";
  const backupRoot = await mkdtempPath(resolve(envelopeRoot, `.editkin-stage-backup-${safeLabel}-`));
  const createdParents = [];
  for (const state of replacements) {
    state.backup = resolve(backupRoot, `entry-${String(state.index).padStart(2, "0")}`);
  }

  let committed = false;
  try {
    // Phase 1: preserve all old targets. No target is ever recursively deleted.
    for (const state of replacements) {
      state.hadTarget = await pathExists(state.target, lstatPath);
      if (!state.hadTarget) continue;
      await renamePath(state.target, state.backup);
      state.backedUp = true;
    }

    // Phase 2: install all staged directories by same-envelope rename.
    for (const state of replacements) {
      const parent = dirname(state.target);
      const newlyCreated = await missingParents(parent, envelopeRoot, lstatPath);
      await mkdirPath(parent, { recursive: true });
      createdParents.push(...newlyCreated);
      await renamePath(state.staged, state.target);
      state.installed = true;
    }
    committed = true;
  } catch (cause) {
    const rollbackErrors = [];
    for (const state of [...replacements].reverse()) {
      if (state.installed) {
        try {
          await renamePath(state.target, state.staged);
          state.installed = false;
        } catch (error) {
          rollbackErrors.push(new Error(`Could not return replacement ${state.index} to staging: ${error?.message ?? error}`));
        }
      }
      if (state.backedUp) {
        try {
          if (await pathExists(state.target, lstatPath)) {
            throw new Error("replacement target is still occupied");
          }
          await renamePath(state.backup, state.target);
          state.backedUp = false;
        } catch (error) {
          rollbackErrors.push(new Error(`Could not restore replacement ${state.index}: ${error?.message ?? error}`));
        }
      }
    }
    if (rollbackErrors.length === 0) {
      for (const parent of [...new Set(createdParents)]) {
        try {
          await rmdirPath(parent);
        } catch (error) {
          if (error?.code !== "ENOENT" && error?.code !== "ENOTEMPTY") rollbackErrors.push(error);
        }
      }
    }
    if (rollbackErrors.length === 0) {
      try {
        await removePath(backupRoot, { recursive: true, force: true });
      } catch (error) {
        rollbackErrors.push(error);
      }
    }
    throw new TransactionalStageReplacementError(
      rollbackErrors.length === 0
        ? `Transactional stage was rejected and the previous envelope was restored: ${cause?.message ?? cause}`
        : `Transactional stage failed and automatic rollback was incomplete; preserve ${backupRoot}`,
      { cause, recoveryRoot: backupRoot, rollbackErrors },
    );
  }

  let cleanupPending = null;
  if (committed) {
    try {
      await removePath(backupRoot, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
    } catch (error) {
      // The new envelope is complete. A locked executable may keep the old,
      // renamed backup alive; retain it for safe cleanup after that process exits.
      cleanupPending = {
        backupRoot,
        error: String(error?.message ?? error),
      };
    }
  }

  return {
    status: cleanupPending ? "COMMITTED_BACKUP_RETAINED" : "COMMITTED_CLEAN",
    replacements: replacements.length,
    cleanupPending,
  };
}
