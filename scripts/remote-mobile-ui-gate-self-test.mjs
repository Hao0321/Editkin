import { assessRemoteMobileUi } from "./lib/remote-mobile-ui.mjs";

const control = { tag: "BUTTON", name: "操作", width: 48, height: 48, fontSize: 16 };
const viewport = (id, width, height, columns) => ({
  id, width, height, columns, viewport: { width, height }, document: { clientWidth: width, scrollWidth: width },
  controls: Array.from({ length: 13 }, () => ({ ...control })), quickColumns: columns, firstScreenActions: 8,
  finalActionReachable: true, runtimeErrors: [], hash: "", connected: true,
});
const fixture = {
  pairingReadyMs: 1_200, commandRoundTripMs: 40, tokenRemovedFromUrl: true, reducedMotion: true,
  reconnectedWithoutQr: true,
  atomicQueueFiles: 1, queuedInstruction: "復原",
  matrix: [viewport("narrow", 360, 800, 2), viewport("compact", 390, 844, 2), viewport("large", 430, 932, 2), viewport("landscape", 844, 390, 4)],
};
const negativeControls = {
  overflow: { ...fixture, matrix: fixture.matrix.map((item, index) => index ? item : { ...item, document: { clientWidth: 360, scrollWidth: 361 } }) },
  smallTarget: { ...fixture, matrix: fixture.matrix.map((item, index) => index ? item : { ...item, controls: item.controls.map((item, controlIndex) => controlIndex ? item : { ...item, width: 24 }) }) },
  smallInputFont: { ...fixture, matrix: fixture.matrix.map((item, index) => index ? item : { ...item, controls: item.controls.map((item, controlIndex) => controlIndex ? item : { ...item, fontSize: 15 }) }) },
  runtimeError: { ...fixture, matrix: fixture.matrix.map((item, index) => index ? item : { ...item, runtimeErrors: ["boom"] }) },
  tokenLeak: { ...fixture, tokenRemovedFromUrl: false },
  reconnectRequiresQr: { ...fixture, reconnectedWithoutQr: false },
  slowPairing: { ...fixture, pairingReadyMs: 3_001 },
  duplicateQueue: { ...fixture, atomicQueueFiles: 2 },
};
const positive = assessRemoteMobileUi(fixture);
const detected = Object.fromEntries(Object.entries(negativeControls).map(([name, candidate]) => [name, assessRemoteMobileUi(candidate)]));
const green = positive.status === "GREEN" && Object.values(detected).every((result) => result.status === "BLOCK");
process.stdout.write(`${JSON.stringify({ status: green ? "GREEN" : "BLOCK", positiveControl: positive.status, detected: Object.fromEntries(Object.entries(detected).map(([name, result]) => [name, result.failures.map((failure) => failure.code)])) })}\n`);
if (!green) process.exitCode = 1;
