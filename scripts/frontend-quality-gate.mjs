import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { captureFrontendQualityInputs, runFrontendQualityGates } from "./lib/frontend-quality-preflight.mjs";

export async function checkFrontendQuality(root) {
  const result = await runFrontendQualityGates({ root, onGate: gate => {
    console.log(JSON.stringify({ status: "GREEN_FRONTEND_QUALITY_GATE", ...gate }));
  } });
  console.log(JSON.stringify({ status: "GREEN_FRONTEND_QUALITY_CHECKS", checked: result.checked.map(gate => gate.id),
    validationIdentity: result.validationInputs.identity, validationSourceFiles: result.validationInputs.files.length,
    validationScope: result.validationInputs.scope }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(import.meta.dirname, "..");
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 1 || args[0] !== "--inputs")) throw new Error("Usage: frontend-quality-gate.mjs [--inputs]");
  if (args[0] === "--inputs") console.log(JSON.stringify(await captureFrontendQualityInputs({ root })));
  else await checkFrontendQuality(root);
}
