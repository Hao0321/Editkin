const ALLOWED_TAURI_PRODUCT_FLAGS = new Set(["--ci", "--verbose", "--no-default-features"]);
const FORBIDDEN_BUILD_ENVIRONMENT = /^(?:RUSTFLAGS|CARGO_ENCODED_RUSTFLAGS|CARGO_BUILD_RUSTFLAGS|CARGO_TARGET_.+_RUSTFLAGS|CARGO_TARGET_DIR|CARGO_HOME|CARGO|RUSTC|RUSTC_WRAPPER|RUSTC_WORKSPACE_WRAPPER|CARGO_BUILD_TARGET|CARGO_BUILD_RUSTC|CARGO_BUILD_RUSTC_WRAPPER|CARGO_BUILD_TARGET_DIR)$/iu;
export const TAURI_PRODUCT_EMBEDDED_FRONTEND_FEATURE = "tauri/custom-protocol";

/** Fail before expensive asset/Cargo work if the reviewed Rust pin is stale.
 * This diagnostic does not replace build.rs's compiled assertion or the final
 * binary/manifest verification. The pin is never rewritten automatically.
 */
export function assertTauriNativePolicyPin(rustSource, expectedPolicySha256) {
  if (typeof rustSource !== "string" || !/^[a-f0-9]{64}$/u.test(expectedPolicySha256 ?? "")) {
    throw new Error("Native policy preflight requires source text and a SHA-256 policy identity");
  }
  // rustfmt may wrap the 64-character literal onto the following line. Accept
  // formatting whitespace while still requiring exactly one typed constant.
  const declarations = [...rustSource.matchAll(/^\s*const EDITKIN_PRODUCT_POLICY_SHA256:\s*&str\s*=\s*"([a-f0-9]{64})";\s*$/gmu)];
  if (declarations.length !== 1 || declarations[0][1] !== expectedPolicySha256) {
    throw new Error("Native policy preflight: reviewed build.rs policy pin is missing, duplicated or stale");
  }
  if (!/assert_eq!\(\s*manifest\["scope"\]\["policySha256"\],\s*EDITKIN_PRODUCT_POLICY_SHA256,/u.test(rustSource)) {
    throw new Error("Native policy preflight: build.rs must assert the manifest policy against its reviewed pin");
  }
}

/** Direct cargo builds do not receive the production feature injected by Tauri CLI. */
export function tauriProductCargoBuildArgs() {
  return ["build", "--locked", "--release", "--no-default-features",
    "--features", TAURI_PRODUCT_EMBEDDED_FRONTEND_FEATURE, "--manifest-path", "src-tauri/Cargo.toml"];
}

function assertWindowsSigningOptions(options) {
  if (!options) return;
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error("Tauri product signing options must be a typed object");
  const keys = Object.keys(options).sort();
  const allowedKeys = options.certificateThumbprint ? ["certificateThumbprint", "timestampUrl"] : ["signCommand"];
  if (JSON.stringify(keys) !== JSON.stringify(allowedKeys.sort())) throw new Error("Tauri product signing options contain untrusted keys");
  if (options.certificateThumbprint) {
    if (!/^[a-f0-9]{40}$/iu.test(options.certificateThumbprint) || !/^https?:\/\//iu.test(options.timestampUrl ?? "")) {
      throw new Error("Tauri product certificate signing options are invalid");
    }
  } else if (typeof options.signCommand !== "string" || !options.signCommand.includes("%1")) {
    throw new Error("Tauri product custom signing command must contain the %1 placeholder");
  }
}

/**
 * Formal product builds are deliberately closed to caller-selected Cargo
 * features. Research features must be built through their isolated benchmark
 * workflow, never by forwarding flags through the product wrapper.
 */
export function assertTauriProductFeatureArgs(userArgs) {
  const seen = new Set();
  for (const argument of userArgs) {
    if (typeof argument !== "string" || !ALLOWED_TAURI_PRODUCT_FLAGS.has(argument) || seen.has(argument)) {
      throw new Error(`Tauri product build 不接受會改變或繞過正式 artifact 邊界的參數：${argument}`);
    }
    seen.add(argument);
  }
}

/** Reject environment-level toolchain, cfg, wrapper and output relocation injection. */
export function assertTauriProductRustflagEnvironment(environment) {
  for (const [name, value] of Object.entries(environment)) {
    if (FORBIDDEN_BUILD_ENVIRONMENT.test(name) && String(value ?? "").trim()) {
      throw new Error(`Tauri product build 不接受未驗證的 Rust/Cargo 環境變數：${name}`);
    }
  }
}

/** Build the only Cargo-feature posture accepted by the formal product wrapper. */
export function tauriProductBuildArgs(userArgs, options = {}) {
  assertTauriProductFeatureArgs(userArgs);
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error("Tauri product build options must be a typed object");
  const optionKeys = Object.keys(options);
  if (optionKeys.some((key) => key !== "windowsSigning")) throw new Error("Tauri product build options contain untrusted keys");
  assertWindowsSigningOptions(options.windowsSigning);
  const normalized = userArgs.filter((argument) => argument !== "--no-default-features");
  const trustedSigningArgs = options.windowsSigning
    ? ["--config", JSON.stringify({ bundle: { windows: options.windowsSigning.certificateThumbprint
      ? { certificateThumbprint: options.windowsSigning.certificateThumbprint, digestAlgorithm: "sha256", timestampUrl: options.windowsSigning.timestampUrl }
      : { signCommand: options.windowsSigning.signCommand } } })]
    : [];
  return ["build", ...normalized, ...trustedSigningArgs, "--", "--no-default-features"];
}
