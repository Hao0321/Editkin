import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { strict as assert } from "node:assert";

const root = resolve(import.meta.dirname, "..");
const standardCargo = resolve(homedir(), ".cargo", "bin", process.platform === "win32" ? "cargo.exe" : "cargo");
const cargo = process.env.CARGO ?? (existsSync(standardCargo) ? standardCargo : "cargo");
const nativeRoot = resolve(root, "native/hao-core");
const executable = resolve(nativeRoot, `target/release/hao-core${process.platform === "win32" ? ".exe" : ""}`);
const evidence = resolve(root, "../../.rd/benchmarks/editkin-native-audio-realtime");

execFileSync(cargo, ["build", "--release", "--locked"], { cwd: nativeRoot, stdio: "inherit", windowsHide: true });
const receipt = JSON.parse(execFileSync(executable, ["audio-realtime-selftest"], { cwd: nativeRoot, encoding: "utf8", windowsHide: true }));
assert.equal(receipt.status, "GREEN");
assert.equal(receipt.transport.callbackLocks, 0);
assert.equal(receipt.transport.callbackAllocations, 0);
assert.equal(receipt.transport.masterFrame, 96_000);
assert.equal(receipt.transport.underrunSamples, 256);
assert.equal(receipt.recoveryGeneration, 2);
assert.equal(receipt.negativeControls.invalidSamplesRejected, true);
assert.equal(receipt.negativeControls.misalignedCallbackRejected, true);
await mkdir(evidence, { recursive: true });
const report = { ...receipt, evidence: resolve(evidence, "report.json") };
await writeFile(report.evidence, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report)}\n`);
