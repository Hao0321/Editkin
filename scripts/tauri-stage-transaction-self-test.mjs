import { strict as assert } from "node:assert";
import { rename as nativeRename, readdir, readFile, rm, writeFile, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  TransactionalStageReplacementError,
  replaceStageDirectoriesTransactionally,
} from "./lib/transactional-stage-replace.mjs";

const root = await mkdtemp(join(tmpdir(), "editkin-tauri-stage-transaction-"));
const productionStageSource = await readFile(resolve(import.meta.dirname, "stage-tauri-resources.mjs"), "utf8");
assert.match(productionStageSource, /replaceStageDirectoriesTransactionally\(replacements, \{ envelopeRoot \}\)/u);
assert.doesNotMatch(productionStageSource, /rm\(\s*target\s*,/u);
assert.match(productionStageSource, /\[stagedAgentRuntime, resolve\(envelopeRoot, "agent-runtime-v3"\)\]/u);
assert.match(productionStageSource, /await cp\(resolve\("\.creative-packs\/hao-creator-library"\), stagedCreativePack,/u);
assert.match(productionStageSource, /await cp\(resolve\("plugins"\), stagedPlugins,/u);
assert.doesNotMatch(productionStageSource, /await cp\([^\n]+replacements\[\d+\]\[0\]/u);

async function fixture(name, { missingSecondStage = false } = {}) {
  const envelope = join(root, name);
  const staging = join(envelope, ".isolated-staging");
  const targetRuntime = join(envelope, "runtime");
  const targetPlugins = join(envelope, "plugins");
  const stagedRuntime = join(staging, "runtime");
  const stagedPlugins = join(staging, "plugins");
  await mkdir(targetRuntime, { recursive: true });
  await mkdir(targetPlugins, { recursive: true });
  await mkdir(stagedRuntime, { recursive: true });
  if (!missingSecondStage) await mkdir(stagedPlugins, { recursive: true });
  await writeFile(join(targetRuntime, "node.exe"), Buffer.from("old-runtime\u0000bytes"));
  await writeFile(join(targetPlugins, "manifest.json"), "old-plugin\n");
  await writeFile(join(stagedRuntime, "node.exe"), Buffer.from("new-runtime\u0000bytes"));
  if (!missingSecondStage) await writeFile(join(stagedPlugins, "manifest.json"), "new-plugin\n");
  return {
    envelope,
    staging,
    targetRuntime,
    targetPlugins,
    stagedRuntime,
    stagedPlugins,
    replacements: [
      [stagedRuntime, targetRuntime],
      [stagedPlugins, targetPlugins],
    ],
  };
}

async function bytes(path) {
  return Buffer.from(await readFile(path)).toString("hex");
}

async function assertOldTargetsIntact(item) {
  assert.equal(await bytes(join(item.targetRuntime, "node.exe")), Buffer.from("old-runtime\u0000bytes").toString("hex"));
  assert.equal(await readFile(join(item.targetPlugins, "manifest.json"), "utf8"), "old-plugin\n");
}

async function assertNoTransactionBackups(envelope) {
  const entries = await readdir(envelope);
  assert.deepEqual(entries.filter((entry) => entry.startsWith(".editkin-stage-backup-")), []);
}

try {
  const preflight = await fixture("missing-source", { missingSecondStage: true });
  await assert.rejects(
    replaceStageDirectoriesTransactionally(preflight.replacements, { envelopeRoot: preflight.envelope, transactionLabel: "preflight" }),
    /staged path is missing before commit/u,
  );
  await assertOldTargetsIntact(preflight);
  await assertNoTransactionBackups(preflight.envelope);

  const locked = await fixture("locked-target");
  let lockInjected = false;
  await assert.rejects(
    replaceStageDirectoriesTransactionally(locked.replacements, {
      envelopeRoot: locked.envelope,
      transactionLabel: "locked",
      fsOps: {
        rename: async (source, target) => {
          if (!lockInjected && resolve(source) === resolve(locked.targetPlugins)
            && basename(target).startsWith("entry-")) {
            lockInjected = true;
            throw Object.assign(new Error("simulated locked target"), { code: "EBUSY" });
          }
          return nativeRename(source, target);
        },
      },
    }),
    (error) => {
      assert(error instanceof TransactionalStageReplacementError);
      assert.equal(error.rollbackComplete, true);
      assert.match(error.message, /previous envelope was restored/u);
      return true;
    },
  );
  assert.equal(lockInjected, true);
  await assertOldTargetsIntact(locked);
  assert.equal(await bytes(join(locked.stagedRuntime, "node.exe")), Buffer.from("new-runtime\u0000bytes").toString("hex"));
  await assertNoTransactionBackups(locked.envelope);

  const installFailure = await fixture("install-failure");
  let installFailureInjected = false;
  await assert.rejects(
    replaceStageDirectoriesTransactionally(installFailure.replacements, {
      envelopeRoot: installFailure.envelope,
      transactionLabel: "install-failure",
      fsOps: {
        rename: async (source, target) => {
          if (!installFailureInjected && resolve(source) === resolve(installFailure.stagedPlugins)
            && resolve(target) === resolve(installFailure.targetPlugins)) {
            installFailureInjected = true;
            throw Object.assign(new Error("simulated install failure"), { code: "EIO" });
          }
          return nativeRename(source, target);
        },
      },
    }),
    (error) => {
      assert(error instanceof TransactionalStageReplacementError);
      assert.equal(error.rollbackComplete, true);
      return true;
    },
  );
  assert.equal(installFailureInjected, true);
  await assertOldTargetsIntact(installFailure);
  assert.equal(await bytes(join(installFailure.stagedRuntime, "node.exe")), Buffer.from("new-runtime\u0000bytes").toString("hex"));
  assert.equal(await readFile(join(installFailure.stagedPlugins, "manifest.json"), "utf8"), "new-plugin\n");
  await assertNoTransactionBackups(installFailure.envelope);

  const success = await fixture("success");
  const committed = await replaceStageDirectoriesTransactionally(success.replacements, {
    envelopeRoot: success.envelope,
    transactionLabel: "success",
  });
  assert.equal(committed.status, "COMMITTED_CLEAN");
  assert.equal(committed.cleanupPending, null);
  assert.equal(await bytes(join(success.targetRuntime, "node.exe")), Buffer.from("new-runtime\u0000bytes").toString("hex"));
  assert.equal(await readFile(join(success.targetPlugins, "manifest.json"), "utf8"), "new-plugin\n");
  await assertNoTransactionBackups(success.envelope);

  const transient = await fixture("transient-rename");
  let transientFailures = 0;
  const transientResult = await replaceStageDirectoriesTransactionally(transient.replacements, {
    envelopeRoot: transient.envelope,
    transactionLabel: "transient",
    transientRenameRetries: 3,
    transientRenameDelayMs: 0,
    fsOps: {
      rename: async (source, target) => {
        if (resolve(source) === resolve(transient.stagedPlugins)
          && resolve(target) === resolve(transient.targetPlugins)
          && transientFailures < 2) {
          transientFailures += 1;
          throw Object.assign(new Error("simulated transient scanner lock"), { code: "EPERM" });
        }
        return nativeRename(source, target);
      },
    },
  });
  assert.equal(transientFailures, 2);
  assert.equal(transientResult.status, "COMMITTED_CLEAN");
  assert.equal(await bytes(join(transient.targetRuntime, "node.exe")), Buffer.from("new-runtime\u0000bytes").toString("hex"));
  assert.equal(await readFile(join(transient.targetPlugins, "manifest.json"), "utf8"), "new-plugin\n");
  await assertNoTransactionBackups(transient.envelope);

  const retained = await fixture("deferred-cleanup");
  const retainedResult = await replaceStageDirectoriesTransactionally(retained.replacements, {
    envelopeRoot: retained.envelope,
    transactionLabel: "retained",
    fsOps: {
      rm: async (path, options) => {
        if (basename(path).startsWith(".editkin-stage-backup-")) {
          throw Object.assign(new Error("simulated old executable lock"), { code: "EBUSY" });
        }
        return rm(path, options);
      },
    },
  });
  assert.equal(retainedResult.status, "COMMITTED_BACKUP_RETAINED");
  assert(retainedResult.cleanupPending?.backupRoot);
  assert.equal(await bytes(join(retained.targetRuntime, "node.exe")), Buffer.from("new-runtime\u0000bytes").toString("hex"));
  assert.equal(await readFile(join(retained.targetPlugins, "manifest.json"), "utf8"), "new-plugin\n");

  process.stdout.write(`${JSON.stringify({
    status: "GREEN",
    canonicalRuntimeTouched: false,
    productionEntrypointWired: true,
    detected: [
      "missing-source-before-mutation",
      "locked-target-byte-identical-rollback",
      "mid-install-byte-identical-rollback",
      "clean-commit",
      "transient-windows-rename-retried",
      "locked-old-backup-retained-after-complete-commit",
    ],
  })}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
