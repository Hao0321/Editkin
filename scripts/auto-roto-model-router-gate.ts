import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { analyzeAutoRoto } from "../src/application/autoRoto";
import {
  AUTO_ROTO_NATIVE_ENGINE,
  AUTO_ROTO_ONNX_ENGINE,
  AUTO_ROTO_ROUTING_POLICY,
  AUTO_ROTO_SAM21_ENGINE,
  AutoRotoRouteError,
  requireAutoRotoRoute,
  resolveAutoRotoRoute,
  routeAutoRotoNativeFallback,
  type AutoRotoRouteReceipt,
} from "../src/application/autoRotoModelRouter";

const root = resolve(import.meta.dirname, "..");
const reportPath = join(root, ".rd", "benchmarks", "editkin-auto-roto-model-router", "report.json");

interface Facts {
  policyVersionExact: boolean;
  productDefaultsSelfAuthored: boolean;
  productRejectsOnnx: boolean;
  productRejectsSam21: boolean;
  productRejectsBeforeFilesystem: boolean;
  researchSamExplicit: boolean;
  debugOnnxExplicit: boolean;
  integrationFixtureRejectedFromResearch: boolean;
  unknownPolicyRejected: boolean;
  deterministicReceiptHash: boolean;
  fallbackPreservesRequestedIdentity: boolean;
  externalCandidatesNeverSelectedInProduct: boolean;
  routeErrorsCarryReceipt: boolean;
  externalResultsForcedDiagnostic: boolean;
}

function hashReceipt(receipt: AutoRotoRouteReceipt): string {
  const { receiptSha256: _receiptSha256, ...body } = receipt;
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

function evaluate(facts: Facts): string[] {
  return Object.entries(facts).filter(([, passed]) => !passed).map(([name]) => name);
}

const validFacts: Facts = {
  policyVersionExact: true,
  productDefaultsSelfAuthored: true,
  productRejectsOnnx: true,
  productRejectsSam21: true,
  productRejectsBeforeFilesystem: true,
  researchSamExplicit: true,
  debugOnnxExplicit: true,
  integrationFixtureRejectedFromResearch: true,
  unknownPolicyRejected: true,
  deterministicReceiptHash: true,
  fallbackPreservesRequestedIdentity: true,
  externalCandidatesNeverSelectedInProduct: true,
  routeErrorsCarryReceipt: true,
  externalResultsForcedDiagnostic: true,
};

function selfTest(): number {
  if (evaluate(validFacts).length) throw new Error("Model-router evaluator rejects its valid control");
  const keys = Object.keys(validFacts) as Array<keyof Facts>;
  for (const key of keys) {
    const mutation = { ...validFacts, [key]: false };
    if (!evaluate(mutation).length) throw new Error(`Model-router evaluator accepted mutation: ${key}`);
  }
  return keys.length;
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function rejectsBeforeFilesystem(): Promise<boolean> {
  try {
    await analyzeAutoRoto({
      sourcePath: join(root, "does-not-exist", "source.mp4"),
      sourceStart: 0,
      duration: 1,
      fps: 24,
      sourceWidth: 1920,
      sourceHeight: 1080,
      initialTime: 0,
      initialRect: { x: 0.25, y: 0.2, width: 0.5, height: 0.6 },
    }, {
      ffmpegPath: join(root, "does-not-exist", "ffmpeg"),
      nativeCorePath: join(root, "does-not-exist", "hao-core"),
      cacheRoot: join(root, "does-not-exist", "cache"),
      routePolicy: { mode: "product", requestedEngine: AUTO_ROTO_SAM21_ENGINE },
      sam21Pack: {
        trustedRoot: join(root, "does-not-exist", "sam21"),
        manifestPath: join(root, "does-not-exist", "sam21", "manifest.json"),
        hostScriptPath: join(root, "does-not-exist", "sam21", "host.py"),
      },
    });
    return false;
  } catch (error) {
    return error instanceof AutoRotoRouteError
      && error.routeReceipt.reasonCode === "product-policy-self-authored-engine-only"
      && error.routeReceipt.status === "rejected";
  }
}

async function collectFacts(): Promise<Facts> {
  const configured = { onnxConfigured: true, sam21Configured: true };
  const product = requireAutoRotoRoute(resolveAutoRotoRoute(configured));
  const productOnnx = resolveAutoRotoRoute({ ...configured, policy: { mode: "product", requestedEngine: AUTO_ROTO_ONNX_ENGINE } });
  const productSam = resolveAutoRotoRoute({ ...configured, policy: { mode: "product", requestedEngine: AUTO_ROTO_SAM21_ENGINE } });
  const researchSam = requireAutoRotoRoute(resolveAutoRotoRoute({
    ...configured,
    policy: { mode: "research", requestedEngine: AUTO_ROTO_SAM21_ENGINE },
    sam21QualityTier: "research_candidate",
  }));
  const debugOnnx = requireAutoRotoRoute(resolveAutoRotoRoute({
    ...configured,
    policy: { mode: "debug", requestedEngine: AUTO_ROTO_ONNX_ENGINE },
    onnxQualityTier: "integration_fixture",
  }));
  const researchFixture = resolveAutoRotoRoute({
    ...configured,
    policy: { mode: "research", requestedEngine: AUTO_ROTO_ONNX_ENGINE },
    onnxQualityTier: "integration_fixture",
  });
  const unknown = resolveAutoRotoRoute({ ...configured, policy: { mode: "product", allowCommercialLicense: true } });
  const fallback = routeAutoRotoNativeFallback(researchSam);
  const [applicationSource, routerSource] = await Promise.all([
    readFile(join(root, "src", "application", "autoRoto.ts"), "utf8"),
    readFile(join(root, "src", "application", "autoRotoModelRouter.ts"), "utf8"),
  ]);
  return {
    policyVersionExact: product.policyVersion === AUTO_ROTO_ROUTING_POLICY,
    productDefaultsSelfAuthored: product.mode === "product" && product.selectedEngine === AUTO_ROTO_NATIVE_ENGINE
      && product.candidates.find((candidate) => candidate.engine === AUTO_ROTO_NATIVE_ENGINE)?.origin === "editkin-self-authored",
    productRejectsOnnx: productOnnx.status === "rejected" && productOnnx.reasonCode === "product-policy-self-authored-engine-only",
    productRejectsSam21: productSam.status === "rejected" && productSam.reasonCode === "product-policy-self-authored-engine-only",
    productRejectsBeforeFilesystem: await rejectsBeforeFilesystem(),
    researchSamExplicit: researchSam.mode === "research" && researchSam.selectedEngine === AUTO_ROTO_SAM21_ENGINE,
    debugOnnxExplicit: debugOnnx.mode === "debug" && debugOnnx.selectedEngine === AUTO_ROTO_ONNX_ENGINE,
    integrationFixtureRejectedFromResearch: researchFixture.status === "rejected" && researchFixture.reasonCode === "integration-fixture-requires-debug-mode",
    unknownPolicyRejected: unknown.status === "rejected" && unknown.reasonCode === "unknown-policy-field",
    deterministicReceiptHash: product.receiptSha256 === hashReceipt(product)
      && product.receiptSha256 === resolveAutoRotoRoute(configured).receiptSha256,
    fallbackPreservesRequestedIdentity: fallback.mode === "research" && fallback.requestedEngine === AUTO_ROTO_SAM21_ENGINE
      && fallback.selectedEngine === AUTO_ROTO_NATIVE_ENGINE && fallback.reasonCode === "requested-runtime-unavailable-native-fallback",
    externalCandidatesNeverSelectedInProduct: product.candidates.filter((candidate) => candidate.origin === "external-model-pack")
      .every((candidate) => candidate.decision === "not-selected"),
    routeErrorsCarryReceipt: routerSource.includes("readonly routeReceipt: AutoRotoRouteReceipt")
      && routerSource.includes("this.routeReceipt = receipt")
      && applicationSource.includes("if (error instanceof AutoRotoRouteError) throw error")
      && applicationSource.includes("throw new AutoRotoRouteError(rejected"),
    externalResultsForcedDiagnostic: applicationSource.includes("routeReceipt.mode === \"product\"")
      && applicationSource.includes("? \"measured\" : \"diagnostic\"")
      && !applicationSource.includes("routeReceipt.mode !== \"product\" ? \"measured\""),
  };
}

async function main(): Promise<void> {
  const mutationCount = selfTest();
  if (process.argv.includes("--self-test")) {
    console.log(`AUTO_ROTO_MODEL_ROUTER_SELF_TEST status=GREEN mutations=${mutationCount}`);
    return;
  }
  const facts = await collectFacts();
  const failures = evaluate(facts);
  const sources = {
    router: { path: "src/application/autoRotoModelRouter.ts", sha256: await sha256(join(root, "src", "application", "autoRotoModelRouter.ts")) },
    application: { path: "src/application/autoRoto.ts", sha256: await sha256(join(root, "src", "application", "autoRoto.ts")) },
    gate: { path: "scripts/auto-roto-model-router-gate.ts", sha256: await sha256(join(root, "scripts", "auto-roto-model-router-gate.ts")) },
    tests: { path: "src/application/autoRotoModelRouter.test.ts", sha256: await sha256(join(root, "src", "application", "autoRotoModelRouter.test.ts")) },
  };
  const report = {
    schema: "editkin.auto-roto-model-router-gate-report/v1",
    generatedAt: new Date().toISOString(),
    status: failures.length ? "BLOCK" : "GREEN_INTERNAL_PRODUCT_POLICY",
    facts,
    failures,
    evaluator: { mutationCount, allRejected: true },
    sources,
    claimBoundary: [
      "Product mode admits only the Editkin-authored native route; it does not claim that native Auto Roto quality is measured.",
      "SAM 2.1 and ONNX remain explicit isolated research/debug routes and cannot close product readiness.",
      "Public installer, Mac parity, model-pack SBOM/rights, and real blind quality are not closed by this router gate.",
    ],
  };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (failures.length) throw new Error(`Auto Roto model router BLOCK: ${failures.join(", ")}`);
  console.log(`Auto Roto model router GREEN (internal product policy) · report ${reportPath}`);
}

await main();
