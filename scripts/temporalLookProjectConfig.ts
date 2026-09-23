import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const evidenceRoot = resolve(root, "../../.rd/benchmarks/editkin-temporal-look-project-render");
const baseline = process.argv.includes("--baseline");
const overlayBaseline = process.argv.includes("--overlay-baseline");
const partialOverlayBaseline = process.argv.includes("--partial-overlay-baseline");
const multiOverlayBaseline = process.argv.includes("--multi-overlay-baseline");
const multiAdjustmentBaseline = process.argv.includes("--multi-adjustment-baseline");
const particleLookBaseline = process.argv.includes("--particle-look-baseline");
const particleMultiAdjustmentBaseline = process.argv.includes("--particle-multi-adjustment-baseline");
const particleOverlayBaseline = process.argv.includes("--particle-overlay-baseline");
const particleOverlayMultiAdjustmentBaseline = process.argv.includes("--particle-overlay-multi-adjustment-baseline");
const particlePartialOverlayBaseline = process.argv.includes("--particle-partial-overlay-baseline");
const particlePartialOverlayMultiAdjustmentBaseline = process.argv.includes("--particle-partial-overlay-multi-adjustment-baseline");
const particleAnimatedOverlayBaseline = process.argv.includes("--particle-animated-overlay-baseline");
const particleAnimatedOverlayTwoKeyframeBaseline = process.argv.includes("--particle-animated-overlay-two-keyframe-baseline");
const particleAnimatedOverlayMultiAdjustmentBaseline = process.argv.includes("--particle-animated-overlay-multi-adjustment-baseline");
const selfTest = process.argv.includes("--self-test");
const reportPath = join(evidenceRoot, particleAnimatedOverlayMultiAdjustmentBaseline ? "particle-animated-overlay-multi-adjustment-baseline-report.json" : particleAnimatedOverlayTwoKeyframeBaseline ? "particle-animated-overlay-two-keyframe-baseline-report.json" : particleAnimatedOverlayBaseline ? "particle-animated-overlay-baseline-report.json" : particlePartialOverlayMultiAdjustmentBaseline ? "particle-partial-overlay-multi-adjustment-baseline-report.json" : particleOverlayMultiAdjustmentBaseline ? "particle-overlay-multi-adjustment-baseline-report.json" : particlePartialOverlayBaseline ? "particle-partial-overlay-baseline-report.json" : particleOverlayBaseline ? "particle-overlay-baseline-report.json" : particleMultiAdjustmentBaseline ? "particle-multi-adjustment-baseline-report.json" : particleLookBaseline ? "particle-look-baseline-report.json" : multiAdjustmentBaseline ? "multi-adjustment-baseline-report.json" : multiOverlayBaseline ? "multi-overlay-baseline-report.json" : partialOverlayBaseline ? "partial-overlay-baseline-report.json" : overlayBaseline ? "overlay-baseline-report.json" : baseline ? "baseline-report.json" : "report.json");
const positional = process.argv.find((value, index) => index > 1 && !value.startsWith("--"));
const compositor = resolve(positional ?? join(root, "native/bin/win32-x64/editkin-gpu-compositor.exe"));

export const temporalLookGateConfig = {
  root, baseline, overlayBaseline, partialOverlayBaseline, multiOverlayBaseline,
  multiAdjustmentBaseline, particleLookBaseline, particleMultiAdjustmentBaseline,
  particleOverlayBaseline, particleOverlayMultiAdjustmentBaseline, particlePartialOverlayBaseline,
  particlePartialOverlayMultiAdjustmentBaseline, particleAnimatedOverlayBaseline,
  particleAnimatedOverlayTwoKeyframeBaseline, particleAnimatedOverlayMultiAdjustmentBaseline,
  selfTest, reportPath, compositor,
};

