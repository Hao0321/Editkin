import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { bindSam21VideoPack, probeSam21VideoPackRuntime } from "../src/application/autoRotoVideoModel";

const appRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(appRoot, "../..");
const packRoot = resolve(repoRoot, ".rd/model-packs/editkin-auto-roto-sam21-tiny-windows-cuda-1.0.3");
const privateKeyPath = resolve(repoRoot, ".rd/keys/editkin-auto-roto-ed25519-private.pem");
const buildReportPath = resolve(appRoot, ".rd/benchmarks/editkin-auto-roto-sam21-portable-pack/report.json");
const reportRoot = resolve(appRoot, ".rd/benchmarks/editkin-auto-roto-sam21-portable-pack-gate");
const reportPath = resolve(reportRoot, "report.json");
const sourceCommit = "2b90b9f5ceec907a1c18123530e92e794ad901a4";

function hash(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

async function walk(root: string, directory = root): Promise<Array<{ path: string; bytes: number; sha256: string }>> {
  const files: Array<{ path: string; bytes: number; sha256: string }> = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    const target = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(root, target));
    else if (entry.isFile()) {
      const path = relative(root, target).replaceAll("\\", "/");
      if (!["manifest.json", "pack-receipt.json", "pack-receipt.sig"].includes(path)) {
        files.push({ path, bytes: (await stat(target)).size, sha256: hash(await readFile(target)) });
      }
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path, "en"));
}

async function fixture(root: string, privateKey: string, options: { selfContained?: boolean; wrongSigner?: boolean } = {}) {
  const moduleRoots = Object.fromEntries(["torch", "torchvision", "numpy", "PIL", "hydra", "omegaconf", "iopath", "sam2"].map((name) => [name, `source/modules/${name}/__init__.py`]));
  const payloads: Record<string, string> = {
    "host/auto-roto-sam21-video-host.py": "print('fixture')\n", "runtime/python.exe": "fixture-python",
    "source/UPSTREAM_COMMIT": `${sourceCommit}\n`, "source/configs/sam2.1/test.yaml": "model: fixture\n",
    "source/checkpoints/model.pt": "fixture-model", "licenses/SAM2-LICENSE.txt": "Apache-2.0\n",
    ...Object.fromEntries(Object.values(moduleRoots).map((path) => [path, "# fixture\n"])),
  };
  for (const [path, value] of Object.entries(payloads)) { await mkdir(resolve(root, path, ".."), { recursive: true }); await writeFile(resolve(root, path), value, "utf8"); }
  const runtimeReceipt = {
    schema: "editkin.auto-roto-python-runtime/v2", selfContained: options.selfContained !== false, isolated: true,
    userSite: false, externalImports: 0, pythonPath: "runtime/python.exe", moduleRoots,
  };
  await mkdir(resolve(root, "runtime"), { recursive: true });
  await writeFile(resolve(root, "runtime/runtime-receipt.json"), JSON.stringify(runtimeReceipt), "utf8");
  const files = await walk(root);
  const sha = async (path: string) => hash(await readFile(resolve(root, path)));
  const manifestIdentity = {
    schema: "editkin.auto-roto-video-pack/v2", id: "editkin-auto-roto-fixture", version: "1.0.0", qualityTier: "production",
    publisherKeyId: "editkin-auto-roto-production-2026", signatureAlgorithm: "ed25519",
    hostPath: "host/auto-roto-sam21-video-host.py", hostSha256: await sha("host/auto-roto-sam21-video-host.py"),
    pythonPath: "runtime/python.exe", pythonSha256: await sha("runtime/python.exe"), sourceRoot: "source", sourceMarkerPath: "source/UPSTREAM_COMMIT", sourceMarkerSha256: await sha("source/UPSTREAM_COMMIT"),
    configPath: "source/configs/sam2.1/test.yaml", configSha256: await sha("source/configs/sam2.1/test.yaml"), configName: "configs/sam2.1/test.yaml",
    checkpointPath: "source/checkpoints/model.pt", checkpointSha256: await sha("source/checkpoints/model.pt"), licensePath: "licenses/SAM2-LICENSE.txt", licenseSha256: await sha("licenses/SAM2-LICENSE.txt"),
    runtimeReceiptPath: "runtime/runtime-receipt.json", runtimeReceiptSha256: await sha("runtime/runtime-receipt.json"), sourceCommit, precision: "float16", requiredDevice: "cuda",
  };
  const receipt = {
    schema: "editkin.auto-roto-pack-receipt/v1", packId: manifestIdentity.id, packVersion: manifestIdentity.version,
    qualityTier: "production", publisherKeyId: "editkin-auto-roto-production-2026", sourceCommit,
    precision: "float16", requiredDevice: "cuda", manifestIdentitySha256: hash(Buffer.from(JSON.stringify(manifestIdentity))), inventorySha256: hash(Buffer.from(JSON.stringify(files))), files,
  };
  const receiptBytes = Buffer.from(JSON.stringify(receipt));
  let signer = privateKey;
  if (options.wrongSigner) signer = generateKeyPairSync("ed25519", { privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
  const signature = `${sign(null, receiptBytes, signer).toString("base64")}\n`;
  await writeFile(resolve(root, "pack-receipt.json"), receiptBytes);
  await writeFile(resolve(root, "pack-receipt.sig"), signature, "utf8");
  const manifest = {
    ...manifestIdentity, receiptPath: "pack-receipt.json", receiptSha256: hash(receiptBytes),
    signaturePath: "pack-receipt.sig", signatureSha256: hash(Buffer.from(signature)),
  };
  await writeFile(resolve(root, "manifest.json"), JSON.stringify(manifest), "utf8");
  return { manifest, request: { trustedRoot: root, manifestPath: resolve(root, "manifest.json"), hostScriptPath: resolve(root, "host/auto-roto-sam21-video-host.py") } };
}

async function rejected(id: string, action: () => Promise<unknown>, pattern: RegExp) {
  try { await action(); return { id, passed: false, message: "unexpected success" }; }
  catch (error) { const message = error instanceof Error ? error.message : String(error); return { id, passed: pattern.test(message), message }; }
}

async function syntheticCalibration(privateKey: string) {
  const root = await mkdtemp(join(tmpdir(), "editkin-roto-pack-gate-"));
  try {
    const valid = await fixture(join(root, "valid"), privateKey);
    const bound = await bindSam21VideoPack(valid.request);
    const cachedModulePath = resolve(valid.request.trustedRoot, "source/modules/numpy/__init__.py");
    await writeFile(cachedModulePath, "tampered!\n", "utf8");
    const cachedPayloadTamper = await rejected("cached-payload-tamper", () => bindSam21VideoPack(valid.request), /closed-world inventory/);
    await writeFile(cachedModulePath, "# fixture\n", "utf8");
    await bindSam21VideoPack(valid.request);
    const originalSignature = await readFile(resolve(valid.request.trustedRoot, "pack-receipt.sig"), "utf8");
    await writeFile(resolve(valid.request.trustedRoot, "pack-receipt.sig"), `${"A".repeat(84)}\n`, "utf8");
    const signatureTamper = await rejected("signature-tamper", () => bindSam21VideoPack(valid.request), /control SHA-256|簽章驗證/);
    await writeFile(resolve(valid.request.trustedRoot, "pack-receipt.sig"), originalSignature, "utf8");
    await writeFile(resolve(valid.request.trustedRoot, "source/checkpoints/model.pt"), "tampered", "utf8");
    const payloadTamper = await rejected("payload-tamper", () => bindSam21VideoPack(valid.request), /closed-world inventory|checkpointSha256/);
    const extra = await fixture(join(root, "extra"), privateKey); await writeFile(resolve(extra.request.trustedRoot, "extra.bin"), "extra", "utf8");
    const extraFile = await rejected("extra-file", () => bindSam21VideoPack(extra.request), /closed-world inventory/);
    const falseRuntime = await fixture(join(root, "false-runtime"), privateKey, { selfContained: false });
    const runtimeLie = await rejected("runtime-lie", () => bindSam21VideoPack(falseRuntime.request), /runtime 必須可攜且自足|離線自足合約/);
    const wrongSigner = await fixture(join(root, "wrong-signer"), privateKey, { wrongSigner: true });
    const untrustedSigner = await rejected("untrusted-signer", () => bindSam21VideoPack(wrongSigner.request), /簽章驗證失敗/);
    const callerMismatch = await fixture(join(root, "host-mismatch"), privateKey);
    callerMismatch.request.hostScriptPath = resolve(callerMismatch.request.trustedRoot, "runtime/python.exe");
    const hostMismatch = await rejected("host-mismatch", () => bindSam21VideoPack(callerMismatch.request), /host 不等於簽章 pack host/);
    const manifestTamperFixture = await fixture(join(root, "manifest-tamper"), privateKey);
    const manifestTamperPath = resolve(manifestTamperFixture.request.trustedRoot, "manifest.json");
    const manifestTamperValue = JSON.parse(await readFile(manifestTamperPath, "utf8"));
    manifestTamperValue.configName = "configs/sam2.1/other.yaml";
    await writeFile(manifestTamperPath, JSON.stringify(manifestTamperValue), "utf8");
    const manifestTamper = await rejected("manifest-semantic-tamper", () => bindSam21VideoPack(manifestTamperFixture.request), /manifest 語意身分/);
    return { bound, faults: [cachedPayloadTamper, signatureTamper, payloadTamper, extraFile, runtimeLie, untrustedSigner, hostMismatch, manifestTamper] };
  } finally { await rm(root, { recursive: true, force: true }); }
}

const privateKey = await readFile(privateKeyPath, "utf8");
const calibration = await syntheticCalibration(privateKey);
if (process.argv.includes("--self-test")) {
  if (calibration.bound.identity.qualityTier !== "production" || calibration.faults.some((fault) => !fault.passed)) throw new Error("portable pack evaluator calibration failed");
  process.stdout.write(`${JSON.stringify({ status: "GREEN", negativeControls: calibration.faults.length })}\n`);
  process.exit(0);
}
const actualRequest = { trustedRoot: packRoot, manifestPath: resolve(packRoot, "manifest.json"), hostScriptPath: resolve(packRoot, "host/auto-roto-sam21-video-host.py") };
const actual = await bindSam21VideoPack(actualRequest);
const probe = await probeSam21VideoPackRuntime(actual);
const buildReportBytes = await readFile(buildReportPath);
const buildReport = JSON.parse(buildReportBytes.toString("utf8"));
const checks = {
  buildGreen: buildReport.status === "GREEN" && buildReport.files >= 5_000 && buildReport.bytes >= 4_000_000_000 && buildReport.manifest?.sha256 === actual.identity.manifestSha256,
  productionIdentity: actual.identity.schema === "editkin.auto-roto-video-pack/v2" && actual.identity.qualityTier === "production" && actual.identity.selfContained,
  publisherTrust: actual.identity.publisherKeyId === "editkin-auto-roto-production-2026" && [actual.identity.receiptSha256, actual.identity.signatureSha256, actual.identity.inventorySha256].every((value) => /^[a-f0-9]{64}$/.test(value ?? "")),
  isolatedRuntime: buildReport.runtime?.isolated === true && buildReport.runtime?.userSite === false && buildReport.runtime?.externalImports === 0,
  qualifiedCell: probe.available && probe.gpu === "NVIDIA GeForce RTX 2060" && probe.cudaRuntime === "11.8",
  negativesCalibrated: calibration.faults.every((fault) => fault.passed),
};
const status = Object.values(checks).every(Boolean) ? "GREEN" : "FAIL";
const report = {
  schema: "editkin.auto-roto-sam21-portable-pack-gate/v1", status, checks, identity: actual.identity, probe,
  faults: calibration.faults, buildReport: { path: buildReportPath, bytes: buildReportBytes.length, sha256: hash(buildReportBytes) },
  claimBoundary: "Proves the exact Windows CUDA model pack is Ed25519-publisher-bound, closed-world, self-contained, isolated from system Python, importable and GPU-ready. Public Authenticode and macOS are separate scopes.",
};
await mkdir(reportRoot, { recursive: true });
await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
process.stdout.write(`AUTO_ROTO_PORTABLE_PACK status=${status} negatives=${calibration.faults.length} report=${reportPath}\n`);
if (status !== "GREEN") process.exitCode = 1;
