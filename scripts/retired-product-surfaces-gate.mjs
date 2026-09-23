import { readFile, readdir, lstat, realpath } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

const appRoot = resolve(import.meta.dirname, "..");
const policyPath = resolve(appRoot, "config/retired-product-surfaces.json");
const expectedSchema = "editkin.retired-product-surfaces/v1";
const allowedRoles = new Set([
  "product-build-policy",
  "product-denial-gate",
  "product-negative-control",
  "research-executor",
  "research-helper",
]);

const normalize = (value) => String(value).split(sep).join("/");
const sorted = (values) => [...values].sort((left, right) => left.localeCompare(right, "en"));
const sameStrings = (left, right) => JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
const unique = (values) => new Set(values).size === values.length;
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

function safeRelativePath(value) {
  return typeof value === "string"
    && value.length > 0
    && !value.includes("\\")
    && !value.startsWith("/")
    && !isAbsolute(value)
    && value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validatePolicy(policy) {
  const errors = [];
  if (!isRecord(policy) || policy.schema !== expectedSchema) errors.push("schema");
  if (typeof policy?.policyId !== "string" || !policy.policyId) errors.push("policyId");
  if (!safeRelativePath(policy?.packageJson)) errors.push("packageJson");
  if (typeof policy?.researchScriptPrefix !== "string" || !policy.researchScriptPrefix.startsWith("research:")) errors.push("researchScriptPrefix");
  if (!isRecord(policy?.gateScripts) || !isRecord(policy?.requiredResearchScripts)) errors.push("scriptMaps");
  if (!Array.isArray(policy?.retiredProductScriptNames) || !unique(policy.retiredProductScriptNames)) errors.push("retiredProductScriptNames");
  if (!isRecord(policy?.researchSurfaceDiscovery)
    || !Array.isArray(policy.researchSurfaceDiscovery.roots)
    || !Array.isArray(policy.researchSurfaceDiscovery.extensions)
    || !Array.isArray(policy.researchSurfaceDiscovery.pathPatterns)
    || !Array.isArray(policy.researchSurfaceDiscovery.contentPatterns)
    || !Array.isArray(policy.researchSurfaceDiscovery.excludedPaths)) errors.push("researchSurfaceDiscovery");
  const classified = policy?.classifiedResearchSurfaceFiles;
  if (!Array.isArray(classified)
    || !unique(classified.map((entry) => entry?.path))
    || classified.some((entry) => !isRecord(entry) || !safeRelativePath(entry.path) || !allowedRoles.has(entry.role))) errors.push("classifiedResearchSurfaceFiles");
  const features = policy?.retiredCargoFeatures;
  if (!Array.isArray(features)
    || !unique(features.map((entry) => `${entry?.manifestPath}:${entry?.feature}`))
    || features.some((entry) => !isRecord(entry) || !safeRelativePath(entry.manifestPath)
      || !safeRelativePath(entry.sentinelPath) || typeof entry.feature !== "string"
      || !Array.isArray(entry.expectedDependencies) || typeof entry.sentinelMessage !== "string")) errors.push("retiredCargoFeatures");
  const bindings = policy?.pipelineBindings;
  if (!Array.isArray(bindings)
    || !unique(bindings.map((entry) => entry?.path))
    || bindings.some((entry) => !isRecord(entry) || !safeRelativePath(entry.path)
      || !Array.isArray(entry.requiredMarkers) || entry.requiredMarkers.length === 0
      || entry.requiredMarkers.some((marker) => typeof marker !== "string" || !marker))) errors.push("pipelineBindings");
  const provenance = policy?.provenanceFiles;
  if (!Array.isArray(provenance)
    || !unique(provenance.map((entry) => entry?.path))
    || provenance.some((entry) => !isRecord(entry) || !safeRelativePath(entry.path)
      || !Array.isArray(entry.requiredMarkers) || entry.requiredMarkers.length === 0
      || entry.requiredMarkers.some((marker) => typeof marker !== "string" || !marker))) errors.push("provenanceFiles");
  for (const pattern of [...(policy?.researchSurfaceDiscovery?.pathPatterns ?? []), ...(policy?.researchSurfaceDiscovery?.contentPatterns ?? [])]) {
    try { new RegExp(pattern, "u"); } catch { errors.push(`invalidRegex:${pattern}`); }
  }
  for (const path of [
    ...(policy?.researchSurfaceDiscovery?.roots ?? []),
    ...(policy?.researchSurfaceDiscovery?.excludedPaths ?? []),
  ]) if (!safeRelativePath(path)) errors.push(`unsafePath:${path}`);
  if (errors.length) throw new Error(`Invalid retired-product-surfaces policy: ${[...new Set(errors)].join(", ")}`);
}

function parseFeatureSection(source) {
  const entries = new Map();
  const lines = source.split(/\r?\n/u);
  const start = lines.findIndex((line) => /^\s*\[features\]\s*$/u.test(line));
  if (start < 0) return entries;
  for (const line of lines.slice(start + 1)) {
    if (/^\s*\[[^\]]+\]\s*$/u.test(line)) break;
    const entry = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(\[[^\n]*\])\s*(?:#.*)?$/u);
    if (!entry) continue;
    try {
      const value = JSON.parse(entry[2]);
      if (Array.isArray(value) && value.every((item) => typeof item === "string")) entries.set(entry[1], value);
    } catch {
      entries.set(entry[1], undefined);
    }
  }
  return entries;
}

function sentinelPresent(source, feature, message) {
  const pattern = new RegExp(
    `#\\[cfg\\(feature\\s*=\\s*"${escapeRegex(feature)}"\\)\\]\\s*compile_error!\\("${escapeRegex(message)}"\\);`,
    "u",
  );
  return pattern.test(source);
}

function referencedPath(command, path) {
  const normalizedCommand = String(command).replace(/\\/gu, "/");
  return normalizedCommand.includes(path);
}

function featureArgumentPresent(command, feature) {
  const normalized = String(command).replace(/\s+/gu, " ");
  return new RegExp(`(?:--features(?:=|\\s+)[^&|;]*|-F(?:=|\\s*)[^&|;]*)${escapeRegex(feature)}`, "u").test(normalized);
}

function evaluate(policy, snapshot) {
  const findings = [];
  const add = (code, details = {}) => findings.push({ code, ...details });
  const scripts = snapshot.packageScripts;

  for (const [name, command] of Object.entries(policy.gateScripts)) {
    if (scripts[name] !== command) add("gate-script-drift", { name, expected: command, actual: scripts[name] ?? null });
  }
  for (const name of policy.retiredProductScriptNames) {
    if (Object.hasOwn(scripts, name)) add("retired-product-script-reachable", { name, command: scripts[name] });
  }
  for (const [name, command] of Object.entries(policy.requiredResearchScripts)) {
    if (scripts[name] !== command) add("research-script-drift", { name, expected: command, actual: scripts[name] ?? null });
  }
  const actualResearchNames = Object.keys(scripts).filter((name) => name.startsWith(policy.researchScriptPrefix));
  const expectedResearchNames = Object.keys(policy.requiredResearchScripts);
  if (!sameStrings(actualResearchNames, expectedResearchNames)) {
    add("research-script-closed-world", {
      missing: expectedResearchNames.filter((name) => !actualResearchNames.includes(name)),
      unclassified: actualResearchNames.filter((name) => !expectedResearchNames.includes(name)),
    });
  }

  const classifiedPaths = policy.classifiedResearchSurfaceFiles.map((entry) => entry.path);
  if (!sameStrings(snapshot.discoveredResearchSurfacePaths, classifiedPaths)) {
    add("research-surface-closed-world", {
      missing: classifiedPaths.filter((path) => !snapshot.discoveredResearchSurfacePaths.includes(path)),
      unclassified: snapshot.discoveredResearchSurfacePaths.filter((path) => !classifiedPaths.includes(path)),
    });
  }
  for (const entry of policy.classifiedResearchSurfaceFiles) {
    if (!snapshot.regularPaths.includes(entry.path)) add("classified-surface-missing-or-not-regular", { path: entry.path, role: entry.role });
  }

  const researchRuntimePaths = policy.classifiedResearchSurfaceFiles
    .filter((entry) => entry.role === "research-executor" || entry.role === "research-helper")
    .map((entry) => entry.path);
  for (const [name, command] of Object.entries(scripts)) {
    if (!name.startsWith(policy.researchScriptPrefix)) {
      for (const path of researchRuntimePaths) {
        if (referencedPath(command, path)) add("research-surface-in-product-namespace", { name, path });
      }
      for (const feature of policy.retiredCargoFeatures) {
        if (featureArgumentPresent(command, feature.feature)) add("retired-feature-in-product-command", { name, feature: feature.feature });
      }
    }
  }

  for (const feature of snapshot.features) {
    if (!feature.manifestRegular) add("cargo-manifest-missing-or-not-regular", { path: feature.manifestPath });
    if (feature.defaultFeatures.includes(feature.feature)) add("retired-feature-default-enabled", { path: feature.manifestPath, feature: feature.feature });
    if (!feature.declarationPresent || !sameStrings(feature.dependencies, feature.expectedDependencies)) {
      add("retired-feature-declaration-drift", {
        path: feature.manifestPath,
        feature: feature.feature,
        expected: feature.expectedDependencies,
        actual: feature.declarationPresent ? feature.dependencies : null,
      });
    }
    if (!feature.sentinelRegular || !feature.sentinelPresent) {
      add("retired-feature-sentinel-missing", { path: feature.sentinelPath, feature: feature.feature });
    }
  }

  for (const binding of snapshot.pipelineBindings) {
    if (!binding.regular) add("pipeline-binding-missing-or-not-regular", { path: binding.path });
    else if (binding.missingMarkers.length) add("pipeline-binding-drift", { path: binding.path, missingMarkers: binding.missingMarkers });
  }

  for (const provenance of snapshot.provenance) {
    if (!provenance.regular) add("research-provenance-missing-or-not-regular", { path: provenance.path });
    else if (provenance.missingMarkers.length) add("research-provenance-marker-drift", { path: provenance.path, missingMarkers: provenance.missingMarkers });
  }
  if (snapshot.symlinkPaths.length) add("symlink-rejected", { paths: snapshot.symlinkPaths });
  return findings;
}

async function regularSource(pathInput, symlinkPaths) {
  const absolute = resolve(appRoot, pathInput);
  const relation = relative(appRoot, absolute);
  if (relation.startsWith("..") || isAbsolute(relation)) throw new Error(`Policy path escaped app root: ${pathInput}`);
  let cursor = appRoot;
  for (const part of normalize(relation).split("/").filter(Boolean)) {
    cursor = resolve(cursor, part);
    let info;
    try { info = await lstat(cursor); } catch { return undefined; }
    if (info.isSymbolicLink()) {
      symlinkPaths.add(normalize(relative(appRoot, cursor)));
      return undefined;
    }
  }
  const [canonicalRoot, canonicalPath] = await Promise.all([realpath(appRoot), realpath(absolute)]);
  const canonicalRelation = relative(canonicalRoot, canonicalPath);
  if (canonicalRelation.startsWith("..") || isAbsolute(canonicalRelation)) throw new Error(`Canonical policy path escaped app root: ${pathInput}`);
  const info = await lstat(absolute);
  if (!info.isFile()) return undefined;
  return readFile(absolute, "utf8");
}

async function discoverResearchSurfaces(policy, symlinkPaths) {
  const discovery = policy.researchSurfaceDiscovery;
  const extensions = new Set(discovery.extensions);
  const excluded = new Set(discovery.excludedPaths);
  const pathPatterns = discovery.pathPatterns.map((pattern) => new RegExp(pattern, "u"));
  const contentPatterns = discovery.contentPatterns.map((pattern) => new RegExp(pattern, "u"));
  const discovered = [];
  async function visit(pathInput) {
    const absolute = resolve(appRoot, pathInput);
    const info = await lstat(absolute);
    const label = normalize(relative(appRoot, absolute));
    if (info.isSymbolicLink()) {
      symlinkPaths.add(label);
      return;
    }
    if (info.isDirectory()) {
      const entries = await readdir(absolute, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
      for (const entry of entries) await visit(`${label}/${entry.name}`);
      return;
    }
    if (!info.isFile() || excluded.has(label) || !extensions.has(extname(label))) return;
    const source = await readFile(absolute, "utf8");
    if (pathPatterns.some((pattern) => pattern.test(label)) || contentPatterns.some((pattern) => pattern.test(source))) discovered.push(label);
  }
  for (const root of discovery.roots) await visit(root);
  return sorted(discovered);
}

async function collectSnapshot(policy) {
  const symlinkPaths = new Set();
  const packageSource = await regularSource(policy.packageJson, symlinkPaths);
  if (packageSource === undefined) throw new Error(`Package file is missing or not regular: ${policy.packageJson}`);
  const packageValue = JSON.parse(packageSource);
  if (!isRecord(packageValue) || !isRecord(packageValue.scripts)) throw new Error("package.json scripts must be an object");
  const packageScripts = Object.fromEntries(Object.entries(packageValue.scripts).map(([name, command]) => {
    if (typeof command !== "string") throw new Error(`package script must be a string: ${name}`);
    return [name, command];
  }));

  const regularPaths = [];
  for (const entry of policy.classifiedResearchSurfaceFiles) {
    if (await regularSource(entry.path, symlinkPaths) !== undefined) regularPaths.push(entry.path);
  }
  const features = [];
  for (const configured of policy.retiredCargoFeatures) {
    const [manifestSource, sentinelSource] = await Promise.all([
      regularSource(configured.manifestPath, symlinkPaths),
      regularSource(configured.sentinelPath, symlinkPaths),
    ]);
    const featureMap = manifestSource === undefined ? new Map() : parseFeatureSection(manifestSource);
    features.push({
      ...configured,
      manifestRegular: manifestSource !== undefined,
      sentinelRegular: sentinelSource !== undefined,
      defaultFeatures: featureMap.get("default") ?? [],
      declarationPresent: featureMap.has(configured.feature) && Array.isArray(featureMap.get(configured.feature)),
      dependencies: featureMap.get(configured.feature) ?? [],
      sentinelPresent: sentinelSource !== undefined && sentinelPresent(sentinelSource, configured.feature, configured.sentinelMessage),
    });
  }
  const provenance = [];
  for (const configured of policy.provenanceFiles) {
    const source = await regularSource(configured.path, symlinkPaths);
    provenance.push({
      path: configured.path,
      regular: source !== undefined,
      missingMarkers: source === undefined ? [...configured.requiredMarkers] : configured.requiredMarkers.filter((marker) => !source.includes(marker)),
    });
  }
  const pipelineBindings = [];
  for (const configured of policy.pipelineBindings) {
    const source = await regularSource(configured.path, symlinkPaths);
    pipelineBindings.push({
      path: configured.path,
      regular: source !== undefined,
      missingMarkers: source === undefined ? [...configured.requiredMarkers] : configured.requiredMarkers.filter((marker) => !source.includes(marker)),
    });
  }
  return {
    packageScripts,
    discoveredResearchSurfacePaths: await discoverResearchSurfaces(policy, symlinkPaths),
    regularPaths,
    features,
    pipelineBindings,
    provenance,
    symlinkPaths: sorted(symlinkPaths),
  };
}

function validSelfTestSnapshot(policy) {
  return {
    packageScripts: {
      ...policy.gateScripts,
      ...policy.requiredResearchScripts,
      "product:safe": "node scripts/product-safe.mjs",
    },
    discoveredResearchSurfacePaths: policy.classifiedResearchSurfaceFiles.map((entry) => entry.path),
    regularPaths: policy.classifiedResearchSurfaceFiles.map((entry) => entry.path),
    features: policy.retiredCargoFeatures.map((feature) => ({
      ...feature,
      manifestRegular: true,
      sentinelRegular: true,
      defaultFeatures: [],
      declarationPresent: true,
      dependencies: [...feature.expectedDependencies],
      sentinelPresent: true,
    })),
    pipelineBindings: policy.pipelineBindings.map((entry) => ({ path: entry.path, regular: true, missingMarkers: [] })),
    provenance: policy.provenanceFiles.map((entry) => ({ path: entry.path, regular: true, missingMarkers: [] })),
    symlinkPaths: [],
  };
}

function runSelfTest(policy) {
  const valid = validSelfTestSnapshot(policy);
  const validFindings = evaluate(policy, valid);
  if (validFindings.length) throw new Error(`Valid retirement fixture rejected: ${JSON.stringify(validFindings)}`);
  const mutations = [
    ["old-product-script", "retired-product-script-reachable", (snapshot) => { snapshot.packageScripts[policy.retiredProductScriptNames[0]] = "node scripts/legacy.mjs"; }],
    ["research-command-in-product", "research-surface-in-product-namespace", (snapshot) => {
      const target = policy.classifiedResearchSurfaceFiles.find((entry) => entry.role === "research-executor").path;
      snapshot.packageScripts["product:leak"] = `node ${target}`;
    }],
    ["unclassified-research-file", "research-surface-closed-world", (snapshot) => { snapshot.discoveredResearchSurfacePaths.push("scripts/new-sam21-runner.mjs"); }],
    ["missing-classified-file", "classified-surface-missing-or-not-regular", (snapshot) => { snapshot.regularPaths = snapshot.regularPaths.slice(1); }],
    ["retired-feature-default", "retired-feature-default-enabled", (snapshot) => { snapshot.features[0].defaultFeatures.push(snapshot.features[0].feature); }],
    ["missing-compile-sentinel", "retired-feature-sentinel-missing", (snapshot) => { snapshot.features[0].sentinelPresent = false; }],
    ["feature-argument-bypass", "retired-feature-in-product-command", (snapshot) => { snapshot.packageScripts["product:bypass"] = `cargo build --features ${snapshot.features[0].feature}`; }],
    ["pipeline-unbound", "pipeline-binding-drift", (snapshot) => { snapshot.pipelineBindings[0].missingMarkers.push("retired-product-surfaces-gate.mjs"); }],
    ["missing-provenance", "research-provenance-missing-or-not-regular", (snapshot) => { snapshot.provenance[0].regular = false; }],
    ["fake-history-rewrite", "research-provenance-marker-drift", (snapshot) => { snapshot.provenance[0].missingMarkers.push("facebookresearch/sam2"); }],
    ["symlink-surface", "symlink-rejected", (snapshot) => { snapshot.symlinkPaths.push("scripts/linked-research.mjs"); }],
  ];
  for (const [name, expectedCode, mutate] of mutations) {
    const snapshot = structuredClone(valid);
    mutate(snapshot);
    const findings = evaluate(policy, snapshot);
    if (!findings.some((finding) => finding.code === expectedCode)) {
      throw new Error(`Retirement evaluator accepted ${name}; findings=${JSON.stringify(findings)}`);
    }
  }
  process.stdout.write(`${JSON.stringify({ schema: "editkin.retired-product-surfaces-self-test/v1", status: "GREEN_SELF_TEST", negativeControls: mutations.length })}\n`);
}

const policy = JSON.parse(await readFile(policyPath, "utf8"));
validatePolicy(policy);
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--self-test") {
  runSelfTest(policy);
} else if (args.length === 0) {
  const snapshot = await collectSnapshot(policy);
  const findings = evaluate(policy, snapshot);
  const report = {
    schema: "editkin.retired-product-surfaces-gate/v1",
    status: findings.length ? "FAIL" : "GREEN_RETIRED_PRODUCT_SURFACES",
    policyId: policy.policyId,
    checks: {
      retiredProductScripts: policy.retiredProductScriptNames.length,
      researchScripts: Object.keys(policy.requiredResearchScripts).length,
      classifiedResearchSurfaces: policy.classifiedResearchSurfaceFiles.length,
      retiredCargoFeatures: policy.retiredCargoFeatures.length,
      pipelineBindings: policy.pipelineBindings.length,
      provenanceFiles: policy.provenanceFiles.length,
    },
    findings,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (findings.length) process.exitCode = 1;
} else {
  throw new Error("retired-product-surfaces-gate accepts only --self-test or no arguments");
}
