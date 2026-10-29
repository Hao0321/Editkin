import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { productModuleSpecifiers } from "./product-module-specifiers.mjs";

test("imports, reexports, require and dynamic import retain actual local edges", () => {
  const code = `import "./side.css"; import value from "./value.js";
    export { other } from "./other.js"; export * from "./all.js";
    const cjs = require("./common.cjs"); const lazy = import("./lazy.mjs");`;
  assert.deepEqual(productModuleSpecifiers(code, "entry.mjs"),
    ["./side.css", "./value.js", "./other.js", "./all.js", "./common.cjs", "./lazy.mjs"]);
});
test("actual metadata formatter has no phantom generated-facade edges", async () => {
  const code = await readFile(new URL("./module-metadata-format-v3.cjs", import.meta.url), "utf8");
  assert.deepEqual(productModuleSpecifiers(code, "module-metadata-format-v3.cjs"), ["node:crypto"]);
});
test("single, double and template literals containing source code create no edge", () => {
  const code = `const a = 'import data from "./phantom.json";';
    const b = "export * from './phantom-export.js';";
    const c = \`require("./phantom-require.cjs")\`;`;
  assert.deepEqual(productModuleSpecifiers(code, "generator.cjs"), []);
});
test("real import inside a template interpolation remains reachable", () => {
  assert.deepEqual(productModuleSpecifiers('const code = `text ${require("./real.cjs")} import "./fake.js"`;', "entry.cjs"), ["./real.cjs"]);
});
test("comments, regex literals and ordinary require properties create no edge", () => {
  const code = String.raw`// import "./comment.js";
    /* require("./block.cjs") */
    const expression = /import "\.\/regex.js"/;
    object.require("./property.cjs");`;
  assert.deepEqual(productModuleSpecifiers(code, "entry.js"), []);
});
test("TypeScript import types and import-equals retain their existing type edges", () => {
  const code = `import type { Value } from "./types";
    import helper = require("./helper.cjs"); type Lazy = import("./lazy-types").Value;`;
  assert.deepEqual(productModuleSpecifiers(code, "entry.ts"), ["./types", "./helper.cjs", "./lazy-types"]);
});
test("JSX source text is excluded and a real JSX expression import is included", () => {
  const code = 'export const view = <span>import "./text.js"{import("./real.js")}</span>;';
  assert.deepEqual(productModuleSpecifiers(code, "view.tsx"), ["./real.js"]);
});
test("escaped and static template specifiers are decoded as module paths", () => {
  assert.deepEqual(productModuleSpecifiers('const a = require(".\\u002freal.cjs"); const b = import(`./other.js`);', "entry.cjs"), ["./real.cjs", "./other.js"]);
});
test("malformed module syntax refuses identity collection rather than dropping edges", () => {
  assert.throws(() => productModuleSpecifiers('import { value from "./broken.js";', "broken.ts"), /Unable to parse product dependency syntax in broken.ts/);
});
