import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { evaluateCreativePack } from "./lib/creative-pack-gate.mjs";

const manifestPath = resolve(process.argv[2] ?? ".creative-packs/hao-creator-library/editkin-pack.json");
try {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const report = evaluateCreativePack(manifest, { root: dirname(manifestPath) });
  process.stdout.write(`${JSON.stringify({ ...report, manifestPath })}\n`);
  if (report.status !== "GREEN") process.exitCode = 1;
} catch (error) {
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, status: "BLOCK", manifestPath, findings: [{ status: "FAIL", code: "missing-pack", message: error instanceof Error ? error.message : String(error) }] })}\n`);
  process.exitCode = 1;
}
