import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { evaluateIdentity, inspectReleaseIdentity } from "./lib/release-identity.mjs";

if (process.argv.includes("--self-test")) {
  const positive = evaluateIdentity("1.2.3", { packageLock: ["1.2.3", "1.2.3"], tauri: ["1.2.3"], cargo: ["1.2.3"], ledger: ["1.2.3"], autopilotLedger: ["1.2.3"], creativePack: ["1.2.3"], personalMusicPack: ["1.2.3"], openFontPack: ["1.2.3"], mcp: ["1.2.3", "1.2.3"] });
  const mismatch = evaluateIdentity("1.2.3", { packageLock: ["1.2.2"], tauri: ["1.2.3"] });
  const missing = evaluateIdentity("1.2.3", { packageLock: [], tauri: ["1.2.3"] });
  const green = positive.status === "GREEN" && mismatch.status === "BLOCK" && missing.status === "BLOCK";
  process.stdout.write(`${JSON.stringify({ status: green ? "GREEN" : "BLOCK", positiveControl: positive.status, detected: { mismatch: mismatch.failures, missing: missing.failures } })}\n`);
  if (!green) process.exitCode = 1;
} else {
  const root = resolve(import.meta.dirname, "..");
  const report = await inspectReleaseIdentity(root);
  const evidence = { schemaVersion: 1, generatedAt: new Date().toISOString(), ...report };
  const outputPath = resolve(process.argv[2] ?? resolve(root, `../../.rd/benchmarks/editkin-release-identity-${report.expectedVersion}.json`));
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ ...evidence, evidencePath: outputPath })}\n`);
  if (report.status !== "GREEN") process.exitCode = 1;
}
