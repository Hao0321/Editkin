import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { copyFile, mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { REPO_TMP, useTempRoots } from "../../src/test/tempRoot.mjs";
import { FRONTEND_QUALITY_GATES, FRONTEND_KNOWLEDGE_VALIDATION_SOURCES, captureFrontendQualityInputs, runFrontendQualityGates } from "./frontend-quality-preflight.mjs";
import { OWNER_VISUAL_GRANT } from "../../src/shared/visualAssetRights.mjs";
import { WINDOWS_GPU_COMPILE_INPUT_PATHS } from "./windows-gpu-build-inputs.mjs";
import { COMMUNITY_RULE_REFERENCES } from "./community-stable-rules.mjs";

// Scratch fixture workspaces live under .rd/tmp and are removed after the file
// (junctions unlinked as links); they are never written into release receipts.
const temp = useTempRoots(after);
const success = { code: 0, closed: true, signal: null, timedOut: false, stdout: "GREEN", stderr: "" };
const expectedIds = ["module-metadata", "locales-generated", "locales-coverage", "aesthetic", "theme-contrast", "community-knowledge", "retired-surfaces", "cinematic-assets"];

async function fixture() {
  const workspace = await temp.create("frontend-quality-owned-", { parent: REPO_TMP });
  const root = resolve(workspace, "apps/editor");
  const knowledge = resolve(workspace, "video-autopilot-kit/knowledge");
  const policyPath = resolve(workspace, "policy/SKILL.md");
  await mkdir(root, { recursive: true });
  const moduleSources = [{ file: "scripts/refresh-module-metadata-v2.cjs", content: "metadata generator fixture" },
    { file: "src/modules/moduleManifestCatalogSourceV2.ts", content: "metadata source fixture" }];
  const digest = value => createHash("sha256").update(value).digest("hex");
  for (const source of moduleSources) { const path = resolve(root, source.file); await mkdir(dirname(path), { recursive: true }); await writeFile(path, source.content); }
  const generatedMetadata = "generated metadata fixture", generatedMetadataPath = resolve(root, "src/modules/moduleMetadataV2.generated.ts");
  await writeFile(generatedMetadataPath, generatedMetadata);
  await writeFile(resolve(root, "scripts/module-metadata-v2.sources.json"), JSON.stringify({ schema: "editkin.module-metadata-source-binding/v2",
    generatedSha256: digest(generatedMetadata), sources: moduleSources.map(source => ({ file: source.file, sha256: digest(source.content) })) }));
  for (const name of WINDOWS_GPU_COMPILE_INPUT_PATHS) {
    const target = resolve(root, name);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(resolve(import.meta.dirname, "../..", name), target);
  }
  await mkdir(dirname(policyPath), { recursive: true });
  await writeFile(policyPath, "canonical test policy");
  for (const source of FRONTEND_KNOWLEDGE_VALIDATION_SOURCES) {
    const path = resolve(knowledge, source);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `private raw test input for ${source}`);
  }
  const retirementPolicyPath = resolve(root, "config/retired-product-surfaces.json");
  const provenanceFiles = ["vendor/model-fixture/SOURCE.json", "vendor/runtime-fixture/SOURCE.json"];
  await mkdir(dirname(retirementPolicyPath), { recursive: true });
  await writeFile(retirementPolicyPath, JSON.stringify({ provenanceFiles: provenanceFiles.map(path => ({ path })) }));
  for (const name of provenanceFiles) {
    const path = resolve(root, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "original research provenance metadata");
  }
  const creativeRoot = resolve(workspace, "community/hao-motion-kit");
  const creativeManifestPath = resolve(creativeRoot, "PUBLIC_ASSET_MANIFEST.json");
  const creativeSource = "assets/broll/domain_fill/fashion/portrait/fashion_editorial_filler.mp4";
  const creativeManifest = { schema_version: 1, fail_closed: true, asset_count: 1, assets: [{ asset_id: "broll:fixture", path: creativeSource }] };
  await mkdir(creativeRoot, { recursive: true });
  await writeFile(creativeManifestPath, JSON.stringify(creativeManifest));
  for (const name of ["ASSET_LICENSE.md", "NOTICE.md", "OWNER_VISUAL_GRANT.json", "OWNER_VISUAL_BUNDLE_GRANT.md"])
    await writeFile(resolve(creativeRoot, name), "scoped generation metadata fixture");
  for (const name of [creativeSource, ...OWNER_VISUAL_GRANT.assets.map(asset => `community/hao-motion-kit/${asset.sourcePath}`)]) {
    const path = resolve(workspace, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "private original media fixture; not a rights or decode test");
  }
  return { workspace, root, knowledge, policyPath, retirementPolicyPath, provenanceFiles,
    creativeManifestPath, creativeManifest, creativeSource };
}

test("one scoped inventory covers all45 live inputs, including eight excluded sources, without outputting content", async () => {
  const input = await fixture();
  const inventory = await captureFrontendQualityInputs(input);
  assert.equal(inventory.files.length, 45);
  assert.equal(inventory.appFiles.length, 3);
  assert.equal(inventory.moduleMetadataFiles.length, 4);
  assert.equal(inventory.schema, "editkin.frontend-quality-validation-inputs/v4");
  assert.equal(inventory.scope, "build-validation-only; never-distributable-resources");
  assert(inventory.files.some(row => row.path.endsWith("runtime/state.json")));
  assert(inventory.files.some(row => row.path.endsWith("README.md")));
  assert(!JSON.stringify(inventory).includes("private raw test input"));
  const before = inventory.identity;
  await writeFile(resolve(input.knowledge, "autopilot-workflow.md"), "changed same path");
  assert.notEqual((await captureFrontendQualityInputs(input)).identity, before);
});

for (const name of ["missing-header", "mutated-header", "unexpected-header", "binary-header", "linked-headers", "missing-runtime-metadata", "mutated-runtime-metadata", "missing-build-script", "missing-cpp-bridge"]) {
  test(`rejects ${name} native compile input before any quality child`, async () => {
    const input = await fixture(), headerRoot = resolve(input.root, "spikes/gpu-compositor/vendor/ffmpeg-8.1-lgpl/include");
    const header = resolve(headerRoot, "libavcodec/avcodec.h");
    const runtime = resolve(input.root, "spikes/gpu-compositor/fixtures/software-video/ffmpeg-lgpl-runtime-rd.json");
    if (name === "missing-header") await rename(header, `${header}.kept`);
    if (name === "mutated-header") await writeFile(header, "different same-named ABI header");
    if (name === "unexpected-header") await writeFile(resolve(headerRoot, "unexpected.h"), "undeclared header");
    if (name === "binary-header") await writeFile(resolve(headerRoot, "model.dll"), "not a compile header");
    if (name === "linked-headers") {
      await rename(headerRoot, `${headerRoot}.kept`);
      await symlink(`${headerRoot}.kept`, headerRoot, process.platform === "win32" ? "junction" : "dir");
    }
    if (name === "missing-runtime-metadata") await rename(runtime, `${runtime}.kept`);
    if (name === "mutated-runtime-metadata") await writeFile(runtime, JSON.stringify({ shippingEligible: true }));
    if (name === "missing-build-script") await rename(resolve(input.root, "spikes/gpu-compositor/build.rs"), resolve(input.root, "spikes/gpu-compositor/build.rs.kept"));
    if (name === "missing-cpp-bridge") await rename(resolve(input.root, "spikes/gpu-compositor/src/software_video_bridge.cpp"), resolve(input.root, "spikes/gpu-compositor/src/software_video_bridge.cpp.kept"));
    let calls = 0;
    await assert.rejects(runFrontendQualityGates({ ...input, run: async () => { calls++; return success; } }));
    assert.equal(calls, 0);
  });
}

test("captures all150 native compile files as hash-only nonshipping metadata", async () => {
  const input = await fixture(), before = await captureFrontendQualityInputs(input);
  assert.equal(before.nativeBuildFiles.length, 150);
  assert.equal(before.nativeBuildScope, "windows-gpu-compile-sources; never-release-resources");
  assert(!JSON.stringify(before).includes("# FFmpeg 8.1 R&D headers"));
  await writeFile(resolve(input.root, "spikes/gpu-compositor/build.rs"), "changed compiler source");
  assert.notEqual((await captureFrontendQualityInputs(input)).identity, before.identity);
});

test("detects native compiler-source drift while all eight children run", async () => {
  const input = await fixture();
  let calls = 0;
  await assert.rejects(runFrontendQualityGates({ ...input, run: async () => {
    if (++calls === 1) await writeFile(resolve(input.root, "spikes/gpu-compositor/build.rs"), "compiler source changed during checks");
    return success;
  } }), /inputs changed/u);
  assert.equal(calls, 8);
});

for (const name of ["missing-media", "wrong-count", "duplicate-ID", "traversal-media", "absolute-media", "binary-media", "outside-media", "linked-media"]) {
  test(`rejects ${name} generation source before invoking any quality child`, async () => {
    const input = await fixture(), target = resolve(input.workspace, input.creativeSource);
    const manifest = structuredClone(input.creativeManifest);
    if (name === "missing-media") await rename(target, `${target}.kept`);
    if (name === "wrong-count") manifest.asset_count++;
    if (name === "duplicate-ID") { manifest.assets.push({ ...manifest.assets[0] }); manifest.asset_count++; }
    if (name === "traversal-media") manifest.assets[0].path = "assets/../secret.mp4";
    if (name === "absolute-media") manifest.assets[0].path = "C:/outside.mp4";
    if (name === "binary-media") manifest.assets[0].path = "assets/model.onnx";
    if (name === "outside-media") manifest.assets[0].path = "notes/private.png";
    if (name === "linked-media") {
      const folder = dirname(target), kept = `${folder}.kept`;
      await rename(folder, kept);
      await symlink(kept, folder, process.platform === "win32" ? "junction" : "dir");
    }
    await writeFile(input.creativeManifestPath, JSON.stringify(manifest));
    let calls = 0;
    await assert.rejects(runFrontendQualityGates({ ...input, run: async () => { calls++; return success; } }));
    assert.equal(calls, 0);
  });
}

test("generation originals are hash-bound without exposing their content or adding resource paths", async () => {
  const input = await fixture(), before = await captureFrontendQualityInputs(input);
  assert(before.generationFiles.some(row => row.path === `workspace/${input.creativeSource}`));
  assert.equal(before.generationFiles.length, 5 + 1 + OWNER_VISUAL_GRANT.assets.length);
  assert.equal(before.generationScope, "manifest-declared-build-sources; original paths never-release-resources");
  assert(!JSON.stringify(before).includes("private original media fixture"));
  await writeFile(resolve(input.workspace, input.creativeSource), "changed source media");
  assert.notEqual((await captureFrontendQualityInputs(input)).identity, before.identity);
});

for (const name of ["missing-provenance", "traversal-provenance", "duplicate-provenance", "binary-provenance", "linked-provenance"] ) {
  test(`rejects ${name} before invoking quality children`, async () => {
    const input = await fixture();
    const target = resolve(input.root, input.provenanceFiles[0]);
    if (name === "missing-provenance") await rename(target, `${target}.kept`);
    if (name === "linked-provenance") {
      const directory = dirname(target), kept = `${directory}.kept`;
      await rename(directory, kept);
      await symlink(kept, directory, process.platform === "win32" ? "junction" : "dir");
    }
    if (name === "traversal-provenance") await writeFile(input.retirementPolicyPath, JSON.stringify({ provenanceFiles: [{ path: "../outside/SOURCE.json" }] }));
    if (name === "duplicate-provenance") await writeFile(input.retirementPolicyPath, JSON.stringify({ provenanceFiles: [{ path: input.provenanceFiles[0] }, { path: input.provenanceFiles[0].toUpperCase() }] }));
    if (name === "binary-provenance") await writeFile(input.retirementPolicyPath, JSON.stringify({ provenanceFiles: [{ path: "vendor/model-fixture/model.onnx" }] }));
    let calls = 0;
    await assert.rejects(runFrontendQualityGates({ ...input, run: async () => { calls++; return success; } }));
    assert.equal(calls, 0);
  });
}

test("changing provenance metadata invalidates the input identity and content stays private", async () => {
  const input = await fixture();
  const before = await captureFrontendQualityInputs(input);
  assert(!JSON.stringify(before).includes("original research provenance metadata"));
  await writeFile(resolve(input.root, input.provenanceFiles[0]), "changed provenance");
  assert.notEqual((await captureFrontendQualityInputs(input)).identity, before.identity);
});

test("runs metadata freshness followed by the original seven checks with bounded shell-free Node/tsx commands", async () => {
  const input = await fixture(), calls = [], events = [];
  const result = await runFrontendQualityGates({ ...input, run: async (...args) => { calls.push(args); return success; }, onGate: gate => events.push(gate.id) });
  assert.deepEqual(result.checked.map(gate => gate.id), expectedIds);
  assert.deepEqual(events, expectedIds);
  assert.equal(calls.length, 8);
  assert.deepEqual(calls[0][1], ["scripts/refresh-module-metadata-v2.cjs", "--check"]);
  assert.deepEqual(calls[1][1], ["--import", "tsx", "scripts/build-interface-locales.ts", "--check"]);
  assert.deepEqual(calls[5][1], ["scripts/community-knowledge-gate.mjs"]);
  for (const [executable, , options] of calls) {
    assert.equal(executable, process.execPath);
    const { env, ...ownedOptions } = options;
    assert.deepEqual(ownedOptions, { cwd: input.root, timeoutMs: 120_000, cleanupWaitMs: 15_000 });
    assert.equal(env.EDITKIN_VIDEO_AUTOPILOT_SKILL, input.policyPath);
  }
});

test("a clone with only the original filter catalogue fails before launching any checks", async () => {
  const input = await fixture();
  const preserved = resolve(input.workspace, "omitted-sources");
  await rename(input.knowledge, preserved);
  await mkdir(resolve(input.knowledge, "runtime"), { recursive: true });
  await writeFile(resolve(input.knowledge, "runtime/filter_library.json"), "original lone catalogue");
  let calls = 0;
  await assert.rejects(runFrontendQualityGates({ ...input, run: async () => { calls++; return success; } }), error => error.code === "knowledge-validation-input-closure" && error.missing.length === 44);
  assert.equal(calls, 0);
});

for (const name of ["unexpected", "nested", "junction", "missing-policy"]) {
  test(`rejects ${name} validation inputs before invoking children`, async () => {
    const input = await fixture();
    if (name === "unexpected") await writeFile(resolve(input.knowledge, "runtime/unclassified.json"), "extra");
    if (name === "nested") await mkdir(resolve(input.knowledge, "runtime/undeclared"));
    if (name === "missing-policy") await rename(input.policyPath, `${input.policyPath}.kept`);
    if (name === "junction") {
      const actual = resolve(input.workspace, "kept-runtime");
      await rename(resolve(input.knowledge, "runtime"), actual);
      await symlink(actual, resolve(input.knowledge, "runtime"), process.platform === "win32" ? "junction" : "dir");
    }
    let calls = 0;
    await assert.rejects(runFrontendQualityGates({ ...input, run: async () => { calls++; return success; } }));
    assert.equal(calls, 0);
  });
}

for (const [name, delta] of Object.entries({ nonzero: { code: 1 }, booleanExit: { code: false }, unclosed: { closed: false }, timeout: { timedOut: true }, signal: { signal: "SIGTERM" }, spawnFailure: { spawnError: "unavailable" } })) {
  test(`stops at ${name} child evidence and preserves the exact failed result`, async () => {
    const input = await fixture(), failed = { ...success, ...delta };
    let calls = 0;
    await assert.rejects(runFrontendQualityGates({ ...input, run: async () => ++calls === 2 ? failed : success }), error => error.gate === expectedIds[1] && error.result === failed && error.checked.length === 1);
    assert.equal(calls, 2);
  });
}

test("a thrown child failure keeps its output and does not run later checks", async () => {
  const input = await fixture(), failed = { ...success, code: 1, stderr: "real failure" };
  let calls = 0;
  await assert.rejects(runFrontendQualityGates({ ...input, run: async () => { calls++; throw Object.assign(new Error("real failure"), { result: failed }); } }), error => error.result === failed && error.gate === expectedIds[0]);
  assert.equal(calls, 1);
});

test("input drift during successful checks prevents a final pass", async () => {
  const input = await fixture();
  await assert.rejects(runFrontendQualityGates({ ...input, run: async () => success, onGate: async gate => {
    if (gate.id === expectedIds.at(-1)) await writeFile(resolve(input.knowledge, "runtime/state.json"), "changed private state");
  } }), /changed while gates ran/u);
});

test("routed canonical policy bytes are captured and drift blocks the whole validation", async () => {
  const input = await fixture();
  await writeFile(input.policyPath, COMMUNITY_RULE_REFERENCES.map(path => `[contract](${path})`).join("\n"));
  for (const path of COMMUNITY_RULE_REFERENCES) {
    const file = resolve(dirname(input.policyPath), path); await mkdir(dirname(file), { recursive: true }); await writeFile(file, "M157：policy fixture");
  }
  const before = await captureFrontendQualityInputs(input);
  assert.equal(before.localPolicySources.length, 5); assert(!JSON.stringify(before).includes("policy fixture"));
  const reference = resolve(dirname(input.policyPath), COMMUNITY_RULE_REFERENCES[2]);
  await writeFile(reference, "M157：changed policy fixture");
  assert.notEqual((await captureFrontendQualityInputs(input)).identity, before.identity);
  await assert.rejects(runFrontendQualityGates({ ...input, run: async () => success, onGate: async gate => {
    if (gate.id === expectedIds.at(-1)) await writeFile(reference, "M157：changed during validation");
  } }), /changed while gates ran/);
});

test("both build entrypoints execute shared checks before typecheck or asset generation", async () => {
  const app = resolve(import.meta.dirname, "../..");
  const pkg = JSON.parse(await readFile(resolve(app, "package.json"), "utf8"));
  assert.equal(pkg.scripts.build, "npm run quality:gate && tsc --noEmit && node scripts/build-web-public.mjs && vite build");
  assert.equal(pkg.scripts["quality:gate"], "node scripts/frontend-quality-gate.mjs");
  const native = await readFile(resolve(app, "scripts/tauri-frontend.mjs"), "utf8");
  assert(native.includes('await import("./frontend-quality-gate.mjs")'));
  const check = native.indexOf("await checkFrontendQuality(root);");
  assert(check > 0 && check < native.indexOf("await assertProductCargoLocks("));
  assert(check < native.indexOf('await runNode("scripts/build-creative-pack.mjs")'));
  assert.equal(FRONTEND_QUALITY_GATES.length, 8);
});

for (const kind of ["missing-binding", "changed-generated", "changed-source", "duplicate", "traversal", "absolute", "binary", "linked", "generator-omitted", "oversized"]) {
  test(`rejects ${kind} module metadata before any quality child`, async () => {
    const input = await fixture(), binding = resolve(input.root, "scripts/module-metadata-v2.sources.json");
    const source = resolve(input.root, "src/modules/moduleManifestCatalogSourceV2.ts");
    const data = JSON.parse(await readFile(binding, "utf8"));
    if (kind === "missing-binding") await rename(binding, `${binding}.kept`);
    else if (kind === "changed-generated") await writeFile(resolve(input.root, "src/modules/moduleMetadataV2.generated.ts"), "stale generation");
    else if (kind === "changed-source") await writeFile(source, "manifest source changed after generation");
    else if (kind === "linked") { const folder = dirname(source); await rename(folder, `${folder}.kept`); await symlink(`${folder}.kept`, folder, process.platform === "win32" ? "junction" : "dir"); }
    else if (kind === "oversized") await writeFile(source, Buffer.alloc(2 * 1024 ** 2 + 1));
    else {
      if (kind === "duplicate") data.sources.push({ ...data.sources[0] });
      if (kind === "traversal") data.sources[0].file = "src/../outside.ts";
      if (kind === "absolute") data.sources[0].file = "C:/outside.ts";
      if (kind === "binary") data.sources[0].file = "src/model.onnx";
      if (kind === "generator-omitted") data.sources = data.sources.filter(row => !row.file.startsWith("scripts/"));
      await writeFile(binding, JSON.stringify(data));
    }
    let calls = 0;
    await assert.rejects(runFrontendQualityGates({ ...input, run: async () => { calls++; return success; } }));
    assert.equal(calls, 0);
  });
}

test("detects a bound module source changed during the eight checks", async () => {
  const input = await fixture(); let calls = 0;
  await assert.rejects(runFrontendQualityGates({ ...input, run: async () => {
    if (++calls === 1) await writeFile(resolve(input.root, "src/modules/moduleManifestCatalogSourceV2.ts"), "changed during validation");
    return success;
  } }), /MODULE_METADATA_STALE/u);
  assert.equal(calls, 8);
});
