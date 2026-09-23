import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const REQUIRED_WINDOWS_RESOURCES = new Map([
  ["../vendor/node/win32-x64/node.exe", "runtime/node.exe"],
  ["../vendor/ffmpeg/win32-x64/ffmpeg.exe", "runtime/ffmpeg.exe"],
  ["../vendor/ffmpeg/win32-x64/ffprobe.exe", "runtime/ffprobe.exe"],
  ["../vendor/whisper/win32-x64/whisper-cli.exe", "runtime/whisper-cli.exe"],
  ["../native/bin/win32-x64/hao-core.exe", "runtime/hao-core.exe"],
  ["../native/bin/win32-x64/editkin-gpu-compositor.exe", "runtime/editkin-gpu-compositor.exe"],
]);
const REQUIRED_MAC_RESOURCES = new Map([
  ["../.platform-runtime/node", "runtime/node"],
  ["../.platform-runtime/NODE-LICENSE.txt", "runtime/NODE-LICENSE.txt"],
  ["../.platform-runtime/manifest.json", "runtime/PLATFORM-MANIFEST.json"],
  ["../.platform-runtime/ffmpeg", "runtime/ffmpeg"],
  ["../.platform-runtime/ffprobe", "runtime/ffprobe"],
  ["../.platform-runtime/FFMPEG-LICENSE.txt", "runtime/FFMPEG-LICENSE.txt"],
  ["../.platform-runtime/FFPROBE-LICENSE.txt", "runtime/FFPROBE-LICENSE.txt"],
  ["../.platform-runtime/hao-core", "runtime/hao-core"],
  ["../.platform-runtime/editkin-gpu-compositor", "runtime/editkin-gpu-compositor"],
  ["../.platform-runtime/whisper-cli", "runtime/whisper-cli"],
  ["../.platform-runtime/WHISPER-LICENSE.txt", "runtime/WHISPER-LICENSE.txt"],
  ["../.platform-runtime/WHISPER-PROVENANCE.json", "runtime/WHISPER-PROVENANCE.json"],
  ["../.platform-runtime/WHISPER-CAPABILITY.json", "runtime/WHISPER-CAPABILITY.json"],
]);

const readJson = async (path) => JSON.parse(await readFile(resolve(path), "utf8"));
const containsResources = (resources, required) => [...required].every(([source, destination]) => resources?.[source] === destination);
const clone = (value) => JSON.parse(JSON.stringify(value));

function evaluate({ base, windows, macos, android, ios, workflow, stageSource, captionSource, bundleGateSource }) {
  const baseResources = base.bundle?.resources ?? {};
  const windowsResources = windows.bundle?.resources ?? {};
  const macResources = macos.bundle?.resources ?? {};
  const captionPreflight = captionSource.indexOf("await assertAutomaticCaptionRuntime(runtime, translationTarget)");
  const captionModelWork = captionSource.lastIndexOf("const model = await ensureWhisperModel(runtime);");
  const assertions = {
    sharedGraphAndFrontend: base.build?.frontendDist === "../dist",
    sharedBundleHasNoObviousHostBinary: Object.keys(baseResources).every((path) => !/(?:\.exe$|win32-x64|darwin-(?:arm64|x64))/i.test(path)),
    windowsNsis: windows.bundle?.targets?.includes("nsis") === true,
    windowsRuntimeClosureDeclared: containsResources(windowsResources, REQUIRED_WINDOWS_RESOURCES),
    macDesktopBundles: macos.bundle?.targets?.includes("app") === true && macos.bundle?.targets?.includes("dmg") === true,
    macRuntimeClosureDeclared: Object.keys(macResources).length >= REQUIRED_MAC_RESOURCES.size
      && Object.keys(macResources).every((path) => path.startsWith("../.platform-runtime/"))
      && containsResources(macResources, REQUIRED_MAC_RESOURCES),
    macStageIsNativeArchitectureOnly: /process\.platform !== ["']darwin["']/.test(stageSource)
      && /targetArch !== process\.arch/.test(stageSource),
    macStageIncludesNativeCoreAndCompositor: /copyFile\(corePath,/.test(stageSource)
      && /copyFile\(gpuCompositorPath,/.test(stageSource),
    macStageBuildsPinnedWhisperCli: /306c88f4d1286aec1bf96e544632897886af5501/.test(stageSource)
      && /f3585ebf64df3e41b26c45d93bdb38b423ca1de0bf40cc4b6d320254867a75df/.test(stageSource)
      && /--target["'],\s*["']whisper-cli/.test(stageSource)
      && /copyFile\(builtWhisperCli,\s*join\(candidateOutput,\s*["']whisper-cli["']\)\)/.test(stageSource)
      && !/(?:spawn|run|capture)\(["']brew["']/.test(stageSource),
    macStageWritesWhisperReceipts: /WHISPER-PROVENANCE\.json/.test(stageSource)
      && /WHISPER-CAPABILITY\.json/.test(stageSource)
      && /capabilityReceiptSha256/.test(stageSource),
    macAutomaticCaptionsFailClosedBeforeModelWork: captionPreflight >= 0 && captionModelWork > captionPreflight,
    macAutomaticCaptionsUseCliFallback: /captionRuntime\.engine === ["']whisper-cli["']/.test(captionSource)
      && /transcribeWithWhisperCli\(request, runtime, model\.path, language, false\)/.test(captionSource),
    macCiCoversArm64AndX64: /runner:\s*macos-15\s*$[\s\S]*?arch:\s*arm64\s*$/m.test(workflow)
      && /runner:\s*macos-15-intel\s*$[\s\S]*?arch:\s*x64\s*$/m.test(workflow),
    macCiBuildsNativeRuntimeAndBundles: workflow.includes("npm run native:build")
      && workflow.includes("npm run runtime:stage")
      && workflow.includes("npm run tauri:build"),
    macCiCalibratesRuntimeGates: workflow.includes("npm run runtime:stage-self-test")
      && workflow.includes("npm run macos:bundle-runtime-self-test")
      && workflow.includes("npm run platform:self-test"),
    macCiVerifiesExactBundledRuntime: workflow.includes("npm run macos:bundle-runtime-gate"),
    macBundleGateLaunchesWhisperCli: /capture\(whisperCliPath,\s*\[["']--help["']\]\)/.test(bundleGateSource)
      && /capture\(whisperCliPath,\s*\[["']--version["']\]\)/.test(bundleGateSource)
      && /validateWhisperContract/.test(bundleGateSource),
    macCiAtLeastVerifiesCodeSignature: workflow.includes("codesign --verify --deep --strict"),
    mobileDoesNotBundleDesktopCodecs: android.bundle?.active === false && ios.bundle?.active === false,
  };
  const macCaptionCapabilityReceipt = Object.values(macResources).includes("runtime/WHISPER-CAPABILITY.json")
    && Object.values(macResources).includes("runtime/WHISPER-PROVENANCE.json")
    && Object.values(macResources).includes("runtime/whisper-cli");
  const notarizationReceiptValidation = /(?:xcrun\s+stapler\s+validate|spctl\s+--assess)/.test(workflow);
  const productionBlockers = [
    !macCaptionCapabilityReceipt && "Mac runtime 缺少 whisper-cli／license／provenance／capability 的閉集交付鏈",
    !notarizationReceiptValidation && "CI 沒有 stapler/spctl 的 notarization ticket 驗證與 Gatekeeper assessment",
    "Windows 靜態審計不能產生或驗證 macOS .app/.dmg、Developer ID、notarization、Metal/CoreAudio/VideoToolbox 或實機啟動證據",
  ].filter(Boolean);
  return {
    status: Object.values(assertions).every(Boolean) ? "GREEN" : "BLOCK",
    claimStatus: productionBlockers.length ? "BLOCK" : "GREEN",
    targets: ["windows-x64", "macos-arm64", "macos-x64", "android-companion", "ios-companion"],
    verifiedScope: "static-source-and-packaging-structure",
    macBuildHostRequired: true,
    assertions,
    productionBlockers,
  };
}

const fixtures = {
  base: await readJson("src-tauri/tauri.conf.json"),
  windows: await readJson("src-tauri/tauri.windows.conf.json"),
  macos: await readJson("src-tauri/tauri.macos.conf.json"),
  android: await readJson("src-tauri/tauri.android.conf.json"),
  ios: await readJson("src-tauri/tauri.ios.conf.json"),
  workflow: await readFile(resolve(".github/workflows/cross-platform.yml"), "utf8"),
  stageSource: await readFile(resolve("scripts/stage-platform-runtime.mjs"), "utf8"),
  captionSource: await readFile(resolve("src/application/automaticCaptions.ts"), "utf8"),
  bundleGateSource: await readFile(resolve("scripts/macos-bundle-runtime-gate.mjs"), "utf8"),
};

if (process.argv.includes("--self-test")) {
  const tests = [];
  const runMutation = (name, mutate, expectedStatus = "BLOCK") => {
    const candidate = clone(fixtures);
    mutate(candidate);
    const actual = evaluate(candidate).status;
    tests.push({ name, expectedStatus, actual, passed: actual === expectedStatus });
  };
  const currentStatus = evaluate(fixtures).status;
  tests.push({ name: "current-positive-fixture", expectedStatus: "GREEN", actual: currentStatus, passed: currentStatus === "GREEN" });
  runMutation("empty-mac-resources", (candidate) => { candidate.macos.bundle.resources = {}; });
  runMutation("shared-windows-binary-leak", (candidate) => { candidate.base.bundle.resources["../native/bin/win32-x64/leak.exe"] = "runtime/leak.exe"; });
  runMutation("missing-mac-compositor", (candidate) => { delete candidate.macos.bundle.resources["../.platform-runtime/editkin-gpu-compositor"]; });
  runMutation("missing-mac-whisper-cli", (candidate) => { delete candidate.macos.bundle.resources["../.platform-runtime/whisper-cli"]; });
  runMutation("missing-x64-mac-ci", (candidate) => { candidate.workflow = candidate.workflow.replace("runner: macos-15-intel", "runner: linux-x64"); });
  runMutation("missing-bundled-runtime-gate", (candidate) => { candidate.workflow = candidate.workflow.replace("npm run macos:bundle-runtime-gate", "echo runtime-gate-missing"); });
  runMutation("missing-runtime-self-test", (candidate) => { candidate.workflow = candidate.workflow.replace("npm run runtime:stage-self-test", "echo stage-self-test-missing"); });
  runMutation("cross-target-stage-allowed", (candidate) => { candidate.stageSource = candidate.stageSource.replace("process.platform !== \"darwin\"", "false"); });
  runMutation("unpinned-whisper-source", (candidate) => { candidate.stageSource = candidate.stageSource.replaceAll("306c88f4d1286aec1bf96e544632897886af5501", "main"); });
  runMutation("missing-whisper-capability-receipt", (candidate) => { candidate.stageSource = candidate.stageSource.replaceAll("WHISPER-CAPABILITY.json", "MISSING-CAPABILITY.json"); });
  runMutation("bundle-does-not-launch-whisper", (candidate) => { candidate.bundleGateSource = candidate.bundleGateSource.replace("capture(whisperCliPath, [\"--help\"])", "Promise.resolve({ stdout: '', stderr: '' })"); });
  runMutation("caption-cli-fallback-removed", (candidate) => { candidate.captionSource = candidate.captionSource.replaceAll("captionRuntime.engine === \"whisper-cli\"", "false"); });
  runMutation("caption-probe-after-model-download", (candidate) => {
    candidate.captionSource = candidate.captionSource.replace(
      "const captionRuntime = await assertAutomaticCaptionRuntime(runtime, translationTarget);\n  const model = await ensureWhisperModel(runtime);",
      "const model = await ensureWhisperModel(runtime);\n  const captionRuntime = await assertAutomaticCaptionRuntime(runtime, translationTarget);",
    );
  });
  const result = { status: tests.every((test) => test.passed) ? "GREEN" : "BLOCK", tests };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status !== "GREEN") process.exitCode = 1;
} else {
  const result = evaluate(fixtures);
  const outputArgument = process.argv.slice(2).find((argument) => !argument.startsWith("--"));
  const output = outputArgument ? resolve(outputArgument) : undefined;
  if (output) {
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status !== "GREEN") process.exitCode = 1;
}
