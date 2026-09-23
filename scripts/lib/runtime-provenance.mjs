import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const SHA256 = /^[a-f0-9]{64}$/;

export function parseVersion(value) {
  const match = String(value).trim().match(/^v?(\d+)\.(\d+)(?:\.(\d+))?$/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

export function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

export function evaluateRuntimeMetadata(input) {
  const minimumText = String(input.engineRange ?? "").match(/^>=\s*(\d+\.\d+(?:\.\d+)?)$/)?.[1];
  const minimum = minimumText ? parseVersion(minimumText) : null;
  const build = parseVersion(input.buildNodeVersion);
  const runtime = parseVersion(input.runtimeNodeVersion);
  const manifest = input.manifest ?? {};
  const expectedSource = runtime
    ? `https://nodejs.org/dist/v${manifest.version}/node-v${manifest.version}-win-x64.zip`
    : "";
  const checks = {
    exactMinimumRange: Boolean(minimum),
    buildVersionValid: Boolean(build),
    runtimeVersionValid: Boolean(runtime),
    buildMeetsMinimum: Boolean(minimum && build && compareVersions(build, minimum) >= 0),
    buildExecutableSha256Matches: SHA256.test(String(input.buildNodeSha256 ?? ""))
      && input.buildNodeSha256 === input.executableSha256,
    buildNodeSourceOwned: input.buildNodeSource === input.expectedBuildNodeSource,
    runtimeMeetsMinimum: Boolean(minimum && runtime && compareVersions(runtime, minimum) >= 0),
    manifestMatchesRuntime: Boolean(runtime && manifest.version === String(input.runtimeNodeVersion).replace(/^v/, "")),
    officialArchiveSource: manifest.source === expectedSource,
    archiveSha256Recorded: SHA256.test(String(manifest.archiveSha256 ?? "")),
    executableSha256Matches: SHA256.test(String(manifest.nodeExeSha256 ?? ""))
      && manifest.nodeExeSha256 === input.executableSha256,
    licenseSha256Matches: SHA256.test(String(manifest.licenseSha256 ?? ""))
      && manifest.licenseSha256 === input.licenseSha256,
  };
  const failures = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  return {
    status: failures.length === 0 ? "GREEN" : "BLOCK",
    minimumNodeVersion: minimumText ?? null,
    buildNodeVersion: input.buildNodeVersion,
    runtimeNodeVersion: input.runtimeNodeVersion,
    manifestVersion: manifest.version ?? null,
    source: manifest.source ?? null,
    hashes: {
      archiveSha256: manifest.archiveSha256 ?? null,
      buildExecutableSha256: input.buildNodeSha256 ?? null,
      executableSha256: input.executableSha256,
      licenseSha256: input.licenseSha256,
    },
    checks,
    failures,
  };
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

export async function inspectRuntimeProvenance({ packageJson, manifest, nodePath, licensePath, buildReceipt }) {
  const versionResult = spawnSync(nodePath, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
  const runtimeNodeVersion = versionResult.status === 0 ? versionResult.stdout.trim() : "unavailable";
  const executableSha256 = await sha256(nodePath);
  const report = evaluateRuntimeMetadata({
    engineRange: packageJson.engines?.node,
    buildNodeVersion: buildReceipt?.nodeVersion,
    buildNodeSha256: buildReceipt?.nodeSha256,
    buildNodeSource: buildReceipt?.nodeSource,
    expectedBuildNodeSource: "vendor/node/win32-x64/node.exe",
    runtimeNodeVersion,
    manifest,
    executableSha256,
    licenseSha256: await sha256(licensePath),
  });
  return {
    ...report,
    buildReceipt: { schemaVersion: buildReceipt?.schemaVersion ?? null, source: buildReceipt?.nodeSource ?? null },
    process: { exitCode: versionResult.status, stderr: versionResult.stderr?.trim() || null },
  };
}
