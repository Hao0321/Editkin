const assert = require("node:assert/strict");
const path = require("node:path");
const { setImmediate: tick } = require("node:timers/promises");
require("tsx/cjs");
const { createModuleLazyLoaderV2 } = require("../src/modules/moduleLazyLoaderV2");
const { createModuleMetadataRegistryV2 } = require("../src/modules/moduleMetadataRuntimeV2");
const { moduleMetadataV2 } = require("../src/modules/moduleMetadataV2.generated");
const { renderModuleMetadataV2, renderModuleMetadataDataV3, checkModuleMetadataV2 } = require("./refresh-module-metadata-v2.cjs");

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function runModuleLoadingControlsV2() {
  const passed = [];
  async function check(name, action) { await action(); passed.push(name); }
  const adapter = { prepare: async () => ({ commands: [] }) };
  await check("32 concurrent callers share one load and the warm adapter", async () => {
    let starts = 0; const pending = deferred();
    const load = createModuleLazyLoaderV2({ one: () => { starts++; return pending.promise; } });
    const calls = Array.from({ length: 32 }, () => load("one"));
    await tick(); assert.equal(starts, 1); pending.resolve(adapter);
    for (const result of await Promise.all(calls)) assert.strictEqual(result, adapter);
    assert.strictEqual(await load("one"), adapter); assert.equal(starts, 1);
  });
  await check("different capabilities load independently", async () => {
    let first = 0, second = 0; const a = deferred(), b = deferred();
    const load = createModuleLazyLoaderV2({ a: () => { first++; return a.promise; }, b: () => { second++; return b.promise; } });
    const p = load("a"), q = load("b"); await tick();
    b.resolve(adapter); assert.strictEqual(await q, adapter); assert.equal(first, 1); assert.equal(second, 1);
    a.resolve(adapter); assert.strictEqual(await p, adapter);
  });
  await check("pre-aborted request never starts an import", async () => {
    let starts = 0; const stop = new AbortController(), reason = Error("already cancelled"); stop.abort(reason);
    const load = createModuleLazyLoaderV2({ one: async () => { starts++; return adapter; } });
    await assert.rejects(load("one", stop.signal), error => error === reason); assert.equal(starts, 0);
    assert.strictEqual(await load("one"), adapter); assert.equal(starts, 1);
  });
  await check("in-flight cancellation is per waiter and listeners are released", async () => {
    let starts = 0, listeners = 0; const pending = deferred(), stop = new AbortController(), reason = Error("cancel one waiter");
    const add = stop.signal.addEventListener.bind(stop.signal), remove = stop.signal.removeEventListener.bind(stop.signal);
    stop.signal.addEventListener = (...args) => { listeners++; return add(...args); };
    stop.signal.removeEventListener = (...args) => { listeners--; return remove(...args); };
    const load = createModuleLazyLoaderV2({ one: () => { starts++; return pending.promise; } });
    const rejected = assert.rejects(load("one", stop.signal), error => error === reason), survivor = load("one");
    await tick(); stop.abort(reason); await rejected; assert.equal(listeners, 0);
    pending.resolve(adapter); assert.strictEqual(await survivor, adapter); assert.equal(starts, 1);
    // Resolution of the shared promise must not remove an already-removed listener twice.
    await tick(); assert.equal(listeners, 0);
  });
  await check("all cancelled waiters leave a reusable successful shared import", async () => {
    let starts = 0; const pending = deferred(), stop = new AbortController();
    const load = createModuleLazyLoaderV2({ one: () => { starts++; return pending.promise; } });
    const rejected = assert.rejects(load("one", stop.signal)); await tick(); stop.abort(); await rejected;
    pending.resolve(adapter); assert.strictEqual(await load("one"), adapter); assert.equal(starts, 1);
  });
  await check("rejection and synchronous throw are retryable without duplicate starts", async () => {
    for (const sync of [false, true]) {
      let starts = 0; const reason = Error("transient import failure");
      const load = createModuleLazyLoaderV2({ one: () => { starts++; if (starts === 1) { if (sync) throw reason; return Promise.reject(reason); } return Promise.resolve(adapter); } });
      const both = await Promise.allSettled([load("one"), load("one")]);
      assert.deepEqual(both.map(result => result.status), ["rejected", "rejected"]); assert.equal(starts, 1);
      assert.strictEqual(await load("one"), adapter); assert.equal(starts, 2);
    }
  });
  await check("invalid adapter is rejected and does not poison retries", async () => {
    let starts = 0; const load = createModuleLazyLoaderV2({ one: async () => ++starts === 1 ? {} : adapter });
    await assert.rejects(load("one"), /MODULE_ADAPTER_INVALID/); assert.strictEqual(await load("one"), adapter); assert.equal(starts, 2);
  });
  await check("inherited names and path-like input cannot select an adapter", async () => {
    let starts = 0; const table = Object.create({ inherited: () => { starts++; return Promise.resolve(adapter); } });
    table.safe = async () => { starts++; return adapter; }; const load = createModuleLazyLoaderV2(table);
    for (const id of ["inherited", "constructor", "__proto__", "../moduleCatalog", "file:///adapter.ts", "unknown"]) await assert.rejects(load(id), /MODULE_ADAPTER_UNAVAILABLE/);
    assert.equal(starts, 0); assert.strictEqual(await load("safe"), adapter); assert.equal(starts, 1);
  });
  await check("metadata positive control is frozen and retains identity and 303 variants", async () => {
    const registry = createModuleMetadataRegistryV2(moduleMetadataV2);
    assert.deepEqual(registry.identity, moduleMetadataV2.identity); assert.equal(registry.manifests.length, 31); assert.equal(registry.identity.variantCount, 303);
    assert(Object.isFrozen(registry.manifests[0].variants)); assert(Object.isFrozen(registry.get(registry.manifests[0].id)));
  });
  await check("metadata rejects changed order, identity, status, certification text, schema and duplicate ids", async () => {
    const mutations = [
      value => value.manifests.reverse(), value => value.identity.sha256 = "0".repeat(64),
      value => value.manifests[0].status = "withdrawn", value => value.manifests[0].variants[0].use = "unreviewed certification",
      value => value.manifests[0].schema = "editkin.module/invalid", value => value.manifests.push(value.manifests[0]),
      value => value.manifests[0].kind = "plugin",
    ];
    for (const mutate of mutations) { const value = structuredClone(moduleMetadataV2); mutate(value); assert.throws(() => createModuleMetadataRegistryV2(value), /MODULE_METADATA_/); }
  });
  await check("freshness evaluator accepts exact bytes and rejects metadata/source drift", async () => {
    const text = renderModuleMetadataV2(moduleMetadataV2.manifests), data = renderModuleMetadataDataV3(moduleMetadataV2.manifests), expected = { text, data, binding: '{"sources": "bound"}' };
    assert(checkModuleMetadataV2(expected, { ...expected }));
    assert.throws(() => checkModuleMetadataV2(expected, { ...expected, data: undefined }), /MODULE_METADATA_STALE/);
    assert.throws(() => checkModuleMetadataV2(expected, { ...expected, data: data + " " }), /MODULE_METADATA_STALE/);
    const changed = structuredClone(moduleMetadataV2.manifests); changed[0].name += " changed";
    assert.throws(() => checkModuleMetadataV2(expected, { ...expected, text: renderModuleMetadataV2(changed) }), /MODULE_METADATA_STALE/);
    assert.throws(() => checkModuleMetadataV2(expected, { ...expected, binding: '{"sources": "changed"}' }), /MODULE_METADATA_STALE/);
  });
  return { status: "PASS", count: passed.length, passed };
}
if (require.main === module) runModuleLoadingControlsV2().then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { runModuleLoadingControlsV2 };
