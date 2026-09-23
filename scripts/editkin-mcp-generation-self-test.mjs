import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import {
  cp,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, delimiter, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  activateMcpGeneration,
  applySnapshotRuntimeBindings,
  EDITKIN_RELEASE_RUNTIME_FILES,
  inspectMcpGenerationCandidate,
  launchActiveMcpGeneration,
  verifyActiveMcpGeneration,
  verifyVendorNodeIdentity,
} from "./lib/editkin-mcp-generation-runtime.mjs";
import { canonicalJson, hashBytes } from "./lib/editkin-mcp-generation-contract.mjs";
import {
  assertProcessGone,
  childEvents,
  decodePayload,
  encodePayload,
  inventoryFixtureTree,
  mutateAndRestore,
  runFixtureBootstrap,
  runOwnedProcess,
  runUnownedRuntimeProbe,
  sha256File,
} from "./lib/editkin-mcp-generation-test-harness.mjs";

const SELF_PATH = fileURLToPath(import.meta.url);
const FIXTURE_CHILD_FLAG = "--fixture-child";
const UNOWNED_PROBE_FLAG = "--unowned-runtime-probe";

if (process.argv[2] === UNOWNED_PROBE_FLAG) {
  if (process.argv.length !== 4) throw new Error("Unowned runtime probe requires one bounded payload");
  await runUnownedRuntimeProbe(process.argv[3]);
  process.exit(0);
}

if (process.argv[2] !== FIXTURE_CHILD_FLAG) {
  process.exit(await runFixtureBootstrap(SELF_PATH, FIXTURE_CHILD_FLAG));
}
if (process.argv.length !== 4) throw new Error("Fixture child requires one bounded payload");
const fixturePayload = decodePayload(process.argv[3]);
if (typeof fixturePayload.root !== "string" || !isAbsolute(fixturePayload.root)
  || !basename(fixturePayload.root).startsWith("editkin-mcp-snapshot-")) {
  throw new Error("Fixture child root is invalid");
}
const fixtureRoot = resolve(fixturePayload.root);
const appRoot = resolve(fixtureRoot, "Editkin App");
const stateRoot = resolve(appRoot, "src-tauri/target-product-generations/editkin-mcp-runtime-v3");
const vendorRoot = resolve(appRoot, "vendor/node/win32-x64");
const vendorNode = resolve(vendorRoot, "node.exe");
const nodeSha256 = await sha256File(vendorNode);
const nodeManifest = JSON.parse(await readFile(resolve(vendorRoot, "manifest.json"), "utf8"));
const ids = {
  one: "candidate-1111111111111111",
  two: "candidate-2222222222222222",
  three: "candidate-3333333333333333",
  mutating: "candidate-4444444444444444",
  linked: "candidate-5555555555555555",
  slow: "candidate-6666666666666666",
  hanging: "candidate-7777777777777777",
  copyCrash: "candidate-8888888888888888",
  commitFail: "candidate-9999999999999999",
  pointerFail: "candidate-aaaaaaaaaaaaaaaa",
};
const controls = [];

async function expectRejected(name, action, matcher) {
  await assert.rejects(action, matcher);
  controls.push(name);
}

async function writeCandidate(candidateId, marker, { largeAssetBytes = 0 } = {}) {
  const envelope = resolve(appRoot, "src-tauri/product-release-candidates", candidateId);
  const runtime = resolve(envelope, "runtime");
  await mkdir(runtime, { recursive: true });
  for (const name of EDITKIN_RELEASE_RUNTIME_FILES) {
    let bytes = Buffer.from(`fixture:${candidateId}:${name}`);
    const target = resolve(runtime, name);
    if (name === "node.exe") {
      await link(vendorNode, target);
      continue;
    }
    if (name === "NODE-MANIFEST.json") bytes = Buffer.from(canonicalJson(nodeManifest));
    if (name === "mcp.mjs") bytes = Buffer.from(`globalThis.__EDITKIN_MCP_SNAPSHOT_TEST__ = ${JSON.stringify(marker)};\n`);
    if (name === "mcp.mjs.material-color-identity.json") {
      const entrypoint = Buffer.from(`globalThis.__EDITKIN_MCP_SNAPSHOT_TEST__ = ${JSON.stringify(marker)};\n`);
      bytes = Buffer.from(JSON.stringify({ schema: "editkin.material-color-bundle/v1", bundle: { file: "mcp.mjs", size: entrypoint.length, sha256: hashBytes(entrypoint) }, implementations: [{ name: "fixture.ts", sha256: "a".repeat(64) }] }));
    }
    await writeFile(target, bytes);
  }
  const assetFiles = {
    "creative-packs/hao-creator-library/cards/fixture.json": `creative:${marker}`,
    "personal-packs/hao-music-library/audio/fixture.txt": `personal:${marker}`,
    "font-packs/editkin-open-fonts/files/fixture.txt": `font:${marker}`,
    "color/aces2/luts/fixture.txt": `color:${marker}`,
    "plugins/builtin/fixture.txt": `plugin:${marker}`,
  };
  for (const [relation, value] of Object.entries(assetFiles)) {
    const path = resolve(envelope, ...relation.split("/"));
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, value);
  }
  if (largeAssetBytes > 0) {
    await writeFile(
      resolve(envelope, "creative-packs/hao-creator-library/cards/slow.bin"),
      Buffer.alloc(largeAssetBytes, marker.charCodeAt(0)),
    );
  }
  return { envelope, runtime, assetFiles };
}

function generationFile(active, relation) {
  return resolve(active.contentRoot, ...relation.split("/"));
}

try {
  assert.equal(await realpath(process.execPath), await realpath(vendorNode));
  assert.equal(nodeManifest.nodeExeSha256, nodeSha256);
  const candidates = {};
  for (const [name, candidateId] of Object.entries(ids)) {
    candidates[name] = await writeCandidate(candidateId, `generation-${name}`, {
      largeAssetBytes: name === "slow" || name === "hanging" ? 3 * 1024 * 1024 : 0,
    });
  }

  const vendor = await verifyVendorNodeIdentity({ appRoot, execPath: vendorNode });
  assert.equal(vendor.sha256, nodeSha256);
  controls.push("pinned-vendor-node-path-and-hash");

  const missingState = resolve(appRoot, "src-tauri/target-product-generations/missing");
  await expectRejected(
    "missing-state-fails-without-creating-fallback",
    () => verifyActiveMcpGeneration({ appRoot, stateRoot: missingState }),
    /ENOENT|no such file/u,
  );
  await assert.rejects(() => lstat(missingState), /ENOENT|no such file/u);

  const guardRoot = resolve(appRoot, "state-path-guard-fixtures");
  const outsideGuardRoot = resolve(fixtureRoot, "outside-state-path-guard-fixtures");
  await mkdir(guardRoot);
  await mkdir(outsideGuardRoot);
  for (const name of ["state-target", "ancestor-target", "generations-target", "alias-app"]) {
    const target = resolve(outsideGuardRoot, name);
    await mkdir(resolve(target, "sentinel-directory"), { recursive: true });
    await writeFile(resolve(target, "sentinel-directory/keep.bin"), Buffer.from([0, 17, 128, 255]));
    await writeFile(resolve(target, "keep.txt"), `unchanged:${name}\n`);
  }
  const stateJunction = resolve(guardRoot, "state-junction");
  const ancestorJunction = resolve(guardRoot, "ancestor-junction");
  const generationsJunctionState = resolve(guardRoot, "generations-junction-state");
  const appAlias = resolve(guardRoot, "app-alias");
  const regularFileAncestor = resolve(guardRoot, "regular-file-ancestor");
  await symlink(resolve(outsideGuardRoot, "state-target"), stateJunction, "junction");
  await symlink(resolve(outsideGuardRoot, "ancestor-target"), ancestorJunction, "junction");
  await mkdir(generationsJunctionState);
  await symlink(resolve(outsideGuardRoot, "generations-target"), resolve(generationsJunctionState, "generations"), "junction");
  await symlink(resolve(outsideGuardRoot, "alias-app"), appAlias, "junction");
  await writeFile(regularFileAncestor, "must remain a regular file\n");
  const statePathGuards = [
    ["preexisting-state-root-junction", appRoot, stateJunction, /regular directory|junction|reparse/u],
    ["ancestor-junction-with-missing-state-child", appRoot, resolve(ancestorJunction, "missing-state"), /regular directory|junction|reparse/u],
    ["generations-directory-junction", appRoot, generationsJunctionState, /regular directory|junction|reparse/u],
    ["app-root-alias", appAlias, resolve(appAlias, "missing-state"), /regular directory|junction|reparse/u],
    ["regular-file-ancestor", appRoot, resolve(regularFileAncestor, "missing-state"), /regular directory|ENOTDIR/u],
    ["outside-app-state-root", appRoot, resolve(outsideGuardRoot, "missing-state"), /strict descendant|inside|escape/u],
  ];
  for (const [name, guardedAppRoot, guardedStateRoot, matcher] of statePathGuards) {
    const beforeOutside = await inventoryFixtureTree(outsideGuardRoot);
    const beforeInside = await inventoryFixtureTree(guardRoot);
    const events = childEvents();
    await expectRejected(`${name}-rejected-before-any-write-or-child`, () => activateMcpGeneration(ids.one, {
      expectedCurrentPointerIdentity: null,
      appRoot: guardedAppRoot,
      stateRoot: guardedStateRoot,
      preflightSupervisorHooks: events.hooks,
    }), matcher);
    assert.equal(events.spawned.length, 0, `${name} started a preflight child`);
    assert.deepEqual(await inventoryFixtureTree(outsideGuardRoot), beforeOutside, `${name} changed outside names or bytes`);
    assert.deepEqual(await inventoryFixtureTree(guardRoot), beforeInside, `${name} changed guarded names or bytes`);
  }

  const injectionChild = childEvents();
  await expectRejected(
    "shell-metacharacter-candidate-rejected-before-child-spawn",
    () => inspectMcpGenerationCandidate("candidate-1111111111111111;whoami", {
      appRoot,
      supervisorHooks: injectionChild.hooks,
    }),
    /Candidate ID/u,
  );
  assert.equal(injectionChild.spawned.length, 0);

  const versionChild = childEvents();
  await writeFile(resolve(vendorRoot, "manifest.json"), canonicalJson({ ...nodeManifest, version: "22.0.0" }));
  await expectRejected(
    "worker-running-node-version-mismatch-rejected-inside-watchdog",
    () => inspectMcpGenerationCandidate(ids.one, { appRoot, supervisorHooks: versionChild.hooks }),
    /worker Node version differs/u,
  );
  assert.equal(versionChild.spawned.length, 1);
  assert.equal(versionChild.exits.length, 1);
  assert.equal(versionChild.terminationRequests.length, 0);
  assertProcessGone(versionChild.spawned[0].pid);
  await writeFile(resolve(vendorRoot, "manifest.json"), canonicalJson(nodeManifest));

  for (const timeoutMs of [1, 100]) {
    const deadlineChild = childEvents();
    const startedAt = Date.now();
    await expectRejected(
      `total-api-deadline-${timeoutMs}ms-returns-stable-timeout`,
      () => inspectMcpGenerationCandidate(ids.one, {
        appRoot,
        preflightTimeoutMs: timeoutMs,
        supervisorHooks: deadlineChild.hooks,
      }),
      (error) => error?.code === "EDITKIN_MCP_PREFLIGHT_TIMEOUT",
    );
    const elapsedMs = Date.now() - startedAt;
    assert(elapsedMs <= timeoutMs + 500, `${timeoutMs}ms total deadline took ${elapsedMs}ms`);
    if (deadlineChild.spawned.length === 1) {
      assert.equal(deadlineChild.exits.length, 1);
      assertProcessGone(deadlineChild.spawned[0].pid);
    }
  }

  const identityHangChild = childEvents();
  await expectRejected(
    "worker-identity-read-and-close-hang-terminated-by-total-deadline",
    () => inspectMcpGenerationCandidate(ids.one, {
      appRoot,
      preflightTimeoutMs: 1_200,
      preflightFault: "worker-identity-read-close-hang",
      supervisorHooks: identityHangChild.hooks,
    }),
    (error) => error?.code === "EDITKIN_MCP_PREFLIGHT_TIMEOUT"
      && error?.details?.terminated === true,
  );
  assert.equal(identityHangChild.spawned.length, 1);
  assert.equal(identityHangChild.terminationRequests.length, 1);
  assert.equal(identityHangChild.exits.length, 1);
  assert.match(
    identityHangChild.stderr.join(""),
    /EDITKIN_PREFLIGHT_TEST_FAULT:worker-identity-read-close-hang:mid-hash-real-read-started/u,
  );
  assertProcessGone(identityHangChild.spawned[0].pid);
  controls.push("parent-performs-no-filesystem-identity-io-before-worker-watchdog");
  controls.push("worker-identity-hash-close-hang-has-no-orphan");

  const inspected = await inspectMcpGenerationCandidate(ids.one, { appRoot });
  assert(inspected.manifest.files.length > EDITKIN_RELEASE_RUNTIME_FILES.length);
  assert(inspected.preflightMs < 5_000, `Fixture preflight exceeded 5000ms: ${inspected.preflightMs}ms`);
  controls.push("candidate-complete-inventory-preflight-is-read-only");
  controls.push("bounded-concurrency-fixture-preflight-under-5000ms");

  const packetMutationControls = [
    ["packet-extra-key", /success packet has an unexpected closed-world field set/u],
    ["result-extra-key", /worker result has an unexpected closed-world field set/u],
    ["result-status-spoof", /result status is invalid/u],
    ["result-entrypoint-spoof", /invalid entrypoint identity/u],
    ["result-vendor-spoof", /spoofed vendor Node identity/u],
    ["packet-nonce-spoof", /not bound to this request/u],
  ];
  for (const [fault, matcher] of packetMutationControls) {
    await expectRejected(
      `${fault}-rejected-by-parent-closed-world-validator`,
      () => inspectMcpGenerationCandidate(ids.one, { appRoot, preflightFault: fault }),
      matcher,
    );
  }

  const systemNode20 = "C:\\Program Files\\nodejs\\node.exe";
  try {
    await lstat(systemNode20);
    const systemVersion = await runOwnedProcess(systemNode20, ["--version"], 10_000);
    if (systemVersion.code === 0 && /^v20\./u.test(systemVersion.stdout.trim())) {
      const probe = await runOwnedProcess(systemNode20, [
        SELF_PATH,
        UNOWNED_PROBE_FLAG,
        encodePayload({ appRoot, candidateId: ids.one }),
      ], 10_000);
      assert.equal(probe.timedOut, false);
      assert.equal(probe.code, 0, probe.stderr);
      const packet = JSON.parse(probe.stdout);
      assert.equal(canonicalJson(packet), probe.stdout);
      assert.deepEqual(packet, { spawned: 0, status: "GREEN_UNOWNED_RUNTIME_REJECTED" });
      controls.push("unowned-system-node20-rejected-before-worker-spawn");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const slowChild = childEvents();
  await expectRejected(
    "slow-mid-hash-read-aborted-by-worker-cooperative-deadline",
    () => inspectMcpGenerationCandidate(ids.slow, {
      appRoot,
      preflightTimeoutMs: 2_000,
      preflightFault: "slow-read",
      supervisorHooks: slowChild.hooks,
    }),
    (error) => error?.code === "EDITKIN_MCP_PREFLIGHT_TIMEOUT",
  );
  assert.equal(slowChild.spawned.length, 1);
  assert.equal(slowChild.terminationRequests.length, 0);
  assert.equal(slowChild.exits.length, 1);
  assert.equal(slowChild.exits[0].timedOut, false);
  assert.match(slowChild.stderr.join(""), /EDITKIN_PREFLIGHT_TEST_FAULT:slow-read:mid-hash-real-read-started/u);
  assertProcessGone(slowChild.spawned[0].pid);
  controls.push("slow-worker-cooperative-timeout-closes-child-without-supervisor-kill");
  controls.push("cooperatively-timed-out-worker-has-no-orphan");

  const timeoutStateRoot = resolve(appRoot, "src-tauri/target-product-generations/timeout-fixture");
  const hangingChild = childEvents();
  await expectRejected(
    "pending-read-and-close-hang-returns-stable-process-timeout-code",
    () => activateMcpGeneration(ids.hanging, {
      expectedCurrentPointerIdentity: null,
      appRoot,
      stateRoot: timeoutStateRoot,
      preflightTimeoutMs: 1_200,
      preflightFault: "pending-read-close-hang",
      preflightSupervisorHooks: hangingChild.hooks,
    }),
    (error) => error?.code === "EDITKIN_MCP_PREFLIGHT_TIMEOUT"
      && error?.details?.terminated === true
      && error?.details?.childPid === hangingChild.spawned[0]?.pid,
  );
  assert.equal(hangingChild.spawned.length, 1);
  assert.equal(hangingChild.terminationRequests.length, 1);
  assert.equal(hangingChild.terminationRequests[0].terminationRequested, true);
  assert.equal(hangingChild.exits.length, 1);
  assert.equal(hangingChild.exits[0].timedOut, true);
  assert.match(hangingChild.stderr.join(""), /EDITKIN_PREFLIGHT_TEST_FAULT:pending-read-close-hang:mid-hash-real-read-started/u);
  assertProcessGone(hangingChild.spawned[0].pid);
  controls.push("child-process-hard-deadline-terminates-close-hung-worker");
  controls.push("hard-timed-out-worker-has-no-orphan");
  assert.deepEqual(await readdir(timeoutStateRoot), ["generations"]);
  assert.deepEqual(await readdir(resolve(timeoutStateRoot, "generations")), []);
  for (const residue of ["ACTIVATION.lock", "ACTIVE-GENERATION.json"]) {
    await assert.rejects(() => lstat(resolve(timeoutStateRoot, residue)), /ENOENT|no such file/u);
  }
  controls.push("timeout-activation-leaves-no-stage-lock-or-pointer-residue");

  const outside = resolve(fixtureRoot, "outside-junction-target");
  const sourceJunction = resolve(candidates.linked.envelope, "creative-packs/hao-creator-library/cards/nested-junction");
  await mkdir(outside, { recursive: true });
  await writeFile(resolve(outside, "outside.txt"), "outside");
  await symlink(outside, sourceJunction, "junction");
  await expectRejected(
    "nested-candidate-junction-rejected",
    () => inspectMcpGenerationCandidate(ids.linked, { appRoot }),
    /symlink|junction|reparse/u,
  );
  await unlink(sourceJunction);

  const orphanStateRoot = resolve(appRoot, "src-tauri/target-product-generations/copy-crash-fixture-v3");
  let incompleteRoot;
  let incompleteTarget;
  await expectRejected(
    "mid-copy-crash-leaves-only-an-incomplete-unselected-instance",
    () => activateMcpGeneration(ids.copyCrash, {
      expectedCurrentPointerIdentity: null,
      appRoot,
      stateRoot: orphanStateRoot,
      hooks: {
        afterSnapshotFileCopied: async ({ generationRoot, index, target }) => {
          if (index !== 1) return;
          incompleteRoot = generationRoot;
          incompleteTarget = target;
          throw new Error("simulated mid-copy crash");
        },
      },
    }),
    /simulated mid-copy crash/u,
  );
  assert(incompleteRoot && incompleteTarget);
  await assert.rejects(
    () => lstat(resolve(orphanStateRoot, "ACTIVE-GENERATION.json")),
    /ENOENT|no such file/u,
  );
  assert.deepEqual(await readdir(resolve(orphanStateRoot, "generations")), [basename(incompleteRoot)]);
  const lockedOrphanHandle = await open(incompleteTarget, "r");
  let retryAfterCopyCrash;
  try {
    retryAfterCopyCrash = await activateMcpGeneration(ids.copyCrash, {
      expectedCurrentPointerIdentity: null,
      appRoot,
      stateRoot: orphanStateRoot,
    });
    assert.equal(retryAfterCopyCrash.generationCreated, true);
    assert.notEqual(retryAfterCopyCrash.generationRoot, incompleteRoot);
    await lstat(incompleteRoot);
  } finally {
    await lockedOrphanHandle.close();
  }
  assert.equal((await readdir(resolve(orphanStateRoot, "generations"))).length, 2);
  await verifyActiveMcpGeneration({ appRoot, stateRoot: orphanStateRoot });
  controls.push("mid-copy-orphan-is-ignored-and-retry-never-deletes-locked-orphan");

  const commitFailureStateRoot = resolve(appRoot, "src-tauri/target-product-generations/commit-failure-fixture-v3");
  await expectRejected(
    "commit-marker-publication-failure-never-selects-incomplete-instance",
    () => activateMcpGeneration(ids.commitFail, {
      expectedCurrentPointerIdentity: null,
      appRoot,
      stateRoot: commitFailureStateRoot,
      renameRetries: 0,
      renamePath: async (source, target) => {
        if (basename(target) === "GENERATION-COMMITTED.json") {
          throw Object.assign(new Error("simulated commit marker lock"), { code: "EBUSY" });
        }
        return rename(source, target);
      },
    }),
    /simulated commit marker lock/u,
  );
  const [missingCommitDirectory] = await readdir(resolve(commitFailureStateRoot, "generations"));
  const missingCommitRoot = resolve(commitFailureStateRoot, "generations", missingCommitDirectory);
  const missingCommitManifestBytes = await readFile(resolve(missingCommitRoot, "GENERATION-MANIFEST.json"));
  const missingCommitManifest = JSON.parse(missingCommitManifestBytes);
  await writeFile(resolve(commitFailureStateRoot, "ACTIVE-GENERATION.json"), canonicalJson({
    schemaVersion: 3,
    kind: "editkin-mcp-runtime-pointer",
    commitSha256: "0".repeat(64),
    generationDirectoryName: missingCommitDirectory,
    generationId: missingCommitManifest.generationId,
    generationManifestSha256: hashBytes(missingCommitManifestBytes),
    selectionRevision: "0".repeat(32),
  }));
  await expectRejected(
    "pointer-cannot-activate-instance-with-missing-commit-marker",
    () => verifyActiveMcpGeneration({ appRoot, stateRoot: commitFailureStateRoot }),
    /ENOENT|no such file|unexpected entry/u,
  );
  await rm(resolve(commitFailureStateRoot, "ACTIVE-GENERATION.json"), { force: true });
  const retryAfterCommitFailure = await activateMcpGeneration(ids.commitFail, {
    expectedCurrentPointerIdentity: null,
    appRoot,
    stateRoot: commitFailureStateRoot,
  });
  assert.equal(retryAfterCommitFailure.generationCreated, true);
  assert.notEqual(retryAfterCommitFailure.generationDirectoryName, missingCommitDirectory);
  assert.equal((await readdir(resolve(commitFailureStateRoot, "generations"))).length, 2);
  controls.push("missing-commit-instance-is-never-activated-or-reused");

  const pointerFailureStateRoot = resolve(appRoot, "src-tauri/target-product-generations/pointer-failure-fixture-v3");
  await expectRejected(
    "pointer-publication-failure-leaves-a-valid-inactive-committed-instance",
    () => activateMcpGeneration(ids.pointerFail, {
      expectedCurrentPointerIdentity: null,
      appRoot,
      stateRoot: pointerFailureStateRoot,
      renameRetries: 0,
      renamePath: async (source, target) => {
        if (basename(target) === "ACTIVE-GENERATION.json") {
          throw Object.assign(new Error("simulated pointer lock"), { code: "EBUSY" });
        }
        return rename(source, target);
      },
    }),
    /simulated pointer lock/u,
  );
  const [inactiveCommittedDirectory] = await readdir(resolve(pointerFailureStateRoot, "generations"));
  const inactiveCommittedRoot = resolve(pointerFailureStateRoot, "generations", inactiveCommittedDirectory);
  const commitPath = resolve(inactiveCommittedRoot, "GENERATION-COMMITTED.json");
  const validCommitBytes = await readFile(commitPath);
  await writeFile(commitPath, "{malformed-commit\n");
  const inactiveManifestBytes = await readFile(resolve(inactiveCommittedRoot, "GENERATION-MANIFEST.json"));
  const inactiveManifest = JSON.parse(inactiveManifestBytes);
  await writeFile(resolve(pointerFailureStateRoot, "ACTIVE-GENERATION.json"), canonicalJson({
    schemaVersion: 3,
    kind: "editkin-mcp-runtime-pointer",
    commitSha256: hashBytes("{malformed-commit\n"),
    generationDirectoryName: inactiveCommittedDirectory,
    generationId: inactiveManifest.generationId,
    generationManifestSha256: hashBytes(inactiveManifestBytes),
    selectionRevision: "1".repeat(32),
  }));
  await expectRejected(
    "malformed-commit-marker-fails-closed",
    () => verifyActiveMcpGeneration({ appRoot, stateRoot: pointerFailureStateRoot }),
    /valid JSON/u,
  );
  await rm(resolve(pointerFailureStateRoot, "ACTIVE-GENERATION.json"), { force: true });
  await writeFile(commitPath, validCommitBytes);
  const retryAfterPointerFailure = await activateMcpGeneration(ids.pointerFail, {
    expectedCurrentPointerIdentity: null,
    appRoot,
    stateRoot: pointerFailureStateRoot,
  });
  assert.equal(retryAfterPointerFailure.generationCreated, false);
  assert.equal(retryAfterPointerFailure.generationDirectoryName, inactiveCommittedDirectory);
  assert.equal((await readdir(resolve(pointerFailureStateRoot, "generations"))).length, 1);
  controls.push("committed-inactive-instance-is-verified-and-reused-after-pointer-failure");

  const pointerFailureY = await activateMcpGeneration(ids.commitFail, {
    expectedCurrentPointerIdentity: retryAfterPointerFailure.pointerIdentity,
    appRoot,
    stateRoot: pointerFailureStateRoot,
  });
  const pointerFailureXAgain = await activateMcpGeneration(ids.pointerFail, {
    expectedCurrentPointerIdentity: pointerFailureY.pointerIdentity,
    appRoot,
    stateRoot: pointerFailureStateRoot,
  });
  assert.equal(pointerFailureXAgain.generationCreated, false);
  assert.equal(pointerFailureXAgain.generationDirectoryName, retryAfterPointerFailure.generationDirectoryName);
  assert.notEqual(pointerFailureXAgain.pointerIdentity, retryAfterPointerFailure.pointerIdentity);
  await expectRejected(
    "stale-pointer-identity-cannot-win-x-y-x-aba",
    () => activateMcpGeneration(ids.commitFail, {
      expectedCurrentPointerIdentity: retryAfterPointerFailure.pointerIdentity,
      appRoot,
      stateRoot: pointerFailureStateRoot,
    }),
    (error) => error?.code === "EDITKIN_MCP_GENERATION_CONFLICT",
  );
  assert.equal(
    (await verifyActiveMcpGeneration({ appRoot, stateRoot: pointerFailureStateRoot })).pointerSha256,
    pointerFailureXAgain.pointerIdentity,
  );
  controls.push("selection-revision-pointer-sha-prevents-x-y-x-aba");

  const duplicateDirectory = `${pointerFailureXAgain.generationId}--${"0".repeat(32)}`;
  const duplicateRoot = resolve(pointerFailureStateRoot, "generations", duplicateDirectory);
  await cp(pointerFailureXAgain.generationRoot, duplicateRoot, {
    recursive: true,
    force: false,
    errorOnExist: true,
  });
  const duplicateCommitPath = resolve(duplicateRoot, "GENERATION-COMMITTED.json");
  const duplicateCommit = {
    ...JSON.parse(await readFile(duplicateCommitPath, "utf8")),
    generationDirectoryName: duplicateDirectory,
  };
  await writeFile(duplicateCommitPath, canonicalJson(duplicateCommit));
  const duplicateSelection = await activateMcpGeneration(ids.pointerFail, {
    expectedCurrentPointerIdentity: pointerFailureXAgain.pointerIdentity,
    appRoot,
    stateRoot: pointerFailureStateRoot,
  });
  assert.equal(duplicateSelection.generationCreated, false);
  assert.equal(duplicateSelection.generationDirectoryName, duplicateDirectory);
  const duplicateActive = await verifyActiveMcpGeneration({ appRoot, stateRoot: pointerFailureStateRoot });
  assert.equal(duplicateActive.generationDirectoryName, duplicateDirectory);
  assert.equal(duplicateActive.pointer.commitSha256, hashBytes(canonicalJson(duplicateCommit)));
  controls.push("same-content-duplicate-instances-select-one-exact-committed-directory");

  const activationRenameTargets = [];
  const first = await activateMcpGeneration(ids.one, {
    expectedCurrentPointerIdentity: null,
    appRoot,
    stateRoot,
    renamePath: async (source, target) => {
      const sourceDetails = await lstat(source);
      assert(sourceDetails.isFile(), `Activation attempted a directory rename: ${source}`);
      assert(sourceDetails.size <= 4 * 1024, `Activation attempted to rename an oversized file: ${source}`);
      const targetName = basename(target);
      assert(
        ["GENERATION-COMMITTED.json", "ACTIVE-GENERATION.json"].includes(targetName),
        `Activation attempted an unexpected rename target: ${target}`,
      );
      activationRenameTargets.push(targetName);
      return rename(source, target);
    },
  });
  assert.equal(first.generationCreated, true);
  assert.equal(first.generationId, inspected.manifest.generationId);
  assert.deepEqual(activationRenameTargets, ["GENERATION-COMMITTED.json", "ACTIVE-GENERATION.json"]);
  let active = await verifyActiveMcpGeneration({ appRoot, stateRoot });
  assert.equal(active.pointerSha256, first.pointerIdentity);
  assert.equal(active.commitSha256, first.commitSha256);
  assert.equal(active.manifest.files.length, inspected.manifest.files.length);
  assert(active.manifest.directories.includes("plugins/builtin"));
  controls.push("full-content-addressed-snapshot-activated-and-verified");
  controls.push("activation-renames-only-small-files-never-generation-directories");

  await launchActiveMcpGeneration({
    appRoot,
    stateRoot,
    execPath: vendorNode,
    importModule: (url) => import(`${url}#${randomUUID()}`),
  });
  assert.equal(globalThis.__EDITKIN_MCP_SNAPSHOT_TEST__, "generation-one");
  assert(process.env.HAO_FFMPEG_PATH.startsWith(active.contentRoot));
  controls.push("verified-entrypoint-imported-from-data-url");

  const sourceMutationTargets = [
    "runtime/mcp.mjs",
    ...Object.keys(candidates.one.assetFiles),
  ];
  for (const relation of sourceMutationTargets) {
    await writeFile(resolve(candidates.one.envelope, ...relation.split("/")), `mutated-source:${relation}`);
  }
  await verifyActiveMcpGeneration({ appRoot, stateRoot });
  globalThis.__EDITKIN_MCP_SNAPSHOT_TEST__ = "reset";
  await launchActiveMcpGeneration({
    appRoot,
    stateRoot,
    execPath: vendorNode,
    importModule: (url) => import(`${url}#${randomUUID()}`),
  });
  assert.equal(globalThis.__EDITKIN_MCP_SNAPSHOT_TEST__, "generation-one");
  controls.push("candidate-mutation-after-activation-cannot-change-snapshot");

  const tamperClasses = {
    runtime: "runtime/ffmpeg.exe",
    creative: "creative-packs/hao-creator-library/cards/fixture.json",
    personal: "personal-packs/hao-music-library/audio/fixture.txt",
    font: "font-packs/editkin-open-fonts/files/fixture.txt",
    color: "color/aces2/luts/fixture.txt",
    plugins: "plugins/builtin/fixture.txt",
  };
  for (const [assetClass, relation] of Object.entries(tamperClasses)) {
    const path = generationFile(active, relation);
    await mutateAndRestore(path, async (original) => {
      await writeFile(path, Buffer.concat([original, Buffer.from("tamper")]));
      await expectRejected(
        `tampered-${assetClass}-snapshot-file-rejected`,
        () => verifyActiveMcpGeneration({ appRoot, stateRoot }),
        /complete manifest inventory/u,
      );
    });
  }

  const snapshotEntrypoint = generationFile(active, "runtime/mcp.mjs");
  await mutateAndRestore(snapshotEntrypoint, async () => {
    globalThis.__EDITKIN_MCP_SNAPSHOT_TEST__ = "reset";
    await assert.rejects(launchActiveMcpGeneration({
      appRoot,
      stateRoot,
      execPath: vendorNode,
      hooks: {
        afterVerification: async () => writeFile(snapshotEntrypoint, "throw new Error('tampered-after-verify');\n"),
      },
      importModule: (url) => import(`${url}#${randomUUID()}`),
    }), /material-color.*(?:identity|drift)/u);
    assert.equal(globalThis.__EDITKIN_MCP_SNAPSHOT_TEST__, "reset");
  });
  controls.push("entrypoint-check-use-window-live-drift-rejected-before-verified-data-import");

  const roamingPlugins = resolve(fixtureRoot, "Roaming/Editkin/plugins");
  const appPlugins = resolve(appRoot, "plugins");
  const legacyPlugins = resolve(appRoot, ".desktop-resources/plugins");
  await Promise.all([mkdir(roamingPlugins, { recursive: true }), mkdir(appPlugins, { recursive: true }), mkdir(legacyPlugins, { recursive: true })]);
  const externalRoots = [
    generationFile(active, "plugins"),
    appPlugins,
    legacyPlugins,
    resolve(candidates.two.envelope, "plugins"),
    roamingPlugins,
    roamingPlugins,
  ].join(delimiter);
  const merged = await applySnapshotRuntimeBindings(active, { appRoot, externalPluginRoots: externalRoots });
  assert.deepEqual(merged.roots, [generationFile(active, "plugins"), await realpath(roamingPlugins)]);
  assert(merged.rejected.filter(({ reason }) => reason === "app-owned").length >= 4);
  controls.push("plugin-roots-merge-dedupe-and-filter-all-app-owned-legacy-paths");

  let releaseFirstLock;
  let announceFirstLock;
  const firstLockHeld = new Promise((resolveHeld) => { announceFirstLock = resolveHeld; });
  const releaseLock = new Promise((resolveRelease) => { releaseFirstLock = resolveRelease; });
  const activatingTwo = activateMcpGeneration(ids.two, {
    expectedCurrentPointerIdentity: first.pointerIdentity,
    appRoot,
    stateRoot,
    hooks: { afterLock: async () => { announceFirstLock(); await releaseLock; } },
  });
  await firstLockHeld;
  await expectRejected(
    "concurrent-activator-rejected-by-exclusive-lock",
    () => activateMcpGeneration(ids.three, {
      expectedCurrentPointerIdentity: first.pointerIdentity,
      appRoot,
      stateRoot,
    }),
    (error) => error?.code === "EDITKIN_MCP_GENERATION_LOCKED",
  );
  releaseFirstLock();
  const second = await activatingTwo;
  active = await verifyActiveMcpGeneration({ appRoot, stateRoot });
  assert.equal(active.manifest.generationId, second.generationId);

  const secondPointerBytes = await readFile(active.pointerPath);
  await expectRejected(
    "compare-and-swap-mismatch-preserves-pointer",
    () => activateMcpGeneration(ids.three, {
      expectedCurrentPointerIdentity: first.pointerIdentity,
      appRoot,
      stateRoot,
    }),
    (error) => error?.code === "EDITKIN_MCP_GENERATION_CONFLICT",
  );
  assert.deepEqual(await readFile(active.pointerPath), secondPointerBytes);

  await expectRejected(
    "locked-pointer-rename-fails-without-changing-selection",
    () => activateMcpGeneration(ids.three, {
      expectedCurrentPointerIdentity: second.pointerIdentity,
      appRoot,
      stateRoot,
      renameRetries: 1,
      retryDelayMs: 0,
      renamePath: async (source, target) => {
        if (basename(target) === "ACTIVE-GENERATION.json") throw Object.assign(new Error("simulated locked pointer"), { code: "EBUSY" });
        return rename(source, target);
      },
    }),
    /simulated locked pointer/u,
  );
  assert.deepEqual(await readFile(active.pointerPath), secondPointerBytes);

  await expectRejected(
    "post-verify-generation-conflict-is-reported",
    () => activateMcpGeneration(ids.three, {
      expectedCurrentPointerIdentity: second.pointerIdentity,
      appRoot,
      stateRoot,
      hooks: { afterPointerWrite: async ({ pointerPath }) => writeFile(pointerPath, secondPointerBytes) },
    }),
    (error) => error?.code === "EDITKIN_MCP_GENERATION_CONFLICT"
      && error?.details?.pointerReplacementCompleted === true,
  );
  assert.deepEqual(await readFile(active.pointerPath), secondPointerBytes);

  const pointerBeforeMutation = await readFile(active.pointerPath);
  await expectRejected(
    "candidate-mutation-during-copy-aborts-before-pointer",
    () => activateMcpGeneration(ids.mutating, {
      expectedCurrentPointerIdentity: second.pointerIdentity,
      appRoot,
      stateRoot,
      hooks: {
        afterCandidateCopied: async () => writeFile(
          resolve(candidates.mutating.envelope, "creative-packs/hao-creator-library/cards/fixture.json"),
          "mutated-during-copy",
        ),
      },
    }),
    /changed while its generation snapshot/u,
  );
  assert.deepEqual(await readFile(active.pointerPath), pointerBeforeMutation);

  const snapshotJunction = generationFile(active, "plugins/nested-junction");
  await symlink(outside, snapshotJunction, "junction");
  await expectRejected(
    "nested-snapshot-junction-rejected",
    () => verifyActiveMcpGeneration({ appRoot, stateRoot }),
    /symlink|junction|reparse/u,
  );
  await unlink(snapshotJunction);

  const hardlinkedSnapshotFile = generationFile(active, "plugins/builtin/fixture.txt");
  const hardlinkSource = resolve(fixtureRoot, "generation-hardlink-source.txt");
  const hardlinkedOriginal = await readFile(hardlinkedSnapshotFile);
  await writeFile(hardlinkSource, hardlinkedOriginal);
  await rm(hardlinkedSnapshotFile);
  await link(hardlinkSource, hardlinkedSnapshotFile);
  await expectRejected(
    "multiply-linked-generation-content-file-rejected",
    () => verifyActiveMcpGeneration({ appRoot, stateRoot }),
    /multiply-linked/u,
  );
  await rm(hardlinkedSnapshotFile);
  await writeFile(hardlinkedSnapshotFile, hardlinkedOriginal);
  await rm(hardlinkSource);

  const pointerBytes = await readFile(active.pointerPath);
  const manifestBytes = await readFile(active.manifestPath);
  const committedMarkerBytes = await readFile(active.commitPath);

  async function expectCommitMutationRejected(name, mutation, matcher) {
    const mutatedMarkerBytes = canonicalJson(mutation);
    try {
      await writeFile(active.commitPath, mutatedMarkerBytes);
      await writeFile(active.pointerPath, canonicalJson({
        ...active.pointer,
        commitSha256: hashBytes(mutatedMarkerBytes),
      }));
      await expectRejected(name, () => verifyActiveMcpGeneration({ appRoot, stateRoot }), matcher);
    } finally {
      await writeFile(active.commitPath, committedMarkerBytes);
      await writeFile(active.pointerPath, pointerBytes);
    }
  }

  await expectCommitMutationRejected(
    "commit-extra-field-rejected",
    { ...active.commit, unexpected: true },
    /closed-world field set/u,
  );
  const { contentBytes: omittedContentBytes, ...partialCommit } = active.commit;
  assert(Number.isSafeInteger(omittedContentBytes));
  await expectCommitMutationRejected(
    "partial-commit-marker-rejected",
    partialCommit,
    /closed-world field set/u,
  );
  await expectCommitMutationRejected(
    "commit-wrong-directory-name-rejected",
    { ...active.commit, generationDirectoryName: `${active.manifest.generationId}--${"f".repeat(32)}` },
    /does not bind the selected snapshot instance/u,
  );
  const wrongGenerationId = "e".repeat(64);
  await expectCommitMutationRejected(
    "commit-wrong-generation-id-rejected",
    {
      ...active.commit,
      generationDirectoryName: `${wrongGenerationId}--${"e".repeat(32)}`,
      generationId: wrongGenerationId,
    },
    /does not bind the selected snapshot instance/u,
  );
  await expectCommitMutationRejected(
    "commit-wrong-manifest-hash-rejected",
    { ...active.commit, generationManifestSha256: "d".repeat(64) },
    /disagrees with the active pointer/u,
  );
  await expectCommitMutationRejected(
    "commit-wrong-file-count-rejected-before-content-selection",
    { ...active.commit, contentFileCount: active.commit.contentFileCount + 1 },
    /content totals disagree/u,
  );
  await expectCommitMutationRejected(
    "commit-wrong-byte-count-rejected-before-content-selection",
    { ...active.commit, contentBytes: active.commit.contentBytes + 1 },
    /content totals disagree/u,
  );

  await writeFile(active.pointerPath, "{broken-json\n");
  await expectRejected("malformed-pointer-fails-closed", () => verifyActiveMcpGeneration({ appRoot, stateRoot }), /valid JSON/u);
  await writeFile(active.pointerPath, pointerBytes);

  await writeFile(active.pointerPath, canonicalJson({ ...active.pointer, generationId: `../${"a".repeat(61)}` }));
  await expectRejected("pointer-traversal-rejected", () => verifyActiveMcpGeneration({ appRoot, stateRoot }), /lowercase SHA-256/u);
  await writeFile(active.pointerPath, pointerBytes);

  await writeFile(active.pointerPath, canonicalJson({ ...active.pointer, generationManifestSha256: "0".repeat(64) }));
  await expectRejected(
    "pointer-manifest-hash-mismatch-rejected",
    () => verifyActiveMcpGeneration({ appRoot, stateRoot }),
    /manifest hash|disagrees with the active pointer/u,
  );
  await writeFile(active.pointerPath, pointerBytes);

  await writeFile(active.pointerPath, canonicalJson({ ...active.pointer, commitSha256: "0".repeat(64) }));
  await expectRejected("pointer-commit-hash-mismatch-rejected", () => verifyActiveMcpGeneration({ appRoot, stateRoot }), /commit marker hash/u);
  await writeFile(active.pointerPath, pointerBytes);

  await writeFile(active.pointerPath, canonicalJson({ ...active.pointer, generationDirectoryName: "../escape" }));
  await expectRejected("pointer-directory-traversal-rejected", () => verifyActiveMcpGeneration({ appRoot, stateRoot }), /directory name/u);
  await writeFile(active.pointerPath, pointerBytes);

  await writeFile(active.pointerPath, canonicalJson({ ...active.pointer, selectionRevision: "not-a-revision" }));
  await expectRejected("pointer-selection-revision-rejected", () => verifyActiveMcpGeneration({ appRoot, stateRoot }), /selection revision/u);
  await writeFile(active.pointerPath, pointerBytes);

  const badManifestBytes = canonicalJson({ ...active.manifest, unexpected: true });
  const badManifestSha256 = hashBytes(badManifestBytes);
  const badManifestCommitBytes = canonicalJson({
    ...active.commit,
    generationManifestSha256: badManifestSha256,
  });
  await writeFile(active.manifestPath, badManifestBytes);
  await writeFile(active.commitPath, badManifestCommitBytes);
  await writeFile(active.pointerPath, canonicalJson({
    ...active.pointer,
    commitSha256: hashBytes(badManifestCommitBytes),
    generationManifestSha256: badManifestSha256,
  }));
  await expectRejected("unknown-manifest-field-rejected", () => verifyActiveMcpGeneration({ appRoot, stateRoot }), /closed-world field set/u);
  await writeFile(active.manifestPath, manifestBytes);
  await writeFile(active.commitPath, committedMarkerBytes);
  await writeFile(active.pointerPath, pointerBytes);

  const unexpected = resolve(active.generationRoot, "unexpected.txt");
  await writeFile(unexpected, "unexpected");
  await expectRejected("generation-extra-entry-rejected", () => verifyActiveMcpGeneration({ appRoot, stateRoot }), /unexpected entry/u);
  await rm(unexpected, { force: true });

  await writeFile(resolve(vendorRoot, "manifest.json"), canonicalJson({ ...nodeManifest, nodeExeSha256: "f".repeat(64) }));
  await expectRejected(
    "vendor-node-hash-tamper-rejected",
    () => verifyVendorNodeIdentity({ appRoot, execPath: vendorNode }),
    /hash does not match/u,
  );
  await writeFile(resolve(vendorRoot, "manifest.json"), canonicalJson(nodeManifest));

  const otherNode = resolve(fixtureRoot, "unowned-node.exe");
  await link(vendorNode, otherNode);
  await expectRejected(
    "unowned-node-launcher-rejected",
    () => verifyVendorNodeIdentity({ appRoot, execPath: otherNode }),
    /pinned vendor Node/u,
  );

  const launcherSource = await readFile(resolve(import.meta.dirname, "editkin-mcp-generation-launcher.mjs"), "utf8");
  const runtimeSource = await readFile(resolve(import.meta.dirname, "lib/editkin-mcp-generation-runtime.mjs"), "utf8");
  const preflightSource = await readFile(resolve(import.meta.dirname, "lib/editkin-mcp-generation-preflight.mjs"), "utf8");
  assert.doesNotMatch(`${launcherSource}\n${runtimeSource}`, /node:child_process|\bexecFile\b|\bspawn\s*\(/u);
  assert.match(preflightSource, /spawn\(expectedWorkerExecutable,/u);
  assert.match(preflightSource, /shell: false/u);
  assert.doesNotMatch(preflightSource, /shell: true|\bexec(?:File|Sync)?\s*\(/u);
  assert.doesNotMatch(preflightSource, /node:fs|verifyVendorNodeIdentity|\brealpath\b|\bopen\s*\(/u);
  assert.doesNotMatch(runtimeSource, /process\.env\.EDITKIN_MCP_(?:STATE|RUNTIME)_ROOT/u);
  assert.match(launcherSource, /process\.argv\.length !== 2/u);
  controls.push("launcher-has-no-shell-or-environment-selected-state-root");

  await verifyActiveMcpGeneration({ appRoot, stateRoot });
  process.stdout.write(`${JSON.stringify({
    status: "GREEN",
    realProductPointerActivated: false,
    snapshotFileCount: active.manifest.files.length,
    negativeControls: controls.length,
    controls,
  })}\n`);
} finally {
  // The bootstrap parent removes the fixture after this pinned child exits.
}
