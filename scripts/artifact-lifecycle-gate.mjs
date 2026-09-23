import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { inspectDistributionArtifacts } from "./lib/artifact-lifecycle.mjs";
import {
  inspectWindowsTauriCandidatePrimaryArtifacts,
  resolveTauriCandidateArtifactRoot,
} from "./lib/tauri-candidate-artifact-root.mjs";

function parseArgs(args) {
  let artifactRoot;
  let output;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if ((flag !== "--artifact-root" && flag !== "--output") || !value || value.startsWith("--")) {
      throw new Error("Artifact lifecycle gate accepts only --artifact-root <candidate-release> and optional --output <receipt>");
    }
    if (flag === "--artifact-root") {
      if (artifactRoot) throw new Error("Artifact lifecycle gate rejects duplicate --artifact-root");
      artifactRoot = value;
    } else {
      if (output) throw new Error("Artifact lifecycle gate rejects duplicate --output");
      output = value;
    }
  }
  if (!artifactRoot) throw new Error("Artifact lifecycle gate requires one explicit --artifact-root");
  return { artifactRoot, output };
}

const root = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const version = packageJson.version;
const args = parseArgs(process.argv.slice(2));
const candidate = resolveTauriCandidateArtifactRoot(root, args.artifactRoot);
const artifactTarget = await inspectWindowsTauriCandidatePrimaryArtifacts(candidate, version);
const report = await inspectDistributionArtifacts({
  root,
  installerPath: resolve(candidate.artifactRoot, artifactTarget.installer.path),
  executablePath: resolve(candidate.artifactRoot, artifactTarget.executable.path),
  creativePackArchivePath: resolve(root, `../../.rd/artifacts/Hao-Creator-Library-${version}.editkin-pack.zip`),
  sourcePackRoot: resolve(root, ".creative-packs/hao-creator-library"),
  sourcePersonalMusicPackRoot: resolve(root, ".personal-packs/hao-music-library"),
  sourceFontPackRoot: resolve(root, "public/fonts"),
});
const output = resolve(args.output ?? resolve(root, `../../.rd/benchmarks/editkin-artifact-lifecycle-${version}-windows-x64.json`));
const evidence = { ...report, artifactTarget, productVersion: version, generatedAt: new Date().toISOString() };
await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ ...evidence, evidencePath: output })}\n`);
if (report.status !== "GREEN") process.exitCode = 1;
