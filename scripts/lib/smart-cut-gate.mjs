export function assessSmartCutBenchmark(measurement) {
  const findings = [];
  const add = (pass, code, message) => findings.push({ status: pass ? "PASS" : "FAIL", code, message });
  const ranges = Array.isArray(measurement?.ranges) ? measurement.ranges : [];
  const validRanges = ranges.length > 0 && ranges.every((range, index) => (
    Number.isInteger(range.startFrame)
    && Number.isInteger(range.endFrame)
    && range.startFrame >= 0
    && range.endFrame > range.startFrame
    && (index === 0 || range.startFrame >= ranges[index - 1].endFrame)
  ));
  add(measurement?.inputSilenceCount === 10_000, "frozen-dataset", "必須使用 10,000 段凍結 silence fixture");
  add(measurement?.equivalentToReference === true, "reference-equivalence", "Rust 結果必須逐項等同獨立 TypeScript reference");
  add(validRanges, "range-contract", "輸出區間必須非空、遞增、互不重疊且使用整數 frame");
  add(Number.isFinite(measurement?.p95Ms) && measurement.p95Ms <= 100, "latency-p95", "10,000 段決策 p95 必須不高於 100ms");
  add(typeof measurement?.engine === "string" && measurement.engine.startsWith("hao-core-rust-"), "native-engine", "正式候選必須由 hao-core Rust 產生");
  add(Number.isInteger(measurement?.removedFrames) && measurement.removedFrames > 0, "non-trivial-output", "fixture 必須實際移除內容，避免空操作假綠燈");
  return { status: findings.every((finding) => finding.status === "PASS") ? "GREEN" : "BLOCK", findings };
}
