import { captureModuleMetadataValidationInputs } from "./module-metadata-validation-inputs.mjs";
import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { readCommunityPolicySnapshot, communityRuleSourceIdentities } from "./community-stable-rules.mjs";
import { extname, isAbsolute, parse, relative, resolve } from "node:path";
import { fileIdentity, readRegularFile } from "./regular-file.mjs";
import { runOwnedProcess } from "./owned-process-runner.mjs";
import { INCLUDED_COMMUNITY_KNOWLEDGE_SOURCES, EXCLUDED_COMMUNITY_KNOWLEDGE_SOURCES } from "./community-knowledge-inventory.mjs";
import { OWNER_VISUAL_GRANT } from "../../src/shared/visualAssetRights.mjs";
import { captureWindowsGpuCompileInputs } from "./windows-gpu-build-inputs.mjs";

export const FRONTEND_QUALITY_GATES = Object.freeze([
  ["module-metadata", "node", "scripts/refresh-module-metadata-v2.cjs", "--check"],
  ["locales-generated", "tsx", "scripts/build-interface-locales.ts", "--check"],
  ["locales-coverage", "tsx", "scripts/audit-interface-locales.ts", "--check"],
  ["aesthetic", "node", "scripts/hao-aesthetic-gate.mjs"],
  ["theme-contrast", "tsx", "scripts/theme-contrast-gate.ts"],
  ["community-knowledge", "node", "scripts/community-knowledge-gate.mjs"],
  ["retired-surfaces", "node", "scripts/retired-product-surfaces-gate.mjs"],
  ["cinematic-assets", "tsx", "scripts/cinematic-asset-product-gate.ts"],
].map(([id, runner, script, ...args]) => Object.freeze({ id, runner, script, args: Object.freeze(args) })));

export const FRONTEND_KNOWLEDGE_VALIDATION_SOURCES = Object.freeze([
  ...INCLUDED_COMMUNITY_KNOWLEDGE_SOURCES, ...Object.keys(EXCLUDED_COMMUNITY_KNOWLEDGE_SOURCES),
].sort());

// These live sources validate the anonymous generated pack. They are build
// prerequisites, including excluded private state, never release resources.
const VALIDATION_SCOPE = "build-validation-only; never-distributable-resources";

async function assertRegularAncestry(boundary, target) {
  const relation = relative(boundary, target);
  if (isAbsolute(relation) || relation.split(/[\\/]/u).includes("..")) throw new Error("Validation input escaped its boundary");
  let current = boundary;
  for (const part of ["", ...relation.split(/[\\/]/u).filter(Boolean)]) {
    if (part) current = resolve(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error(`Validation input rejects link/junction: ${current}`);
    if (current === target && !info.isFile()) throw new Error(`Validation input is not a regular file: ${current}`);
  }
}

async function discoverKnowledgeSources(knowledgeRoot) {
  const paths = [];
  for (const entry of await readdir(knowledgeRoot, { withFileTypes: true })) {
    if (entry.isFile()) paths.push(entry.name);
    else if (entry.isDirectory() && entry.name === "runtime") {
      for (const child of await readdir(resolve(knowledgeRoot, "runtime"), { withFileTypes: true })) {
        if (!child.isFile()) throw new Error(`Invalid knowledge validation entry: runtime/${child.name}`);
        paths.push(`runtime/${child.name}`);
      }
    } else throw new Error(`Invalid knowledge validation entry: ${entry.name}`);
  }
  const expected = new Set(FRONTEND_KNOWLEDGE_VALIDATION_SOURCES);
  const found = new Set(paths);
  const missing = [...expected].filter(name => !found.has(name));
  const unexpected = paths.filter(name => !expected.has(name));
  if (missing.length || unexpected.length) {
    throw Object.assign(new Error(`Knowledge validation inputs incomplete: ${missing.length} missing, ${unexpected.length} unexpected`), {
      code: "knowledge-validation-input-closure", missing, unexpected,
    });
  }
  return [...found].sort();
}

async function captureAppValidationInputs(rootInput) {
  const root = resolve(rootInput), policyPath = "config/retired-product-surfaces.json";
  const absolutePolicy = resolve(root, policyPath);
  await assertRegularAncestry(parse(root).root, absolutePolicy);
  const raw = await readRegularFile(absolutePolicy);
  const policy = JSON.parse(raw.toString("utf8"));
  if (!Array.isArray(policy.provenanceFiles) || !policy.provenanceFiles.length) throw new Error("Missing retired provenance input policy");
  const names = policy.provenanceFiles.map(entry => entry?.path);
  if (new Set(names.map(name => typeof name === "string" ? name.toLowerCase() : name)).size !== names.length) throw new Error("Duplicate retired provenance input");
  for (const name of names) {
    if (typeof name !== "string" || !/^[a-z0-9._/-]+$/iu.test(name) || isAbsolute(name)
      || name.split("/").some(part => !part || part === "." || part === "..")
      || !/\.(?:json|md|[cm]?js|ts|rs|py)$/iu.test(name)) throw new Error("Unsafe or binary retired provenance input");
  }
  const files = [{ path: policyPath, bytes: raw.length, sha256: createHash("sha256").update(raw).digest("hex") }];
  for (const name of [...names].sort()) {
    const path = resolve(root, name);
    await assertRegularAncestry(root, path);
    files.push({ path: name, ...await fileIdentity(path) });
  }
  return files;
}

// The pack generator reads its declared originals, not the already generated
// release pack. Include those dependencies in the isolated-build inventory;
// original workspace paths are never added to shipping resources or identity.
async function captureCreativeGenerationInputs(workspace) {
  const base = "community/hao-motion-kit/";
  const manifestName = `${base}PUBLIC_ASSET_MANIFEST.json`;
  const manifestPath = resolve(workspace, manifestName);
  await assertRegularAncestry(workspace, manifestPath);
  const raw = await readRegularFile(manifestPath);
  const manifest = JSON.parse(raw.toString("utf8"));
  if (manifest.schema_version !== 1 || manifest.fail_closed !== true || !Array.isArray(manifest.assets)
    || !manifest.assets.length || manifest.asset_count !== manifest.assets.length) throw new Error("Invalid creative source manifest");
  const assets = [...manifest.assets, ...OWNER_VISUAL_GRANT.assets.map(asset => ({
    asset_id: asset.id, path: `${base}${asset.sourcePath}`,
  }))];
  const ids = new Set(), paths = new Map();
  for (const asset of assets) {
    if (typeof asset?.asset_id !== "string" || !asset.asset_id.trim() || ids.has(asset.asset_id)) throw new Error("Duplicate or invalid creative source ID");
    ids.add(asset.asset_id);
    const name = asset.path;
    if (typeof name !== "string" || isAbsolute(name) || name.includes("\\") || name.includes("\0")
      || name.split("/").some(part => !part || part === "." || part === "..")
      || !(name.startsWith("assets/") || name.startsWith(base))
      || !/^(?:\.png|\.jpe?g|\.webp|\.bmp|\.gif|\.mp4|\.mov|\.webm|\.mkv|\.wav|\.mp3|\.m4a|\.aac|\.flac)$/iu.test(extname(name))) {
      throw new Error("Unsafe or unsupported creative source path");
    }
    const folded = name.toLowerCase();
    if (paths.has(folded) && paths.get(folded) !== name) throw new Error("Case-conflicting creative source path");
    paths.set(folded, name);
  }
  const names = [...new Set([
    manifestName, `${base}ASSET_LICENSE.md`, `${base}NOTICE.md`,
    `${base}OWNER_VISUAL_GRANT.json`, `${base}OWNER_VISUAL_BUNDLE_GRANT.md`, ...paths.values(),
  ])].sort();
  const files = [];
  for (const name of names) {
    const path = resolve(workspace, name);
    await assertRegularAncestry(workspace, path);
    const identity = name === manifestName
      ? { bytes: raw.length, sha256: createHash("sha256").update(raw).digest("hex") }
      : await fileIdentity(path);
    files.push({ path: `workspace/${name}`, ...identity });
  }
  return files;
}

export async function captureFrontendQualityInputs({ root, policyPath }) {
  const workspace = resolve(root, "../..");
  const knowledgeRoot = resolve(workspace, "video-autopilot-kit/knowledge");
  // Check directory ancestors before discovery, without following a clone junction.
  await assertRegularAncestry(parse(workspace).root, resolve(knowledgeRoot, "runtime/filter_library.json"));
  const sources = await discoverKnowledgeSources(knowledgeRoot);
  const files = [];
  for (const source of sources) {
    const path = resolve(knowledgeRoot, source);
    await assertRegularAncestry(workspace, path);
    files.push({ path: `workspace/video-autopilot-kit/knowledge/${source}`, ...await fileIdentity(path) });
  }
  const policy = await readCommunityPolicySnapshot({ policyPath });
  const localPolicySources = communityRuleSourceIdentities(policy.records);
  const localPolicy = { ...localPolicySources[0], path: policy.policyPath };
  const appFiles = await captureAppValidationInputs(root);
  const generationFiles = await captureCreativeGenerationInputs(workspace);
  const nativeBuild = await captureWindowsGpuCompileInputs({ root, assertRegularAncestry });
  const nativeBuildFiles = nativeBuild.files;
  // v2 binds the legacy literal; v3 binds both JSON data and its typed facade.
  // Every returned byte identity participates before and after all eight gates.
  const moduleMetadataFiles = await captureModuleMetadataValidationInputs(root);
  const identity = createHash("sha256").update(JSON.stringify({ files, appFiles, generationFiles, nativeBuildFiles, moduleMetadataFiles, localPolicy, localPolicySources })).digest("hex");
  return { schema: "editkin.frontend-quality-validation-inputs/v4", scope: VALIDATION_SCOPE,
    generationScope: "manifest-declared-build-sources; original paths never-release-resources",
    nativeBuildScope: nativeBuild.scope, files, appFiles, generationFiles, nativeBuildFiles, moduleMetadataFiles, localPolicy, localPolicySources, identity };
}

export async function runFrontendQualityGates({ root, policyPath, run = runOwnedProcess, onGate = () => {} }) {
  const inputs = await captureFrontendQualityInputs({ root, policyPath });
  const checked = [];
  for (const gate of FRONTEND_QUALITY_GATES) {
    const args = gate.runner === "tsx" ? ["--import", "tsx", gate.script, ...gate.args] : [gate.script, ...gate.args];
    let child;
    try {
      child = await run(process.execPath, args, { cwd: resolve(root), timeoutMs: 120_000, cleanupWaitMs: 15_000,
        env: { ...process.env, EDITKIN_VIDEO_AUTOPILOT_SKILL: inputs.localPolicy.path } });
      if (child.code !== 0 || child.closed !== true || child.signal || child.timedOut || child.spawnError) {
        throw Object.assign(new Error("Quality gate did not return a complete successful child"), { result: child });
      }
    } catch (cause) {
      throw Object.assign(new Error(`Frontend quality gate ${gate.id} failed: ${cause.message}`, { cause }), {
        gate: gate.id, result: cause.result ?? child, checked, validationInputs: inputs,
      });
    }
    checked.push({ id: gate.id, ...child });
    await onGate(checked.at(-1));
  }
  const after = await captureFrontendQualityInputs({ root, policyPath });
  if (after.identity !== inputs.identity) throw new Error("Frontend quality validation inputs changed while gates ran");
  return { checked, validationInputs: after };
}
