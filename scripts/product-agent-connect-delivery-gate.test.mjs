import { strict as assert } from "node:assert";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, it } from "vitest";
import {
  inspectExtractedProductAgentConnect,
  PRODUCT_AGENT_CONNECT_DELIVERY_SCHEMA,
} from "./product-agent-connect-delivery-gate.mjs";

const APP_ROOT = resolve(import.meta.dirname, "..");
const owned = [];

async function fixture() {
  const testRoot = resolve(APP_ROOT, ".rd/tmp");
  await mkdir(testRoot, { recursive: true });
  const root = await mkdtemp(resolve(testRoot, "editkin-agent-delivery-test-"));
  owned.push(root);
  const resources = resolve(root, "agent-runtime-v3");
  await mkdir(resources);
  await copyFile(resolve(APP_ROOT, "scripts/editkin-product-mcp-launcher.mjs"), resolve(resources, "launcher.mjs"));
  await copyFile(resolve(APP_ROOT, "src/shared/agentSetupContract.json"), resolve(resources, "agent-setup-contract.json"));
  const installerPath = resolve(root, "Editkin_fixture_x64-setup.exe");
  await writeFile(installerPath, "fixture installer\n");
  return { root, resources, installerPath };
}

afterEach(async () => {
  for (const root of owned.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("product Agent Connect delivered-resource evidence", () => {
  it("reports exact delivered launcher bytes and closed-world config", async () => {
    const item = await fixture();
    const report = await inspectExtractedProductAgentConnect({
      extractedRoot: item.root,
      installerPath: item.installerPath,
    });
    assert.equal(report.schema, PRODUCT_AGENT_CONNECT_DELIVERY_SCHEMA);
    assert.equal(report.status, "GREEN");
    assert.deepEqual(Object.keys(report).sort(), [
      "closedWorldConfig", "embeddedContract", "extractedResourceRootSha256", "generatedAt",
      "installer", "launcher", "schema", "sourceIdentities", "status",
    ]);
    assert.deepEqual(report.closedWorldConfig.resourceInventory, ["agent-setup-contract.json", "launcher.mjs"]);
    assert.equal(report.closedWorldConfig.directMcpEntrypointAllowed, false);
    assert.equal(report.closedWorldConfig.launcherArgs.length, 0);
  });

  it("rejects an extra delivered file and stale launcher bytes", async () => {
    const extra = await fixture();
    await writeFile(resolve(extra.resources, "mcp.mjs"), "retired direct entrypoint\n");
    await assert.rejects(
      inspectExtractedProductAgentConnect({ extractedRoot: extra.root, installerPath: extra.installerPath }),
      /inventory is not closed-world/,
    );
    const stale = await fixture();
    await writeFile(resolve(stale.resources, "launcher.mjs"), "// stale\n");
    await assert.rejects(
      inspectExtractedProductAgentConnect({ extractedRoot: stale.root, installerPath: stale.installerPath }),
      /stale relative to current source bytes/,
    );
  });
});
