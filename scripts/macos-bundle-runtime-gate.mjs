import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";

const PINNED_WHISPER_CPP = Object.freeze({
  version: "1.9.2",
  commit: "306c88f4d1286aec1bf96e544632897886af5501",
  sourceArchiveSha256: "f3585ebf64df3e41b26c45d93bdb38b423ca1de0bf40cc4b6d320254867a75df",
});
const REQUIRED_WHISPER_FLAGS = ["--language", "--output-srt", "--translate"];
const EXECUTABLES = ["node", "ffmpeg", "ffprobe", "hao-core", "editkin-gpu-compositor", "whisper-cli"];
const REQUIRED_FILES = [
  "node", "NODE-LICENSE.txt", "ffmpeg", "ffprobe", "FFMPEG-LICENSE.txt", "FFPROBE-LICENSE.txt",
  "hao-core", "editkin-gpu-compositor", "whisper-cli", "WHISPER-LICENSE.txt",
  "WHISPER-PROVENANCE.json", "WHISPER-CAPABILITY.json",
];

function capture(executable, args, timeoutMs = 30_000) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectRun(error); else resolveRun({ stdout, stderr });
    };
    const timer = setTimeout(() => { child.kill(); finish(new Error(`${basename(executable)} probe timed out`)); }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${String(chunk)}`.slice(-4_000_000); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-4_000_000); });
    child.on("error", finish);
    child.on("exit", (code) => finish(code === 0 ? undefined : new Error(`${basename(executable)} probe exited ${code}: ${stderr.trim().slice(-2_000)}`)));
  });
}

function hashFile(path) {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", rejectHash);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

export function matchesArchitecture(fileDescription, arch) {
  if (arch === "arm64") return /\barm64\b/i.test(fileDescription);
  if (arch === "x64") return /\bx86_64\b/i.test(fileDescription);
  return false;
}

export function hasWhisperFilter(filterInventory) {
  return filterInventory.split(/\r?\n/).some((line) => /^\s*[.A-Z|]{3,8}\s+whisper(?:\s|$)/.test(line));
}

export function whisperCliHasRequiredCapabilities(helpText) {
  return REQUIRED_WHISPER_FLAGS.every((flag) => helpText.includes(flag));
}

export function isClosedWorldFileSet(names) {
  return JSON.stringify([...names].sort()) === JSON.stringify([...REQUIRED_FILES].sort());
}

export function validateWhisperContract({ manifest, provenance, capability, files, arch }) {
  const findings = [];
  const expect = (condition, code) => { if (!condition) findings.push(code); };
  expect(manifest?.schemaVersion === 2, "manifest-schema");
  expect(manifest?.whisper?.version === PINNED_WHISPER_CPP.version, "manifest-whisper-version");
  expect(manifest?.whisper?.commit === PINNED_WHISPER_CPP.commit, "manifest-whisper-commit");
  expect(manifest?.whisper?.sourceArchiveSha256 === PINNED_WHISPER_CPP.sourceArchiveSha256, "manifest-whisper-source");
  expect(manifest?.whisper?.binarySha256 === files?.["whisper-cli"]?.sha256, "manifest-whisper-binary");
  expect(manifest?.whisper?.capabilityReceiptSha256 === files?.["WHISPER-CAPABILITY.json"]?.sha256, "manifest-whisper-capability");

  expect(provenance?.schemaVersion === 1 && provenance?.component === "whisper.cpp/whisper-cli", "provenance-schema");
  expect(provenance?.version === PINNED_WHISPER_CPP.version && provenance?.commit === PINNED_WHISPER_CPP.commit, "provenance-version");
  expect(provenance?.source?.sha256 === PINNED_WHISPER_CPP.sourceArchiveSha256 && provenance?.source?.url?.endsWith(PINNED_WHISPER_CPP.commit), "provenance-source");
  expect(provenance?.license?.spdx === "MIT" && provenance?.license?.sha256 === files?.["WHISPER-LICENSE.txt"]?.sha256, "provenance-license");
  expect(provenance?.target?.platform === "darwin" && provenance?.target?.arch === arch, "provenance-target");
  expect(provenance?.binary?.sha256 === files?.["whisper-cli"]?.sha256 && provenance?.binary?.name === "whisper-cli", "provenance-binary");
  expect(provenance?.build?.sharedLibraries === false && provenance?.build?.metal === true && provenance?.build?.homebrewRuntimeAllowed === false, "provenance-build");
  expect(!JSON.stringify(provenance?.runtimeDependencies ?? []).match(/(?:\/opt\/homebrew|\/usr\/local|@rpath|@loader_path|@executable_path|whisper-build|editkin-macos-runtime)/i), "provenance-runtime-dependency");

  expect(capability?.schemaVersion === 1 && capability?.capabilityId === "editkin.automatic-captions.whisper-cli/v1", "capability-schema");
  expect(capability?.version === PINNED_WHISPER_CPP.version && capability?.commit === PINNED_WHISPER_CPP.commit, "capability-version");
  expect(capability?.platform === "darwin" && capability?.arch === arch, "capability-target");
  expect(capability?.binarySha256 === files?.["whisper-cli"]?.sha256, "capability-binary");
  expect(capability?.provenanceSha256 === files?.["WHISPER-PROVENANCE.json"]?.sha256, "capability-provenance");
  expect(capability?.probe?.launched === true && REQUIRED_WHISPER_FLAGS.every((flag) => capability?.probe?.requiredFlags?.includes(flag)), "capability-probe");
  expect(["monolingualTranscription", "automaticLanguage", "srt", "translateToEnglish", "localOnly"].every((name) => capability?.capabilities?.[name] === true), "capability-flags");
  expect(capability?.routing?.fallbackWhen === "ffmpeg-whisper-filter-unavailable", "capability-routing");
  return findings;
}

if (process.argv.includes("--self-test")) {
  const hashA = "a".repeat(64);
  const hashB = "b".repeat(64);
  const hashC = "c".repeat(64);
  const files = {
    "whisper-cli": { sha256: hashA },
    "WHISPER-LICENSE.txt": { sha256: hashB },
    "WHISPER-PROVENANCE.json": { sha256: hashC },
    "WHISPER-CAPABILITY.json": { sha256: "d".repeat(64) },
  };
  const manifest = { schemaVersion: 2, whisper: { ...PINNED_WHISPER_CPP, binarySha256: hashA, capabilityReceiptSha256: files["WHISPER-CAPABILITY.json"].sha256 } };
  const provenance = {
    schemaVersion: 1, component: "whisper.cpp/whisper-cli", version: PINNED_WHISPER_CPP.version, commit: PINNED_WHISPER_CPP.commit,
    source: { url: `https://codeload.github.com/ggml-org/whisper.cpp/tar.gz/${PINNED_WHISPER_CPP.commit}`, sha256: PINNED_WHISPER_CPP.sourceArchiveSha256 },
    license: { spdx: "MIT", sha256: hashB }, target: { platform: "darwin", arch: "arm64" }, binary: { name: "whisper-cli", sha256: hashA },
    build: { sharedLibraries: false, metal: true, homebrewRuntimeAllowed: false }, runtimeDependencies: ["/System/Library/Frameworks/Metal.framework"],
  };
  const capability = {
    schemaVersion: 1, capabilityId: "editkin.automatic-captions.whisper-cli/v1", version: PINNED_WHISPER_CPP.version, commit: PINNED_WHISPER_CPP.commit,
    platform: "darwin", arch: "arm64", binarySha256: hashA, provenanceSha256: hashC,
    probe: { launched: true, requiredFlags: REQUIRED_WHISPER_FLAGS },
    capabilities: { monolingualTranscription: true, automaticLanguage: true, srt: true, translateToEnglish: true, localOnly: true },
    routing: { fallbackWhen: "ffmpeg-whisper-filter-unavailable" },
  };
  const brokenCapability = structuredClone(capability);
  brokenCapability.capabilities.monolingualTranscription = false;
  const brokenProvenance = structuredClone(provenance);
  brokenProvenance.runtimeDependencies = ["/opt/homebrew/lib/libwhisper.dylib"];
  const brokenManifest = structuredClone(manifest);
  brokenManifest.whisper.binarySha256 = "e".repeat(64);
  const tests = [
    { name: "arm64-positive", passed: matchesArchitecture("Mach-O 64-bit executable arm64", "arm64") },
    { name: "x64-positive", passed: matchesArchitecture("Mach-O 64-bit executable x86_64", "x64") },
    { name: "cross-architecture-negative", passed: !matchesArchitecture("PE32+ executable x86-64", "arm64") },
    { name: "ffmpeg-filter-detection", passed: hasWhisperFilter(" ... whisper           A->A       Transcribe audio.") && !hasWhisperFilter("FFmpeg was built without whisper") },
    { name: "whisper-cli-capability-positive", passed: whisperCliHasRequiredCapabilities("--language\n--output-srt\n--translate") },
    { name: "whisper-cli-missing-srt-negative", passed: !whisperCliHasRequiredCapabilities("--language\n--translate") },
    { name: "closed-world-missing-binary-negative", passed: !isClosedWorldFileSet(REQUIRED_FILES.filter((name) => name !== "whisper-cli")) },
    { name: "receipt-positive", passed: validateWhisperContract({ manifest, provenance, capability, files, arch: "arm64" }).length === 0 },
    { name: "receipt-binary-hash-negative", passed: validateWhisperContract({ manifest: brokenManifest, provenance, capability, files, arch: "arm64" }).includes("manifest-whisper-binary") },
    { name: "receipt-capability-negative", passed: validateWhisperContract({ manifest, provenance, capability: brokenCapability, files, arch: "arm64" }).includes("capability-flags") },
    { name: "homebrew-runtime-negative", passed: validateWhisperContract({ manifest, provenance: brokenProvenance, capability, files, arch: "arm64" }).includes("provenance-runtime-dependency") },
  ];
  const result = { status: tests.every((test) => test.passed) ? "GREEN" : "BLOCK", tests };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status !== "GREEN") process.exitCode = 1;
} else {
  if (process.platform !== "darwin") throw new Error("macOS app runtime gate 必須在原生 macOS host 執行");
  const [appArgument, arch, outputArgument] = process.argv.slice(2);
  if (!appArgument || !["arm64", "x64"].includes(arch)) {
    throw new Error("usage: node scripts/macos-bundle-runtime-gate.mjs <Editkin.app> <arm64|x64> [receipt.json]");
  }
  if (process.arch !== arch) throw new Error(`runner architecture 與宣告不一致：host=${process.arch}, expected=${arch}`);
  const appPath = resolve(appArgument);
  const runtimeRoot = join(appPath, "Contents", "Resources", "runtime");
  const manifestPath = join(runtimeRoot, "PLATFORM-MANIFEST.json");
  await access(manifestPath);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.schemaVersion !== 2 || manifest.platform !== "darwin" || manifest.arch !== arch) {
    throw new Error(`bundled runtime manifest target mismatch: schema=${manifest.schemaVersion}, ${manifest.platform}/${manifest.arch}`);
  }
  const declaredNames = Object.keys(manifest.files ?? {}).sort();
  if (!isClosedWorldFileSet(declaredNames)) throw new Error(`bundled runtime manifest is not closed-world: ${declaredNames.join(",")}`);

  const files = {};
  for (const name of REQUIRED_FILES) {
    const path = join(runtimeRoot, name);
    const info = await stat(path);
    if (!info.isFile()) throw new Error(`bundled runtime entry is not a file: ${name}`);
    const sha256 = await hashFile(path);
    if (sha256 !== manifest.files[name]) throw new Error(`bundled runtime hash mismatch: ${name}`);
    files[name] = { bytes: info.size, sha256 };
  }
  const architectures = {};
  for (const name of EXECUTABLES) {
    const path = join(runtimeRoot, name);
    const info = await stat(path);
    if ((info.mode & 0o111) === 0) throw new Error(`bundled runtime lost executable permission: ${name}`);
    const description = (await capture("/usr/bin/file", ["-b", path])).stdout.trim();
    if (!matchesArchitecture(description, arch)) throw new Error(`bundled runtime architecture mismatch: ${name}: ${description}`);
    architectures[name] = description;
  }

  const provenance = JSON.parse(await readFile(join(runtimeRoot, "WHISPER-PROVENANCE.json"), "utf8"));
  const capability = JSON.parse(await readFile(join(runtimeRoot, "WHISPER-CAPABILITY.json"), "utf8"));
  const whisperContractFindings = validateWhisperContract({ manifest, provenance, capability, files, arch });
  if (whisperContractFindings.length) throw new Error(`bundled whisper contract mismatch: ${whisperContractFindings.join(",")}`);

  const whisperCliPath = join(runtimeRoot, "whisper-cli");
  const whisperHelpResult = await capture(whisperCliPath, ["--help"]);
  const whisperHelp = `${whisperHelpResult.stdout}\n${whisperHelpResult.stderr}`;
  if (!whisperCliHasRequiredCapabilities(whisperHelp)) throw new Error("bundled whisper-cli launch probe lacks language/SRT/translate capabilities");
  const whisperVersionResult = await capture(whisperCliPath, ["--version"]);
  const whisperVersion = `${whisperVersionResult.stdout}\n${whisperVersionResult.stderr}`.trim();
  if (!whisperVersion.includes(PINNED_WHISPER_CPP.version) && !whisperVersion.includes(PINNED_WHISPER_CPP.commit.slice(0, 7))) {
    throw new Error(`bundled whisper-cli version probe mismatch: ${whisperVersion.slice(0, 500)}`);
  }
  const whisperDependencies = (await capture("/usr/bin/otool", ["-L", whisperCliPath])).stdout.trim();
  if (/(?:\/opt\/homebrew|\/usr\/local|@rpath|@loader_path|@executable_path|whisper-build|editkin-macos-runtime)/i.test(whisperDependencies)) {
    throw new Error(`bundled whisper-cli has non-closed runtime dependency: ${whisperDependencies}`);
  }

  const nodeVersion = (await capture(join(runtimeRoot, "node"), ["--version"])).stdout.trim();
  const ffmpegVersion = (await capture(join(runtimeRoot, "ffmpeg"), ["-version"])).stdout.split(/\r?\n/)[0]?.trim();
  const ffprobeVersion = (await capture(join(runtimeRoot, "ffprobe"), ["-version"])).stdout.split(/\r?\n/)[0]?.trim();
  const filters = await capture(join(runtimeRoot, "ffmpeg"), ["-hide_banner", "-filters"]);
  const ffmpegWhisperFilter = hasWhisperFilter(`${filters.stdout}\n${filters.stderr}`);
  const automaticCaptionsEngine = ffmpegWhisperFilter ? "ffmpeg-filter" : "whisper-cli";
  const result = {
    status: "GREEN",
    claimBoundary: "Native macOS host verified the exact bundled runtime closure, hashes, executable bits, architectures, pinned whisper.cpp receipts and real whisper-cli launch probes; signing, notarization, transcription quality and physical-device behavior are separate gates.",
    appPath,
    arch,
    manifest,
    files,
    architectures,
    versions: { node: nodeVersion, ffmpeg: ffmpegVersion, ffprobe: ffprobeVersion, whisperCli: whisperVersion },
    capabilities: {
      automaticCaptions: true,
      automaticCaptionsEngine,
      ffmpegWhisperFilter,
      whisperCliFallback: true,
      whisperCliRequiredFlags: REQUIRED_WHISPER_FLAGS,
    },
    whisper: { provenance, capability, runtimeDependencies: whisperDependencies.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) },
  };
  const output = resolve(outputArgument ?? `.rd/receipts/macos-runtime-${arch}.json`);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ status: result.status, arch, automaticCaptionsEngine, output })}\n`);
}
