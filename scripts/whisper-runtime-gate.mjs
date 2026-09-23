import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { inspectPeMitigations } from "./lib/security-hardening.mjs";

const root = resolve(import.meta.dirname, "..");
const runtimeRoot = resolve(root, "vendor/whisper/win32-x64");
const manifest = JSON.parse(await readFile(resolve(runtimeRoot, "manifest.json"), "utf8"));
const expectedNames = new Set(["manifest.json", "WHISPER-LICENSE.txt", ...manifest.files.map((file) => file.name)]);
const actualNames = new Set((await readdir(runtimeRoot)).sort());
const findings = [];

for (const name of expectedNames) if (!actualNames.has(name)) findings.push({ code: "missing-runtime-file", name });
for (const name of actualNames) if (!expectedNames.has(name)) findings.push({ code: "undeclared-runtime-file", name });
for (const file of manifest.files) {
  const path = resolve(runtimeRoot, file.name);
  const info = await stat(path);
  const bytes = await readFile(path);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (info.size !== file.bytes || sha256 !== file.sha256) findings.push({ code: "runtime-identity-mismatch", name: file.name, bytes: info.size, sha256 });
  const pe = inspectPeMitigations(bytes);
  if (!pe.valid || pe.architecture !== "x64" || !pe.dynamicBase || !pe.nxCompat || !pe.highEntropyVa) findings.push({ code: "runtime-pe-hardening-missing", name: file.name, pe });
}
const licenseSha256 = createHash("sha256").update(await readFile(resolve(runtimeRoot, "WHISPER-LICENSE.txt"))).digest("hex");
if (manifest.license !== "MIT" || licenseSha256 !== manifest.licenseSha256) findings.push({ code: "license-identity-mismatch", licenseSha256 });
const help = spawnSync(resolve(runtimeRoot, "whisper-cli.exe"), ["--help"], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
const helpText = `${help.stdout ?? ""}\n${help.stderr ?? ""}`;
if (help.status !== 0 || !/--translate/.test(helpText) || !/--output-srt/.test(helpText)) findings.push({ code: "bilingual-capability-missing", status: help.status });

const report = { status: findings.length ? "BLOCK" : "GREEN", version: manifest.version, files: manifest.files.length, archiveSha256: manifest.archive.sha256, findings };
process.stdout.write(`${JSON.stringify(report)}\n`);
if (findings.length) process.exitCode = 1;
