import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { afterEach, describe, it } from "vitest";
import {
  assertProductAgentTauriResourceMapping,
  inspectExtractedProductAgentConnect,
  PRODUCT_AGENT_CONNECT_DELIVERY_SCHEMA,
  PRODUCT_AGENT_CONNECT_RESOURCE_INVENTORY,
} from "./product-agent-connect-delivery-gate.mjs";
import { productAgentRuntimeResources, productAgentTauriResourceMappings } from "./lib/agent-launcher-closure.mjs";

const APP_ROOT = resolve(import.meta.dirname, "..");
const owned = [];

// The 0.15.0 public preview installer's agent-runtime-v3 folder (Editkin #102/#104/#105).
const SHIPPED_0_15_0_INVENTORY = ["agent-setup-contract.json", "launcher.mjs"];

async function fixture({ delivered = PRODUCT_AGENT_CONNECT_RESOURCE_INVENTORY } = {}) {
  const testRoot = resolve(APP_ROOT, ".rd/tmp");
  await mkdir(testRoot, { recursive: true });
  const root = await mkdtemp(resolve(testRoot, "editkin-agent-delivery-test-"));
  owned.push(root);
  const resources = resolve(root, "agent-runtime-v3");
  await mkdir(resources);
  for (const { source, destination } of productAgentRuntimeResources(APP_ROOT)) {
    if (!delivered.includes(destination)) continue;
    await mkdir(dirname(resolve(resources, destination)), { recursive: true });
    await copyFile(resolve(APP_ROOT, source), resolve(resources, destination));
  }
  const installerPath = resolve(root, "Editkin_fixture_x64-setup.exe");
  await writeFile(installerPath, "fixture installer\n");
  return { root, resources, installerPath };
}

function inspect(item) {
  return inspectExtractedProductAgentConnect({
    extractedRoot: item.root,
    installerPath: item.installerPath,
    linkCheckNodePath: process.execPath,
  });
}

afterEach(async () => {
  for (const root of owned.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("product Agent Connect delivered-resource evidence", () => {
  it("derives the delivered inventory from the launcher's actual imports", () => {
    assert.deepEqual([...PRODUCT_AGENT_CONNECT_RESOURCE_INVENTORY], [
      "agent-setup-contract.json", "launcher.mjs", "lib/regular-file.mjs",
    ]);
  });

  it("reports exact delivered launcher bytes and closed-world config", async () => {
    const item = await fixture();
    const report = await inspect(item);
    assert.equal(report.schema, PRODUCT_AGENT_CONNECT_DELIVERY_SCHEMA);
    assert.equal(report.status, "GREEN");
    assert.deepEqual(Object.keys(report).sort(), [
      "closedWorldConfig", "embeddedContract", "extractedResourceRootSha256", "generatedAt",
      "installer", "launcher", "schema", "sourceIdentities", "status",
    ]);
    assert.deepEqual(report.closedWorldConfig.resourceInventory, [...PRODUCT_AGENT_CONNECT_RESOURCE_INVENTORY]);
    assert.equal(report.closedWorldConfig.directMcpEntrypointAllowed, false);
    assert.equal(report.closedWorldConfig.launcherArgs.length, 0);
  }, 60_000);

  it("rejects the 0.15.0 layout that shipped the launcher without its imported module", async () => {
    const item = await fixture({ delivered: SHIPPED_0_15_0_INVENTORY });
    await assert.rejects(inspect(item), /inventory is not closed-world \(missing: lib\/regular-file\.mjs/);
  });

  it("the merged Windows bundle ships every file the launcher imports, at the path it imports it from", async () => {
    const read = async (path) => JSON.parse(await readFile(resolve(APP_ROOT, path), "utf8"));
    const merge = (target, patch) => {
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete target[key];
        else if (typeof value === "object" && !Array.isArray(value) && typeof target[key] === "object" && target[key] && !Array.isArray(target[key])) merge(target[key], value);
        else target[key] = value;
      }
      return target;
    };
    // JSON Merge Patch (RFC 7396), as `tauri build` applies the platform config.
    const config = merge(await read("src-tauri/tauri.conf.json"), await read("src-tauri/tauri.windows.conf.json"));
    const shipped = Object.entries(config.bundle.resources).filter(([, destination]) => destination.startsWith("agent-runtime-v3/"));
    assert.deepEqual(Object.fromEntries(shipped), Object.fromEntries(productAgentTauriResourceMappings(APP_ROOT)));
    for (const [source] of shipped) assert.equal(existsSync(resolve(APP_ROOT, "src-tauri", source)), true, source);
  });

  it("rejects a Tauri resource map that omits a module the launcher imports", async () => {
    const base = JSON.parse(await readFile(resolve(APP_ROOT, "src-tauri/tauri.conf.json"), "utf8"));
    const platform = JSON.parse(await readFile(resolve(APP_ROOT, "src-tauri/tauri.windows.conf.json"), "utf8"));
    assert.doesNotThrow(() => assertProductAgentTauriResourceMapping(base, platform));
    const withoutClosure = structuredClone(base);
    delete withoutClosure.bundle.resources["../scripts/lib/regular-file.mjs"];
    assert.throws(() => assertProductAgentTauriResourceMapping(withoutClosure, platform),
      /does not map the exact product Agent launcher resources; missing \.\.\/scripts\/lib\/regular-file\.mjs -> agent-runtime-v3\/lib\/regular-file\.mjs/);
    const overridden = structuredClone(platform);
    overridden.bundle.resources["../scripts/lib/regular-file.mjs"] = "agent-runtime-v3/lib/regular-file.mjs";
    assert.throws(() => assertProductAgentTauriResourceMapping(base, overridden), /must not override/);
  });

  it("rejects an extra delivered file and stale launcher bytes", async () => {
    const extra = await fixture();
    await writeFile(resolve(extra.resources, "mcp.mjs"), "retired direct entrypoint\n");
    await assert.rejects(inspect(extra), /inventory is not closed-world/);
    const stale = await fixture();
    await writeFile(resolve(stale.resources, "launcher.mjs"), "// stale\n");
    await assert.rejects(inspect(stale), /stale relative to current source bytes: launcher\.mjs/);
    const staleModule = await fixture();
    await writeFile(resolve(staleModule.resources, "lib/regular-file.mjs"), "// stale\n");
    await assert.rejects(inspect(staleModule), /stale relative to current source bytes: lib\/regular-file\.mjs/);
  });

  it("loads the delivered launcher's module graph and rejects one that does not load", async () => {
    // A source tree whose launcher closure is complete by inventory but whose
    // module graph still fails to load in the delivered folder.
    const testRoot = resolve(APP_ROOT, ".rd/tmp");
    await mkdir(testRoot, { recursive: true });
    const sourceRoot = await mkdtemp(resolve(testRoot, "editkin-agent-delivery-source-"));
    owned.push(sourceRoot);
    const write = async (path, text) => {
      await mkdir(dirname(resolve(sourceRoot, path)), { recursive: true });
      await writeFile(resolve(sourceRoot, path), text);
    };
    await write("scripts/editkin-product-mcp-launcher.mjs",
      'import { helper } from "./lib/helper.mjs";\nexport async function launchProductMcpGeneration() { return helper; }\n');
    await write("scripts/lib/helper.mjs", 'import "node:editkin-missing-builtin";\nexport const helper = 1;\n');
    await write("src/shared/agentSetupContract.json", await readFile(resolve(APP_ROOT, "src/shared/agentSetupContract.json"), "utf8"));
    const resources = Object.fromEntries(productAgentRuntimeResources(sourceRoot)
      .map(({ source, destination }) => [`../${source}`, `agent-runtime-v3/${destination}`]));
    await write("src-tauri/tauri.conf.json", JSON.stringify({ bundle: { resources } }));
    await write("src-tauri/tauri.windows.conf.json", JSON.stringify({ bundle: { resources: {} } }));
    const extractedRoot = await mkdtemp(resolve(testRoot, "editkin-agent-delivery-extracted-"));
    owned.push(extractedRoot);
    for (const { source, destination } of productAgentRuntimeResources(sourceRoot)) {
      await mkdir(dirname(resolve(extractedRoot, "agent-runtime-v3", destination)), { recursive: true });
      await copyFile(resolve(sourceRoot, source), resolve(extractedRoot, "agent-runtime-v3", destination));
    }
    const installerPath = resolve(extractedRoot, "Editkin_fixture_x64-setup.exe");
    await writeFile(installerPath, "fixture installer\n");
    await assert.rejects(inspectExtractedProductAgentConnect({
      extractedRoot, installerPath, sourceRoot, linkCheckNodePath: process.execPath,
    }), /cannot load its module graph from the delivered tree/);
    await write("scripts/lib/helper.mjs", 'import "node:path";\nexport const helper = 1;\n');
    await copyFile(resolve(sourceRoot, "scripts/lib/helper.mjs"), resolve(extractedRoot, "agent-runtime-v3/lib/helper.mjs"));
    const report = await inspectExtractedProductAgentConnect({
      extractedRoot, installerPath, sourceRoot, linkCheckNodePath: process.execPath,
    });
    assert.deepEqual(report.closedWorldConfig.resourceInventory, ["agent-setup-contract.json", "launcher.mjs", "lib/helper.mjs"]);
  }, 60_000);
});
