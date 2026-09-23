import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { publicMusicPayloadFiles } from "./public-music-payload.mjs";

export const PAYLOAD_SECURITY_POLICY_REVISION = 2;

const FORBIDDEN_EXTENSIONS = new Set([
  ".map",
  ".pdb",
  ".ts",
  ".tsx",
  ".rs",
  ".env",
  ".pem",
  ".key",
  ".pfx",
  ".p12",
]);
const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".txt",
]);
const ALLOWED_BINARIES = new Set([
  "editkin.exe",
  "runtime/ffmpeg.exe",
  "runtime/ffprobe.exe",
  "runtime/whisper-cli.exe",
  "runtime/whisper.dll",
  "runtime/ggml.dll",
  "runtime/ggml-base.dll",
  "runtime/ggml-cpu.dll",
  "runtime/hao-core.exe",
  "runtime/editkin-gpu-compositor.exe",
  "runtime/node.exe",
]);
const SECRET_PATTERNS = [
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i],
  ["aws-access-key", /\bAKIA[0-9A-Z]{16}\b/],
  ["github-token", /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/],
  ["openai-shaped-key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/],
];
const PRIVATE_PATH_PATTERNS = [
  /\b[A-Za-z]:\\Users\\[^\\\r\n]+\\/i,
  /\/(?:Users|home)\/[^/\r\n]+\//,
  /Hao0321_YT_Claude/i,
];

function normalized(path) {
  return String(path).replaceAll("\\", "/").replace(/^\.\//, "");
}

export function inspectPeMitigations(bytes) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length < 0x100 ||
    bytes.readUInt16LE(0) !== 0x5a4d
  ) {
    return { valid: false, reason: "invalid-dos-header" };
  }
  const peOffset = bytes.readUInt32LE(0x3c);
  if (
    peOffset + 96 > bytes.length ||
    bytes.readUInt32LE(peOffset) !== 0x00004550
  ) {
    return { valid: false, reason: "invalid-pe-header" };
  }
  const optionalHeader = peOffset + 24;
  const magic = bytes.readUInt16LE(optionalHeader);
  const machine = bytes.readUInt16LE(peOffset + 4);
  const dllCharacteristics = bytes.readUInt16LE(optionalHeader + 70);
  return {
    valid: true,
    architecture: machine === 0x8664 && magic === 0x20b ? "x64" : "unsupported",
    dllCharacteristics: `0x${dllCharacteristics.toString(16).padStart(4, "0")}`,
    highEntropyVa: Boolean(dllCharacteristics & 0x0020),
    dynamicBase: Boolean(dllCharacteristics & 0x0040),
    nxCompat: Boolean(dllCharacteristics & 0x0100),
    controlFlowGuard: Boolean(dllCharacteristics & 0x4000),
  };
}

export function evaluatePayloadSecurity({
  entries,
  textPayloads,
  fileIdentities = [],
  pe,
  authenticode,
  profile = "internal",
}) {
  const findings = [];
  const normalizedEntries = entries.map(normalized);
  for (const path of normalizedEntries) {
    const lower = path.toLowerCase();
    if (
      path.startsWith("/") ||
      path.includes(":") ||
      path.split("/").some((part) => part === ".." || part === ".")
    )
      findings.push({ code: "unsafe-release-path", path });
    if (FORBIDDEN_EXTENSIONS.has(extname(lower)))
      findings.push({ code: "forbidden-release-artifact", path });
    if (
      /\.(?:exe|dll)$/i.test(lower) &&
      !ALLOWED_BINARIES.has(lower) &&
      !/^\$pluginsdir\/[^/]+\.dll$/i.test(lower)
    ) {
      findings.push({ code: "undeclared-native-binary", path });
    }
  }
  for (const payload of textPayloads) {
    if (/sourceMappingURL\s*=/i.test(payload.text))
      findings.push({ code: "source-map-reference", path: payload.path });
    for (const [kind, pattern] of SECRET_PATTERNS)
      if (pattern.test(payload.text))
        findings.push({
          code: "secret-shaped-payload",
          kind,
          path: payload.path,
        });
    if (PRIVATE_PATH_PATTERNS.some((pattern) => pattern.test(payload.text)))
      findings.push({ code: "private-absolute-path", path: payload.path });
  }
  if (!pe?.valid || pe.architecture !== "x64")
    findings.push({ code: "invalid-or-unsupported-pe", actual: pe });
  else {
    if (!pe.dynamicBase) findings.push({ code: "pe-aslr-disabled" });
    if (!pe.nxCompat) findings.push({ code: "pe-nx-disabled" });
    if (!pe.highEntropyVa)
      findings.push({ code: "pe-high-entropy-va-disabled" });
  }
  const personalPackEntries = normalizedEntries.filter((path) =>
    path.toLowerCase().startsWith("personal-packs/"),
  );
  const allowedMusic = publicMusicPayloadFiles(
    normalizedEntries,
    textPayloads.map((item) => ({ ...item, path: normalized(item.path) })),
    fileIdentities,
  );
  const ownerOnlyAssets = personalPackEntries.filter(
    (path) => !allowedMusic.has(path),
  );
  const authenticodeValid = authenticode?.Status === "Valid";
  if (profile === "public" && ownerOnlyAssets.length)
    findings.push({
      code: "owner-only-assets-in-public-package",
      count: ownerOnlyAssets.length,
    });
  if (profile === "public" && !authenticodeValid)
    findings.push({
      code: "public-installer-not-authenticode-valid",
      actual: authenticode?.Status ?? "missing",
    });
  return {
    schemaVersion: 1,
    policyRevision: PAYLOAD_SECURITY_POLICY_REVISION,
    status: findings.length ? "BLOCK" : "GREEN",
    profile,
    entries: normalizedEntries.length,
    textFilesScanned: textPayloads.length,
    ownerOnlyFiles: ownerOnlyAssets.length,
    communityRedistributableFiles:
      personalPackEntries.length - ownerOnlyAssets.length,
    declaredNativeBinaries: normalizedEntries.filter((path) =>
      /\.(?:exe|dll)$/i.test(path),
    ).length,
    pe,
    authenticode,
    findings,
  };
}

export function evaluateSourceSecurity({
  tauriConfig,
  tauriCargo,
  nativeCargo,
  buildDesktop,
  tauriMain,
  electronMain,
  remoteServer,
  relayWorker = "",
  relayConfig = {},
  packageScripts = {},
}) {
  const findings = [];
  const security = tauriConfig?.app?.security;
  const csp = String(security?.csp ?? "");
  if (security?.freezePrototype !== true)
    findings.push({ code: "tauri-prototype-not-frozen" });
  if (security?.dangerousDisableAssetCspModification !== false)
    findings.push({
      code: "tauri-asset-csp-modification-disabled-or-implicit",
    });
  if (
    security?.assetProtocol?.enable !== true ||
    !Array.isArray(security?.assetProtocol?.scope) ||
    security.assetProtocol.scope.length !== 0
  ) {
    findings.push({ code: "tauri-asset-protocol-scope-open" });
  }
  if (!csp || csp.includes("default-src *") || csp.includes("unsafe-eval"))
    findings.push({ code: "tauri-csp-not-restrictive" });
  if (
    !/minify:\s*true/.test(buildDesktop) ||
    !/sourcemap:\s*false/.test(buildDesktop)
  )
    findings.push({ code: "desktop-release-debug-artifacts-enabled" });
  for (const [surface, cargo] of [
    ["tauri", tauriCargo],
    ["native-core", nativeCargo],
  ]) {
    if (
      !/\[profile\.release\][\s\S]*?strip\s*=\s*true/.test(cargo) ||
      !/\[profile\.release\][\s\S]*?panic\s*=\s*"abort"/.test(cargo)
    ) {
      findings.push({ code: "native-release-profile-not-hardened", surface });
    }
  }
  if (!/runtime_override\(\s*cfg!\(debug_assertions\)/m.test(tauriMain))
    findings.push({ code: "tauri-release-runtime-override-not-closed" });
  if (
    !/unsigned_update_override_allowed\(\s*cfg!\(debug_assertions\)/m.test(
      tauriMain,
    )
  )
    findings.push({ code: "tauri-release-unsigned-update-override-open" });
  if (
    !/!app\.isPackaged\s*&&\s*process\.env\.HAO_EDITOR_ALLOW_UNSIGNED_UPDATES/.test(
      electronMain,
    )
  )
    findings.push({ code: "electron-release-unsigned-update-override-open" });
  for (const marker of [
    "contextIsolation: true",
    "nodeIntegration: false",
    "sandbox: true",
    "setPermissionRequestHandler",
    "setWindowOpenHandler",
    "assertTrustedSender",
    "approvedMediaPaths",
    "will-navigate",
  ]) {
    if (!electronMain.includes(marker))
      findings.push({ code: "electron-security-control-missing", marker });
  }
  for (const marker of [
    "timingSafeEqual",
    "pairRateAllowed",
    "requestOriginAllowed",
    "script-src 'sha256-",
    "style-src 'sha256-",
    "server.headersTimeout",
    "server.requestTimeout",
  ]) {
    if (!remoteServer.includes(marker))
      findings.push({ code: "remote-security-control-missing", marker });
  }
  if (/content-security-policy[^\n]+unsafe-inline/i.test(remoteServer))
    findings.push({ code: "remote-csp-allows-inline-code" });
  for (const marker of [
    "HttpOnly; Secure; SameSite=Strict",
    'request.headers.get("origin") !== url.origin',
    "pendingCredentials",
    "script-src 'nonce-",
    "frame-ancestors 'none'",
  ]) {
    if (!relayWorker.includes(marker))
      findings.push({ code: "relay-security-control-missing", marker });
  }
  if (
    /localStorage\.(?:setItem|getItem)\([^)]*(?:credential|token|secret)/i.test(
      relayWorker,
    )
  )
    findings.push({ code: "relay-long-lived-credential-in-local-storage" });
  if (/content-security-policy[^\n]+unsafe-inline/i.test(relayWorker))
    findings.push({ code: "relay-csp-allows-inline-code" });
  const expectedRemotePolicy = {
    schemaVersion: 2,
    mode: "user-owned-byo",
    defaultTransport: "lan",
    relayOrigin: "",
    publicTunnelOrigin: "",
    autoDeploy: false,
    providerRequired: false,
    costResponsibility: "end-user",
    deploymentStatus: "optional-user-configuration-required-for-cross-network",
  };
  const expectedPolicyKeys = Object.keys(expectedRemotePolicy).sort();
  const actualPolicyKeys = Object.keys(relayConfig ?? {}).sort();
  if (
    JSON.stringify(actualPolicyKeys) !== JSON.stringify(expectedPolicyKeys) ||
    expectedPolicyKeys.some(
      (key) => relayConfig?.[key] !== expectedRemotePolicy[key],
    )
  ) {
    findings.push({ code: "remote-user-owned-policy-invalid" });
  }
  const bundledOrigins = Object.entries(relayConfig ?? {})
    .filter(
      ([key, value]) =>
        /origin/i.test(key) && String(value ?? "").trim().length > 0,
    )
    .map(([key]) => key);
  if (bundledOrigins.length) {
    findings.push({
      code: "bundled-central-remote-origin",
      fields: bundledOrigins,
    });
  }
  if (relayConfig?.autoDeploy !== false)
    findings.push({ code: "remote-auto-deploy-enabled" });
  const bundledCredentialFields = Object.entries(relayConfig ?? {})
    .filter(
      ([key, value]) =>
        /(?:token|secret|credential|password|apiKey)/i.test(key) &&
        String(value ?? "").trim().length > 0,
    )
    .map(([key]) => key);
  if (bundledCredentialFields.length) {
    findings.push({
      code: "remote-bundled-credential",
      fields: bundledCredentialFields,
    });
  }
  for (const [marker, pattern] of [
    ["REMOTE_RELAY_CONFIG", /REMOTE_RELAY_CONFIG/],
    ["configured_remote_origins", /fn\s+configured_remote_origins\s*\(/],
    ["EDITKIN_REMOTE_RELAY_URL", /EDITKIN_REMOTE_RELAY_URL/],
    ["EDITKIN_REMOTE_PUBLIC_URL", /EDITKIN_REMOTE_PUBLIC_URL/],
  ]) {
    if (!pattern.test(tauriMain))
      findings.push({ code: "remote-byo-runtime-missing", marker });
  }
  const productionTauri = tauriMain.split(/#\[cfg\(test\)\]/)[0];
  if (
    /start_quick_tunnel|EDITKIN_CLOUDFLARED_PATH|Command::new\([^)]*(?:cloudflared|wrangler)/is.test(
      productionTauri,
    )
  )
    findings.push({ code: "remote-managed-tunnel-launch" });
  const configuredRemoteFunction = productionTauri.match(
    /fn\s+configured_remote_origins\s*\([\s\S]*?(?=#\[tauri::command\])/,
  )?.[0];
  if (configuredRemoteFunction && /(?:https|wss):\/\/[A-Za-z0-9]/i.test(configuredRemoteFunction)) {
    findings.push({
      code: "bundled-central-remote-origin",
      surface: "configured_remote_origins",
    });
  }
  for (const [name, command] of Object.entries(packageScripts ?? {})) {
    const value = String(command ?? "");
    const namedRemoteDeploy =
      /(?:remote|relay|tunnel)/i.test(name) && /deploy/i.test(name);
    const providerDeploy =
      /\b(?:wrangler(?:\.cmd)?\s+deploy|cloudflared(?:\.exe)?\s+(?:tunnel|access)\b|vercel(?:\.cmd)?\s+(?:deploy|--prod)\b|netlify(?:\.cmd)?\s+deploy\b|firebase(?:\.cmd)?\s+deploy\b)/i.test(
        value,
      );
    if (namedRemoteDeploy || providerDeploy) {
      findings.push({ code: "remote-auto-deploy-command", script: name });
    }
  }
  return {
    schemaVersion: 1,
    status: findings.length ? "BLOCK" : "GREEN",
    findings,
  };
}

export async function inspectExtractedPayload({
  root,
  entries,
  executablePath,
  authenticode,
  profile = "internal",
}) {
  const boundary = resolve(root);
  const textPayloads = [];
  const fileIdentities = [];
  const discoveredFiles = [];
  const declaredFiles = new Set(entries.map(normalized));
  async function visit(directory) {
    const children = await readdir(directory, { withFileTypes: true });
    for (const child of children) {
      const absolute = join(directory, child.name);
      if (child.isSymbolicLink()) throw new Error("payload-link-not-allowed");
      if (child.isDirectory()) await visit(absolute);
      else if (child.isFile()) {
        const info = await stat(absolute);
        const path = relative(boundary, absolute).split(sep).join("/");
        discoveredFiles.push(path);
        if (path.startsWith("personal-packs/hao-music-library/")) {
          const hash = createHash("sha256");
          for await (const chunk of createReadStream(absolute))
            hash.update(chunk);
          fileIdentities.push({
            path,
            bytes: info.size,
            sha256: hash.digest("hex"),
          });
        }
        if (
          TEXT_EXTENSIONS.has(extname(child.name).toLowerCase()) &&
          info.size <= 8 * 1024 * 1024
        )
          textPayloads.push({ path, text: await readFile(absolute, "utf8") });
      }
    }
  }
  await visit(boundary);
  return evaluatePayloadSecurity({
    entries: [
      ...entries,
      ...discoveredFiles.filter((path) => !declaredFiles.has(path)),
    ],
    textPayloads,
    fileIdentities,
    pe: inspectPeMitigations(await readFile(executablePath)),
    authenticode,
    profile,
  });
}
