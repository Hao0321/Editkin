import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  evaluateSourceSecurity,
  PAYLOAD_SECURITY_POLICY_REVISION,
} from "./lib/security-hardening.mjs";
import {
  assertTauriArtifactTargetBinding,
  inspectWindowsTauriCandidatePrimaryArtifacts,
  resolveTauriCandidateArtifactRoot,
} from "./lib/tauri-candidate-artifact-root.mjs";

function parseArgs(args) {
  const profile = args[0] === "public" ? "public" : args[0] === "internal" ? "internal" : undefined;
  if (!profile || args.length !== 3 || args[1] !== "--artifact-root" || !args[2] || args[2].startsWith("--")) {
    throw new Error("Security hardening gate requires <internal|public> --artifact-root <candidate-release>");
  }
  return { profile, artifactRoot: args[2] };
}

const root = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(
  await readFile(resolve(root, "package.json"), "utf8"),
);
const { profile, artifactRoot } = parseArgs(process.argv.slice(2));
const candidate = resolveTauriCandidateArtifactRoot(root, artifactRoot);
const currentArtifactTarget = await inspectWindowsTauriCandidatePrimaryArtifacts(candidate, packageJson.version);
const artifactEvidencePath = resolve(
  root,
  `../../.rd/benchmarks/editkin-artifact-lifecycle-${packageJson.version}-windows-x64.json`,
);
const [
  artifact,
  tauriConfig,
  tauriCargo,
  nativeCargo,
  buildDesktop,
  tauriMain,
  electronMain,
  electronUpdateIpc,
  remoteServer,
  relayWorker,
  relayConfig,
] = await Promise.all([
  readFile(artifactEvidencePath, "utf8").then(JSON.parse),
  readFile(resolve(root, "src-tauri/tauri.conf.json"), "utf8").then(JSON.parse),
  readFile(resolve(root, "src-tauri/Cargo.toml"), "utf8"),
  readFile(resolve(root, "native/hao-core/Cargo.toml"), "utf8"),
  readFile(resolve(root, "scripts/build-desktop.mjs"), "utf8"),
  readFile(resolve(root, "src-tauri/src/main.rs"), "utf8"),
  readFile(resolve(root, "electron/main.ts"), "utf8"),
  readFile(resolve(root, "electron/updateIpc.ts"), "utf8"),
  readFile(resolve(root, "src/remote/server.ts"), "utf8"),
  readFile(resolve(root, "relay/src/index.mjs"), "utf8"),
  readFile(resolve(root, "src-tauri/remote-relay.json"), "utf8").then(
    JSON.parse,
  ),
]);
const source = evaluateSourceSecurity({
  tauriConfig,
  tauriCargo,
  nativeCargo,
  buildDesktop,
  tauriMain,
  electronMain: `${electronMain}\n${electronUpdateIpc}`,
  remoteServer,
  relayWorker,
  relayConfig,
  packageScripts: packageJson.scripts,
});
const payload = artifact?.nsis?.security;
const findings = [...source.findings];
try {
  assertTauriArtifactTargetBinding(candidate, artifact?.artifactTarget, currentArtifactTarget);
} catch (error) {
  findings.push({ code: "artifact-evidence-target-mismatch", detail: String(error) });
}
if (
  artifact?.status !== "GREEN" ||
  artifact?.productVersion !== packageJson.version
)
  findings.push({ code: "artifact-evidence-not-current-green" });
if (!payload || payload.status !== "GREEN")
  findings.push({ code: "payload-security-not-green" });
if (payload?.policyRevision !== PAYLOAD_SECURITY_POLICY_REVISION)
  findings.push({ code: "payload-security-policy-stale" });
if (profile === "public") {
  if ((payload?.ownerOnlyFiles ?? 0) > 0)
    findings.push({
      code: "owner-only-assets-in-public-package",
      count: payload.ownerOnlyFiles,
    });
  if (payload?.authenticode?.Status !== "Valid")
    findings.push({
      code: "public-installer-not-authenticode-valid",
      actual: payload?.authenticode?.Status ?? "missing",
    });
}
const report = {
  schemaVersion: 1,
  status: findings.length ? "BLOCK" : "GREEN",
  profile,
  artifactTarget: currentArtifactTarget,
  product: packageJson.productName,
  productVersion: packageJson.version,
  generatedAt: new Date().toISOString(),
  source,
  payload,
  findings,
};
const output = resolve(
  root,
  `../../.rd/benchmarks/editkin-security-hardening-${packageJson.version}-windows-x64-${profile}.json`,
);
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(
  `${JSON.stringify({ status: report.status, profile, artifactTarget: currentArtifactTarget, productVersion: packageJson.version, source: source.status, payload: payload?.status ?? "missing", ownerOnlyFiles: payload?.ownerOnlyFiles, authenticode: payload?.authenticode?.Status, pe: payload?.pe, findings, evidencePath: output })}\n`,
);
if (report.status !== "GREEN") process.exitCode = 1;
