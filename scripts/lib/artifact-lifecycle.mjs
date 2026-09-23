import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { evaluateCreativePack } from "./creative-pack-gate.mjs";
import { inspectAuthenticode } from "./authenticode.mjs";
import { PRODUCT_RELEASE_SCOPE, computeBuildInputIdentity, computeBuildOutputIdentity } from "./build-input-identity.mjs";
import { validateSpdx } from "./sbom.mjs";
import { inspectExtractedPayload } from "./security-hardening.mjs";

const MANAGED_RUNTIME = [
  ["runtime/node.exe", "vendor/node/win32-x64/node.exe"],
  ["runtime/NODE-LICENSE.txt", "vendor/node/win32-x64/NODE-LICENSE.txt"],
  ["runtime/NODE-MANIFEST.json", "vendor/node/win32-x64/manifest.json"],
  ["runtime/ffmpeg.exe", "vendor/ffmpeg/win32-x64/ffmpeg.exe"],
  ["runtime/ffprobe.exe", "vendor/ffmpeg/win32-x64/ffprobe.exe"],
  ["runtime/FFMPEG-LICENSE.txt", "vendor/ffmpeg/win32-x64/FFMPEG-LICENSE.txt"],
  ["runtime/whisper-cli.exe", "vendor/whisper/win32-x64/whisper-cli.exe"],
  ["runtime/whisper.dll", "vendor/whisper/win32-x64/whisper.dll"],
  ["runtime/ggml.dll", "vendor/whisper/win32-x64/ggml.dll"],
  ["runtime/ggml-base.dll", "vendor/whisper/win32-x64/ggml-base.dll"],
  ["runtime/ggml-cpu.dll", "vendor/whisper/win32-x64/ggml-cpu.dll"],
  ["runtime/WHISPER-LICENSE.txt", "vendor/whisper/win32-x64/WHISPER-LICENSE.txt"],
  ["runtime/WHISPER-MANIFEST.json", "vendor/whisper/win32-x64/manifest.json"],
  ["runtime/hao-core.exe", "native/bin/win32-x64/hao-core.exe"],
  ["runtime/editkin-gpu-compositor.exe", "native/bin/win32-x64/editkin-gpu-compositor.exe"],
  ["runtime/service.mjs", "desktop-dist/service.mjs"],
  ["runtime/mcp.mjs", "desktop-dist/mcp.mjs"],
  ["runtime/mcp.mjs.material-color-identity.json", "desktop-dist/mcp.mjs.material-color-identity.json"],
  ["runtime/remote.mjs", "desktop-dist/remote.mjs"],
  ["runtime/demo-source.mp4", "public/demo-source.mp4"],
  ["runtime/editkin-demo-preview.mp4", "public/editkin-demo-preview.mp4"],
  ["runtime/BUILD-MANIFEST.json", ".release-input-manifest.json"],
  ["runtime/editkin.spdx.json", "release/editkin.spdx.json"],
  ["runtime/THIRD_PARTY_NOTICES.md", "release/THIRD_PARTY_NOTICES.md"],
];

const MANAGED_AGENT_CONNECT = [
  ["agent-runtime-v3/agent-setup-contract.json", "src/shared/agentSetupContract.json"],
  ["agent-runtime-v3/launcher.mjs", "scripts/editkin-product-mcp-launcher.mjs"],
];

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function identity(path) {
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`Expected file: ${path}`);
  return { bytes: info.size, sha256: await sha256(path) };
}

async function fileMap(root) {
  const boundary = resolve(root);
  const output = {};
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) output[relative(boundary, absolute).split(sep).join("/")] = await identity(absolute);
      else throw new Error(`Managed artifact contains a non-file entry: ${absolute}`);
    }
  }
  await visit(boundary);
  return output;
}

export function compareFileMaps(expected, actual, label = "artifact") {
  const findings = [];
  const expectedNames = Object.keys(expected).sort();
  const actualNames = Object.keys(actual).sort();
  for (const path of expectedNames) {
    if (!actual[path]) findings.push({ code: "missing-file", label, path });
    else if (actual[path].bytes !== expected[path].bytes || actual[path].sha256 !== expected[path].sha256) {
      findings.push({ code: "identity-mismatch", label, path, expected: expected[path], actual: actual[path] });
    }
  }
  for (const path of actualNames) if (!expected[path]) findings.push({ code: "unexpected-file", label, path });
  return findings;
}

export function validateArchiveEntries(entries, requiredRoot) {
  const findings = [];
  const seen = new Set();
  for (const raw of entries) {
    const path = String(raw).replaceAll("\\", "/").replace(/\/$/, "");
    if (!path) continue;
    const lower = path.toLowerCase();
    if (/^(?:[a-z]:|\/)/i.test(path) || path.split("/").includes("..")) findings.push({ code: "unsafe-entry", path });
    if (requiredRoot && !(path === requiredRoot || path.startsWith(`${requiredRoot}/`))) findings.push({ code: "wrong-root", path });
    if (seen.has(lower)) findings.push({ code: "duplicate-entry", path });
    seen.add(lower);
  }
  return findings;
}

export function verifyToolIdentity(receipt, actual) {
  const findings = [];
  if (receipt?.schemaVersion !== 1) findings.push({ code: "tool-receipt-schema" });
  if (receipt?.sevenZip?.packageVersion !== actual.packageVersion) findings.push({ code: "tool-package-version" });
  if (receipt?.sevenZip?.bytes !== actual.bytes) findings.push({ code: "tool-bytes" });
  if (receipt?.sevenZip?.sha256 !== actual.sha256) findings.push({ code: "tool-sha256" });
  return findings;
}

function sortedJson(value) {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedJson(value[key])]));
  return value;
}

// Keep this projection identical to src-tauri/build.rs. The executable embeds
// the compact identity, not the multi-megabyte inventory; its hash binds every
// byte of the delivered inventory without weakening source/output checks.
export function embeddedBuildIdentity(manifest, manifestBytes) {
  return Buffer.from(JSON.stringify(sortedJson({
    schemaVersion: manifest.schemaVersion,
    product: manifest.product,
    productVersion: manifest.productVersion,
    inputIdentity: manifest.inputIdentity,
    outputIdentity: manifest.outputIdentity,
    scope: manifest.scope,
    manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
    detailLocation: "runtime/BUILD-MANIFEST.json",
  })));
}

export function compareNsisExecutableBytes(source, delivered) {
  const marker = Buffer.from("__TAURI_BUNDLE_TYPE_VAR_");
  if (!Buffer.isBuffer(source) || !Buffer.isBuffer(delivered) || source.length !== delivered.length) return false;
  const offset = source.indexOf(marker);
  if (offset < 0 || delivered.indexOf(marker) !== offset || source.indexOf(marker, offset + 1) !== -1
    || delivered.indexOf(marker, offset + 1) !== -1) return false;
  const at = offset + marker.length;
  if (delivered.toString("ascii", at, at + 3) !== "NSS"
    || !["UNK", "NSS"].includes(source.toString("ascii", at, at + 3))) return false;
  // Tauri temporarily patches UNK -> NSS for NSIS, then restores the standalone
  // binary. Permit only those three bytes; every other byte must be identical.
  const normalized = Buffer.from(source);
  normalized.write("NSS", at, "ascii");
  return normalized.equals(delivered);
}

export function evaluateBuildManifest({ manifest, manifestBytes, deliveredExecutableBytes, currentInputIdentity, currentOutputIdentity, expectedVersion, expectedProductName }) {
  const findings = [];
  if (manifest?.schemaVersion !== 2 || manifest?.productVersion !== expectedVersion || manifest?.product !== expectedProductName
    || JSON.stringify(manifest?.scope) !== JSON.stringify(PRODUCT_RELEASE_SCOPE)) {
    findings.push({
      code: "build-manifest-product-identity",
      expected: { schemaVersion: 2, product: expectedProductName, productVersion: expectedVersion, scope: PRODUCT_RELEASE_SCOPE },
      actual: { schemaVersion: manifest?.schemaVersion, product: manifest?.product, productVersion: manifest?.productVersion, scope: manifest?.scope },
    });
  }
  if (JSON.stringify(manifest?.inputIdentity) !== JSON.stringify(currentInputIdentity)) {
    findings.push({ code: "stale-build-inputs", expected: currentInputIdentity, actual: manifest?.inputIdentity });
  }
  if (JSON.stringify(manifest?.outputIdentity) !== JSON.stringify(currentOutputIdentity)) {
    findings.push({ code: "stale-build-outputs", expected: currentOutputIdentity, actual: manifest?.outputIdentity });
  }
  if (!Buffer.isBuffer(deliveredExecutableBytes) || !Buffer.isBuffer(manifestBytes) || !manifest
    || !deliveredExecutableBytes.includes(embeddedBuildIdentity(manifest, manifestBytes))) {
    findings.push({ code: "executable-missing-build-manifest" });
  }
  return findings;
}

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: options.timeout ?? 300_000,
    maxBuffer: 32 * 1024 * 1024,
    cwd: options.cwd,
  });
  if (result.status !== 0) throw new Error(`${executable} ${args[0]} failed: ${result.stderr || result.error?.message || result.status}`);
  return result.stdout;
}

function sevenZipEntries(stdout) {
  const section = stdout.split(/\r?\n----------\r?\n/)[1] ?? "";
  return [...section.matchAll(/^Path = (.+)$/gm)].map((match) => match[1]);
}

async function inspectPeExecutable(path) {
  const bytes = await readFile(path);
  if (bytes.length < 0x100 || bytes.readUInt16LE(0) !== 0x5a4d) throw new Error(`Invalid PE DOS header: ${path}`);
  const peOffset = bytes.readUInt32LE(0x3c);
  if (peOffset + 26 > bytes.length || bytes.readUInt32LE(peOffset) !== 0x00004550) throw new Error(`Invalid PE signature: ${path}`);
  const machine = bytes.readUInt16LE(peOffset + 4);
  const optionalMagic = bytes.readUInt16LE(peOffset + 24);
  const encodedPath = Buffer.from(path, "utf8").toString("base64");
  const script = `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'));$i=[System.Diagnostics.FileVersionInfo]::GetVersionInfo($p);@{fileVersion=$i.FileVersion;productVersion=$i.ProductVersion;productName=$i.ProductName;fileDescription=$i.FileDescription}|ConvertTo-Json -Compress`;
  const version = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
  if (version.status !== 0) throw new Error(`Cannot inspect PE version metadata: ${version.stderr || version.error?.message || version.status}`);
  return { machine: `0x${machine.toString(16)}`, architecture: machine === 0x8664 && optionalMagic === 0x20b ? "x64" : "unsupported", ...JSON.parse(version.stdout) };
}

export function productVersionMatches(actual, expected) {
  const value = String(actual ?? "").trim();
  return value === expected || value === `${expected}.0`;
}

async function inspectPackArchive({ archivePath, sourcePackRoot, tarPath = "tar" }) {
  const workspace = await mkdtemp(join(tmpdir(), "editkin-pack-archive-"));
  try {
    const listing = run(tarPath, ["-tf", archivePath]);
    const entries = listing.split(/\r?\n/).filter(Boolean);
    const entryFindings = validateArchiveEntries(entries, "hao-creator-library");
    if (!entries.includes("hao-creator-library/editkin-pack.json")) entryFindings.push({ code: "missing-manifest" });
    if (entryFindings.length) return { status: "BLOCK", findings: entryFindings };
    run(tarPath, ["-xf", archivePath, "-C", workspace]);
    const extracted = resolve(workspace, "hao-creator-library");
    const expectedFiles = await fileMap(sourcePackRoot);
    const actualFiles = await fileMap(extracted);
    const findings = compareFileMaps(expectedFiles, actualFiles, "creator-pack-archive");
    const manifest = JSON.parse(await readFile(resolve(extracted, "editkin-pack.json"), "utf8"));
    const packReport = evaluateCreativePack(manifest, { root: extracted });
    if (packReport.status !== "GREEN") findings.push(...packReport.findings.map((item) => ({ code: `pack-${item.code}`, path: item.path })));
    return {
      status: findings.length ? "BLOCK" : "GREEN",
      files: Object.keys(actualFiles).length,
      bytes: (await identity(archivePath)).bytes,
      sha256: await sha256(archivePath),
      findings,
    };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function inspectNsis({ root, installerPath, sourcePackRoot, sourcePersonalMusicPackRoot, sourceFontPackRoot, executablePath, toolReceipt, expectedVersion, expectedProductName }) {
  const sevenZipPath = resolve(root, toolReceipt.sevenZip.path);
  const packageJson = JSON.parse(await readFile(resolve(dirname(sevenZipPath), "../package.json"), "utf8"));
  const sevenZipIdentity = await identity(sevenZipPath);
  const toolFindings = verifyToolIdentity(toolReceipt, { packageVersion: packageJson.version, ...sevenZipIdentity });
  if (toolFindings.length) return { status: "BLOCK", tool: { path: toolReceipt.sevenZip.path, ...sevenZipIdentity }, findings: toolFindings };
  const workspace = await mkdtemp(join(tmpdir(), "editkin-nsis-payload-"));
  try {
    const listing = run(sevenZipPath, ["l", "-slt", installerPath]);
    const entries = sevenZipEntries(listing);
    const findings = validateArchiveEntries(entries);
    const required = [
      "editkin.exe",
      ...MANAGED_RUNTIME.map(([path]) => path),
      ...MANAGED_AGENT_CONNECT.map(([path]) => path),
      "creative-packs/hao-creator-library/editkin-pack.json",
      "personal-packs/hao-music-library/editkin-personal-music.json",
      "font-packs/editkin-open-fonts/editkin-open-fonts.json",
      "plugins/creator-accelerators/editkin-plugin.json",
    ];
    const normalizedEntries = new Set(entries.map((path) => path.replaceAll("\\", "/").toLowerCase()));
    for (const path of required) if (!normalizedEntries.has(path.toLowerCase())) findings.push({ code: "missing-managed-entry", path });
    if (findings.length) return { status: "BLOCK", entries: entries.length, findings };
    run(sevenZipPath, ["x", "-y", `-o${workspace}`, installerPath]);
    const expectedRuntime = {};
    const actualRuntime = {};
    for (const [payload, source] of MANAGED_RUNTIME) {
      const key = payload.slice("runtime/".length);
      expectedRuntime[key] = await identity(resolve(root, source));
    }
    const extractedRuntime = resolve(workspace, "runtime");
    Object.assign(actualRuntime, await fileMap(extractedRuntime));
    findings.push(...compareFileMaps(expectedRuntime, actualRuntime, "nsis-runtime"));
    const expectedAgentConnect = {};
    for (const [payload, source] of MANAGED_AGENT_CONNECT) {
      expectedAgentConnect[payload.slice("agent-runtime-v3/".length)] = await identity(resolve(root, source));
    }
    const actualAgentConnect = await fileMap(resolve(workspace, "agent-runtime-v3"));
    findings.push(...compareFileMaps(expectedAgentConnect, actualAgentConnect, "nsis-agent-connect"));
    const sbom = JSON.parse(await readFile(resolve(extractedRuntime, "editkin.spdx.json"), "utf8"));
    const sbomReport = validateSpdx(sbom, { productVersion: expectedVersion });
    if (sbomReport.status !== "GREEN") findings.push(...sbomReport.findings.map((item) => ({ ...item, code: `sbom-${item.code}` })));
    const sbomNames = new Set(sbom.packages?.map((item) => item.name));
    for (const id of ["noto-sans-tc", "noto-serif-tc", "lxgw-wenkai-mono-tc", "bebas-neue", "fredoka"]) {
      if (!sbomNames.has(`font-${id}`)) findings.push({ code: "sbom-missing-open-font", id });
    }
    const deliveredExecutablePath = resolve(workspace, "editkin.exe");
    const sourceExecutable = await identity(executablePath);
    const deliveredExecutableBytes = await readFile(deliveredExecutablePath);
    if (!compareNsisExecutableBytes(await readFile(executablePath), deliveredExecutableBytes)) {
      findings.push({ code: "executable-not-same-build", detail: "Only Tauri's exact UNK-to-NSS bundle marker patch is permitted" });
    }
    const deliveredExecutable = {
      ...await identity(deliveredExecutablePath),
      pe: await inspectPeExecutable(deliveredExecutablePath),
      authenticode: inspectAuthenticode(deliveredExecutablePath),
    };
    const security = await inspectExtractedPayload({
      root: workspace,
      entries,
      executablePath: deliveredExecutablePath,
      authenticode: deliveredExecutable.authenticode,
      profile: "internal",
    });
    findings.push(...security.findings.map((item) => ({ ...item, code: `security-${item.code}` })));
    if (deliveredExecutable.pe.architecture !== "x64") findings.push({ code: "executable-architecture", actual: deliveredExecutable.pe.architecture });
    if (!productVersionMatches(deliveredExecutable.pe.productVersion, expectedVersion)) findings.push({ code: "executable-version", expected: expectedVersion, actual: deliveredExecutable.pe.productVersion });
    if (deliveredExecutable.pe.productName !== expectedProductName || deliveredExecutable.pe.fileDescription !== expectedProductName) {
      findings.push({ code: "executable-product-identity", expected: expectedProductName, actual: { productName: deliveredExecutable.pe.productName, fileDescription: deliveredExecutable.pe.fileDescription } });
    }
    const buildManifestBytes = await readFile(resolve(workspace, "runtime/BUILD-MANIFEST.json"));
    const buildManifest = JSON.parse(buildManifestBytes);
    const currentInputIdentity = await computeBuildInputIdentity(root);
    const currentOutputIdentity = await computeBuildOutputIdentity(root);
    findings.push(...evaluateBuildManifest({
      manifest: buildManifest,
      manifestBytes: buildManifestBytes,
      deliveredExecutableBytes,
      currentInputIdentity,
      currentOutputIdentity,
      expectedVersion,
      expectedProductName,
    }));
    const expectedPack = await fileMap(sourcePackRoot);
    const actualPack = await fileMap(resolve(workspace, "creative-packs/hao-creator-library"));
    findings.push(...compareFileMaps(expectedPack, actualPack, "nsis-creator-pack"));
    const expectedPersonalMusicPack = await fileMap(sourcePersonalMusicPackRoot);
    const actualPersonalMusicPack = await fileMap(resolve(workspace, "personal-packs/hao-music-library"));
    findings.push(...compareFileMaps(expectedPersonalMusicPack, actualPersonalMusicPack, "nsis-personal-music-pack"));
    const personalMusicManifest = JSON.parse(await readFile(resolve(workspace, "personal-packs/hao-music-library/editkin-personal-music.json"), "utf8"));
    if (personalMusicManifest?.schemaVersion !== 2
      || personalMusicManifest?.assetCount !== 175
      || personalMusicManifest?.assets?.length !== 175
      || personalMusicManifest?.distributionScope !== "community-redistributable"
      || personalMusicManifest?.redistributable !== true
      || personalMusicManifest?.provenanceAudit?.status !== "owner_attested_ai_generated"
      || personalMusicManifest?.provenanceAudit?.publicExportAllowed !== true
      || personalMusicManifest?.provenanceAudit?.attestationId !== "owner-attestation-2026-08-22") {
      findings.push({
        code: "personal-music-manifest-contract",
        actual: {
          schemaVersion: personalMusicManifest?.schemaVersion,
          assetCount: personalMusicManifest?.assetCount,
          distributionScope: personalMusicManifest?.distributionScope,
          redistributable: personalMusicManifest?.redistributable,
          publicExportAllowed: personalMusicManifest?.provenanceAudit?.publicExportAllowed,
        },
      });
    }
    const expectedFontPack = await fileMap(sourceFontPackRoot);
    const extractedFontPackRoot = resolve(workspace, "font-packs/editkin-open-fonts");
    const actualFontPack = await fileMap(extractedFontPackRoot);
    findings.push(...compareFileMaps(expectedFontPack, actualFontPack, "nsis-open-font-pack"));
    const expectedPlugins = await fileMap(resolve(root, "plugins"));
    const actualPlugins = await fileMap(resolve(workspace, "plugins"));
    findings.push(...compareFileMaps(expectedPlugins, actualPlugins, "nsis-plugins"));
    const fontManifest = JSON.parse(await readFile(resolve(extractedFontPackRoot, "editkin-open-fonts.json"), "utf8"));
    if (fontManifest?.schemaVersion !== 2 || fontManifest?.id !== "studio.hao.editkin-open-fonts" || fontManifest?.fonts?.length !== 5) {
      findings.push({ code: "open-font-manifest-contract", actual: { schemaVersion: fontManifest?.schemaVersion, id: fontManifest?.id, fonts: fontManifest?.fonts?.length } });
    } else {
      const families = new Set();
      for (const font of fontManifest.fonts) {
        const file = actualFontPack[font.file];
        const license = actualFontPack[font.licenseFile];
        if (families.has(font.family) || font.license !== "OFL-1.1" || !file || file.bytes !== font.bytes || file.sha256 !== font.sha256 || !license) {
          findings.push({ code: "open-font-file-contract", id: font.id });
        }
        families.add(font.family);
      }
      // Validate the v2 static face grid, SFNT names/weights, license hashes and
      // closed-world payload using the same checker as the font build.
      const fontCheck = JSON.parse(run(process.execPath, [resolve(root, "scripts/open-font-gate.mjs"), extractedFontPackRoot], { cwd: root }));
      if (fontCheck.status !== "VERIFIED_FONT_ASSET_CONTRACT_ONLY" || fontCheck.faceCount !== 43) {
        findings.push({ code: "open-font-static-face-contract" });
      }
    }
    return {
      status: findings.length ? "BLOCK" : "GREEN",
      entries: entries.length,
      managedRuntimeFiles: Object.keys(actualRuntime).length,
      managedAgentConnectFiles: Object.keys(actualAgentConnect).length,
      creatorPackFiles: Object.keys(actualPack).length,
      personalMusicPackFiles: Object.keys(actualPersonalMusicPack).length,
      personalMusicAssets: personalMusicManifest?.assetCount,
      openFontFiles: Object.keys(actualFontPack).length,
      openFontFamilies: fontManifest?.fonts?.length,
      tool: { path: toolReceipt.sevenZip.path, ...sevenZipIdentity },
      sourceExecutable,
      deliveredExecutable,
      security,
      buildManifest,
      sbom: { status: sbomReport.status, packages: sbomReport.packages, findings: sbomReport.findings },
      findings,
    };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

export async function inspectDistributionArtifacts({ root, installerPath, executablePath, creativePackArchivePath, sourcePackRoot, sourcePersonalMusicPackRoot, sourceFontPackRoot }) {
  const toolReceipt = JSON.parse(await readFile(resolve(root, "scripts/artifact-toolchain.json"), "utf8"));
  const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const archive = await inspectPackArchive({ archivePath: creativePackArchivePath, sourcePackRoot });
  const nsis = await inspectNsis({
    root,
    installerPath,
    sourcePackRoot,
    sourcePersonalMusicPackRoot,
    sourceFontPackRoot,
    executablePath,
    toolReceipt,
    expectedVersion: packageJson.version,
    expectedProductName: packageJson.productName,
  });
  const findings = [
    ...(archive.findings ?? []).map((item) => ({ surface: "creator-pack-archive", ...item })),
    ...(nsis.findings ?? []).map((item) => ({ surface: "nsis", ...item })),
  ];
  return { schemaVersion: 1, status: archive.status === "GREEN" && nsis.status === "GREEN" ? "GREEN" : "BLOCK", archive, nsis, findings };
}
