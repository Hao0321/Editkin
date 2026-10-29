import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { evaluateProductCapabilities } from "./lib/product-capability-gate.mjs";

const root = resolve(import.meta.dirname, "..");
const document = JSON.parse(await readFile(resolve(root, "product-capabilities.json"), "utf8"));
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const scope = process.argv[2] ?? "internal";
const report = evaluateProductCapabilities(document, { root, packageJson, scope });
process.stdout.write(`${JSON.stringify(report)}\n`);
if (report.status !== "GREEN") process.exitCode = 1;
