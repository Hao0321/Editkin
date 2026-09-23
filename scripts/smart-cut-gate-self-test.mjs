import { assessSmartCutBenchmark } from "./lib/smart-cut-gate.mjs";

const good = {
  inputSilenceCount: 10_000,
  equivalentToReference: true,
  ranges: [{ startFrame: 0, endFrame: 90 }, { startFrame: 120, endFrame: 240 }],
  p95Ms: 42,
  engine: "hao-core-rust-0.4",
  removedFrames: 30,
};
const cases = [
  ["frozen-dataset", { ...good, inputSilenceCount: 9_999 }],
  ["reference-equivalence", { ...good, equivalentToReference: false }],
  ["range-contract", { ...good, ranges: [{ startFrame: 20, endFrame: 10 }] }],
  ["latency-p95", { ...good, p95Ms: 101 }],
  ["native-engine", { ...good, engine: "editkin-typescript" }],
  ["non-trivial-output", { ...good, removedFrames: 0 }],
];
const positive = assessSmartCutBenchmark(good);
const detected = cases.map(([code, fixture]) => {
  const result = assessSmartCutBenchmark(fixture);
  if (result.status !== "BLOCK" || !result.findings.some((finding) => finding.code === code && finding.status === "FAIL")) {
    throw new Error(`Smart Cut evaluator 無法偵測 ${code}`);
  }
  return code;
});
if (positive.status !== "GREEN") throw new Error("Smart Cut evaluator 拒絕正向控制");
process.stdout.write(`${JSON.stringify({ status: "GREEN", positiveControl: "PASS", detected })}\n`);
