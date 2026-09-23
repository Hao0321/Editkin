import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const nativeRoot = resolve(root, "native/hao-core");
const cargoCandidate = join(
  homedir(),
  ".cargo",
  "bin",
  process.platform === "win32" ? "cargo.exe" : "cargo",
);
const cargo = process.env.CARGO ?? (existsSync(cargoCandidate) ? cargoCandidate : "cargo");
const executable = resolve(
  nativeRoot,
  `target/release/hao-core${process.platform === "win32" ? ".exe" : ""}`,
);
const evidenceDirectory = resolve(root, "../../.rd/benchmarks/editkin-native-audio-device");
const evidence = resolve(evidenceDirectory, "report.json");

if (process.platform !== "win32") {
  await mkdir(evidenceDirectory, { recursive: true });
  const report = {
    schema: "editkin.native-audio-device-gate/v1",
    decision: "BLOCK",
    reason: "CoreAudio physical-device parity is not implemented yet.",
  };
  await writeFile(evidence, `${JSON.stringify(report, null, 2)}\n`);
  process.stderr.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(1);
}

execFileSync(cargo, ["build", "--release", "--locked"], {
  cwd: nativeRoot,
  stdio: "inherit",
  windowsHide: true,
});
const receipt = JSON.parse(execFileSync(executable, ["audio-device-selftest"], {
  cwd: nativeRoot,
  encoding: "utf8",
  windowsHide: true,
  timeout: 30_000,
}));

assert.equal(receipt.schema, "editkin.wasapi-physical-output-gate/v2");
assert.equal(receipt.status, "GREEN");
assert.equal(receipt.backend, "WASAPI shared event-driven");
assert.ok(receipt.endpoint.activeCount >= 1);
assert.match(receipt.endpoint.selectedIdHash, /^sha256:[a-f0-9]{64}$/);
assert.equal(receipt.endpoint.state, 1);
assert.ok(receipt.format.sampleRate >= 8_000);
assert.ok(receipt.format.sampleRate <= 384_000);
assert.ok(receipt.format.channels >= 1);
assert.ok(receipt.format.channels <= 8);
assert.equal(receipt.format.negotiatedFromEndpoint, true);
assert.ok(receipt.device.bufferFrames > 0);
assert.equal(receipt.device.eventCallbacks, 8);
assert.equal(receipt.device.callbackFrames.length, 8);
assert.ok(receipt.device.callbackFrames.every((frames) => frames > 0));
assert.ok(receipt.device.clockFrequency > 0);
assert.ok(receipt.device.clockPosition > 0);
assert.ok(receipt.device.clockFrame > 0);
assert.ok(receipt.device.clockLeadFrames >= 0);
assert.ok(receipt.device.clockLeadFrames <= receipt.device.bufferFrames * 2);
assert.equal(receipt.device.started, true);
assert.equal(receipt.device.stopped, true);
assert.equal(receipt.device.reset, true);
assert.equal(receipt.transport.callbackLocks, 0);
assert.equal(receipt.transport.callbackAllocations, 0);
assert.equal(receipt.graphToDevice.nodeCount, 5);
assert.equal(receipt.graphToDevice.sidechainRouting, true);
assert.equal(receipt.graphToDevice.sampleAutomation, true);
assert.equal(receipt.graphToDevice.subAudible, true);
assert.match(receipt.graphToDevice.sha256, /^[a-f0-9]{64}$/);
assert.ok(receipt.transport.masterFrame > receipt.device.bufferFrames);
assert.ok(receipt.transport.underrunSamples > 0);
assert.equal(receipt.negativeControls.duplicateStartRejected, true);
assert.equal(receipt.negativeControls.underrunFilledWithSilence, true);
assert.equal(receipt.negativeControls.captureDefaultChangeIgnored, true);
assert.equal(receipt.deviceRecovery.notificationRegistered, true);
assert.equal(receipt.deviceRecovery.notificationUnregistered, true);
assert.equal(receipt.deviceRecovery.renderSignalGeneration, 2);
assert.equal(receipt.deviceRecovery.transportRecoveryGeneration, 2);
assert.equal(receipt.deviceRecovery.physicalStreamReopened, true);
assert.match(receipt.deviceRecovery.reopenedIdHash, /^sha256:[a-f0-9]{64}$/);
assert.ok(receipt.deviceRecovery.reopenBufferFrames > 0);
assert.ok(receipt.deviceRecovery.reopenCallbackFrames > 0);
assert.equal(receipt.deviceRecovery.realHotplugPerformed, false);

const report = {
  schema: "editkin.native-audio-device-gate/v1",
  decision: "GREEN",
  platform: process.platform,
  receipt,
  checks: {
    physicalEndpointSelected: true,
    sharedEventCallbackDelivered: true,
    physicalAudioClockBounded: true,
    sampleMasterClockAdvanced: true,
    nativeGraphReachedDeviceRing: true,
    callbackLocks: 0,
    callbackAllocations: 0,
    lifecycleStartStopReset: true,
    duplicateStartRejected: true,
    underrunFilledWithSilence: true,
    endpointNotificationLifecycle: true,
    notificationRecoveryGeneration: true,
    physicalStreamReopened: true,
  },
  claimBoundary:
    "Proves real Windows shared event-driven WASAPI output, hardware-clock accounting, endpoint notification lifecycle, recovery generation, and physical restart of the current endpoint. Real hotplug/default-device replacement, changed-format resample/remix, CoreAudio parity, and long-play drift remain open.",
  evidence,
};
await mkdir(evidenceDirectory, { recursive: true });
await writeFile(evidence, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report)}\n`);
