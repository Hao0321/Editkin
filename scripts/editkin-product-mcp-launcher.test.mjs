import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertLauncherArguments,
  canonicalJson,
  generationIdForRecords,
  importVerifiedEntrypoint,
  launchProductMcpGeneration,
  PRODUCT_AGENT_DIRECTORY_ROLES,
  PRODUCT_AGENT_FILE_ROLES,
  sha256Bytes,
  VERIFIED_ENTRYPOINT_LOADER_UNAVAILABLE,
  verifyNodeManifest,
} from "./editkin-product-mcp-launcher.mjs";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEST_ROOT = resolve(APP_ROOT, ".rd/tmp");
const LAUNCHER = resolve(APP_ROOT, "scripts/editkin-product-mcp-launcher.mjs");
const CONTRACT = resolve(APP_ROOT, "src/shared/agentSetupContract.json");
const NODE = process.execPath;
const touchedEnvironment = [
  "HAO_FFMPEG_PATH", "EDITKIN_FFMPEG_PATH", "HAO_FFPROBE_PATH", "EDITKIN_FFPROBE_PATH",
  "EDITKIN_WHISPER_CLI_PATH", "HAO_NATIVE_CORE_PATH", "EDITKIN_GPU_COMPOSITOR_PATH",
  "EDITKIN_CREATIVE_PACK_ROOT", "EDITKIN_PERSONAL_MUSIC_ROOT", "EDITKIN_FONT_ROOT",
  "EDITKIN_PERSONAL_VISUAL_ROOT", "EDITKIN_COLOR_ROOT", "EDITKIN_PLUGIN_ROOTS",
  "EDITKIN_MODEL_ROOT", "EDITKIN_CACHE_ROOT", "EDITKIN_VIDEO_AUTOPILOT_SKILL",
  "EDITKIN_WORKFLOW_PROFILE_PATH", "EDITKIN_MCP_MODE",
];
const originalEnvironment = Object.fromEntries(touchedEnvironment.map((key) => [key, process.env[key]]));
const ownedRoots = [];

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * Stands in for Node's ESM loader: resolve and load go through the hooks the
 * launcher registered, and the fallback load reads the file again from disk,
 * so a bypassed hook would show up as disk bytes instead of verified bytes.
 */
function simulatedNodeLoader({ beforeLoad } = {}) {
  const loads = [];
  let hooks;
  let deregistered = false;
  return {
    loads,
    get deregistered() { return deregistered; },
    registerHooks(value) {
      hooks = value;
      return { deregister() { deregistered = true; } };
    },
    async importModule(specifier) {
      const resolved = hooks.resolve(specifier, { conditions: ["node", "import"], parentURL: undefined },
        () => ({ url: specifier }));
      await beforeLoad?.(resolved.url);
      const loaded = hooks.load(resolved.url, { format: resolved.format, conditions: [] },
        async (url) => ({ format: "module", source: await readFile(fileURLToPath(url)), shortCircuit: true }));
      loads.push({ specifier, url: resolved.url, format: loaded.format, source: Buffer.from(await loaded.source) });
    },
  };
}

async function fixture({ entrypointSource = "globalThis.__EDITKIN_PRODUCT_LAUNCHER_TEST__ = true;\n" } = {}) {
  await mkdir(TEST_ROOT, { recursive: true });
  const root = await mkdtemp(resolve(TEST_ROOT, "product-agent-launcher-"));
  ownedRoots.push(root);
  const stateRoot = resolve(root, "agent-runtime-v3");
  const filesRoot = resolve(root, "resource-fixture");
  const directoryPaths = {
    color: resolve(filesRoot, "color/aces2"),
    creativePack: resolve(filesRoot, "creative-packs/hao-creator-library"),
    fonts: resolve(filesRoot, "font-packs/editkin-open-fonts"),
    personalMusic: resolve(filesRoot, "personal-packs/hao-music-library"),
    personalVisual: resolve(filesRoot, "creative-packs/hao-creator-library"),
    plugins: resolve(filesRoot, "plugins"),
    resourceRoot: APP_ROOT,
  };
  for (const path of Object.values(directoryPaths).filter((path) => path !== APP_ROOT)) await mkdir(path, { recursive: true });
  await mkdir(resolve(stateRoot, "generations"), { recursive: true });

  const entrypoint = resolve(filesRoot, "runtime/mcp.mjs");
  const entrypointIdentity = resolve(filesRoot, "runtime/mcp.mjs.material-color-identity.json");
  const nodeManifest = resolve(filesRoot, "runtime/NODE-MANIFEST.json");
  const node = resolve(filesRoot, "runtime/node.exe");
  await mkdir(dirname(entrypoint), { recursive: true });
  const entrypointBytes = Buffer.from(entrypointSource);
  await writeFile(entrypoint, entrypointBytes);
  await writeFile(entrypointIdentity, JSON.stringify({
    schema: "editkin.material-color-bundle/v1",
    bundle: { file: "mcp.mjs", size: entrypointBytes.length, sha256: sha256Bytes(entrypointBytes) },
  }));
  await copyFile(NODE, node);
  await writeFile(nodeManifest, JSON.stringify({ version: process.versions.node, nodeExeSha256: await sha256File(node) }));

  const filePaths = {
    embeddedContract: CONTRACT,
    entrypoint,
    entrypointIdentity,
    ffmpeg: resolve(filesRoot, "runtime/ffmpeg.exe"),
    ffprobe: resolve(filesRoot, "runtime/ffprobe.exe"),
    gpuCompositor: resolve(filesRoot, "runtime/editkin-gpu-compositor.exe"),
    launcher: LAUNCHER,
    nativeCore: resolve(filesRoot, "runtime/hao-core.exe"),
    node,
    nodeManifest,
    whisper: resolve(filesRoot, "runtime/whisper-cli.exe"),
  };
  for (const [role, path] of Object.entries(filePaths)) {
    if (["embeddedContract", "entrypoint", "entrypointIdentity", "launcher", "node", "nodeManifest"].includes(role)) continue;
    await writeFile(path, `fixture:${role}\n`);
  }
  const files = [];
  for (const role of PRODUCT_AGENT_FILE_ROLES) {
    const path = filePaths[role];
    const bytes = await readFile(path);
    files.push({ bytes: bytes.length, path, role, sha256: sha256Bytes(bytes) });
  }
  const directories = PRODUCT_AGENT_DIRECTORY_ROLES.map((role) => ({ path: directoryPaths[role], role }));
  const generationId = generationIdForRecords(files, directories);
  const generationDirectoryName = `${generationId}--${randomBytes(16).toString("hex")}`;
  const generationRoot = resolve(stateRoot, "generations", generationDirectoryName);
  await mkdir(generationRoot);
  const manifest = { directories, files, generationId, kind: "editkin-product-mcp-generation", schemaVersion: 3 };
  const manifestBytes = Buffer.from(canonicalJson(manifest));
  await writeFile(resolve(generationRoot, "GENERATION-MANIFEST.json"), manifestBytes);
  const pointer = {
    generationDirectoryName,
    generationId,
    kind: "editkin-product-mcp-pointer",
    manifestSha256: sha256Bytes(manifestBytes),
    schemaVersion: 3,
    selectionRevision: randomBytes(16).toString("hex"),
  };
  await writeFile(resolve(stateRoot, "ACTIVE-GENERATION.json"), canonicalJson(pointer));
  return { entrypoint, entrypointBytes, files, manifest, node, pointer, stateRoot };
}

afterEach(async () => {
  for (const key of touchedEnvironment) {
    if (originalEnvironment[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnvironment[key];
  }
  for (const root of ownedRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("delivered product MCP generation launcher", () => {
  it("loads only the verified active user-scoped generation and binds its runtime", async () => {
    const item = await fixture();
    const loader = simulatedNodeLoader();
    const result = await launchProductMcpGeneration({
      stateRoot: item.stateRoot,
      runningExecutable: item.node,
      selfPath: LAUNCHER,
      registerHooks: loader.registerHooks,
      importModule: loader.importModule,
    });
    expect(result).toMatchObject({ status: "GREEN_PRODUCT_MCP_GENERATION_STARTED", generationId: item.manifest.generationId });
    // The real file:// URL of the generation entrypoint, never a data: URL, and
    // the evaluated source is the verified buffer.
    const entrypointUrl = pathToFileURL(item.entrypoint).href;
    expect(loader.loads).toEqual([{ specifier: entrypointUrl, url: entrypointUrl, format: "module", source: item.entrypointBytes }]);
    expect(loader.deregistered).toBe(true);
    expect(process.env.HAO_FFMPEG_PATH).toMatch(/resource-fixture[\\/]runtime[\\/]ffmpeg\.exe$/);
    expect(process.env.EDITKIN_GPU_COMPOSITOR_PATH).toMatch(/resource-fixture[\\/]runtime[\\/]editkin-gpu-compositor\.exe$/);
    expect(process.env.EDITKIN_FONT_ROOT).toMatch(/resource-fixture[\\/]font-packs[\\/]editkin-open-fonts$/);
    expect(process.env.EDITKIN_COLOR_ROOT).toMatch(/resource-fixture[\\/]color[\\/]aces2$/);
    expect(process.env.EDITKIN_PLUGIN_ROOTS).toMatch(/resource-fixture[\\/]plugins$/);
    expect(process.env.EDITKIN_PERSONAL_VISUAL_ROOT).toMatch(/resource-fixture[\\/]creative-packs[\\/]hao-creator-library$/);
  });

  it("evaluates the verified bytes even when the entrypoint file is rewritten after verification", async () => {
    const item = await fixture();
    const loader = simulatedNodeLoader({ beforeLoad: () => writeFile(item.entrypoint, "globalThis.__EDITKIN_TAMPERED__ = true;\n") });
    await expect(launchProductMcpGeneration({
      stateRoot: item.stateRoot,
      runningExecutable: item.node,
      selfPath: LAUNCHER,
      registerHooks: loader.registerHooks,
      importModule: loader.importModule,
    })).rejects.toThrow(/verified-entrypoint-live-drift/);
    expect(loader.loads).toHaveLength(1);
    expect(loader.loads[0].source).toEqual(item.entrypointBytes);
  });

  it("serves the verified bytes to a fresh module instance of the same file URL", async () => {
    const item = await fixture();
    const loader = simulatedNodeLoader();
    const entrypointUrl = pathToFileURL(item.entrypoint).href;
    await importVerifiedEntrypoint({
      path: item.entrypoint,
      bytes: item.entrypointBytes,
      sha256: sha256Bytes(item.entrypointBytes),
      registerHooks: loader.registerHooks,
      importModule: (url) => loader.importModule(`${url}#instance-2`),
    });
    expect(loader.loads).toEqual([{ specifier: `${entrypointUrl}#instance-2`, url: `${entrypointUrl}#instance-2`, format: "module", source: item.entrypointBytes }]);
    await expect(importVerifiedEntrypoint({
      path: item.entrypoint,
      bytes: Buffer.from("tampered\n"),
      sha256: sha256Bytes(item.entrypointBytes),
      registerHooks: loader.registerHooks,
      importModule: loader.importModule,
    })).rejects.toThrow(/do not match their verified identity/);
  });

  it("refuses to import the entrypoint at all when the runtime cannot load verified bytes with file semantics", async () => {
    const item = await fixture();
    const imports = [];
    await expect(launchProductMcpGeneration({
      stateRoot: item.stateRoot,
      runningExecutable: item.node,
      selfPath: LAUNCHER,
      registerHooks: null,
      importModule: async (url) => imports.push(url),
    })).rejects.toThrow(new RegExp(VERIFIED_ENTRYPOINT_LOADER_UNAVAILABLE));
    expect(imports).toEqual([]);
  });

  it("fails closed when the entrypoint import does not go through the verified-bytes hook", async () => {
    const item = await fixture();
    await expect(launchProductMcpGeneration({
      stateRoot: item.stateRoot,
      runningExecutable: item.node,
      selfPath: LAUNCHER,
      registerHooks: () => ({ deregister() {} }),
      importModule: async () => undefined,
    })).rejects.toThrow(/verified-entrypoint-not-served/);
  });

  it("runs the delivered entrypoint with its real file URL, dirname and filename in a launcher process", async () => {
    const item = await fixture({
      entrypointSource: [
        'import { fileURLToPath } from "node:url";',
        'const context = globalThis[Symbol.for("editkin.material-color.verified-data-bundle/v1")];',
        "process.stdout.write(JSON.stringify({ url: import.meta.url, dirname: import.meta.dirname ?? null,",
        "  filename: import.meta.filename ?? null, path: fileURLToPath(import.meta.url), dataContext: context === undefined ? null : \"present\",",
        "  fontRoot: process.env.EDITKIN_FONT_ROOT, colorRoot: process.env.EDITKIN_COLOR_ROOT,",
        "  gpuCompositor: process.env.EDITKIN_GPU_COMPOSITOR_PATH }));",
        "",
      ].join("\n"),
    });
    const child = spawnSync(item.node, [LAUNCHER], {
      cwd: dirname(item.stateRoot),
      encoding: "utf8",
      env: { EDITKIN_AGENT_STATE_ROOT: item.stateRoot, SystemRoot: process.env.SystemRoot ?? "" },
      timeout: 60_000,
      windowsHide: true,
    });
    expect(child.status, child.stderr).toBe(0);
    const observed = JSON.parse(child.stdout);
    const runtimeDirectory = dirname(item.entrypoint);
    expect(observed).toEqual({
      url: pathToFileURL(item.entrypoint).href,
      dirname: runtimeDirectory,
      filename: item.entrypoint,
      path: item.entrypoint,
      dataContext: null,
      fontRoot: resolve(runtimeDirectory, "../font-packs/editkin-open-fonts"),
      colorRoot: resolve(runtimeDirectory, "../color/aces2"),
      gpuCompositor: resolve(runtimeDirectory, "editkin-gpu-compositor.exe"),
    });
  }, 90_000);

  it("remote-only mode never exposes editing asset, plugin, model, or workflow paths", async () => {
    const item = await fixture();
    process.env.EDITKIN_MCP_MODE = "remote-only";
    process.env.EDITKIN_PLUGIN_ROOTS = "attacker-plugin-root";
    process.env.EDITKIN_MODEL_ROOT = "attacker-model-root";
    process.env.EDITKIN_VIDEO_AUTOPILOT_SKILL = "attacker-skill";
    const loader = simulatedNodeLoader();
    const result = await launchProductMcpGeneration({
      stateRoot: item.stateRoot,
      runningExecutable: item.node,
      selfPath: LAUNCHER,
      registerHooks: loader.registerHooks,
      importModule: loader.importModule,
    });
    expect(result).toMatchObject({
      status: "GREEN_PRODUCT_MCP_GENERATION_STARTED",
      rejectedPluginRoots: [],
    });
    expect(process.env.EDITKIN_MCP_MODE).toBe("remote-only");
    for (const key of touchedEnvironment.filter((key) => key !== "EDITKIN_MCP_MODE")) {
      expect(process.env[key], key).toBeUndefined();
    }
    expect(loader.loads).toHaveLength(1);
  });

  it("rejects an unknown MCP mode instead of widening to the full editing server", async () => {
    const item = await fixture();
    process.env.EDITKIN_MCP_MODE = "remote-ony";
    await expect(launchProductMcpGeneration({
      stateRoot: item.stateRoot,
      runningExecutable: item.node,
      selfPath: LAUNCHER,
      importModule: async () => undefined,
    })).rejects.toThrow(/not a supported closed-world mode/);
  });

  it("rejects direct runtime arguments and a retired mcp.mjs argument", () => {
    expect(() => assertLauncherArguments([NODE, LAUNCHER])).not.toThrow();
    expect(() => assertLauncherArguments([NODE, LAUNCHER, "runtime/mcp.mjs"])).toThrow(/accepts no runtime or entrypoint arguments/);
  });

  it("fails closed when a generation-bound file changes", async () => {
    const item = await fixture();
    await writeFile(item.entrypoint, "tampered\n");
    await expect(launchProductMcpGeneration({
      stateRoot: item.stateRoot,
      runningExecutable: item.node,
      selfPath: LAUNCHER,
      importModule: async () => undefined,
    })).rejects.toThrow(/changed|SHA-256/);
  });

  it("rejects non-canonical or extra-field pointer data before import", async () => {
    const item = await fixture();
    const path = resolve(item.stateRoot, "ACTIVE-GENERATION.json");
    await writeFile(path, canonicalJson({ ...item.pointer, forged: true }));
    await expect(launchProductMcpGeneration({
      stateRoot: item.stateRoot,
      runningExecutable: item.node,
      selfPath: LAUNCHER,
      importModule: async () => undefined,
    })).rejects.toThrow(/unexpected closed-world field set/);
  });

  it("rejects a Node executable outside the generation-selected path even when its bytes match", async () => {
    const item = await fixture();
    const copiedNode = resolve(dirname(item.stateRoot), "copied-node.exe");
    await copyFile(NODE, copiedNode);
    await expect(launchProductMcpGeneration({
      stateRoot: item.stateRoot,
      runningExecutable: copiedNode,
      selfPath: LAUNCHER,
      importModule: async () => undefined,
    })).rejects.toThrow(/generation-selected Node path/);
  });

  it("accepts the closed-world macOS platform manifest Node binding", async () => {
    const nodeSha256 = await sha256File(NODE);
    await expect(verifyNodeManifest(
      { path: NODE, sha256: nodeSha256 },
      Buffer.from(JSON.stringify({ schemaVersion: 2, nodeVersion: process.versions.node, files: { node: nodeSha256 } })),
      NODE,
    )).resolves.toBeUndefined();
    expect(() => verifyNodeManifest(
      { path: NODE, sha256: nodeSha256 },
      Buffer.from(JSON.stringify({ schemaVersion: 2, nodeVersion: "0.0.0", files: { node: nodeSha256 } })),
      NODE,
    )).toThrow(/does not bind/);
  });
});
