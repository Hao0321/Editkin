/**
 * Regenerates src/modules/motionLibraryModuleVariantsV1.json, the variant snapshot behind the three Motion Library
 * modules (graphic.text_motion, transition.motion_pair, background.motion_loop), from the live catalog and Claude's
 * revision-pinned certifications. Run it after certifying items or when an item is implemented, then run
 * `node scripts/refresh-module-metadata-v2.cjs --write` so module discovery shows the new artStatus.
 * Prepare never trusts this snapshot for choice: auto-pick re-reads the live catalog.
 *
 *   vendor/node/win32-x64/node.exe node_modules/tsx/dist/cli.mjs scripts/refresh-motion-library-module-variants.ts [--check]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { motionLibraryModuleVariantSnapshotV1 } from "../src/modules/motionLibraryModulesV1";

const path = resolve(import.meta.dirname, "../src/modules/motionLibraryModuleVariantsV1.json");
const text = `${JSON.stringify(motionLibraryModuleVariantSnapshotV1(), null, 1)}\n`;
if (process.argv.includes("--check")) {
  let current = "";
  try { current = readFileSync(path, "utf8"); } catch { /* missing counts as stale */ }
  if (current !== text) { console.error(`Motion library module variants are stale: ${path}`); process.exit(1); }
  console.log(JSON.stringify({ status: "FRESH", path }));
} else {
  writeFileSync(path, text, "utf8");
  console.log(JSON.stringify({ status: "GENERATED", path, bytes: Buffer.byteLength(text) }));
}
