/**
 * Regenerates src/modules/styleTemplateModuleVariantsV1.json, the variant snapshot behind graphic.style_template, from
 * the live slot catalogue (templates with slots, their art status and whether their components render). Run it after a
 * template's slots, art status or components change, then run `node scripts/refresh-module-metadata-v2.cjs --write` so
 * module discovery shows them. Prepare never trusts this snapshot for choice: auto-pick re-reads the live catalogue.
 *
 *   vendor/node/win32-x64/node.exe node_modules/tsx/dist/cli.mjs scripts/refresh-style-template-module-variants.ts [--check]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { styleTemplateModuleVariantSnapshotV1 } from "../src/modules/styleTemplateModulesV1";

const path = resolve(import.meta.dirname, "../src/modules/styleTemplateModuleVariantsV1.json");
const text = `${JSON.stringify(styleTemplateModuleVariantSnapshotV1(), null, 1)}\n`;
if (process.argv.includes("--check")) {
  let current = "";
  try { current = readFileSync(path, "utf8"); } catch { /* missing counts as stale */ }
  if (current !== text) { console.error(`Style template module variants are stale: ${path}`); process.exit(1); }
  console.log(JSON.stringify({ status: "FRESH", path }));
} else {
  writeFileSync(path, text, "utf8");
  console.log(JSON.stringify({ status: "GENERATED", path, bytes: Buffer.byteLength(text) }));
}
