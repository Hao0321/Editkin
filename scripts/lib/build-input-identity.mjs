import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { readRegularFile } from "./regular-file.mjs";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { OWNER_VISUAL_GRANT } from "../../src/shared/visualAssetRights.mjs";
import { FRONTEND_QUALITY_GATES } from "./frontend-quality-preflight.mjs";
import { productModuleSpecifiers } from "./product-module-specifiers.mjs";

import {
  APP_INPUT_ROOTS,
  PRODUCT_MODULE_ENTRYPOINTS,
  PRODUCT_PIPELINE_SCRIPT_ENTRYPOINTS,
  WORKSPACE_INPUT_ROOTS,
  PRODUCT_REQUIRED_INPUT_PATHS,
  PRODUCT_REQUIRED_OUTPUT_PATHS,
  RESEARCH_ONLY_EXACT_PATHS,
  EVIDENCE_ONLY_EXACT_PATHS,
  outputPaths,
} from "./build-input-path-contract.mjs";

export { PRODUCT_REQUIRED_INPUT_PATHS, PRODUCT_REQUIRED_OUTPUT_PATHS } from "./build-input-path-contract.mjs";

// Bind the declared path roles at the pipeline entry even when their single owner is split out.
if (!APP_INPUT_ROOTS.includes("config/retired-product-surfaces.json")
  || !PRODUCT_PIPELINE_SCRIPT_ENTRYPOINTS.includes("scripts/retired-product-surfaces-gate.mjs")
  || !PRODUCT_REQUIRED_INPUT_PATHS.includes("config/retired-product-surfaces.json")
  || !PRODUCT_REQUIRED_INPUT_PATHS.includes("scripts/retired-product-surfaces-gate.mjs")) {
  throw new Error("EDITKIN_RETIRED_PRODUCT_BINDING_MISSING");
}

const RELEASE_SCOPE_POLICY = Object.freeze({
  schema: "editkin.product-release-input-policy/v1",
  productModuleEntrypoints: PRODUCT_MODULE_ENTRYPOINTS,
  productPipelineEntrypoints: PRODUCT_PIPELINE_SCRIPT_ENTRYPOINTS,
  researchOnlyExactPaths: [...RESEARCH_ONLY_EXACT_PATHS].sort(),
  evidenceOnlyExactPaths: [...EVIDENCE_ONLY_EXACT_PATHS].sort(),
  testsExcluded: true,
  symlinksRejected: true,
  pathNamespaces: ["app-relative", "workspace-relative-with-workspace-prefix"],
  ownerVisualGrantId: OWNER_VISUAL_GRANT.id,
  ownerVisualGrantPolicySha256: createHash("sha256").update(canonicalJson(OWNER_VISUAL_GRANT)).digest("hex"),
});

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export const PRODUCT_RELEASE_SCOPE = Object.freeze({
  id: "editkin.formal-product-build-scope/v1",
  productMode: "native-only-auto-roto",
  inputBoundary: "reachable-product-modules-plus-release-pipeline-and-bundled-resources",
  researchBoundary: "repository-retained-artifact-excluded",
  policySha256: createHash("sha256").update(canonicalJson(RELEASE_SCOPE_POLICY)).digest("hex"),
});

const normalize = (path) => path.split(sep).join("/");
const isInside = (root, candidate) => {
  const relation = relative(root, candidate);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
};
async function assertNoSymlinkAncestry(boundaryInput, targetInput) {
  const boundary = resolve(boundaryInput);
  const target = resolve(targetInput);
  if (!isInside(boundary, target)) throw new Error(`Build identity path escaped declared boundary: ${target}`);
  let cursor = boundary;
  for (const part of ["", ...relative(boundary, target).split(/[\\/]+/u).filter(Boolean)]) {
    if (part) cursor = resolve(cursor, part);
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) throw new Error(`Build identity rejects symlink/junction ancestry: ${cursor}`);
  }
  const [canonicalBoundary, canonicalTarget] = await Promise.all([realpath(boundary), realpath(target)]);
  if (!isInside(canonicalBoundary, canonicalTarget)) throw new Error(`Build identity canonical path escaped declared boundary: ${target}`);
}
const isTestPath = (path) => /(?:^|\/)(?:__tests__|test|tests|fixtures)(?:\/|$)/iu.test(path)
  || /\.(?:test|spec)\.[cm]?[jt]sx?$/iu.test(path);

export function productInputExclusionReason(pathInput) {
  const path = normalize(String(pathInput));
  if (EVIDENCE_ONLY_EXACT_PATHS.has(path)) return "release-evidence-only";
  if (/^(?:workspace\/)?\.personal-packs\//iu.test(path) && !/^\.personal-packs\/hao-music-library\//u.test(path)) return "owner-only-personal-pack";
  if (/^workspace\/assets\/broll\/transitions\//iu.test(path)) return "private-original-source-folder";
  if (isTestPath(path)) return "test-or-fixture";
  if (RESEARCH_ONLY_EXACT_PATHS.has(path)) return "research-only-auto-roto";
  if (/(?:^|\/)(?:auto[-_]?roto[^/]*(?:sam2|sam21|onnx)|self-authored-auto-roto-vs-sam|auto-roto-sam21-video-host)(?:[^/]*)(?:\/|$|\.)/iu.test(path)) {
    return "research-only-auto-roto";
  }
  return undefined;
}

function labelFor(root, workspaceRoot, absolute) {
  if (isInside(root, absolute)) return normalize(relative(root, absolute));
  if (isInside(workspaceRoot, absolute)) return `workspace/${normalize(relative(workspaceRoot, absolute))}`;
  throw new Error(`Build input escaped the declared app/workspace namespaces: ${absolute}`);
}

async function regularFile(path) {
  try {
    const info = await lstat(path);
    return info.isFile() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

async function resolveLocalModule(importer, specifier) {
  const clean = specifier.replace(/[?#].*$/u, "");
  if (!clean.startsWith(".")) return undefined;
  const base = resolve(dirname(importer), clean);
  const explicitModuleExtension = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".css"].includes(extname(base).toLowerCase());
  const candidates = explicitModuleExtension
    ? [base]
    : [base, ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".css"].map((extension) => `${base}${extension}`),
        ...["index.ts", "index.tsx", "index.js", "index.mjs", "index.json"].map((name) => resolve(base, name))];
  for (const candidate of candidates) if (await regularFile(candidate)) return candidate;
  throw new Error(`Unable to resolve local product dependency ${specifier} from ${importer}`);
}

export function productDependencyBoundary(root, workspaceRoot, target) {
  if (isInside(root, target)) return root;
  for (const declared of WORKSPACE_INPUT_ROOTS) {
    const boundary = resolve(workspaceRoot, declared);
    if (isInside(boundary, target)) return boundary;
  }
  throw new Error(`Product dependency escaped the declared app/workspace input roots: ${target}`);
}

async function dependencyClosure(root, entrypoints, { includeDeclarations = false, workspaceRoot = resolve(root, "../..") } = {}) {
  const pending = entrypoints.map((path) => resolve(root, path));
  const visited = new Set();
  while (pending.length) {
    const current = pending.pop();
    if (visited.has(current)) continue;
    await assertNoSymlinkAncestry(productDependencyBoundary(root, workspaceRoot, current), current);
    const info = await lstat(current);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Product dependency is not a regular file: ${current}`);
    visited.add(current);
    const extension = extname(current).toLowerCase();
    if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(extension)) continue;
    const source = (await readRegularFile(current)).toString("utf8");
    for (const specifier of productModuleSpecifiers(source, current)) {
      const dependency = await resolveLocalModule(current, specifier);
      if (dependency) pending.push(dependency);
    }
    if (includeDeclarations && current.endsWith(".mjs")) {
      const declaration = current.slice(0, -4) + ".d.mts";
      if (await regularFile(declaration)) pending.push(declaration);
    }
  }
  return [...visited];
}

async function collect(root, workspaceRoot, requested, { exclude = () => false } = {}) {
  const files = new Map();
  const ignoredGeneratedEntry = (name, isDirectory) => isDirectory
    ? name === "__pycache__"
    : name.endsWith(".pyc") || name.endsWith(".pyo");
  async function visit(path) {
    const boundary = isInside(root, path) ? root : workspaceRoot;
    await assertNoSymlinkAncestry(boundary, path);
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`Build identity rejects symlink input: ${path}`);
    const label = labelFor(root, workspaceRoot, path);
    if (exclude(label, info.isDirectory())) return;
    if (info.isFile()) {
      const bytes = await readRegularFile(path);
      files.set(label, { path: label, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
      return;
    }
    if (!info.isDirectory()) throw new Error(`Build identity rejects non-file input: ${path}`);
    const entries = await readdir(path, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      if (ignoredGeneratedEntry(entry.name, entry.isDirectory())) continue;
      await visit(resolve(path, entry.name));
    }
  }
  for (const item of requested) await visit(resolve(item));
  return [...files.values()].sort((left, right) => left.path.localeCompare(right.path, "en"));
}

export function aggregateBuildFiles(files) {
  const hash = createHash("sha256");
  let bytes = 0;
  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path, "en"))) {
    hash.update(file.path).update("\0").update(String(file.bytes)).update("\0").update(file.sha256).update("\n");
    bytes += file.bytes;
  }
  return { files: files.length, bytes, sha256: hash.digest("hex") };
}

async function productInputFiles(rootInput) {
  const root = resolve(rootInput);
  const workspaceRoot = resolve(root, "../..");
  const [modules, scripts] = await Promise.all([
    dependencyClosure(root, PRODUCT_MODULE_ENTRYPOINTS, { workspaceRoot }),
    dependencyClosure(root, [...PRODUCT_PIPELINE_SCRIPT_ENTRYPOINTS, ...FRONTEND_QUALITY_GATES.map(gate => gate.script)], { includeDeclarations: true, workspaceRoot }),
  ]);
  for (const path of [...modules, ...scripts]) {
    const label = labelFor(root, workspaceRoot, path);
    const reason = productInputExclusionReason(label);
    if (reason) throw new Error(`Product dependency crossed ${reason} boundary: ${label}`);
  }
  const requested = [
    ...APP_INPUT_ROOTS.map((path) => resolve(root, path)),
    ...WORKSPACE_INPUT_ROOTS.map((path) => resolve(workspaceRoot, path)),
    ...modules,
    ...scripts,
  ];
  return collect(root, workspaceRoot, requested, {
    exclude: (path, isDirectory) => !isDirectory && Boolean(productInputExclusionReason(path)),
  });
}

async function productOutputFiles(rootInput) {
  const root = resolve(rootInput);
  return collect(root, resolve(root, "../.."), outputPaths().map((path) => resolve(root, path)));
}

function validEntryList(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return false;
  const seen = new Set();
  const seenFolded = new Set();
  let previous = "";
  for (const entry of entries) {
    if (!entry || typeof entry.path !== "string" || entry.path.includes("\\") || entry.path.startsWith("/") || isAbsolute(entry.path)
      || entry.path.split("/").some((part) => !part || part === "." || part === "..")
      || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !/^[a-f0-9]{64}$/u.test(entry.sha256)
      || seen.has(entry.path) || seenFolded.has(entry.path.toLocaleLowerCase("en-US")) || (previous && previous.localeCompare(entry.path, "en") > 0)) return false;
    seen.add(entry.path);
    seenFolded.add(entry.path.toLocaleLowerCase("en-US"));
    previous = entry.path;
  }
  return true;
}

export function productReleaseManifestFindings(manifest) {
  const findings = [];
  if (manifest?.schemaVersion !== 2) findings.push({ code: "schema-version" });
  if (canonicalJson(manifest?.scope) !== canonicalJson(PRODUCT_RELEASE_SCOPE)) findings.push({ code: "product-scope" });
  if (!validEntryList(manifest?.inputs)) findings.push({ code: "invalid-input-inventory" });
  if (!validEntryList(manifest?.outputs)) findings.push({ code: "invalid-output-inventory" });
  const inputs = Array.isArray(manifest?.inputs) ? manifest.inputs : [];
  const outputs = Array.isArray(manifest?.outputs) ? manifest.outputs : [];
  const inputPaths = new Set(inputs.map((entry) => entry?.path));
  const outputPaths = new Set(outputs.map((entry) => entry?.path));
  const excluded = inputs.flatMap((entry) => {
    const reason = productInputExclusionReason(entry?.path);
    return reason ? [{ path: entry?.path, reason }] : [];
  });
  if (excluded.length) findings.push({ code: "excluded-product-input", entries: excluded });
  const privateOutputs = outputs.filter((entry) => /(?:^|\/)\.?personal-packs\//iu.test(entry?.path ?? "")
    && !/^\.personal-packs\/hao-music-library\//u.test(entry?.path ?? ""));
  if (privateOutputs.length) findings.push({ code: "owner-only-product-output", paths: privateOutputs.map((entry) => entry.path) });
  const missingInputs = PRODUCT_REQUIRED_INPUT_PATHS.filter((path) => !inputPaths.has(path));
  if (missingInputs.length) findings.push({ code: "missing-required-product-input", paths: missingInputs });
  const missingOutputs = PRODUCT_REQUIRED_OUTPUT_PATHS.filter((path) => !outputPaths.has(path));
  if (missingOutputs.length || ![...outputPaths].some((path) => typeof path === "string" && path.startsWith("dist/"))) {
    findings.push({ code: "missing-required-product-output", paths: missingOutputs });
  }
  if (validEntryList(inputs) && canonicalJson(manifest?.inputIdentity) !== canonicalJson(aggregateBuildFiles(inputs))) findings.push({ code: "input-identity" });
  if (validEntryList(outputs) && canonicalJson(manifest?.outputIdentity) !== canonicalJson(aggregateBuildFiles(outputs))) findings.push({ code: "output-identity" });
  return findings;
}

export async function computeBuildInputIdentity(root) {
  return aggregateBuildFiles(await productInputFiles(root));
}

export async function computeBuildOutputIdentity(root) {
  return aggregateBuildFiles(await productOutputFiles(root));
}

export async function computeBuildReceipt(root) {
  const [inputs, outputs] = await Promise.all([productInputFiles(root), productOutputFiles(root)]);
  return {
    scope: PRODUCT_RELEASE_SCOPE,
    inputs,
    outputs,
    inputIdentity: aggregateBuildFiles(inputs),
    outputIdentity: aggregateBuildFiles(outputs),
  };
}

export function buildManifestIdentityMatches(actual, expected) {
  const identityMatches = (left, right) => left?.files === right?.files
    && left?.bytes === right?.bytes && left?.sha256 === right?.sha256;
  return actual?.schemaVersion === expected?.schemaVersion
    && actual?.product === expected?.product
    && actual?.productVersion === expected?.productVersion
    && canonicalJson(actual?.scope) === canonicalJson(expected?.scope)
    && identityMatches(actual?.inputIdentity, expected?.inputIdentity)
    && identityMatches(actual?.outputIdentity, expected?.outputIdentity);
}
