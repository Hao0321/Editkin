import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { evaluateRuntimeMetadata, inspectRuntimeProvenance } from "./lib/runtime-provenance.mjs";

const root = resolve(import.meta.dirname, "..");
const fixture = {
  engineRange: ">=22.13",
  buildNodeVersion: "v22.23.2",
  buildNodeSha256: "b".repeat(64),
  buildNodeSource: "vendor/node/win32-x64/node.exe",
  expectedBuildNodeSource: "vendor/node/win32-x64/node.exe",
  runtimeNodeVersion: "v22.23.2",
  manifest: {
    version: "22.23.2",
    source: "https://nodejs.org/dist/v22.23.2/node-v22.23.2-win-x64.zip",
    archiveSha256: "a".repeat(64),
    nodeExeSha256: "b".repeat(64),
    licenseSha256: "c".repeat(64),
  },
  executableSha256: "b".repeat(64),
  licenseSha256: "c".repeat(64),
};

if (process.argv.includes("--self-test")) {
  const positive = evaluateRuntimeMetadata(fixture);
  const negativeControls = {
    oldBuild: evaluateRuntimeMetadata({ ...fixture, buildNodeVersion: "v20.13.1" }),
    oldRuntime: evaluateRuntimeMetadata({ ...fixture, runtimeNodeVersion: "v20.13.1" }),
    sqliteFlagRequiredRuntime: evaluateRuntimeMetadata({ ...fixture, runtimeNodeVersion: "v22.12.0" }),
    unownedBuildNode: evaluateRuntimeMetadata({ ...fixture, buildNodeSource: "operator-node" }),
    buildExecutableTamper: evaluateRuntimeMetadata({ ...fixture, buildNodeSha256: "d".repeat(64) }),
    versionDrift: evaluateRuntimeMetadata({ ...fixture, manifest: { ...fixture.manifest, version: "22.22.0" } }),
    untrustedSource: evaluateRuntimeMetadata({ ...fixture, manifest: { ...fixture.manifest, source: "https://example.invalid/node.zip" } }),
    executableTamper: evaluateRuntimeMetadata({ ...fixture, executableSha256: "d".repeat(64) }),
    licenseTamper: evaluateRuntimeMetadata({ ...fixture, licenseSha256: "d".repeat(64) }),
    ambiguousEngine: evaluateRuntimeMetadata({ ...fixture, engineRange: ">=20 || >=22" }),
  };
  const green = positive.status === "GREEN" && Object.values(negativeControls).every((report) => report.status === "BLOCK");
  process.stdout.write(`${JSON.stringify({ status: green ? "GREEN" : "BLOCK", positiveControl: positive.status, detected: Object.fromEntries(Object.entries(negativeControls).map(([name, report]) => [name, report.failures])) })}\n`);
  if (!green) process.exitCode = 1;
} else {
  const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const manifest = JSON.parse(await readFile(resolve(root, "vendor/node/win32-x64/manifest.json"), "utf8"));
  const buildReceipt = JSON.parse(await readFile(resolve(root, ".build-node-receipt.json"), "utf8"));
  const report = await inspectRuntimeProvenance({
    packageJson,
    manifest,
    nodePath: resolve(root, "vendor/node/win32-x64/node.exe"),
    licensePath: resolve(root, "vendor/node/win32-x64/NODE-LICENSE.txt"),
    buildReceipt,
  });
  const evidence = { schemaVersion: 1, productVersion: packageJson.version, generatedAt: new Date().toISOString(), ...report };
  const outputPath = resolve(process.argv[2] ?? resolve(root, `../../.rd/benchmarks/editkin-runtime-provenance-${packageJson.version}.json`));
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ ...evidence, evidencePath: outputPath })}\n`);
  if (report.status !== "GREEN") process.exitCode = 1;
}
