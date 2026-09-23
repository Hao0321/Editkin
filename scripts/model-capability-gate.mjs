import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { strict as assert } from "node:assert";
import { evaluateModelCapability } from "./lib/model-capability.mjs";

const root = resolve(import.meta.dirname, "..");
const document = JSON.parse(await readFile(resolve(root, "model-capability-contract.json"), "utf8"));
if (process.argv.includes("--self-test")) {
  assert.equal(evaluateModelCapability(document, root).status, "GREEN");
  assert.equal(evaluateModelCapability({ ...document, requiredCellIds: document.requiredCellIds.slice(1) }, root).status, "BLOCK");
  const cells = structuredClone(document.cells);
  cells[0] = { ...cells[0], status: "measured", nextExperiment: undefined };
  assert.equal(evaluateModelCapability({ ...document, cells }, root).status, "BLOCK");
  assert.equal(evaluateModelCapability({ ...document, semanticGateIndependentOfModel: false }, root).status, "BLOCK");
  process.stdout.write(`${JSON.stringify({ status: "GREEN", negativeControls: ["missing-cell", "false-measured", "model-bypass"] })}\n`);
} else {
  const report = evaluateModelCapability(document, root);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.status !== "GREEN") process.exitCode = 1;
}
