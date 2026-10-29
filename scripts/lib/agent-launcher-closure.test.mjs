import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  productAgentLauncherModuleClosure,
  productAgentRuntimeInventory,
  productAgentRuntimeResources,
} from "./agent-launcher-closure.mjs";

const APP_ROOT = resolve(import.meta.dirname, "../..");
const owned = [];

afterEach(async () => {
  for (const root of owned.splice(0)) await rm(root, { recursive: true, force: true });
});

async function sourceTree(files) {
  const testRoot = resolve(APP_ROOT, ".rd/tmp");
  await mkdir(testRoot, { recursive: true });
  const root = await mkdtemp(resolve(testRoot, "editkin-launcher-closure-"));
  owned.push(root);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(resolve(root, path)), { recursive: true });
    await writeFile(resolve(root, path), text);
  }
  return root;
}

describe("product Agent launcher module closure", () => {
  it("follows the launcher's real imports", () => {
    expect(productAgentLauncherModuleClosure(APP_ROOT)).toEqual([
      { source: "scripts/editkin-product-mcp-launcher.mjs", destination: "launcher.mjs" },
      { source: "scripts/lib/regular-file.mjs", destination: "lib/regular-file.mjs" },
    ]);
    expect(productAgentRuntimeInventory(APP_ROOT)).toEqual(["agent-setup-contract.json", "launcher.mjs", "lib/regular-file.mjs"]);
  });

  it("is transitive and covers re-exports and literal dynamic imports", async () => {
    const root = await sourceTree({
      "scripts/editkin-product-mcp-launcher.mjs": 'import { a } from "./lib/a.mjs";\nimport "node:fs";\nconst late = () => import("./late.mjs");\nconst dynamic = (url) => import(url);\nexport { a, late, dynamic };\n',
      "scripts/lib/a.mjs": 'export * from "./nested/b.mjs";\nexport const a = 1;\n',
      "scripts/lib/nested/b.mjs": 'import { c } from "../c.mjs";\nexport const b = c;\n',
      "scripts/lib/c.mjs": "export const c = 1;\n",
      "scripts/late.mjs": "export default 1;\n",
    });
    expect(productAgentRuntimeResources(root).map(({ destination }) => destination)).toEqual([
      "agent-setup-contract.json", "late.mjs", "launcher.mjs", "lib/a.mjs", "lib/c.mjs", "lib/nested/b.mjs",
    ]);
  });

  it("rejects imports that cannot be delivered next to the launcher", async () => {
    const cases = [
      ['import x from "some-package";\n', /only node: builtins and relative \.mjs modules/],
      ['import "fs";\n', /only node: builtins and relative \.mjs modules/],
      ['import data from "./data.json" with { type: "json" };\n', /non-\.mjs/],
      ['import "../outside.mjs";\n', /escapes scripts\//],
      ['import "./lib/missing.mjs";\n', /does not exist/],
      ['import "./lib/Helper.mjs";\n', /on-disk spelling|does not exist/],
    ];
    for (const [launcher, error] of cases) {
      const root = await sourceTree({
        "scripts/editkin-product-mcp-launcher.mjs": launcher,
        "scripts/lib/helper.mjs": "export {};\n",
        "outside.mjs": "export {};\n",
        "scripts/data.json": "{}\n",
      });
      expect(() => productAgentLauncherModuleClosure(root), launcher).toThrow(error);
    }
  });
});
