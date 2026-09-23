import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  assertTauriNativePolicyPin,
  assertTauriProductRustflagEnvironment,
  tauriProductCargoBuildArgs,
  tauriProductBuildArgs,
} from "./lib/tauri-product-feature-policy.mjs";
import { PRODUCT_RELEASE_SCOPE } from "./lib/build-input-identity.mjs";
import { assertTauriStageReplacementTarget, resolveTauriStageTarget } from "./lib/tauri-stage-target-policy.mjs";

const clean = ["--ci", "--verbose"];
const standaloneCargoArgs = ["build", "--locked", "--release", "--no-default-features",
  "--features", "tauri/custom-protocol", "--manifest-path", "src-tauri/Cargo.toml"];
assert.deepEqual(tauriProductCargoBuildArgs(), standaloneCargoArgs);
const independentArgs = tauriProductCargoBuildArgs();
independentArgs.push("auto-roto-research");
assert.deepEqual(tauriProductCargoBuildArgs(), standaloneCargoArgs, "caller mutation must not change product features");
const cleanSnapshot = [...clean];
assert.deepEqual(
  tauriProductBuildArgs(clean),
  ["build", ...clean, "--", "--no-default-features"],
);
assert.deepEqual(clean, cleanSnapshot, "policy helper must not mutate caller arguments");
assert.deepEqual(
  tauriProductBuildArgs(["--no-default-features"]),
  ["build", "--", "--no-default-features"],
);
assert.deepEqual(
  tauriProductBuildArgs(["--ci"], {
    windowsSigning: { certificateThumbprint: "a".repeat(40), timestampUrl: "https://timestamp.example.test" },
  }),
  [
    "build",
    "--ci",
    "--config",
    JSON.stringify({ bundle: { windows: { certificateThumbprint: "a".repeat(40), digestAlgorithm: "sha256", timestampUrl: "https://timestamp.example.test" } } }),
    "--",
    "--no-default-features",
  ],
);
assert.doesNotThrow(() => assertTauriProductRustflagEnvironment({ PATH: "fixture" }));

const nativeSource = await readFile(new URL("../src-tauri/build.rs", import.meta.url), "utf8");
assert.doesNotThrow(() => assertTauriNativePolicyPin(nativeSource, PRODUCT_RELEASE_SCOPE.policySha256));
const nativePolicyMutations = [
  nativeSource.replace(PRODUCT_RELEASE_SCOPE.policySha256, "0".repeat(64)),
  nativeSource.replace(/^const EDITKIN_PRODUCT_POLICY_SHA256:.*$/mu, ""),
  nativeSource + `\nconst EDITKIN_PRODUCT_POLICY_SHA256: &str = "${PRODUCT_RELEASE_SCOPE.policySha256}";\n`,
  nativeSource.replace(
    /manifest\["scope"\]\["policySha256"\],\s*EDITKIN_PRODUCT_POLICY_SHA256,/u,
    'manifest["scope"]["policySha256"], manifest["scope"]["policySha256"],',
  ),
];
for (const source of nativePolicyMutations) assert.throws(() => assertTauriNativePolicyPin(source, PRODUCT_RELEASE_SCOPE.policySha256), /Native policy preflight/u);
assert.throws(() => assertTauriNativePolicyPin(nativeSource, "untrusted"), /SHA-256/u);

const argumentMutations = [
  ["--features", "tauri/custom-protocol"],
  ["--features=tauri/custom-protocol"],
  ["--features", "tauri/custom-protocol,auto-roto-research"],
  ["--features", "auto-roto-research"],
  ["--features=auto-roto-research"],
  ["--features="],
  ["--all-features"],
  ["-F", "auto-roto-research"],
  ["-Fauto-roto-research"],
  ["-F=auto-roto-research"],
  ["-f", "auto-roto-research"],
  ["-fauto-roto-research"],
  ["-f=auto-roto-research"],
  ["--no-bundle"],
  ["--no-sign"],
  ["--ignore-version-mismatches"],
  ["--skip-stapling"],
  ["--bundles", "msi"],
  ["--", "--features", "auto-roto-research"],
  ["--"],
  ["--runner", "cargo"],
  ["--runner=cargo"],
  ["-rcargo"],
  ["--debug"],
  ["-d"],
  ["-vd"],
  ["--target", "x86_64-pc-windows-msvc"],
  ["--target=x86_64-pc-windows-msvc"],
  ["-tx86_64-pc-windows-msvc"],
  ["--config", "alternate.json"],
  ["--config=alternate.json"],
  ["-calternate.json"],
  ["--help"],
  ["--version"],
  ["--ci", "--ci"],
  ["--unknown"],
];
for (const mutation of argumentMutations) {
  assert.throws(
    () => tauriProductBuildArgs(mutation),
    /不接受/u,
    `feature/artifact bypass must be rejected: ${JSON.stringify(mutation)}`,
  );
}

const environmentNames = [
  "RUSTFLAGS",
  "CARGO_ENCODED_RUSTFLAGS",
  "CARGO_BUILD_RUSTFLAGS",
  "CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS",
  "rustflags",
  "CARGO_TARGET_DIR",
  "CARGO_HOME",
  "CARGO",
  "RUSTC",
  "RUSTC_WRAPPER",
  "RUSTC_WORKSPACE_WRAPPER",
  "CARGO_BUILD_TARGET",
  "CARGO_BUILD_RUSTC",
  "CARGO_BUILD_RUSTC_WRAPPER",
  "CARGO_BUILD_TARGET_DIR",
];
for (const name of environmentNames) {
  assert.throws(
    () => assertTauriProductRustflagEnvironment({ [name]: "untrusted-override" }),
    /不接受/u,
    `Rust/Cargo environment injection must be rejected: ${name}`,
  );
}

const trustedOptionMutations = [
  [[], ["--features", "auto-roto-research"]],
  [[], { arbitraryArgs: ["--features", "auto-roto-research"] }],
  [[], { windowsSigning: { certificateThumbprint: "a".repeat(40), timestampUrl: "https://timestamp.example.test", features: "auto-roto-research" } }],
  [[], { windowsSigning: { signCommand: "signtool.exe" } }],
];
for (const [args, options] of trustedOptionMutations) {
  assert.throws(() => tauriProductBuildArgs(args, options), /(?:typed object|untrusted keys|placeholder)/u);
}

const productBinaryBuilder = await readFile(new URL("./build-tauri-product-binary.mjs", import.meta.url), "utf8");
assert.match(productBinaryBuilder, /assertTauriProductRustflagEnvironment\(process\.env\)/u);
assert.match(productBinaryBuilder, /mkdtemp\(join\(productBuildRoot, "generation-"\)\)/u);
assert.match(productBinaryBuilder, /CARGO_INCREMENTAL: "0"/u);
assert.match(productBinaryBuilder, /await rm\(buildTargetDir, \{ recursive: true, force: true \}\)/u);
assert.doesNotMatch(productBinaryBuilder, /const buildTargetDir = resolve\(root, "src-tauri\/target-product"\)/u);
assert.match(productBinaryBuilder, /const command = tauriProductCargoBuildArgs\(\)/u);
assert.match(productBinaryBuilder, /frontendMode: "embedded-custom-protocol"/u);
assert.match(productBinaryBuilder, /enabledCargoFeatures: \[TAURI_PRODUCT_EMBEDDED_FRONTEND_FEATURE\]/u);
assert.match(productBinaryBuilder, /"scripts\/lib\/tauri-product-feature-policy\.mjs",\s*"dist"/u);
function assertBefore(source, check, work) {
  const checkAt = source.indexOf(check), workAt = source.indexOf(work);
  assert(checkAt >= 0 && workAt >= 0 && checkAt < workAt, "Native preflight must exist before expensive build work");
}
assertBefore(productBinaryBuilder, "assertTauriNativePolicyPin(await readFile", "await mkdir(productBuildRoot");
assertBefore(productBinaryBuilder, "const currentRelease = await computeBuildReceipt(root)", "await mkdir(productBuildRoot");
const frontendBuilder = await readFile(new URL("./tauri-frontend.mjs", import.meta.url), "utf8");
assertBefore(frontendBuilder, "assertTauriNativePolicyPin(await readFile", 'await runNode("scripts/build-creative-pack.mjs")');
assert.throws(() => assertBefore(frontendBuilder.replace("assertTauriNativePolicyPin(await readFile", "missingPreflight(await readFile"), "assertTauriNativePolicyPin(await readFile", 'await runNode("scripts/build-creative-pack.mjs")'));

const fixtureRoot = resolve(".tauri-stage-policy-fixture");
const canonicalStage = resolveTauriStageTarget(fixtureRoot);
assert.equal(canonicalStage.targetRoot, resolve(fixtureRoot, "src-tauri/target/release/runtime"));
assert.equal(canonicalStage.candidateTarget, false);
const candidateStage = resolveTauriStageTarget(fixtureRoot, "src-tauri/product-release-candidates/candidate-0123/runtime");
assert.equal(candidateStage.candidateTarget, true);
for (const invalid of [
  "runtime",
  "src-tauri/target/debug/runtime",
  "src-tauri/product-release-candidates/runtime",
  "src-tauri/product-release-candidates/candidate/nested/runtime",
  "../escaped/runtime",
]) {
  assert.throws(() => resolveTauriStageTarget(fixtureRoot, invalid), /approved release roots/u);
}
assert.doesNotThrow(() => assertTauriStageReplacementTarget(candidateStage.envelopeRoot, resolve(candidateStage.envelopeRoot, "plugins")));
assert.throws(
  () => assertTauriStageReplacementTarget(candidateStage.envelopeRoot, resolve(candidateStage.envelopeRoot, "../outside")),
  /escaped its release envelope/u,
);

console.log(JSON.stringify({
  status: "GREEN_SELF_TEST",
  argumentMutationsRejected: argumentMutations.length,
  environmentMutationsRejected: environmentNames.length,
  trustedOptionMutationsRejected: trustedOptionMutations.length,
  productBinaryBuilderPolicyAssertions: 9,
  nativePolicyMutationsRejected: nativePolicyMutations.length + 1,
  earlyPolicyOrderingAssertions: 3,
  missingPreflightOrderingMutationRejected: 1,
  standaloneCargoArgs,
  stageTargetMutationsRejected: 6,
  forcedArgs: tauriProductBuildArgs(["--ci"]),
}));
