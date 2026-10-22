const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { createRequire, registerHooks, _extensions } = require("node:module");
const { fileURLToPath, pathToFileURL } = require("node:url");
const { createModuleMetadataGeneratorV3 } = require("../refresh-module-metadata-v2.cjs");
const { createModuleMetadataSyncReaderV3, MODULE_METADATA_MAX_INPUT_BYTES_V3: MAX } = require("./module-metadata-sync-read-v3.cjs");
const { withModuleMetadataSourcesV3 } = require("./module-metadata-source-loader-v3.cjs");
const { MODULE_METADATA_TOOL_SOURCES_V3: TOOLS, MODULE_METADATA_JSON_SOURCES_V3: JSONS, moduleMetadataSourcePathV3: at } = require("./module-metadata-input-contract-v3.cjs");

const { checkedTempParent, createOwnedTestRoot, selectedTestGroups } = require("../test/module-test-temp.cjs");
const product = path.resolve(__dirname, "../..");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const padded = length => '{"marker":"fixture"}' + " ".repeat(length - 20);
const include = selectedTestGroups(["normal", "require", "hash", "isolation", "semantics"]);
process.env.TSX_DISABLE_CACHE = "1";
process.env.ESBUILD_WORKER_THREADS = "0";
process.env.TMPDIR = process.env.TEMP;

function fixture(t, bom = false) {
  const workspace = createOwnedTestRoot(t, "source-loader-");
  const root = path.join(workspace, "apps/editor");
  const write = (name, content) => { const file = at(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };
  for (const name of TOOLS.filter(name => name.startsWith("scripts/"))) write(name, fs.readFileSync(path.join(product, name)));
  for (const name of JSONS) write(name, (bom ? "\uFEFF" : "") + '{"marker":"fixture"}');
  write("src/modules/moduleTypes.ts", `import probe from "../creative/editkinAestheticStandard.json";
if(probe.marker!=="fixture")throw Error("BAD_SOURCE_DATA");
globalThis.__metadataFixtureLoads=(globalThis.__metadataFixtureLoads||0)+1;
export const EDITKIN_MODULE_REGISTRY_SCHEMA="editkin.module-registry/v2",EDITKIN_MODULE_SCHEMA="editkin.module/v1",EDITKIN_MODULE_INDEX_SCHEMA="editkin.module-index/v2";
export const MODULE_KINDS=["effect"],MODULE_STATUSES=["available"],MODULE_FORMATS=["video"];`);
  write("src/shared/canonicalJson.ts", `export const canonicalJson=(value:any):string=>JSON.stringify(value,(_,entry)=>entry&&typeof entry==="object"&&!Array.isArray(entry)?Object.fromEntries(Object.keys(entry).sort().map(key=>[key,entry[key]])):entry);`);
  const imports = JSONS.map((name, index) => {
    const relative = path.relative(path.join(root, "src/modules"), at(root, name)).split(path.sep).join("/");
    return `import j${index} from ${JSON.stringify(relative.startsWith(".") ? relative : "./" + relative)};`;
  }).join("\n");
  write("src/modules/moduleManifestCatalogSourceV2.ts", `${imports}
globalThis.__metadataFixtureLoads=(globalThis.__metadataFixtureLoads||0)+1;
if([${JSONS.map((_, index) => `j${index}`).join(",")}].some(value=>value.marker!=="fixture"))throw Error("BAD_CATALOG_DATA");
export const moduleManifestCatalogSourceV2=()=>[{manifest:{id:"fixture",name:"Fixture",variants:[{id:"normal"}]}}];`);
  globalThis.__metadataFixtureLoads = 0;
  return { root, write, target: at(root, JSONS[0]), catalogTarget: at(root, JSONS[3]) };
}

function measuredReader(target, mutate = {}) {
  const descriptors = new Map(), events = [];
  let changed = false;
  const io = { ...fs,
    openSync(file, flags) {
      if (file === target && mutate.beforeOpen && !changed) { changed = true; mutate.beforeOpen(file); events.push({ phase: "mutate-before-open" }); }
      const fd = fs.openSync(file, flags); descriptors.set(fd, file);
      if (file === target) events.push({ phase: "open" });
      return fd;
    },
    fstatSync(fd, options) {
      const snapshot = fs.fstatSync(fd, options);
      if (descriptors.get(fd) === target) {
        events.push({ phase: "handle-stat", size: Number(snapshot.size) });
        if (mutate.afterStat && !changed) { changed = true; mutate.afterStat(target); events.push({ phase: "mutate-after-stat" }); }
      }
      return snapshot;
    },
    readSync(fd, buffer, offset, length, position) {
      const count = fs.readSync(fd, buffer, offset, length, position);
      if (descriptors.get(fd) === target) events.push({ phase: "read", bytes: count, requested: length, allocation: buffer.byteLength });
      return count;
    },
    closeSync(fd) { if (descriptors.get(fd) === target) events.push({ phase: "close" }); descriptors.delete(fd); fs.closeSync(fd); },
  };
  return { reader: createModuleMetadataSyncReaderV3(io), events };
}
function assertTrace(events, expectedReadBytes) {
  const reads = events.filter(event => event.phase === "read");
  assert.equal(reads.reduce((sum, event) => sum + event.bytes, 0), expectedReadBytes);
  assert(reads.every(event => event.requested <= 65536 && event.allocation === MAX + 1));
  assert.equal(events.filter(event => event.phase === "open").length, events.filter(event => event.phase === "close").length);
}
function record(kind, events) {
  console.log(JSON.stringify({ kind, events, sourceRuntimeBodies: globalThis.__metadataFixtureLoads, liveCatalog: false }));
}

if (include("normal")) {
  for (const bom of [false, true]) test(`actual generator factory loads tiny tsx types/catalog and all six ${bom ? "BOM" : "plain"} JSON inputs`, t => {
    const input = fixture(t, bom), extension = _extensions[".json"];
    const output = createModuleMetadataGeneratorV3(input.root).buildModuleMetadataV2();
    assert.equal(globalThis.__metadataFixtureLoads, 2); assert.equal(output.manifestCount, 1);
    const binding = JSON.parse(output.binding); assert.equal(binding.sources.filter(row => row.file.endsWith(".json")).length, 6);
    for (const row of binding.sources) assert.equal(row.sha256, sha(fs.readFileSync(at(input.root, row.file))));
    assert.equal(_extensions[".json"], extension);
    input.write("src/modules/moduleMetadataV2.generated.ts", output.text); input.write("src/modules/moduleMetadataV2.data.json", output.data);
    input.write("scripts/module-metadata-v2.sources.json", output.binding);
    const generator = createModuleMetadataGeneratorV3(input.root);
    generator.checkModuleMetadataV2(output, generator.readGeneratedModuleMetadataV3());
    assert.deepEqual(generator.buildModuleMetadataV2(), output);
    record(bom ? "normal-bom" : "normal", []);
  });
  test("extensionless CJS resolves the generated typed facade with a distinct data basename", t => {
    const input = fixture(t), output = createModuleMetadataGeneratorV3(input.root).buildModuleMetadataV2();
    input.write("src/modules/moduleMetadataV2.generated.ts", output.text);
    input.write("src/modules/moduleMetadataV2.data.json", output.data);
    const local = createRequire(path.join(input.root, "scripts/source.cjs"));
    const name = "../src/modules/moduleMetadataV2.generated";
    assert.equal(local.resolve(name), at(input.root, "src/modules/moduleMetadataV2.generated.ts"));
    const actual = local(name), expected = JSON.parse(output.data);
    assert.deepEqual(actual.moduleMetadataV2, expected.metadata);
    assert.deepEqual(actual.moduleMetadataConstantsV2, expected.constants);
  });
  test("known-bad same-basename JSON reproduces the extensionless CJS shadowing", t => {
    const input = fixture(t), output = createModuleMetadataGeneratorV3(input.root).buildModuleMetadataV2();
    input.write("src/modules/moduleMetadataV2.generated.ts", output.text);
    input.write("src/modules/moduleMetadataV2.data.json", output.data);
    input.write("src/modules/moduleMetadataV2.generated.json", output.data);
    const local = createRequire(path.join(input.root, "scripts/source.cjs"));
    const name = "../src/modules/moduleMetadataV2.generated";
    assert.equal(local.resolve(name), at(input.root, "src/modules/moduleMetadataV2.generated.json"));
    assert.equal(local(name).moduleMetadataV2, undefined);
    assert.equal(local(name).schema, "editkin.module-metadata-data/v3");
  });
  test("cache-hit JSON is still admitted before the next actual generator call", t => {
    const input = fixture(t), generator = createModuleMetadataGeneratorV3(input.root);
    generator.buildModuleMetadataV2(); fs.writeFileSync(input.target, padded(MAX + 1));
    assert.throws(() => generator.buildModuleMetadataV2(), /INPUT_BUDGET/u);
    assert.equal(globalThis.__metadataFixtureLoads, 2);
  });
  test("render-only compatibility helpers do not require unused catalog JSON", t => {
    const input = fixture(t), file = at(input.root, "src/modules/moduleTypes.ts");
    const text = fs.readFileSync(file, "utf8").split("\n").slice(2).join("\n"); fs.writeFileSync(file, text);
    for (const name of JSONS) fs.renameSync(at(input.root, name), at(input.root, name) + ".kept");
    const generator = createModuleMetadataGeneratorV3(input.root), manifests = [{ id: "render-only", variants: [{ id: "plain" }] }];
    const result = JSON.parse(generator.renderModuleMetadataDataV3(manifests));
    assert.deepEqual(result.metadata.manifests, manifests);
    assert(generator.renderModuleMetadataV2(manifests).includes("moduleMetadataV2.data.json"));
  });
}

if (include("require")) {
  test("render-only sourceRuntime still admits JSON it actually imports", t => {
    const input = fixture(t); fs.writeFileSync(input.target, padded(MAX + 1));
    const { reader, events } = measuredReader(input.target);
    assert.throws(() => createModuleMetadataGeneratorV3(input.root, { reader }).renderModuleMetadataV2([]), /INPUT_BUDGET/u);
    assertTrace(events, 0); assert.equal(globalThis.__metadataFixtureLoads, 0);
  });
  test("overcap declared JSON is rejected before sourceRuntime begins", t => {
    const input = fixture(t); fs.writeFileSync(input.target, padded(MAX + 1));
    const { reader, events } = measuredReader(input.target);
    assert.throws(() => createModuleMetadataGeneratorV3(input.root, { reader }).buildModuleMetadataV2(), /INPUT_BUDGET/u);
    assertTrace(events, 0); assert.equal(globalThis.__metadataFixtureLoads, 0); record("initial-overcap", events);
  });
  for (const phase of ["types", "catalog"]) {
    for (const kind of ["grow", "replace"]) test(`actual ${phase} JSON ${kind} between admission and open rejects before content read`, t => {
      const input = fixture(t), target = phase === "types" ? input.target : input.catalogTarget;
      const beforeOpen = file => {
        if (kind === "grow") fs.writeFileSync(file, padded(MAX + 1));
        else { fs.renameSync(file, file + ".kept"); fs.writeFileSync(file, '{"marker":"fixture"}'); }
      };
      const { reader, events } = measuredReader(target, { beforeOpen });
      assert.throws(() => createModuleMetadataGeneratorV3(input.root, { reader }).buildModuleMetadataV2(), /INPUT_BUDGET|INPUT_CHANGED/u);
      assertTrace(events, 0); assert.equal(globalThis.__metadataFixtureLoads, phase === "types" ? 0 : 1);
      record(`require-${phase}-${kind}`, events);
    });
  }
  test("actual JSON loader same-handle growth stops at sentinel before JSON parse", t => {
    const input = fixture(t), { reader, events } = measuredReader(input.target, { afterStat: file => fs.writeFileSync(file, padded(MAX + 1)) });
    assert.throws(() => createModuleMetadataGeneratorV3(input.root, { reader }).buildModuleMetadataV2(), /INPUT_BUDGET/u);
    assertTrace(events, MAX + 1); assert.equal(globalThis.__metadataFixtureLoads, 0); record("require-sentinel", events);
  });
}

if (include("hash")) {
  for (const kind of ["overcap", "grow", "replace", "sentinel"]) test(`actual post-require generator hashing ${kind} is bounded`, t => {
    const input = fixture(t), target = at(input.root, "scripts/refresh-module-metadata-v2.cjs");
    if (kind === "overcap") fs.writeFileSync(target, padded(MAX + 1));
    const mutation = kind === "grow" ? { beforeOpen: file => fs.writeFileSync(file, padded(MAX + 1)) }
      : kind === "replace" ? { beforeOpen: file => { fs.renameSync(file, file + ".kept"); fs.writeFileSync(file, "changed"); } }
      : kind === "sentinel" ? { afterStat: file => fs.writeFileSync(file, padded(MAX + 1)) } : {};
    const { reader, events } = measuredReader(target, mutation);
    assert.throws(() => createModuleMetadataGeneratorV3(input.root, { reader }).buildModuleMetadataV2(), /INPUT_BUDGET|INPUT_CHANGED/u);
    assert.equal(globalThis.__metadataFixtureLoads, 2); assertTrace(events, kind === "sentinel" ? MAX + 1 : 0);
    record(`post-require-hash-${kind}`, events);
  });
  test("generated-file check rejects overcap JSON before content reading", t => {
    const input = fixture(t), target = at(input.root, "src/modules/moduleMetadataV2.data.json");
    input.write("src/modules/moduleMetadataV2.generated.ts", "facade"); fs.writeFileSync(target, padded(MAX + 1));
    const { reader, events } = measuredReader(target);
    assert.throws(() => createModuleMetadataGeneratorV3(input.root, { reader }).readGeneratedModuleMetadataV3(), /INPUT_BUDGET/u);
    assertTrace(events, 0); assert.equal(globalThis.__metadataFixtureLoads, 0);
  });
}

if (include("isolation")) {
  test("ordinary node_modules and undeclared JSON retain default overcap load behavior", t => {
    const input = fixture(t), plain = path.join(input.root, "src/unlisted.json"), dependency = path.join(input.root, "node_modules/plain-fixture/data.json");
    fs.mkdirSync(path.dirname(dependency), { recursive: true }); fs.writeFileSync(plain, padded(MAX + 1)); fs.writeFileSync(dependency, padded(MAX + 1));
    const local = createRequire(path.join(input.root, "scripts/source.cjs")), extension = _extensions[".json"];
    withModuleMetadataSourcesV3(input.root, () => {
      assert.equal(local(plain).marker, "fixture"); assert.equal(local(dependency).marker, "fixture");
      assert.equal(_extensions[".json"], extension);
    });
    assert.equal(_extensions[".json"], extension);
  });
  test("callback failure deregisters boundary and original default require remains usable", t => {
    const input = fixture(t), extension = _extensions[".json"];
    assert.throws(() => withModuleMetadataSourcesV3(input.root, () => { throw Error("fixture callback failure"); }), /callback failure/u);
    fs.writeFileSync(input.target, padded(MAX + 1));
    assert.equal(require(input.target).marker, "fixture"); assert.equal(_extensions[".json"], extension);
  });
  test("declared JSON redirected by an actual resolver hook rejects before alternate parsing", t => {
    const input = fixture(t), alternate = path.join(input.root, "alternate.json"); fs.writeFileSync(alternate, '{"marker":"alternate"}');
    const redirect = registerHooks({ resolve(specifier, context, next) {
      const result = next(specifier, context);
      return result.url === pathToFileURL(input.target).href ? { ...result, url: pathToFileURL(alternate).href } : result;
    } });
    try { assert.throws(() => createModuleMetadataGeneratorV3(input.root).buildModuleMetadataV2(), /JSON_RESOLUTION_CHANGED/u); }
    finally { redirect.deregister(); }
    assert.equal(globalThis.__metadataFixtureLoads, 0);
  });
  test("known-bad default tsx source load accepts the same controlled overcap JSON", t => {
    const input = fixture(t); fs.writeFileSync(input.target, padded(MAX + 1));
    require("tsx/cjs");
    const local = createRequire(path.join(input.root, "scripts/source.cjs"));
    assert.equal(local("../src/modules/moduleTypes").EDITKIN_MODULE_SCHEMA, "editkin.module/v1");
    assert.equal(globalThis.__metadataFixtureLoads, 1);
    console.log(JSON.stringify({ calibration: "default-tsx-accepts-overcap", encodedBytes: fs.statSync(input.target).size, candidateRejects: true }));
  });
}
if (include("semantics")) {
  for (const length of [0, 20, MAX]) test(`sync source reader and existing async collector reader preserve ${length} stable bytes`, async t => {
    const input = fixture(t), file = path.join(input.root, "stable.json"), expected = Buffer.alloc(length, 120);
    fs.writeFileSync(file, expected);
    const { readModuleMetadataFileV3 } = await import("./module-metadata-bounded-read-v3.mjs");
    assert.deepEqual(createModuleMetadataSyncReaderV3().read(file), expected);
    assert.deepEqual(await readModuleMetadataFileV3(file), expected);
  });
  test("partial synchronous growth reuses one fixed buffer and closes after sentinel", () => {
    const target = path.join(checkedTempParent(), "fake-source.json"), buffers = new Set();
    let readBytes = 0, closes = 0, stats = 0;
    const info = file => ({ dev: 1n, ino: 1n, mode: 1n, size: file ? 3n : 0n, mtimeNs: 1n, ctimeNs: 1n,
      isFile: () => file, isDirectory: () => !file, isSymbolicLink: () => false });
    const reader = createModuleMetadataSyncReaderV3({
      lstatSync: file => info(file === target), openSync: () => 1,
      fstatSync: () => { stats++; return info(true); },
      readSync: (fd, buffer, offset, length) => {
        assert(length <= 65536); assert.equal(buffer.byteLength, MAX + 1); buffers.add(buffer);
        const count = Math.min(32768, length); buffer.fill(120, offset, offset + count); readBytes += count; return count;
      },
      closeSync: () => { closes++; },
    });
    assert.throws(() => reader.read(target), /INPUT_BUDGET/u);
    assert.equal(buffers.size, 1); assert.equal(readBytes, MAX + 1); assert.equal(closes, 1); assert.equal(stats, 1);
  });
}
