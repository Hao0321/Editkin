import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { OWNER_VISUAL_GRANT } from "../../src/shared/visualAssetRights.mjs";
import { NATIVE_SHARED_PROCESS_INPUTS } from "./native-shared-inputs.mjs";

const OWNER_VISUAL_SOURCE_PREFIX = "workspace/community/hao-motion-kit/";
const OWNER_VISUAL_OUTPUT_PREFIX = ".creative-packs/hao-creator-library/";
const ownerVisualOutputs = OWNER_VISUAL_GRANT.assets.flatMap((asset) => {
  const previewKey = createHash("sha256").update(JSON.stringify(asset.id)).digest("hex").slice(0, 20);
  const safeId = asset.id.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();
  return [
    `${OWNER_VISUAL_OUTPUT_PREFIX}assets/${asset.category}/${safeId}${extname(asset.sourcePath).toLowerCase()}`,
    `${OWNER_VISUAL_OUTPUT_PREFIX}previews/${previewKey}/poster.jpg`,
    `${OWNER_VISUAL_OUTPUT_PREFIX}previews/${previewKey}/preview.mp4`,
  ];
});

const APP_INPUT_ROOTS = [
  ".build-node-receipt.json",
  "index.html",
  "forge.config.cjs",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "vite.config.ts",
  "performance-budgets.json",
  "config/retired-product-surfaces.json",
  "THIRD_PARTY_NOTICES.md",
  "src-tauri/icons",
  "src-tauri/capabilities",
  "src-tauri/remote-relay.json",
  "src-tauri/Cargo.toml",
  "src-tauri/Cargo.lock",
  "src-tauri/build.rs",
  "src-tauri/src",
  "src-tauri/tauri.conf.json",
  "src-tauri/tauri.android.conf.json",
  "src-tauri/tauri.existing-dev-server.conf.json",
  "src-tauri/tauri.ios.conf.json",
  "src-tauri/tauri.windows.conf.json",
  "src-tauri/tauri.macos.conf.json",
  "src/shared/agentSetupContract.json",
  "scripts/editkin-product-mcp-launcher.mjs",
  "public/demo-source.mp4",
  "public/editkin-demo-preview.mp4",
  "public/fonts",
  "public/color/aces2",
  "plugins",
  "native/hao-core/Cargo.toml",
  "native/hao-core/Cargo.lock",
  "native/hao-core/src/engine",
  "native/hao-core/src/lib.rs",
  "native/hao-core/src/main.rs",
  "native/shared",
  "spikes/gpu-compositor/Cargo.toml",
  "spikes/gpu-compositor/Cargo.lock",
  "spikes/gpu-compositor/src",
  "vendor/node/win32-x64",
  "vendor/ffmpeg/win32-x64",
  "vendor/whisper/win32-x64",
  ".personal-packs/hao-music-library/COMMUNITY-ASSET-GRANT.md",
];

const PRODUCT_MODULE_ENTRYPOINTS = [
  "src/main.tsx",
  "electron/main.ts",
  "electron/preload.ts",
  "src/mcp/server.ts",
  "src/service/cli.ts",
  "src/remote/server.ts",
];

const PRODUCT_PIPELINE_SCRIPT_ENTRYPOINTS = [
  "scripts/editkin-mcp-generation-preflight-worker.mjs",
  "scripts/tauri-frontend.mjs",
  "scripts/tauri-build.mjs",
  "scripts/tauri-build-isolation-runner.mjs",
  "scripts/build-tauri-product-binary.mjs",
  "scripts/product-agent-connect-delivery-gate.mjs",
  "scripts/build-native-core.mjs",
  "scripts/build-gpu-compositor.mjs",
  "scripts/build-creative-pack.mjs",
  "scripts/archive-creative-pack.mjs",
  "scripts/build-personal-music-pack.mjs",
  "scripts/personal-music-pack-gate.mjs",
  "scripts/generate-sbom.mjs",
  "scripts/bundle-size-gate.mjs",
  "scripts/build-web-public.mjs",
  "scripts/build-desktop.mjs",
  "scripts/build-release-input-manifest.mjs",
  "scripts/stage-platform-runtime.mjs",
  "scripts/stage-tauri-resources.mjs",
  "scripts/stage-desktop-resources.mjs",
  "scripts/product-release-manifest-policy-gate.mjs",
  "scripts/auto-roto-native-product-artifact-freshness-gate.ts",
  "scripts/artifact-lifecycle-gate.mjs",
  "scripts/security-hardening-gate.mjs",
  "scripts/macos-bundle-runtime-gate.mjs",
  "scripts/editkin-skill-pack-gate.ts",
  "scripts/editkin-mcp-generation-launcher.mjs",
  "scripts/editkin-product-mcp-launcher.mjs",
  "scripts/activate-editkin-mcp-generation.mjs",
  "scripts/editkin-mcp-generation-self-test.mjs",
  "scripts/update-channel.mjs",
  "scripts/retired-product-surfaces-gate.mjs",
];

const WORKSPACE_INPUT_ROOTS = [
  "community/hao-motion-kit",
  "assets/bgm",
  "video-autopilot-kit/knowledge/runtime/filter_library.json",
];

export const PRODUCT_REQUIRED_INPUT_PATHS = Object.freeze([
  ...NATIVE_SHARED_PROCESS_INPUTS,
  "scripts/lib/native-shared-inputs.mjs",
  "src/application/autoRotoNativeProduct.ts",
  "src/application/autoRotoProductContract.ts",
  "src/domain/autoRotoPreviewProjection.ts",
  "src/domain/autoRotoProductReceipt.ts",
  "src/render/autoRotoMatteIntegrity.ts",
  "src/service/autoRotoServiceArtifact.ts",
  "src/service/cli.ts",
  "src/application/updateManager.ts",
  "src/application/updateCache.ts",
  "src/shared/updateVersion.mjs",
  "src/shared/updateVersion.d.mts",
  "src/shared/visualAssetRights.mjs",
  "src/shared/visualAssetRights.d.mts",
  `${OWNER_VISUAL_SOURCE_PREFIX}OWNER_VISUAL_GRANT.json`,
  `${OWNER_VISUAL_SOURCE_PREFIX}OWNER_VISUAL_BUNDLE_GRANT.md`,
  ...OWNER_VISUAL_GRANT.assets.map((asset) => `${OWNER_VISUAL_SOURCE_PREFIX}${asset.sourcePath}`),
  "scripts/update-channel.mjs",
  "native/hao-core/src/engine/auto_roto.rs",
  "src-tauri/src/main.rs",
  "scripts/build-native-core.mjs",
  "scripts/build-tauri-product-binary.mjs",
  "scripts/product-agent-connect-delivery-gate.mjs",
  "scripts/build-release-input-manifest.mjs",
  "scripts/tauri-build.mjs",
  "scripts/lib/build-input-identity.mjs",
  "scripts/lib/desktop-stage-target-policy.mjs",
  "scripts/lib/desktop-stage-target-policy.d.mts",
  "scripts/lib/tauri-product-feature-policy.mjs",
  "scripts/lib/tauri-candidate-artifact-root.mjs",
  "scripts/lib/tauri-candidate-artifact-root.d.mts",
  "scripts/lib/tauri-stage-target-policy.mjs",
  "scripts/product-release-manifest-policy-gate.mjs",
  "scripts/auto-roto-native-product-artifact-freshness-gate.ts",
  "scripts/artifact-lifecycle-gate.mjs",
  "scripts/security-hardening-gate.mjs",
  "scripts/macos-bundle-runtime-gate.mjs",
  "scripts/editkin-skill-pack-gate.ts",
  "scripts/editkin-mcp-generation-launcher.mjs",
  "scripts/editkin-product-mcp-launcher.mjs",
  "scripts/activate-editkin-mcp-generation.mjs",
  "scripts/editkin-mcp-generation-self-test.mjs",
  "scripts/editkin-mcp-generation-preflight-worker.mjs",
  "scripts/lib/editkin-mcp-generation-contract.mjs",
  "scripts/lib/editkin-mcp-generation-preflight.mjs",
  "scripts/lib/editkin-mcp-generation-snapshot.mjs",
  "scripts/lib/editkin-mcp-generation-runtime.mjs",
  "scripts/lib/editkin-mcp-generation-test-harness.mjs",
  "scripts/retired-product-surfaces-gate.mjs",
  "config/retired-product-surfaces.json",
  "scripts/stage-tauri-resources.mjs",
  "scripts/stage-desktop-resources.mjs",
  "forge.config.cjs",
]);

export const PRODUCT_REQUIRED_OUTPUT_PATHS = Object.freeze([
  "desktop-dist/main.mjs",
  "desktop-dist/preload.cjs",
  "desktop-dist/mcp.mjs",
  "desktop-dist/mcp.mjs.material-color-identity.json",
  "desktop-dist/service.mjs",
  "desktop-dist/remote.mjs",
  ".creative-packs/hao-creator-library/editkin-pack.json",
  `${OWNER_VISUAL_OUTPUT_PREFIX}${OWNER_VISUAL_GRANT.document.path}`,
  ...ownerVisualOutputs,
  ".personal-packs/hao-music-library/editkin-personal-music.json",
  "release/editkin.spdx.json",
  "release/THIRD_PARTY_NOTICES.md",
]);

const RESEARCH_ONLY_EXACT_PATHS = new Set([
  "src/application/autoRoto.ts",
  "src/application/autoRotoModelRouter.ts",
  "src/application/autoRotoProductBoundary.ts",
  "src/application/autoRotoVideoModel.ts",
  "src/application/autoRotoVideoPack.ts",
  "native/hao-core/src/engine/auto_roto_onnx.rs",
  "native/hao-core/src/bin/adaptive_optical_alpha_benchmark.rs",
  "native/hao-core/src/bin/optical_alpha_benchmark.rs",
  "native/hao-core/src/bin/region_memory_roto_benchmark.rs",
]);

// Product capability evidence is release governance, not executable runtime
// input. Keeping it outside the product byte identity prevents an impossible
// manifest -> gate report -> ledger -> manifest hash cycle.
const EVIDENCE_ONLY_EXACT_PATHS = new Set(["product-capabilities.json"]);

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
  const candidates = extname(base)
    ? [base]
    : [base, ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".css"].map((extension) => `${base}${extension}`),
        ...["index.ts", "index.tsx", "index.js", "index.mjs", "index.json"].map((name) => resolve(base, name))];
  for (const candidate of candidates) if (await regularFile(candidate)) return candidate;
  throw new Error(`Unable to resolve local product dependency ${specifier} from ${importer}`);
}

function localSpecifiers(source) {
  const values = new Set();
  const patterns = [
    /\b(?:import|export)\s+(?:[^"'`]*?\s+from\s+)?["']([^"']+)["']/gu,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/gu,
  ];
  for (const pattern of patterns) for (const match of source.matchAll(pattern)) values.add(match[1]);
  return [...values];
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
    const source = await readFile(current, "utf8");
    for (const specifier of localSpecifiers(source)) {
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
      const bytes = await readFile(path);
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

function outputPaths() {
  const runtime = process.platform === "win32"
    ? [
        "native/bin/win32-x64/hao-core.exe",
        "native/bin/win32-x64/editkin-gpu-compositor.exe",
        "vendor/node/win32-x64",
        "vendor/ffmpeg/win32-x64",
        "vendor/whisper/win32-x64",
      ]
    : [".platform-runtime"];
  return [
    "dist",
    "desktop-dist",
    ".creative-packs/hao-creator-library",
    ".personal-packs/hao-music-library",
    "release/editkin.spdx.json",
    "release/THIRD_PARTY_NOTICES.md",
    ...runtime,
  ];
}

async function productInputFiles(rootInput) {
  const root = resolve(rootInput);
  const workspaceRoot = resolve(root, "../..");
  const [modules, scripts] = await Promise.all([
    dependencyClosure(root, PRODUCT_MODULE_ENTRYPOINTS, { workspaceRoot }),
    dependencyClosure(root, PRODUCT_PIPELINE_SCRIPT_ENTRYPOINTS, { includeDeclarations: true, workspaceRoot }),
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
