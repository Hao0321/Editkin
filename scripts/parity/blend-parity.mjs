// Blend / matte / adjustment parity CLI (P4).
//
//   vendor\node\win32-x64\node.exe scripts/parity/blend-parity.mjs --out <dir> [--fixtures <substring>] [--native-exe <path>]
//
// Runs src/render/parity/blendParity.render.test.ts in report mode (every renderer: export, native image preview,
// CSS compatible preview) and writes <dir>/parity-matrix.json and <dir>/REPORT.md. Offline. Every work file stays
// under <dir>/work; put TEMP/TMP on a drive with room. Exit code: vitest's (1 when a gated cell fails).
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const argument = (name) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
const out = argument("--out");
if (!out) {
  process.stderr.write("usage: blend-parity.mjs --out <dir> [--fixtures <substring>] [--native-exe <path>]\n");
  process.exit(2);
}
mkdirSync(resolve(out), { recursive: true });
const environment = { ...process.env, EDITKIN_PARITY_OUT: resolve(out), EDITKIN_PARITY_CSS: "1" };
if (argument("--fixtures")) environment.EDITKIN_PARITY_FIXTURES = argument("--fixtures");
if (argument("--native-exe")) environment.EDITKIN_PARITY_NATIVE_EXE = resolve(argument("--native-exe"));
const child = spawn(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "--no-cache", "--dir", "src", "src/render/parity/blendParity.render.test.ts"],
  { stdio: "inherit", env: environment, windowsHide: true });
child.on("exit", code => {
  process.stdout.write(`\nparity matrix: ${resolve(out, "parity-matrix.json")}\nreport: ${resolve(out, "REPORT.md")}\n`);
  process.exit(code ?? 1);
});
