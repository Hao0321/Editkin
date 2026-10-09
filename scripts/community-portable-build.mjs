// Agent integration: urn:uuid:d366cab7-d5a4-44d8-b80d-4c7ce4daf65d. Existing GPL license retained; see AGENT-NOTICE.md.
import { spawn } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stageEmbeddedAgent } from "./lib/embedded-agent-runtime.mjs";
import { portableBuildEnvironment, verifyPortablePrivacy } from "./lib/portable-build-privacy.mjs";
import { verifyAgentProvenance } from "./lib/agent-provenance.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const provenance = await verifyAgentProvenance(root);
const whisperRoot = resolve(root, "vendor/whisper/win32-x64");
const whisperModel = resolve(root, "vendor/whisper/models/ggml-small-q5_1.bin");
async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
const rustBin = resolve(homedir(), ".cargo", "bin");
if (process.platform !== "win32" || !existsSync(resolve(rustBin, "cargo.exe"))) {
  throw new Error("Windows Rust/Cargo is required for the community portable preview");
}

async function run(args, env = process.env) {
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: "inherit", windowsHide: true });
  const code = await new Promise((resolveCode, reject) => {
    child.once("error", reject);
    child.once("exit", (status, signal) => signal ? reject(new Error(`Build interrupted by ${signal}`)) : resolveCode(status));
  });
  if (code !== 0) throw new Error(`Build step failed (${code}): ${args.slice(0, 2).join(" ")}`);
}

const pinnedWhisper = JSON.parse(await readFile(resolve(root, "config/community-whisper-runtime.json"), "utf8"));
const stagedWhisper = JSON.parse(await readFile(resolve(whisperRoot, "manifest.json"), "utf8"));
if (!isDeepStrictEqual(stagedWhisper, pinnedWhisper)) throw new Error("Whisper runtime metadata differs from the public community build pin");
await run([resolve(root, "scripts/whisper-runtime-gate.mjs")]);
const modelIdentity = { bytes: 190_085_487, sha256: "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb" };
if ((await stat(whisperModel)).size !== modelIdentity.bytes || await sha256File(whisperModel) !== modelIdentity.sha256) {
  throw new Error("Pinned Whisper model identity mismatch; portable build stopped");
}
await run([resolve(root, "scripts/community-desktop-dev.mjs"), "--prepare-only"]);
const buildEnv = portableBuildEnvironment(root, {
  ...process.env,
  PATH: `${rustBin};${process.env.PATH ?? ""}`,
  EDITKIN_COMMUNITY_PORTABLE: "1",
});
delete buildEnv.EDITKIN_COMMUNITY_DEV;
delete buildEnv.EDITKIN_LOCAL_MODEL_ORIGIN;
await run([
  resolve(root, "node_modules/@tauri-apps/cli/tauri.js"),
  "build", "--debug", "--no-bundle", "--config", "src-tauri/tauri.community.portable.conf.json",
], buildEnv);

const artifactRoot = resolve(root, "../artifacts/autopilot-desk");
await mkdir(artifactRoot, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const destination = resolve(artifactRoot, `portable-preview-${stamp}`);
await mkdir(destination);
const resources = resolve(destination, "resources");
await mkdir(resolve(resources, "licenses"), { recursive: true });
for (const [source, target] of [["LICENSE", "GPL-3.0-or-later.txt"], ["LICENSES/AGPL-3.0-or-later.txt", "AGPL-3.0-or-later.txt"],
  ["AGENT-NOTICE.md", "AGENT-NOTICE.md"], ["AGENT-PROVENANCE.json", "AGENT-PROVENANCE.json"]]) {
  await copyFile(resolve(root, source), resolve(resources, "licenses", target));
}
const runtime = resolve(resources, "runtime");
await mkdir(runtime, { recursive: true });
const executable = resolve(destination, "AutopilotDesk-Community-Preview.exe");
await copyFile(resolve(root, "src-tauri/target/debug/editkin.exe"), executable);
for (const file of ["service.mjs", "service.mjs.material-color-identity.json", "mcp.mjs", "mcp.mjs.material-color-identity.json", "agent-gateway.mjs", "remote.mjs"]) {
  await copyFile(resolve(root, "community-desktop-dist", file), resolve(runtime, file));
}
for (const file of ["demo-source.mp4", "editkin-demo-preview.mp4"]) {
  await copyFile(resolve(root, "public", file), resolve(runtime, file));
}
const whisperManifest = JSON.parse(await readFile(resolve(whisperRoot, "manifest.json"), "utf8"));
for (const file of whisperManifest.files) await copyFile(resolve(whisperRoot, file.name), resolve(runtime, file.name));
await copyFile(resolve(whisperRoot, "WHISPER-LICENSE.txt"), resolve(runtime, "WHISPER-LICENSE.txt"));
await copyFile(resolve(whisperRoot, "manifest.json"), resolve(runtime, "WHISPER-MANIFEST.json"));
await mkdir(resolve(runtime, "models"), { recursive: true });
const packagedModel = resolve(runtime, "models/ggml-small-q5_1.bin");
await copyFile(whisperModel, packagedModel);
if (await sha256File(packagedModel) !== modelIdentity.sha256) throw new Error("Packaged Whisper model identity mismatch");
await writeFile(resolve(runtime, "WHISPER-MODEL-SOURCE.txt"), [
  "ggml-small-q5_1.bin · multilingual Whisper model · MIT",
  "Source: https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin",
  `Bytes: ${modelIdentity.bytes}`,
  `SHA-256: ${modelIdentity.sha256}`,
  "",
].join("\r\n"), "utf8");
await cp(resolve(root, "community-desktop-dist/fonts"), resolve(resources, "fonts"), { recursive: true });
await mkdir(resolve(resources, "color"), { recursive: true });
await cp(resolve(root, "public/color/aces2"), resolve(resources, "color/aces2"), { recursive: true });
await cp(resolve(root, "plugins"), resolve(resources, "plugins"), { recursive: true });
await mkdir(resolve(resources, "agent-runtime-v3"), { recursive: true });
await stageEmbeddedAgent({ runtimeDirectory: resolve(resources, "agent-runtime-v3"), kitDirectory: resolve(resources, "video-autopilot-kit") });
await copyFile(resolve(root, "scripts/editkin-product-mcp-launcher.mjs"), resolve(resources, "agent-runtime-v3/launcher.mjs"));
await copyFile(resolve(root, "src/shared/agentSetupContract.json"), resolve(resources, "agent-runtime-v3/agent-setup-contract.json"));
const sha256 = createHash("sha256").update(await readFile(executable)).digest("hex");
await writeFile(resolve(destination, "README.txt"), [
  "Autopilot Desk Community Preview (private Windows trial)",
  "This is an unattested community build, not an official Editkin release or installer.",
  "Run AutopilotDesk-Community-Preview.exe from this folder; keep resources beside it.",
  "Prerequisites: WebView2, Node.js 22.13+ (node.exe on PATH), FFmpeg and ffprobe on PATH.",
  "Basic manual editing and MP4 rendering require an actual local test on the target machine.",
  "Local story draft bridge supports a user-configured private-IP Qwen endpoint and loopback Ollama. Verify model service on this machine; LAN story generation is not yet end-to-end accepted.",
  "MV story mode requires user-supplied lyrics. The model receives lyrics text but has not heard the song or viewed the footage; review the draft before editing.",
  "In the editor, open Story Draft, enter the LAN model's HTTP private-IP origin, then choose Save and Check. This setting is stored only in local app data.",
  "The Agent dock includes a pinned 1.18.32 Agent runtime and Video Autopilot Kit source. It starts automatically for saved projects. Python 3 remains a local prerequisite for Kit durable workflow commands.",
  "Choose a local model, API provider or configured login gateway in the same Agent dock; configure credentials only in settings. Local model origins are saved only to local app data. The embedded Agent binary is pinned by SHA-256 and does not auto-update.",
  "The compact Agent gateway reaches the original Editkin v4 MCP tools. A complete audited automatic edit and render still require project-specific verification.",
  "Local speech recognition uses the included whisper.cpp CPU runtime and multilingual model. Review recognition before publishing subtitles.",
  "Proprietary native media extensions are not included. Provider account login and subscription quota require account-specific validation; this preview does not grant subscription entitlements.",
  `Executable SHA-256: ${sha256}`,
  `Agent contribution: ${provenance.originId} · ${provenance.attribution}`,
  `Agent source digest: ${provenance.sourceDigest}`,
  "Agent modules: AGPL-3.0-or-later; existing editor integration: GPL-3.0-or-later. See resources/licenses.",
  "Provide the matching Corresponding Source and license notices when redistributing this preview.",
  "",
].join("\r\n"), "utf8");
const privacy = await verifyPortablePrivacy(destination, { root });
await verifyAgentProvenance(root);
console.log(JSON.stringify({ status: "BUILT_UNVERIFIED_PORTABLE_PREVIEW", destination, executable, sha256, privacy, provenance }));
