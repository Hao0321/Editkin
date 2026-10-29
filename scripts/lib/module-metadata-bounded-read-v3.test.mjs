import assert from "node:assert/strict";
import test, { after } from "node:test";
import { appendFile, lstat, mkdir, open, rename, symlink, truncate, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { REPO_TMP, useTempRoots } from "../../src/test/tempRoot.mjs";
import { PRODUCT_REQUIRED_INPUT_PATHS, productInputExclusionReason } from "./build-input-identity.mjs";
import {
  MODULE_METADATA_MAX_INPUT_BYTES_V3 as MAX_BYTES,
  createModuleMetadataReaderV3,
  readModuleMetadataFileV3,
  readModuleMetadataHandleV3,
} from "./module-metadata-bounded-read-v3.mjs";

const temp = useTempRoots(after);
function info(size = 3, extra = {}) {
  return { dev: 1n, ino: 10n, mode: 33188n, size: BigInt(size), mtimeNs: 1n, ctimeNs: 1n,
    isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, ...extra };
}
function fakeHandle({ before = info(), afterStat = before, bytes = Buffer.from("abc"), fillForever = false, partial = false } = {}) {
  let offset = 0, stats = 0;
  const requests = [], buffers = new Set();
  return {
    requests, buffers, get stats() { return stats; },
    async stat(options) { assert.equal(options.bigint, true); return ++stats === 1 ? before : afterStat; },
    async readFile() { throw Error("UNBOUNDED_READ_CALIBRATION: rejected before an unbounded allocation"); },
    async read(buffer, start, length, position) {
      assert.equal(position, null); buffers.add(buffer);
      const count = fillForever ? (partial ? 1 : length) : Math.min(length, bytes.length - offset);
      requests.push({ start, length, count, allocation: buffer.byteLength });
      if (fillForever) buffer.fill(120, start, start + count);
      else bytes.copy(buffer, start, offset, offset + count);
      offset += count;
      return { bytesRead: count, buffer };
    },
  };
}

test("growth after an admitted stat stops at exactly max+1 bytes using one fixed buffer", async () => {
  const handle = fakeHandle({ fillForever: true });
  await assert.rejects(readModuleMetadataHandleV3(handle, info()), /beyond its budget/u);
  assert.equal(handle.requests.reduce((sum, row) => sum + row.count, 0), MAX_BYTES + 1);
  assert(handle.requests.every(row => row.length <= 65536 && row.allocation === MAX_BYTES + 1));
  assert.equal(handle.buffers.size, 1);
  assert.equal(handle.stats, 1);
});

test("partial one-byte growth reuses one buffer and cannot amplify allocations", async () => {
  const handle = fakeHandle({ fillForever: true, partial: true });
  await assert.rejects(readModuleMetadataHandleV3(handle, info(), 10), /beyond its budget/u);
  assert.equal(handle.requests.length, 11);
  assert.equal(handle.buffers.size, 1);
  assert(handle.requests.every(row => row.allocation === 11));
});

for (const kind of ["nonregular", "oversized", "negative-size", "open-identity", "short-read", "same-size-mutation", "size-change", "identity-change", "invalid-result"]) {
  test(`bounded handle rejects ${kind}`, async () => {
    const before = info(), options = {};
    if (kind === "nonregular") options.before = info(3, { isFile: () => false });
    if (kind === "oversized") options.before = info(MAX_BYTES + 1);
    if (kind === "negative-size") options.before = info(-1);
    if (kind === "open-identity") options.before = info(3, { ino: 11n });
    if (kind === "short-read") options.bytes = Buffer.from("ab");
    if (kind === "same-size-mutation") options.afterStat = info(3, { mtimeNs: 2n, ctimeNs: 2n });
    if (kind === "size-change") options.afterStat = info(4);
    if (kind === "identity-change") options.afterStat = info(3, { ino: 11n });
    const handle = fakeHandle(options);
    if (kind === "invalid-result") handle.read = async () => ({ bytesRead: -1 });
    await assert.rejects(readModuleMetadataHandleV3(handle, before));
    if (["nonregular", "oversized", "negative-size", "open-identity"].includes(kind)) assert.equal(handle.requests.length, 0);
  });
}

for (const limit of [-1, 0.5, NaN, MAX_BYTES + 1]) {
  test(`invalid handle budget ${String(limit)} is rejected before stat or allocation`, async () => {
    const handle = fakeHandle();
    await assert.rejects(readModuleMetadataHandleV3(handle, info(), limit), /Invalid.*budget/u);
    assert.equal(handle.stats, 0); assert.equal(handle.requests.length, 0);
  });
}

for (const kind of ["stable", "leaf-replaced", "ancestor-replaced", "leaf-link", "ancestor-link", "missing-after-read", "growth", "read-error"]) {
  test(`file reader ${kind} observes post-read path checks and closes its single handle`, async () => {
    const target = resolve(REPO_TMP, "fake-metadata-reader/source.ts"), parent = dirname(target);
    let changed = false, closes = 0, opens = 0;
    const handle = fakeHandle({ fillForever: kind === "growth" });
    const baseRead = handle.read.bind(handle);
    handle.read = async (...args) => {
      if (kind === "read-error") throw Error("injected read error");
      const result = await baseRead(...args); changed = true; return result;
    };
    handle.close = async () => { closes++; };
    const reader = createModuleMetadataReaderV3({
      open: async path => { assert.equal(path, target); opens++; return handle; },
      lstat: async (path, options) => {
        assert.equal(options.bigint, true);
        if (changed && kind === "missing-after-read" && path === target) throw Error("injected ENOENT");
        const leaf = path === target;
        const link = changed && ((kind === "leaf-link" && leaf) || (kind === "ancestor-link" && path === parent));
        const replaced = changed && ((kind === "leaf-replaced" && leaf) || (kind === "ancestor-replaced" && path === parent));
        return info(leaf ? 3 : 0, { ino: replaced ? 11n : 10n,
          isFile: () => leaf, isDirectory: () => !leaf, isSymbolicLink: () => link });
      },
    });
    if (kind === "stable") assert.equal((await reader(target)).toString(), "abc");
    else await assert.rejects(reader(target));
    assert.equal(opens, 1); assert.equal(closes, 1);
  });
}

for (const length of [0, 3, 65536, MAX_BYTES]) {
  test(`real regular file of ${length} bytes has exact stable output`, async () => {
    const root = await temp.create("metadata-read-owned-", { parent: REPO_TMP });
    const file = resolve(root, "source.json"), expected = Buffer.alloc(length, 120);
    await writeFile(file, expected);
    assert.deepEqual(await readModuleMetadataFileV3(file), expected);
  });
}

test("real overbudget file, directory and linked ancestry fail before returning content", async () => {
  const root = await temp.create("metadata-read-owned-", { parent: REPO_TMP });
  const folder = resolve(root, "plain"), file = resolve(folder, "source.ts"), link = resolve(root, "linked");
  await mkdir(folder); await writeFile(file, "abc");
  await symlink(folder, link, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(readModuleMetadataFileV3(resolve(link, "source.ts")), /rejects links/u);
  await assert.rejects(readModuleMetadataFileV3(folder), /bounded regular/u);
  await writeFile(file, Buffer.alloc(MAX_BYTES + 1));
  await assert.rejects(readModuleMetadataFileV3(file), /bounded regular/u);
});

test("bounded reader is a mandatory non-excluded product input without changing generated source binding", () => {
  const name = "scripts/lib/module-metadata-bounded-read-v3.mjs";
  assert(PRODUCT_REQUIRED_INPUT_PATHS.includes(name));
  assert.equal(productInputExclusionReason(name), undefined);
});

for (const kind of ["within-budget", "over-budget"]) {
  test(`real metadata source grows ${kind} after its admitted handle stat`, async () => {
    const root = await temp.create("metadata-read-owned-", { parent: REPO_TMP });
    const file = resolve(root, "scripts/module-metadata-v2.sources.json");
    await mkdir(dirname(file), { recursive: true }); await writeFile(file, "abc");
    const events = []; let stats = 0, closes = 0;
    const reader = createModuleMetadataReaderV3({ lstat, open: async (path, flags) => {
      const handle = await open(path, flags);
      return {
        async stat(options) {
          const snapshot = await handle.stat(options); stats++;
          events.push({ phase: "handle-stat", size: Number(snapshot.size) });
          if (stats === 1) {
            if (kind === "within-budget") await appendFile(file, "d");
            else await truncate(file, MAX_BYTES + 1);
            events.push({ phase: "grow-after-admission", size: kind === "within-budget" ? 4 : MAX_BYTES + 1 });
          }
          return snapshot;
        },
        async read(...args) {
          const result = await handle.read(...args);
          events.push({ phase: "bounded-read", requested: args[2], bytes: result.bytesRead }); return result;
        },
        async close() { closes++; events.push({ phase: "close" }); await handle.close(); },
      };
    } });
    let rejected;
    try { await reader(file); } catch (error) { rejected = error; }
    assert(rejected); assert.equal(closes, 1);
    const reads = events.filter(row => row.phase === "bounded-read");
    assert(reads.every(row => row.requested <= 65536));
    if (kind === "over-budget") {
      assert.match(rejected.message, /beyond its budget/u); assert.equal(stats, 1);
      assert.equal(reads.reduce((sum, row) => sum + row.bytes, 0), MAX_BYTES + 1);
    } else {
      assert.match(rejected.message, /changed while reading/u); assert.equal(stats, 2);
      assert.equal(reads.reduce((sum, row) => sum + row.bytes, 0), 4);
    }
    console.log(JSON.stringify({ realMetadataRace: kind, events, rejection: rejected.message }));
  });
}

test("real metadata leaf replacement after path admission rejects before its first read", async () => {
  const root = await temp.create("metadata-read-owned-", { parent: REPO_TMP });
  const folder = resolve(root, "src/modules"), file = resolve(folder, "moduleMetadataV2.data.json");
  await mkdir(folder, { recursive: true }); await writeFile(file, "abc");
  const events = []; let stats = 0, closes = 0, reads = 0;
  const reader = createModuleMetadataReaderV3({
    lstat: async (...args) => {
      const snapshot = await lstat(...args);
      if (args[0] === file) events.push({ phase: "path-admission-stat" });
      return snapshot;
    },
    open: async (path, flags) => {
      await rename(file, file + ".kept"); await writeFile(file, "abc");
      events.push({ phase: "replace-leaf-with-equal-content-before-open" });
      const handle = await open(path, flags);
      return {
        async stat(options) { stats++; events.push({ phase: "replacement-handle-stat" }); return handle.stat(options); },
        async read(...args) {
          reads++; return handle.read(...args);
        },
        async close() { closes++; events.push({ phase: "close" }); await handle.close(); },
      };
    },
  });
  let rejected;
  try { await reader(file); } catch (error) { rejected = error; }
  assert(rejected); assert.match(rejected.message, /changed before reading/u);
  assert.equal(stats, 1); assert.equal(closes, 1); assert.equal(reads, 0);
  assert(events.some(row => row.phase === "path-admission-stat"));
  console.log(JSON.stringify({ realMetadataRace: "leaf-replaced-before-open", events, rejection: rejected.message }));
});
