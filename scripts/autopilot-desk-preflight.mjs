import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { PRODUCT_REQUIRED_INPUT_PATHS, PRODUCT_REQUIRED_OUTPUT_PATHS } from "./lib/build-input-identity.mjs";

// Read-only Windows desktop packaging inventory. No secrets or user media are read.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tauriRoot = resolve(root, "src-tauri");
const strict = process.argv.includes("--strict");
const strictDev = process.argv.includes("--strict-dev");
const strictCommunity = process.argv.includes("--strict-community");
const strictCommunityRender = process.argv.includes("--strict-community-render");
const strictCommunityPortable = process.argv.includes("--strict-community-portable");
const workspaceRoot = resolve(root, "../..");

function commandAvailable(name) {
  if (process.platform === "win32" && ["cargo", "rustc"].includes(name)
    && existsSync(resolve(homedir(), ".cargo", "bin", `${name}.exe`))) return true;
  const finder = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(finder, [name], { encoding: "utf8", timeout: 3000, windowsHide: true });
  return result.status === 0 && Boolean(result.stdout?.trim());
}

function webView2Available() {
  if (process.platform !== "win32") return false;
  const bases = [process.env["ProgramFiles(x86)"], process.env.ProgramFiles].filter(Boolean);
  for (const base of bases) {
    const directory = resolve(base, "Microsoft", "EdgeWebView", "Application");
    if (!existsSync(directory)) continue;
    if (readdirSync(directory, { withFileTypes: true })
      .some(entry => entry.isDirectory() && existsSync(resolve(directory, entry.name, "msedgewebview2.exe")))) return true;
  }
  return false;
}

function resourceEntries(configName) {
  const config = JSON.parse(readFileSync(resolve(tauriRoot, configName), "utf8"));
  return Object.keys(config.bundle?.resources ?? {}).map(source => ({
    source,
    present: existsSync(resolve(tauriRoot, source)),
  }));
}

const tools = Object.fromEntries(
  ["node", "cargo", "rustc", "cl", "ffmpeg", "ffprobe", "whisper-cli"]
    .map(name => [name, commandAvailable(name)]),
);
const resources = {
  base: resourceEntries("tauri.conf.json"),
  windows: resourceEntries("tauri.windows.conf.json"),
};
const missingResources = Object.entries(resources)
  .flatMap(([group, entries]) => entries.filter(entry => !entry.present).map(entry => `${group}:${entry.source}`));
const missingSourceInputs = PRODUCT_REQUIRED_INPUT_PATHS.filter(source => !existsSync(
  source.startsWith("workspace/") ? resolve(workspaceRoot, source.slice("workspace/".length)) : resolve(root, source),
));
const missingReleaseOutputs = PRODUCT_REQUIRED_OUTPUT_PATHS.filter(source => !existsSync(resolve(root, source)));
const missingDevInputs = [
  ".release-input-manifest.json",
  "desktop-dist/service.mjs",
  "desktop-dist/service.mjs.material-color-identity.json",
  "desktop-dist/mcp.mjs",
].filter(source => !existsSync(resolve(root, source)));
const missingBaseResources = resources.base.filter(entry => !entry.present).map(entry => entry.source);
const missingCoreBundleResources = resources.windows.filter(entry => !entry.present && !entry.source.startsWith("../vendor/whisper/"))
  .map(entry => entry.source);
const missingTranscriptionBundleResources = resources.windows.filter(entry => !entry.present && entry.source.startsWith("../vendor/whisper/"))
  .map(entry => entry.source);
const webBuildPresent = tools.node && existsSync(resolve(root, "node_modules")) && existsSync(resolve(root, "dist", "index.html"));
const desktopToolchainPresent = process.platform === "win32" && tools.node && tools.cargo && tools.rustc && tools.cl && webView2Available();
const bundleInputsPresent = missingResources.length === 0;
const canAttemptDesktopDev = desktopToolchainPresent && missingSourceInputs.length === 0
  && missingBaseResources.length === 0 && missingDevInputs.length === 0;
const canAttemptCommunityDesktopDev = desktopToolchainPresent && missingBaseResources.length === 0
  && existsSync(resolve(tauriRoot, "tauri.community.conf.json"))
  && existsSync(resolve(root, "scripts/community-desktop-dev.mjs"));
const communityFontFiles = [
  "BebasNeue-Regular.ttf", "Fredoka[wdth,wght].ttf", "LXGWWenKaiMonoTC-Regular.ttf",
  "NotoSansTC[wght].ttf", "NotoSerifTC[wght].ttf",
];
const missingCommunityFontSources = communityFontFiles.filter(file => !existsSync(resolve(root, "public/fonts", file)));
const canAttemptCommunityBasicRender = canAttemptCommunityDesktopDev && tools.ffmpeg && tools.ffprobe
  && missingCommunityFontSources.length === 0;
const canAttemptCommunityPortablePreview = canAttemptCommunityBasicRender
  && existsSync(resolve(tauriRoot, "tauri.community.portable.conf.json"))
  && existsSync(resolve(root, "scripts/community-portable-build.mjs"));
const nativeMediaExtensionsPresent = existsSync(resolve(root, "native/bin/win32-x64/hao-core.exe"))
  && existsSync(resolve(root, "native/bin/win32-x64/editkin-gpu-compositor.exe"));
const result = {
  schema: "autopilot-desk.desktop-preflight/v4",
  platform: process.platform,
  webBuildPresent,
  desktopToolchainPresent,
  canAttemptDesktopDev,
  canAttemptCommunityDesktopDev,
  canAttemptCommunityBasicRender,
  canAttemptCommunityPortablePreview,
  nativeMediaExtensionsPresent,
  bundleInputsPresent,
  canAttemptWindowsBundle: desktopToolchainPresent && bundleInputsPresent
    && missingSourceInputs.length === 0 && missingReleaseOutputs.length === 0 && missingDevInputs.length === 0,
  tools,
  webView2: webView2Available(),
  missingSourceInputs,
  missingDevInputs,
  missingReleaseOutputs,
  missingBaseResources,
  missingCommunityFontSources,
  missingCoreBundleResources,
  missingTranscriptionBundleResources,
  missingResources,
  note: "canAttemptDesktopDev and canAttemptWindowsBundle describe the formal profile. Community debug and portable preview have separate unattested identities. Their attempt gates check local tooling and source fonts, not actual GUI or output quality; nativeMediaExtensionsPresent is separate. The portable preview requires Node, FFmpeg and ffprobe on target PATH and is not an installer. The community source edition intentionally omits owner assets; do not fabricate them. Whisper is optional for manual editing but required by the current formal Windows bundle config. This inventory does not verify licenses, hashes, runtime behavior or release readiness.",
};
console.log(JSON.stringify(result, null, 2));
if (strict && !result.canAttemptWindowsBundle) process.exitCode = 1;
if (strictDev && !result.canAttemptDesktopDev) process.exitCode = 1;
if (strictCommunity && !result.canAttemptCommunityDesktopDev) process.exitCode = 1;
if (strictCommunityRender && !result.canAttemptCommunityBasicRender) process.exitCode = 1;
if (strictCommunityPortable && !result.canAttemptCommunityPortablePreview) process.exitCode = 1;
