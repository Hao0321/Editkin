import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

const root = resolve(import.meta.dirname, "..");
const targetPlatform = process.env.EDITKIN_TARGET_PLATFORM ?? process.platform;
const targetArch = process.env.EDITKIN_TARGET_ARCH ?? process.arch;
const output = resolve(root, ".platform-runtime");

export const PINNED_WHISPER_CPP = Object.freeze({
  version: "1.9.2",
  tag: "v1.9.2",
  commit: "306c88f4d1286aec1bf96e544632897886af5501",
  sourceUrl: "https://codeload.github.com/ggml-org/whisper.cpp/tar.gz/306c88f4d1286aec1bf96e544632897886af5501",
  archiveBytes: 9_627_120,
  archiveSha256: "f3585ebf64df3e41b26c45d93bdb38b423ca1de0bf40cc4b6d320254867a75df",
  license: "MIT",
});

const NODE_VERSION = "22.23.2";
const REQUIRED_WHISPER_FLAGS = ["--language", "--output-srt", "--translate"];
const RUNTIME_FILES = [
  "node", "NODE-LICENSE.txt", "ffmpeg", "ffprobe", "FFMPEG-LICENSE.txt", "FFPROBE-LICENSE.txt",
  "hao-core", "editkin-gpu-compositor", "whisper-cli", "WHISPER-LICENSE.txt",
  "WHISPER-PROVENANCE.json", "WHISPER-CAPABILITY.json",
];

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function hashFile(path) {
  return sha256(await readFile(path));
}

function run(executable, args, timeoutMs = 20 * 60_000) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: "inherit" });
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolvePromise();
    };
    const timer = setTimeout(() => { child.kill(); finish(new Error(`${basename(executable)} timed out`)); }, timeoutMs);
    child.on("error", finish);
    child.on("exit", (code) => finish(code === 0 ? undefined : new Error(`${basename(executable)} exit ${code}`)));
  });
}

function capture(executable, args, timeoutMs = 30_000) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolvePromise({ stdout, stderr });
    };
    const timer = setTimeout(() => { child.kill(); finish(new Error(`${basename(executable)} probe timed out`)); }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${String(chunk)}`.slice(-4_000_000); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-4_000_000); });
    child.on("error", finish);
    child.on("exit", (code) => finish(code === 0 ? undefined : new Error(`${basename(executable)} probe exit ${code}: ${stderr.trim().slice(-2_000)}`)));
  });
}

export function whisperCliHasRequiredCapabilities(helpText) {
  return REQUIRED_WHISPER_FLAGS.every((flag) => helpText.includes(flag));
}

export function matchesMacArchitecture(fileDescription, arch) {
  if (arch === "arm64") return /\barm64\b/i.test(fileDescription);
  if (arch === "x64") return /\bx86_64\b/i.test(fileDescription);
  return false;
}

async function fetchPinnedArtifact(url, expectedBytes, expectedSha256, label) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`${label} 下載失敗：HTTP ${response.status}`);
  const declaredBytes = Number(response.headers.get("content-length") ?? 0);
  if (declaredBytes > 0 && declaredBytes !== expectedBytes) {
    throw new Error(`${label} Content-Length 不符：${declaredBytes}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const actualSha256 = sha256(bytes);
  if (bytes.length !== expectedBytes || actualSha256 !== expectedSha256) {
    throw new Error(`${label} identity 不符：${bytes.length} bytes / ${actualSha256}`);
  }
  return bytes;
}

if (process.argv.includes("--self-test")) {
  const positiveHelp = "  -l, --language LANG\n  -osrt, --output-srt\n  -tr, --translate";
  const tests = [
    { name: "pinned-full-commit", passed: /^[a-f0-9]{40}$/.test(PINNED_WHISPER_CPP.commit) && PINNED_WHISPER_CPP.sourceUrl.endsWith(PINNED_WHISPER_CPP.commit) },
    { name: "pinned-source-sha256", passed: /^[a-f0-9]{64}$/.test(PINNED_WHISPER_CPP.archiveSha256) && PINNED_WHISPER_CPP.archiveBytes > 1_000_000 },
    { name: "transcription-and-translation-help", passed: whisperCliHasRequiredCapabilities(positiveHelp) },
    { name: "missing-srt-negative", passed: !whisperCliHasRequiredCapabilities("--language LANG\n--translate") },
    { name: "missing-translation-negative", passed: !whisperCliHasRequiredCapabilities("--language LANG\n--output-srt") },
    { name: "closed-world-runtime-files", passed: new Set(RUNTIME_FILES).size === RUNTIME_FILES.length && RUNTIME_FILES.includes("whisper-cli") && RUNTIME_FILES.includes("WHISPER-CAPABILITY.json") },
    { name: "architecture-negative", passed: matchesMacArchitecture("Mach-O 64-bit executable arm64", "arm64") && !matchesMacArchitecture("Mach-O 64-bit executable x86_64", "arm64") },
  ];
  const result = { status: tests.every((test) => test.passed) ? "GREEN" : "BLOCK", tests };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status !== "GREEN") process.exitCode = 1;
} else {
  if (targetPlatform !== "darwin") {
    process.stdout.write(`${JSON.stringify({ status: "SKIP", reason: "Windows 使用已釘選 vendor runtime", targetPlatform, targetArch })}\n`);
    process.exit(0);
  }
  if (process.platform !== "darwin" || targetArch !== process.arch) {
    throw new Error(`macOS runtime 必須在相同 architecture 的原生 macOS host 建立：host=${process.platform}/${process.arch}, target=${targetPlatform}/${targetArch}`);
  }

  const nodeArtifacts = {
    arm64: { archive: `node-v${NODE_VERSION}-darwin-arm64.tar.gz`, sha256: "61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6" },
    x64: { archive: `node-v${NODE_VERSION}-darwin-x64.tar.gz`, sha256: "58e99022c2ff89395576cc7fd4d98cea24bb68081475d5f88b801ee8729fb026" },
  };
  const nodeArtifact = nodeArtifacts[targetArch];
  if (!nodeArtifact) throw new Error(`不支援的 macOS architecture：${targetArch}`);
  const corePath = resolve(process.env.HAO_NATIVE_CORE_PATH ?? "native/hao-core/target/release/hao-core");
  const gpuCompositorPath = resolve(process.env.EDITKIN_GPU_COMPOSITOR_PATH ?? "spikes/gpu-compositor/target/release/editkin-gpu-compositor");
  const staging = await mkdtemp(join(tmpdir(), "editkin-macos-runtime-"));
  const candidateOutput = resolve(root, `.platform-runtime.stage-${process.pid}`);

  try {
    await rm(candidateOutput, { recursive: true, force: true });
    await mkdir(candidateOutput, { recursive: true });

    const nodeResponse = await fetch(`https://nodejs.org/dist/v${NODE_VERSION}/${nodeArtifact.archive}`);
    if (!nodeResponse.ok) throw new Error(`Node runtime 下載失敗：HTTP ${nodeResponse.status}`);
    const nodeArchiveBytes = Buffer.from(await nodeResponse.arrayBuffer());
    const nodeArchiveSha256 = sha256(nodeArchiveBytes);
    if (nodeArchiveSha256 !== nodeArtifact.sha256) throw new Error(`Node runtime SHA-256 不符：${nodeArchiveSha256}`);
    const nodeArchivePath = join(staging, nodeArtifact.archive);
    await writeFile(nodeArchivePath, nodeArchiveBytes);
    await run("/usr/bin/tar", ["-xzf", nodeArchivePath, "-C", staging]);
    const nodeRoot = join(staging, nodeArtifact.archive.replace(/\.tar\.gz$/, ""));

    const whisperArchiveBytes = await fetchPinnedArtifact(
      PINNED_WHISPER_CPP.sourceUrl,
      PINNED_WHISPER_CPP.archiveBytes,
      PINNED_WHISPER_CPP.archiveSha256,
      `whisper.cpp ${PINNED_WHISPER_CPP.tag}`,
    );
    const whisperArchivePath = join(staging, `whisper.cpp-${PINNED_WHISPER_CPP.commit}.tar.gz`);
    await writeFile(whisperArchivePath, whisperArchiveBytes);
    await run("/usr/bin/tar", ["-xzf", whisperArchivePath, "-C", staging]);
    const whisperSourceRoot = join(staging, `whisper.cpp-${PINNED_WHISPER_CPP.commit}`);
    const whisperBuildRoot = join(staging, "whisper-build");
    const cmakeConfiguration = [
      "-DCMAKE_BUILD_TYPE=Release",
      `-DCMAKE_OSX_ARCHITECTURES=${targetArch === "x64" ? "x86_64" : "arm64"}`,
      "-DCMAKE_OSX_DEPLOYMENT_TARGET=12.0",
      "-DBUILD_SHARED_LIBS=OFF",
      "-DWHISPER_BUILD_TESTS=OFF",
      "-DWHISPER_BUILD_EXAMPLES=ON",
      "-DWHISPER_BUILD_SERVER=OFF",
      "-DGGML_NATIVE=OFF",
      "-DGGML_METAL=ON",
      "-DGGML_METAL_EMBED_LIBRARY=ON",
      "-DGGML_ACCELERATE=ON",
      "-DGGML_OPENMP=OFF",
    ];
    await run("cmake", ["-S", whisperSourceRoot, "-B", whisperBuildRoot, ...cmakeConfiguration]);
    await run("cmake", ["--build", whisperBuildRoot, "--config", "Release", "--target", "whisper-cli", "--parallel", "2"]);
    const builtWhisperCli = join(whisperBuildRoot, "bin", "whisper-cli");
    const builtWhisperInfo = await stat(builtWhisperCli);
    if (!builtWhisperInfo.isFile() || builtWhisperInfo.size <= 0) throw new Error("whisper-cli build 沒有產生有效 binary");
    const builtDescription = (await capture("/usr/bin/file", ["-b", builtWhisperCli])).stdout.trim();
    if (!matchesMacArchitecture(builtDescription, targetArch)) throw new Error(`whisper-cli architecture 不符：${builtDescription}`);
    const whisperHelpResult = await capture(builtWhisperCli, ["--help"]);
    const whisperHelp = `${whisperHelpResult.stdout}\n${whisperHelpResult.stderr}`;
    if (!whisperCliHasRequiredCapabilities(whisperHelp)) throw new Error("whisper-cli 缺少 language／SRT／translate capability");
    const whisperVersionResult = await capture(builtWhisperCli, ["--version"]);
    const whisperVersion = `${whisperVersionResult.stdout}\n${whisperVersionResult.stderr}`.trim();
    if (!whisperVersion.includes(PINNED_WHISPER_CPP.version) && !whisperVersion.includes(PINNED_WHISPER_CPP.commit.slice(0, 7))) {
      throw new Error(`whisper-cli version probe 與 pin 不符：${whisperVersion.slice(0, 500)}`);
    }
    const whisperDependencies = (await capture("/usr/bin/otool", ["-L", builtWhisperCli])).stdout.trim();
    if (/(?:\/opt\/homebrew|\/usr\/local|@rpath|@loader_path|@executable_path|whisper-build|editkin-macos-runtime)/i.test(whisperDependencies)) {
      throw new Error(`whisper-cli 含非閉集 build／Homebrew runtime dependency：${whisperDependencies}`);
    }
    const cmakeVersion = `${(await capture("cmake", ["--version"])).stdout}`.split(/\r?\n/)[0]?.trim();
    const compilerVersion = `${(await capture("/usr/bin/clang++", ["--version"])).stdout}`.split(/\r?\n/)[0]?.trim();

    await copyFile(join(nodeRoot, "bin/node"), join(candidateOutput, "node"));
    await copyFile(join(nodeRoot, "LICENSE"), join(candidateOutput, "NODE-LICENSE.txt"));
    await copyFile(ffmpegPath, join(candidateOutput, "ffmpeg"));
    await copyFile(ffprobeStatic.path, join(candidateOutput, "ffprobe"));
    await copyFile(`${ffmpegPath}.LICENSE`, join(candidateOutput, "FFMPEG-LICENSE.txt"));
    await copyFile(resolve(root, "node_modules/ffprobe-static/LICENSE"), join(candidateOutput, "FFPROBE-LICENSE.txt"));
    await copyFile(corePath, join(candidateOutput, "hao-core"));
    await copyFile(gpuCompositorPath, join(candidateOutput, "editkin-gpu-compositor"));
    await copyFile(builtWhisperCli, join(candidateOutput, "whisper-cli"));
    await copyFile(join(whisperSourceRoot, "LICENSE"), join(candidateOutput, "WHISPER-LICENSE.txt"));
    for (const executable of ["node", "ffmpeg", "ffprobe", "hao-core", "editkin-gpu-compositor", "whisper-cli"]) {
      await chmod(join(candidateOutput, executable), 0o755);
    }

    const whisperBinarySha256 = await hashFile(join(candidateOutput, "whisper-cli"));
    const whisperLicenseSha256 = await hashFile(join(candidateOutput, "WHISPER-LICENSE.txt"));
    const whisperProvenance = {
      schemaVersion: 1,
      component: "whisper.cpp/whisper-cli",
      version: PINNED_WHISPER_CPP.version,
      tag: PINNED_WHISPER_CPP.tag,
      commit: PINNED_WHISPER_CPP.commit,
      source: { url: PINNED_WHISPER_CPP.sourceUrl, bytes: PINNED_WHISPER_CPP.archiveBytes, sha256: PINNED_WHISPER_CPP.archiveSha256 },
      license: { spdx: PINNED_WHISPER_CPP.license, file: "WHISPER-LICENSE.txt", sha256: whisperLicenseSha256 },
      target: { platform: targetPlatform, arch: targetArch, minimumMacOS: "12.0" },
      build: { cmakeVersion, compilerVersion, configuration: cmakeConfiguration, sharedLibraries: false, metal: true, accelerate: true, homebrewRuntimeAllowed: false },
      binary: { name: "whisper-cli", bytes: (await stat(join(candidateOutput, "whisper-cli"))).size, sha256: whisperBinarySha256, fileDescription: builtDescription },
      runtimeDependencies: whisperDependencies.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
    };
    await writeFile(join(candidateOutput, "WHISPER-PROVENANCE.json"), `${JSON.stringify(whisperProvenance, null, 2)}\n`, "utf8");
    const whisperCapability = {
      schemaVersion: 1,
      capabilityId: "editkin.automatic-captions.whisper-cli/v1",
      component: "whisper.cpp/whisper-cli",
      version: PINNED_WHISPER_CPP.version,
      commit: PINNED_WHISPER_CPP.commit,
      platform: targetPlatform,
      arch: targetArch,
      binarySha256: whisperBinarySha256,
      provenanceSha256: await hashFile(join(candidateOutput, "WHISPER-PROVENANCE.json")),
      probe: { launched: true, version: whisperVersion, requiredFlags: REQUIRED_WHISPER_FLAGS },
      capabilities: { monolingualTranscription: true, automaticLanguage: true, srt: true, translateToEnglish: true, localOnly: true },
      routing: { fallbackWhen: "ffmpeg-whisper-filter-unavailable", primaryWhenAvailable: "ffmpeg-whisper-filter" },
    };
    await writeFile(join(candidateOutput, "WHISPER-CAPABILITY.json"), `${JSON.stringify(whisperCapability, null, 2)}\n`, "utf8");

    const files = {};
    for (const name of RUNTIME_FILES) files[name] = await hashFile(join(candidateOutput, name));
    const manifest = {
      schemaVersion: 2,
      platform: targetPlatform,
      arch: targetArch,
      nodeVersion: NODE_VERSION,
      nodeArchiveSha256,
      whisper: {
        version: PINNED_WHISPER_CPP.version,
        commit: PINNED_WHISPER_CPP.commit,
        sourceArchiveSha256: PINNED_WHISPER_CPP.archiveSha256,
        binarySha256: whisperBinarySha256,
        capabilityReceiptSha256: files["WHISPER-CAPABILITY.json"],
      },
      files,
    };
    await writeFile(join(candidateOutput, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    if (output !== resolve(root, ".platform-runtime")) throw new Error(`拒絕覆寫非 canonical runtime：${output}`);
    await rm(output, { recursive: true, force: true });
    await rename(candidateOutput, output);
    process.stdout.write(`${JSON.stringify({ status: "GREEN", output, ...manifest })}\n`);
  } finally {
    await rm(candidateOutput, { recursive: true, force: true });
    await rm(staging, { recursive: true, force: true });
  }
}
