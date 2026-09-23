import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createEmptyProject } from "../src/domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject } from "../src/domain/types";
import { renderProject } from "../src/render/ffmpeg";
import {
  HIGH_BIT_DEPTH_ALPHA_ENCODER_ARGS,
  assertHighBitDepthAlphaDeliveryProject,
  assertHighBitDepthAlphaOutputProbe,
  compositePixelContract,
} from "../src/render/highBitDepthAlphaDelivery";
import { runProcess } from "../src/render/ffmpegMedia";

const root = resolve(import.meta.dirname, "..");
const ffmpeg = process.env.HAO_FFMPEG_PATH ?? join(root, "vendor/ffmpeg/win32-x64/ffmpeg.exe");
const ffprobe = process.env.HAO_FFPROBE_PATH ?? join(root, "vendor/ffmpeg/win32-x64/ffprobe.exe");
const evidenceRoot = join(root, ".rd/benchmarks/editkin-high-bit-depth-alpha-delivery");
const reportPath = join(evidenceRoot, "report.json");
const selfTestPath = join(evidenceRoot, "self-test.json");
const planPath = join(root, ".rd/experiments/high-bit-depth-alpha-internal-cell-plan-20260904.json");
const THRESHOLDS = {
  minimumDecodedAlphaLevels: 512,
  decodedAlphaMinimum: 0,
  decodedAlphaMaximum: 65_520,
  maximumZeroAlphaRgbCode: 1_024,
  maximumAlphaAbsoluteError: 64,
  maximumForegroundAbsoluteError: 2_048,
  maximumForegroundMeanAbsoluteError: 512,
} as const;
const PLAN_CONTRACT = Object.freeze({
  schema: "editkin.rd-experiment-plan/v1",
  id: "high-bit-depth-alpha-and-foreground-delivery-internal-cell-20260904-v2",
  ledgerObligation: "high-bit-depth-alpha-and-foreground-delivery",
  decodedAlphaMaximumDerivation: "yuva444p12le full-scale 4095 expanded to gray16le as 4095 << 4",
  decisionRule: "A bounded ProRes GREEN advances only this measured slice. The ledger internal cell remains planned until graph crossings, half-float and float EXR, Preview/formal parity, save/reopen and delivered-product evidence all pass on one fresh provenance envelope.",
  requiredBeforeInternalVerified: [
    "integer-16, half-float and float alpha/foreground graph-crossing oracles",
    "straight and premultiplied semantics across every admitted delivery format",
    "alpha 0/1 and RGB-under-zero-alpha policy",
    "Preview/formal pixel parity",
    "save/reopen and exact frame/timebase persistence",
    "current packaged/delivered runtime execution with independent decoder readback",
  ],
});

type JsonObject = Record<string, unknown>;

function jsonObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function validateFrozenPlan(value: unknown): string[] {
  const failures: string[] = [];
  const plan = jsonObject(value);
  if (!plan) return ["plan-json-object"];
  if (plan.schema !== PLAN_CONTRACT.schema) failures.push("plan-schema");
  if (plan.id !== PLAN_CONTRACT.id) failures.push("plan-id");
  if (plan.ledgerObligation !== PLAN_CONTRACT.ledgerObligation) failures.push("plan-ledger-obligation");
  if (plan.decisionRule !== PLAN_CONTRACT.decisionRule) failures.push("plan-decision-rule");

  const required = plan.requiredBeforeInternalVerified;
  if (!Array.isArray(required)
    || required.length !== PLAN_CONTRACT.requiredBeforeInternalVerified.length
    || required.some((entry, index) => entry !== PLAN_CONTRACT.requiredBeforeInternalVerified[index])) {
    failures.push("plan-required-before-internal-verified");
  }

  const boundedExperiment = jsonObject(plan.boundedExperiment);
  const declaredThresholds = jsonObject(boundedExperiment?.thresholds);
  const expectedThresholdKeys = [...Object.keys(THRESHOLDS), "decodedAlphaMaximumDerivation"].sort();
  const declaredThresholdKeys = declaredThresholds ? Object.keys(declaredThresholds).sort() : [];
  if (declaredThresholdKeys.join("\n") !== expectedThresholdKeys.join("\n")) {
    failures.push("plan-threshold-key-set");
  }
  for (const [name, expected] of Object.entries(THRESHOLDS)) {
    if (declaredThresholds?.[name] !== expected) failures.push(`plan-threshold-${name}`);
  }
  if (declaredThresholds?.decodedAlphaMaximumDerivation !== PLAN_CONTRACT.decodedAlphaMaximumDerivation) {
    failures.push("plan-threshold-derivation");
  }
  return failures;
}

interface ForegroundRoundTrip {
  comparedSamples: number;
  maxAbsoluteError: number;
  meanAbsoluteError: number;
  alphaMaxAbsoluteError: number;
}

interface DecodedRgbaFacts {
  alphaLevels: number;
  alphaMinimum: number;
  alphaMaximum: number;
  zeroAlphaPixelCount: number;
  zeroAlphaRgbMaximum: number;
}

interface DeliveryFacts {
  schema: "editkin.high-bit-depth-alpha-bounded-facts/v2";
  planBound: boolean;
  straightReceiptGreen: boolean;
  premultipliedReceiptGreen: boolean;
  workingPixelFormat: string;
  requestedEncoderPixelFormat: string;
  probedOutputPixelFormat: string;
  probedBitsPerRawSample: number;
  effectiveMinimumAlphaBits: number;
  straight: DecodedRgbaFacts;
  premultiplied: DecodedRgbaFacts;
  foregroundRoundTrip: ForegroundRoundTrip;
  outputHashesBound: boolean;
}

function fixtureProject(path: string, alphaMode: "straight" | "premultiplied" = "straight"): EditProject {
  const project = createEmptyProject("High-bit Alpha Delivery Gate", { id: "alpha-delivery-gate", width: 64, height: 64, fps: 1 });
  project.assets.push({
    id: "alpha-gradient",
    name: "16-bit alpha gradient",
    kind: "image",
    uri: path,
    duration: 1,
    width: 64,
    height: 64,
    alphaMode,
    color: { interpretation: "rec709" },
  });
  project.tracks[0].clips.push({
    id: "foreground",
    assetId: "alpha-gradient",
    trackId: project.tracks[0].id,
    timelineStart: 0,
    sourceStart: 0,
    duration: 1,
    volume: 1,
    transform: { ...DEFAULT_TRANSFORM },
    color: { ...DEFAULT_COLOR },
    keyframes: [],
  });
  return project;
}

function alphaLevels(bytes: Buffer): number {
  assert.equal(bytes.length, 64 * 64 * 2);
  const values = new Set<number>();
  for (let offset = 0; offset < bytes.length; offset += 2) values.add(bytes.readUInt16LE(offset));
  return values.size;
}

function inspectDecodedRgba(bytes: Buffer): DecodedRgbaFacts {
  assert.equal(bytes.length, 64 * 64 * 4 * 2);
  const pixels = 64 * 64;
  const levels = new Set<number>();
  let alphaMinimum = 65_535;
  let alphaMaximum = 0;
  let zeroAlphaPixelCount = 0;
  let zeroAlphaRgbMaximum = 0;
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const alpha = bytes.readUInt16LE((3 * pixels + pixel) * 2);
    levels.add(alpha);
    alphaMinimum = Math.min(alphaMinimum, alpha);
    alphaMaximum = Math.max(alphaMaximum, alpha);
    if (alpha === 0) {
      zeroAlphaPixelCount += 1;
      for (let plane = 0; plane < 3; plane += 1) {
        zeroAlphaRgbMaximum = Math.max(zeroAlphaRgbMaximum, bytes.readUInt16LE((plane * pixels + pixel) * 2));
      }
    }
  }
  return { alphaLevels: levels.size, alphaMinimum, alphaMaximum, zeroAlphaPixelCount, zeroAlphaRgbMaximum };
}

function compareStraightForeground(left: Buffer, right: Buffer): ForegroundRoundTrip {
  assert.equal(left.length, 64 * 64 * 4 * 2);
  assert.equal(right.length, left.length);
  const pixels = 64 * 64;
  let comparedSamples = 0;
  let maxAbsoluteError = 0;
  let totalAbsoluteError = 0;
  let alphaMaxAbsoluteError = 0;
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const leftAlpha = left.readUInt16LE((3 * pixels + pixel) * 2);
    const rightAlpha = right.readUInt16LE((3 * pixels + pixel) * 2);
    alphaMaxAbsoluteError = Math.max(alphaMaxAbsoluteError, Math.abs(leftAlpha - rightAlpha));
    // RGB beneath nearly transparent pixels is mathematically unstable after unpremultiply.
    if (Math.min(leftAlpha, rightAlpha) < 8192) continue;
    for (let plane = 0; plane < 3; plane += 1) {
      const error = Math.abs(left.readUInt16LE((plane * pixels + pixel) * 2) - right.readUInt16LE((plane * pixels + pixel) * 2));
      maxAbsoluteError = Math.max(maxAbsoluteError, error);
      totalAbsoluteError += error;
      comparedSamples += 1;
    }
  }
  return { comparedSamples, maxAbsoluteError, meanAbsoluteError: totalAbsoluteError / comparedSamples, alphaMaxAbsoluteError };
}

function evaluate(facts: DeliveryFacts): string[] {
  const failures: string[] = [];
  if (facts.schema !== "editkin.high-bit-depth-alpha-bounded-facts/v2") failures.push("schema");
  if (!facts.planBound) failures.push("plan-provenance");
  if (!facts.straightReceiptGreen || !facts.premultipliedReceiptGreen) failures.push("delivery-receipt");
  if (facts.workingPixelFormat !== "gbrap16le") failures.push("working-pixel-format");
  if (facts.requestedEncoderPixelFormat !== "yuva444p10le"
    || facts.probedOutputPixelFormat !== "yuva444p12le" || facts.probedBitsPerRawSample !== 12) {
    failures.push("encoder-pixel-contract");
  }
  if (facts.effectiveMinimumAlphaBits < 10) failures.push("effective-alpha-bits");
  for (const [name, decoded] of [["straight", facts.straight], ["premultiplied", facts.premultiplied]] as const) {
    if (decoded.alphaLevels < THRESHOLDS.minimumDecodedAlphaLevels) failures.push(`${name}-alpha-levels`);
    if (decoded.alphaMinimum !== THRESHOLDS.decodedAlphaMinimum
      || decoded.alphaMaximum !== THRESHOLDS.decodedAlphaMaximum) failures.push(`${name}-alpha-endpoints`);
    if (decoded.zeroAlphaPixelCount < 1 || decoded.zeroAlphaRgbMaximum > THRESHOLDS.maximumZeroAlphaRgbCode) {
      failures.push(`${name}-zero-alpha-rgb`);
    }
  }
  if (facts.foregroundRoundTrip.comparedSamples < 1) failures.push("foreground-samples");
  if (facts.foregroundRoundTrip.alphaMaxAbsoluteError > THRESHOLDS.maximumAlphaAbsoluteError) failures.push("alpha-consistency");
  if (facts.foregroundRoundTrip.maxAbsoluteError > THRESHOLDS.maximumForegroundAbsoluteError) failures.push("foreground-maximum-error");
  if (facts.foregroundRoundTrip.meanAbsoluteError > THRESHOLDS.maximumForegroundMeanAbsoluteError) failures.push("foreground-mean-error");
  if (!facts.outputHashesBound) failures.push("output-hash-binding");
  return failures;
}

const validFacts = (): DeliveryFacts => ({
  schema: "editkin.high-bit-depth-alpha-bounded-facts/v2",
  planBound: true,
  straightReceiptGreen: true,
  premultipliedReceiptGreen: true,
  workingPixelFormat: "gbrap16le",
  requestedEncoderPixelFormat: "yuva444p10le",
  probedOutputPixelFormat: "yuva444p12le",
  probedBitsPerRawSample: 12,
  effectiveMinimumAlphaBits: 10,
  straight: { alphaLevels: 1_024, alphaMinimum: 0, alphaMaximum: 65_520, zeroAlphaPixelCount: 1, zeroAlphaRgbMaximum: 512 },
  premultiplied: { alphaLevels: 1_024, alphaMinimum: 0, alphaMaximum: 65_520, zeroAlphaPixelCount: 1, zeroAlphaRgbMaximum: 512 },
  foregroundRoundTrip: { comparedSamples: 1, maxAbsoluteError: 100, meanAbsoluteError: 2, alphaMaxAbsoluteError: 0 },
  outputHashesBound: true,
});

function calibrateEvaluator(): string[] {
  const mutations: Array<[string, (facts: DeliveryFacts) => void]> = [
    ["schema", (facts) => { (facts as { schema: string }).schema = "wrong"; }],
    ["plan", (facts) => { facts.planBound = false; }],
    ["receipt", (facts) => { facts.straightReceiptGreen = false; }],
    ["working-format", (facts) => { facts.workingPixelFormat = "rgba"; }],
    ["encoder-format", (facts) => { facts.probedOutputPixelFormat = "yuv444p12le"; }],
    ["effective-bits", (facts) => { facts.effectiveMinimumAlphaBits = 8; }],
    ["levels", (facts) => { facts.straight.alphaLevels = 511; }],
    ["minimum-endpoint", (facts) => { facts.straight.alphaMinimum = 1; }],
    ["maximum-endpoint", (facts) => { facts.premultiplied.alphaMaximum = 65_000; }],
    ["zero-alpha-rgb", (facts) => { facts.straight.zeroAlphaRgbMaximum = 1_025; }],
    ["zero-alpha-missing", (facts) => { facts.premultiplied.zeroAlphaPixelCount = 0; }],
    ["alpha-consistency", (facts) => { facts.foregroundRoundTrip.alphaMaxAbsoluteError = 65; }],
    ["foreground-max", (facts) => { facts.foregroundRoundTrip.maxAbsoluteError = 2_049; }],
    ["foreground-mean", (facts) => { facts.foregroundRoundTrip.meanAbsoluteError = 513; }],
    ["hash-binding", (facts) => { facts.outputHashesBound = false; }],
  ];
  assert.deepEqual(evaluate(validFacts()), []);
  for (const [name, mutate] of mutations) {
    const facts = structuredClone(validFacts());
    mutate(facts);
    assert.ok(evaluate(facts).length > 0, `evaluator accepted mutation ${name}`);
  }
  return mutations.map(([name]) => name);
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function fileIdentity(path: string) {
  const bytes = await readFile(path);
  return {
    path: path.slice(root.length + 1).replaceAll("\\", "/"),
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function inspectFrozenPlan() {
  const bytes = await readFile(planPath);
  const identity = {
    path: planPath.slice(root.length + 1).replaceAll("\\", "/"),
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    return { identity, bound: false, failures: ["plan-json-parse"], declared: null };
  }
  const plan = jsonObject(value);
  const boundedExperiment = jsonObject(plan?.boundedExperiment);
  const declared = {
    schema: plan?.schema ?? null,
    id: plan?.id ?? null,
    ledgerObligation: plan?.ledgerObligation ?? null,
    decisionRule: plan?.decisionRule ?? null,
    requiredBeforeInternalVerified: plan?.requiredBeforeInternalVerified ?? null,
    thresholds: boundedExperiment?.thresholds ?? null,
  };
  const failures = validateFrozenPlan(value);
  return { identity, bound: failures.length === 0, failures, declared };
}

async function selfTest(): Promise<void> {
  const rejectedMutations = calibrateEvaluator();
  const frozenPlan = JSON.parse(await readFile(planPath, "utf8")) as unknown;
  assert.deepEqual(validateFrozenPlan(frozenPlan), []);
  const thresholdMutation = structuredClone(frozenPlan);
  const thresholdRecord = jsonObject(jsonObject(jsonObject(thresholdMutation)?.boundedExperiment)?.thresholds);
  assert.ok(thresholdRecord);
  thresholdRecord.minimumDecodedAlphaLevels = THRESHOLDS.minimumDecodedAlphaLevels - 1;
  assert.ok(validateFrozenPlan(thresholdMutation).includes("plan-threshold-minimumDecodedAlphaLevels"));
  const decisionMutation = structuredClone(frozenPlan);
  const decisionRecord = jsonObject(decisionMutation);
  assert.ok(decisionRecord);
  decisionRecord.decisionRule = "A bounded result verifies the full internal cell.";
  assert.ok(validateFrozenPlan(decisionMutation).includes("plan-decision-rule"));
  const requirementMutation = structuredClone(frozenPlan);
  const requirementRecord = jsonObject(requirementMutation);
  assert.ok(requirementRecord);
  requirementRecord.requiredBeforeInternalVerified = PLAN_CONTRACT.requiredBeforeInternalVerified.slice(0, -1);
  assert.ok(validateFrozenPlan(requirementMutation).includes("plan-required-before-internal-verified"));
  assert.deepEqual(compositePixelContract(true), {
    rgba: "gbrap16le", rgb: "gbrp16le", gray: "gray16le", grayMaximum: 65535, encodedPixelFormat: "yuva444p10le",
  });
  assert.deepEqual([...HIGH_BIT_DEPTH_ALPHA_ENCODER_ARGS], ["-c:v", "prores_ks", "-profile:v", "4", "-alpha_bits", "16", "-vendor", "apl0"]);
  const project = fixtureProject("D:/fixture.png");
  assert.doesNotThrow(() => assertHighBitDepthAlphaDeliveryProject(project, "D:/foreground.mov"));
  assert.throws(() => assertHighBitDepthAlphaDeliveryProject(project, "D:/foreground.mp4"), /\.mov/);
  const aces = fixtureProject("D:/fixture.png");
  aces.colorManagement = { ...aces.colorManagement!, mode: "aces2" };
  assert.throws(() => assertHighBitDepthAlphaDeliveryProject(aces, "D:/foreground.mov"), /Rec\.709/);
  const caption = fixtureProject("D:/fixture.png");
  caption.captions.push({ id: "caption", text: "unsupported", start: 0, duration: 1 });
  assert.throws(() => assertHighBitDepthAlphaDeliveryProject(caption, "D:/foreground.mov"), /字幕/);
  const blend = fixtureProject("D:/fixture.png");
  blend.tracks[0]!.clips[0]!.layer = { enabled: true, blendMode: "screen" };
  assert.throws(() => assertHighBitDepthAlphaDeliveryProject(blend, "D:/foreground.mov"), /安全阻擋/);
  const validProbe = {
    duration: 1, hasVideo: true, hasAudio: true, codecName: "prores", codecProfile: "4444",
    pixelFormat: "yuva444p12le", bitsPerRawSample: 12, audioCodecName: "pcm_s24le",
  };
  assert.doesNotThrow(() => assertHighBitDepthAlphaOutputProbe(validProbe));
  assert.throws(() => assertHighBitDepthAlphaOutputProbe({ ...validProbe, pixelFormat: "yuv444p12le" }), /pix_fmt/);
  assert.throws(() => assertHighBitDepthAlphaOutputProbe({ ...validProbe, audioCodecName: "aac" }), /24-bit PCM/);
  const sources = [
    planPath,
    fileURLToPath(import.meta.url),
    join(root, "src/render/highBitDepthAlphaDelivery.ts"),
    join(root, "src/render/highBitDepthAlphaDelivery.test.ts"),
  ];
  const report = {
    schema: "editkin.high-bit-depth-alpha-delivery-self-test/v2",
    generatedAt: new Date().toISOString(),
    status: "GREEN_EVALUATOR_CALIBRATED_PRODUCT_CELL_PLANNED",
    evaluator: { mutationCount: rejectedMutations.length, allRejected: true, rejectedMutations },
    negativeControls: {
      wrongContainerRejected: true,
      acesRejected: true,
      captionRejected: true,
      nonNormalBlendRejected: true,
      missingAlphaPixelFormatRejected: true,
      missingPcm24AudioRejected: true,
      planThresholdDriftRejected: true,
      planDecisionRuleDriftRejected: true,
      planRequirementRemovalRejected: true,
    },
    sources: Object.fromEntries(await Promise.all(sources.map(async (path) => [path.slice(root.length + 1).replaceAll("\\", "/"), { bytes: (await readFile(path)).byteLength, sha256: await sha256(path) }]))),
    claimBoundary: "Evaluator and fail-closed contract calibration only. No rendered artifact, half/float EXR, Preview parity, delivered runtime or broad internal-cell completion is claimed.",
  };
  await mkdir(evidenceRoot, { recursive: true });
  await writeFile(selfTestPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`high-bit-depth alpha delivery self-test passed (${rejectedMutations.length} evaluator mutations)\n`);
}

async function gate(): Promise<void> {
  const rejectedMutations = calibrateEvaluator();
  await mkdir(evidenceRoot, { recursive: true });
  const fixture = join(evidenceRoot, "alpha-gradient-straight-rgba16.png");
  const premultipliedFixture = join(evidenceRoot, "alpha-gradient-premultiplied-rgba16.png");
  const output = join(evidenceRoot, "foreground-straight-prores4444-alpha.mov");
  const premultipliedOutput = join(evidenceRoot, "foreground-premultiplied-prores4444-alpha.mov");
  const decodedAlpha = join(evidenceRoot, "foreground-straight-alpha.gray16le");
  const premultipliedDecodedAlpha = join(evidenceRoot, "foreground-premultiplied-alpha.gray16le");
  const decodedRgba = join(evidenceRoot, "foreground-straight.gbrap16le");
  const premultipliedDecodedRgba = join(evidenceRoot, "foreground-premultiplied.gbrap16le");
  await Promise.all([output, premultipliedOutput, decodedAlpha, premultipliedDecodedAlpha, decodedRgba, premultipliedDecodedRgba].map((path) => rm(path, { force: true })));
  await runProcess(ffmpeg, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "nullsrc=s=64x64:r=1:d=1,format=gbrap16le,geq=r='50000':g='30000':b='10000':a='mod(X+Y*64,1024)*65535/1023'",
    "-frames:v", "1", "-pix_fmt", "rgba64be", fixture,
  ], 30_000);
  await runProcess(ffmpeg, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "nullsrc=s=64x64:r=1:d=1,format=gbrap16le,geq=r='50000*mod(X+Y*64,1024)/1023':g='30000*mod(X+Y*64,1024)/1023':b='10000*mod(X+Y*64,1024)/1023':a='mod(X+Y*64,1024)*65535/1023'",
    "-frames:v", "1", "-pix_fmt", "rgba64be", premultipliedFixture,
  ], 30_000);
  const renderOptions = {
    ffmpegPath: ffmpeg,
    ffprobePath: ffprobe,
    nativeCorePath: join(evidenceRoot, "absent-native-core"),
    preferGpu: false,
    deliveryProfile: "prores4444_alpha_10bit",
    timeoutMs: 120_000,
  } as const;
  const result = await renderProject(fixtureProject(fixture, "straight"), output, renderOptions);
  const premultipliedResult = await renderProject(fixtureProject(premultipliedFixture, "premultiplied"), premultipliedOutput, renderOptions);
  for (const [source, alpha, rgba] of [[output, decodedAlpha, decodedRgba], [premultipliedOutput, premultipliedDecodedAlpha, premultipliedDecodedRgba]]) {
    await runProcess(ffmpeg, [
      "-y", "-hide_banner", "-loglevel", "error", "-i", source,
      "-frames:v", "1", "-vf", "alphaextract,format=gray16le", "-f", "rawvideo", alpha,
    ], 30_000);
    await runProcess(ffmpeg, [
      "-y", "-hide_banner", "-loglevel", "error", "-i", source,
      "-frames:v", "1", "-pix_fmt", "gbrap16le", "-f", "rawvideo", rgba,
    ], 30_000);
  }
  const decodedAlphaLevels = alphaLevels(await readFile(decodedAlpha));
  const premultipliedDecodedAlphaLevels = alphaLevels(await readFile(premultipliedDecodedAlpha));
  const straightRgba = await readFile(decodedRgba);
  const premultipliedRgba = await readFile(premultipliedDecodedRgba);
  const straight = inspectDecodedRgba(straightRgba);
  const premultiplied = inspectDecodedRgba(premultipliedRgba);
  const foregroundRoundTrip = compareStraightForeground(straightRgba, premultipliedRgba);
  const receipt = result.alphaDelivery;
  const premultipliedReceipt = premultipliedResult.alphaDelivery;
  const sourcePaths = [
    planPath,
    fileURLToPath(import.meta.url),
    join(root, "src/render/highBitDepthAlphaDelivery.ts"),
    join(root, "src/render/highBitDepthAlphaDelivery.test.ts"),
    join(root, "src/render/ffmpeg.ts"),
    join(root, "src/render/ffmpegComposite.ts"),
    join(root, "src/domain/chromaKey.ts"),
    join(root, "src/render/maskFilters.ts"),
  ];
  const outputSha256 = await sha256(output);
  const premultipliedOutputSha256 = await sha256(premultipliedOutput);
  const planInspection = await inspectFrozenPlan();
  const sourceSha256 = Object.fromEntries(await Promise.all(sourcePaths.map(async (path) => [path.slice(root.length + 1).replaceAll("\\", "/"), await sha256(path)])));
  const planIdentityStillCurrent = sourceSha256[planInspection.identity.path] === planInspection.identity.sha256;
  const facts: DeliveryFacts = {
    schema: "editkin.high-bit-depth-alpha-bounded-facts/v2",
    planBound: planInspection.bound && planIdentityStillCurrent,
    straightReceiptGreen: receipt?.status === "GREEN",
    premultipliedReceiptGreen: premultipliedReceipt?.status === "GREEN",
    workingPixelFormat: receipt?.workingPixelFormat ?? "missing",
    requestedEncoderPixelFormat: receipt?.requestedEncoderPixelFormat ?? "missing",
    probedOutputPixelFormat: receipt?.probedOutputPixelFormat ?? "missing",
    probedBitsPerRawSample: receipt?.probedBitsPerRawSample ?? 0,
    effectiveMinimumAlphaBits: Math.min(receipt?.effectiveMinimumAlphaBits ?? 0, premultipliedReceipt?.effectiveMinimumAlphaBits ?? 0),
    straight: { ...straight, alphaLevels: decodedAlphaLevels },
    premultiplied: { ...premultiplied, alphaLevels: premultipliedDecodedAlphaLevels },
    foregroundRoundTrip,
    outputHashesBound: receipt?.outputSha256 === outputSha256
      && premultipliedReceipt?.outputSha256 === premultipliedOutputSha256,
  };
  const failures = evaluate(facts);
  const green = failures.length === 0;
  const report = {
    schema: "editkin.high-bit-depth-alpha-delivery-gate/v2",
    generatedAt: new Date().toISOString(),
    status: green ? "GREEN_BOUNDED_PRORES_SLICE_BROAD_CAPABILITY_PLANNED" : "BLOCK",
    claim: "The bounded Rec.709 normal source-over product path must preserve high-cardinality alpha including exact 0/1 endpoints for straight and premultiplied fixtures, bound hidden RGB beneath decoded zero alpha, and retain foreground consistency after actual ProRes 4444 encode/decode.",
    baseline: "The default 8-bit render path and encoder-list presence do not qualify; all facts come from the same fixture and actual EditGraph -> formal compositor -> encoder -> separately executed FFmpeg decode pass with executable and artifact identity.",
    thresholds: THRESHOLDS,
    facts,
    failures,
    frozenPlan: { ...planInspection, identityStillCurrent: planIdentityStillCurrent },
    evaluator: { mutationCount: rejectedMutations.length, allRejected: true, rejectedMutations },
    fixture: {
      format: "rgba64be PNG", alphaLevels: 1024,
      straightSha256: await sha256(fixture), premultipliedSha256: await sha256(premultipliedFixture),
    },
    decodedOutput: {
      straight,
      premultiplied,
      foregroundRoundTrip,
      straightAlphaSha256: await sha256(decodedAlpha),
      premultipliedAlphaSha256: await sha256(premultipliedDecodedAlpha),
      straightRgbaArtifact: await fileIdentity(decodedRgba),
      premultipliedRgbaArtifact: await fileIdentity(premultipliedDecodedRgba),
    },
    result: { straight: result, premultiplied: premultipliedResult },
    compiler: {
      workingPixelContract: compositePixelContract(true),
      encoderArgs: [...HIGH_BIT_DEPTH_ALPHA_ENCODER_ARGS],
      sourceSha256,
    },
    runtime: {
      ffmpeg: { path: ffmpeg, sha256: await sha256(ffmpeg) },
      ffprobe: { path: ffprobe, sha256: await sha256(ffprobe) },
    },
    claimBoundary: "Deterministic one-frame Rec.709 straight and premultiplied RGBA16 fixtures traversed the complete EditGraph -> formal FFmpeg compositor -> prores_ks product path, retained at least 512 decoded alpha levels including exact endpoints, and converged within the recorded bounded foreground error away from near-zero alpha. This bounded slice does not prove half/float EXR, every graph crossing, Preview parity, save/reopen, delivered installer/Mac, real-footage Roto/Keyer quality, mathematically lossless codec behavior or external-product parity; the broad ledger cell remains planned.",
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ status: report.status, decodedAlphaLevels, premultipliedDecodedAlphaLevels, foregroundRoundTrip, receipt, evidence: reportPath }, null, 2)}\n`);
  if (!green) process.exitCode = 1;
}

if (process.argv.includes("--self-test")) await selfTest();
else await gate();
