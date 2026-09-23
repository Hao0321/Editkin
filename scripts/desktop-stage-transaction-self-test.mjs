import { strict as assert } from "node:assert";
import { rename as nativeRename, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  assertDesktopStageReplacementTarget,
  createIsolatedDesktopCandidateEnvelope,
  resolveDesktopStageTarget,
} from "./lib/desktop-stage-target-policy.mjs";
import {
  TransactionalStageReplacementError,
  replaceStageDirectoriesTransactionally,
} from "./lib/transactional-stage-replace.mjs";

const root = await mkdtemp(join(tmpdir(), "editkin-desktop-stage-transaction-"));
const productionStageSource = await readFile(resolve(import.meta.dirname, "stage-desktop-resources.mjs"), "utf8");
const forgeConfigSource = await readFile(resolve(import.meta.dirname, "../forge.config.cjs"), "utf8");
const auditConfig = JSON.parse(await readFile(resolve(import.meta.dirname, "../audit.config.json"), "utf8"));
assert.match(productionStageSource, /replaceStageDirectoriesTransactionally\(\s*\[\[stagingRoot, envelopeRoot\]\]/u);
assert.match(productionStageSource, /GREEN_ISOLATED_DESKTOP_CANDIDATE_STAGE/u);
assert.match(productionStageSource, /COPYFILE_EXCL/u);
assert.match(productionStageSource, /createIsolatedDesktopCandidateEnvelope/u);
assert.doesNotMatch(productionStageSource, /rm\(\s*envelopeRoot\s*,/u);
assert.match(forgeConfigSource, /\.desktop-product-release-candidates/u);
assert(auditConfig.exclude.includes(".desktop-product-release-candidates/**"));

const policyFixtureRoot = resolve(root, "policy");
await mkdir(policyFixtureRoot);
const canonicalStage = resolveDesktopStageTarget(policyFixtureRoot);
assert.equal(canonicalStage.targetRoot, resolve(policyFixtureRoot, ".desktop-resources/runtime"));
assert.equal(canonicalStage.candidateTarget, false);
const candidateStage = resolveDesktopStageTarget(
  policyFixtureRoot,
  ".desktop-product-release-candidates/candidate-0123/runtime",
);
assert.equal(candidateStage.candidateTarget, true);
await createIsolatedDesktopCandidateEnvelope(candidateStage);
await assert.rejects(createIsolatedDesktopCandidateEnvelope(candidateStage), /must not already exist/u);
for (const invalid of [
  "runtime",
  ".desktop-resources/debug/runtime",
  ".desktop-product-release-candidates/runtime",
  ".desktop-product-release-candidates/candidate/nested/runtime",
  "../escaped/runtime",
]) {
  assert.throws(() => resolveDesktopStageTarget(policyFixtureRoot, invalid), /approved release roots/u);
}
assert.doesNotThrow(() => assertDesktopStageReplacementTarget(candidateStage.envelopeRoot, resolve(candidateStage.envelopeRoot, "plugins")));
assert.throws(
  () => assertDesktopStageReplacementTarget(candidateStage.envelopeRoot, resolve(candidateStage.envelopeRoot, "../outside")),
  /escaped its release envelope/u,
);

async function fixture(name) {
  const envelope = join(root, name);
  const target = join(envelope, ".desktop-resources");
  const staged = join(envelope, ".editkin-desktop-resources-stage-test");
  await mkdir(join(target, "runtime"), { recursive: true });
  await mkdir(join(staged, "runtime"), { recursive: true });
  await writeFile(join(target, "runtime", "BUILD-MANIFEST.json"), "old-manifest\n");
  await writeFile(join(target, "runtime", "hao-core.exe"), Buffer.from("old-core\0bytes"));
  await writeFile(join(staged, "runtime", "BUILD-MANIFEST.json"), "new-manifest\n");
  await writeFile(join(staged, "runtime", "hao-core.exe"), Buffer.from("new-core\0bytes"));
  return { envelope, target, staged };
}

async function contents(item, rootPath) {
  return {
    manifest: await readFile(join(rootPath, "runtime", "BUILD-MANIFEST.json"), "utf8"),
    core: Buffer.from(await readFile(join(rootPath, "runtime", "hao-core.exe"))).toString("hex"),
  };
}

async function assertNoBackups(envelope) {
  const entries = await readdir(envelope);
  assert.deepEqual(entries.filter((entry) => entry.startsWith(".editkin-stage-backup-")), []);
}

try {
  const backupFailure = await fixture("backup-failure");
  let backupFailureInjected = false;
  await assert.rejects(
    replaceStageDirectoriesTransactionally([[backupFailure.staged, backupFailure.target]], {
      envelopeRoot: backupFailure.envelope,
      transactionLabel: "desktop-backup-failure",
      fsOps: {
        rename: async (source, target) => {
          if (!backupFailureInjected && resolve(source) === resolve(backupFailure.target)
            && basename(target).startsWith("entry-")) {
            backupFailureInjected = true;
            throw Object.assign(new Error("simulated locked desktop target"), { code: "EBUSY" });
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
  assert.equal(backupFailureInjected, true);
  assert.deepEqual(await contents(backupFailure, backupFailure.target), {
    manifest: "old-manifest\n",
    core: Buffer.from("old-core\0bytes").toString("hex"),
  });
  assert.deepEqual(await contents(backupFailure, backupFailure.staged), {
    manifest: "new-manifest\n",
    core: Buffer.from("new-core\0bytes").toString("hex"),
  });
  await assertNoBackups(backupFailure.envelope);

  const installFailure = await fixture("install-failure");
  let installFailureInjected = false;
  await assert.rejects(
    replaceStageDirectoriesTransactionally([[installFailure.staged, installFailure.target]], {
      envelopeRoot: installFailure.envelope,
      transactionLabel: "desktop-install-failure",
      fsOps: {
        rename: async (source, target) => {
          if (!installFailureInjected && resolve(source) === resolve(installFailure.staged)
            && resolve(target) === resolve(installFailure.target)) {
            installFailureInjected = true;
            throw Object.assign(new Error("simulated desktop install failure"), { code: "EIO" });
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
  assert.deepEqual(await contents(installFailure, installFailure.target), {
    manifest: "old-manifest\n",
    core: Buffer.from("old-core\0bytes").toString("hex"),
  });
  assert.deepEqual(await contents(installFailure, installFailure.staged), {
    manifest: "new-manifest\n",
    core: Buffer.from("new-core\0bytes").toString("hex"),
  });
  await assertNoBackups(installFailure.envelope);

  const success = await fixture("success");
  const result = await replaceStageDirectoriesTransactionally([[success.staged, success.target]], {
    envelopeRoot: success.envelope,
    transactionLabel: "desktop-success",
  });
  assert.equal(result.status, "COMMITTED_CLEAN");
  assert.equal(result.cleanupPending, null);
  assert.deepEqual(await contents(success, success.target), {
    manifest: "new-manifest\n",
    core: Buffer.from("new-core\0bytes").toString("hex"),
  });
  await assertNoBackups(success.envelope);

  const deferredCleanup = await fixture("deferred-cleanup");
  const deferredResult = await replaceStageDirectoriesTransactionally([[deferredCleanup.staged, deferredCleanup.target]], {
    envelopeRoot: deferredCleanup.envelope,
    transactionLabel: "desktop-deferred-cleanup",
    fsOps: {
      rm: async (path, options) => {
        if (basename(path).startsWith(".editkin-stage-backup-")) {
          throw Object.assign(new Error("simulated old desktop resource lock"), { code: "EBUSY" });
        }
        return rm(path, options);
      },
    },
  });
  assert.equal(deferredResult.status, "COMMITTED_BACKUP_RETAINED");
  assert(deferredResult.cleanupPending?.backupRoot);
  assert.deepEqual(await contents(deferredCleanup, deferredCleanup.target), {
    manifest: "new-manifest\n",
    core: Buffer.from("new-core\0bytes").toString("hex"),
  });

  process.stdout.write(`${JSON.stringify({
    status: "GREEN",
    canonicalDesktopResourcesTouched: false,
    productionEntrypointWired: true,
    detected: [
      "bounded-canonical-and-isolated-candidate-targets",
      "candidate-path-escape-and-nesting-rejected",
      "locked-target-byte-identical-rollback",
      "mid-install-byte-identical-rollback",
      "clean-commit",
      "locked-old-backup-retained-after-complete-commit",
    ],
  })}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
