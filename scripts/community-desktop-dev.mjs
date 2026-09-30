// Agent integration: urn:uuid:d366cab7-d5a4-44d8-b80d-4c7ce4daf65d. Existing GPL license retained; see AGENT-NOTICE.md.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { buildMaterialColorBundle } from "./lib/material-color-bundle-identity.mjs";
import { stageEmbeddedAgent } from "./lib/embedded-agent-runtime.mjs";
import { verifyAgentProvenance } from "./lib/agent-provenance.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
await verifyAgentProvenance(root);
const output = resolve(root, "community-desktop-dist");
const fontRoot = resolve(output, "fonts");
const rustBin = resolve(homedir(), ".cargo", "bin");
const cargo = resolve(rustBin, "cargo.exe");
const rustc = resolve(rustBin, "rustc.exe");
if (process.platform !== "win32" || !existsSync(cargo) || !existsSync(rustc)) {
  throw new Error("Community desktop debug requires installed Windows Rust/Cargo");
}
const executable = name => {
  const result = spawnSync("where.exe", [name], { encoding: "utf8", windowsHide: true, timeout: 3000 });
  const path = result.stdout?.split(/\r?\n/u).find(Boolean);
  if (result.status !== 0 || !path) throw new Error(`Missing local executable: ${name}`);
  return path;
};
const env = {
  ...process.env,
  PATH: `${rustBin};${process.env.PATH ?? ""}`,
  EDITKIN_COMMUNITY_DEV: "1",
  EDITKIN_NODE_PATH: process.execPath,
  EDITKIN_SERVICE_PATH: resolve(output, "service.mjs"),
  EDITKIN_MCP_PATH: resolve(output, "mcp.mjs"),
  EDITKIN_MCP_IDENTITY_PATH: resolve(output, "mcp.mjs.material-color-identity.json"),
  EDITKIN_REMOTE_PATH: resolve(output, "remote.mjs"),
  HAO_FFMPEG_PATH: executable("ffmpeg.exe"),
  HAO_FFPROBE_PATH: executable("ffprobe.exe"),
  EDITKIN_FONT_ROOT: fontRoot,
};
for (const [key, path] of [
  ["HAO_NATIVE_CORE_PATH", resolve(root, "native/bin/win32-x64/hao-core.exe")],
  ["EDITKIN_GPU_COMPOSITOR_PATH", resolve(root, "native/bin/win32-x64/editkin-gpu-compositor.exe")],
]) {
  if (existsSync(path)) env[key] = path;
}

const common = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  minify: true,
  sourcemap: false,
  legalComments: "none",
};
await mkdir(fontRoot, { recursive: true });
await stageEmbeddedAgent({ runtimeDirectory: output, kitDirectory: resolve(output, "kit") });
for (const file of [
  "BebasNeue-Regular.ttf", "Fredoka[wdth,wght].ttf", "LXGWWenKaiMonoTC-Regular.ttf",
  "NotoSansTC[wght].ttf", "NotoSerifTC[wght].ttf",
  "bebas-neue-OFL.txt", "fredoka-OFL.txt", "lxgw-wenkai-mono-tc-OFL.txt",
  "noto-sans-tc-OFL.txt", "noto-serif-tc-OFL.txt",
]) {
  await copyFile(resolve(root, "public/fonts", file), resolve(fontRoot, file));
}
await buildMaterialColorBundle({
  ...common,
  entryPoints: ["src/mcp/server.ts"],
  outfile: resolve(output, "mcp.mjs"),
});
await Promise.all([
  buildMaterialColorBundle({
    ...common,
    entryPoints: ["src/service/cli.ts"],
    outfile: resolve(output, "service.mjs"),
    define: { __EDITKIN_AUTO_ROTO_SERVICE_ARTIFACT_KIND__: JSON.stringify("product") },
  }),
  build({
    ...common,
    entryPoints: ["src/remote/server.ts"],
    outfile: resolve(output, "remote.mjs"),
  }),
  build({
    ...common,
    entryPoints: ["src/mcp/agentGateway.ts"],
    outfile: resolve(output, "agent-gateway.mjs"),
  }),
]);
console.log("Community debug service bundles built. This is not a release artifact.");
if (process.argv.includes("--prepare-only")) process.exit(0);
const args = [
  resolve(root, "node_modules/@tauri-apps/cli/tauri.js"),
  "dev", "--config", "src-tauri/tauri.community.conf.json",
];
const child = spawn(process.execPath, args, { cwd: root, env, stdio: "inherit", windowsHide: true });
const status = await new Promise((resolveStatus, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => resolveStatus({ code, signal }));
});
if (status.signal) throw new Error(`Community desktop debug stopped by ${status.signal}`);
process.exitCode = status.code ?? 1;
