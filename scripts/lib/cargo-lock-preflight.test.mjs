import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { assertProductCargoLocks, PRODUCT_CARGO_MANIFESTS } from "./cargo-lock-preflight.mjs";

const root = resolve("."), cargo = "pinned-cargo";
const success = { pid: 7, code: 0, closed: true, signal: null, timedOut: false, stdout: "package v1\n", stderr: "" };

test("checks all product locks offline without compiling or updating dependencies", async () => {
  const calls = [];
  const checked = await assertProductCargoLocks({ root, cargo, run: async (...args) => { calls.push(args); return success; } });
  assert.deepEqual(checked.map(item => item.manifest), PRODUCT_CARGO_MANIFESTS);
  for (const [index, [executable, args, options]] of calls.entries()) {
    assert.equal(executable, cargo);
    assert.deepEqual(args, ["tree", "--locked", "--offline", "--no-default-features", "--depth", "0", "--manifest-path", resolve(root, PRODUCT_CARGO_MANIFESTS[index])]);
    assert.deepEqual(options, { cwd: root, timeoutMs: 30_000 });
  }
});

test("a stale GPU consumer stops preflight and retains the actual child failure", async () => {
  let calls = 0;
  const failure = { ...success, pid: 8, code: 101, stderr: "lock file needs updating" };
  await assert.rejects(assertProductCargoLocks({ root, cargo, run: async () => {
    if (++calls === 2) throw Object.assign(new Error(failure.stderr), { result: failure });
    return success;
  } }), error => error.manifest === PRODUCT_CARGO_MANIFESTS[1] && error.result === failure);
  assert.equal(calls, 2);
});

for (const [name, delta] of Object.entries({
  nonzero: { code: 101 }, unclosed: { closed: false }, signal: { signal: "SIGTERM" },
  timeout: { timedOut: true }, empty: { stdout: "  " },
})) {
  test(`rejects ${name} child evidence without continuing`, async () => {
    let calls = 0;
    await assert.rejects(assertProductCargoLocks({ root, cargo, run: async () => { calls++; return { ...success, ...delta }; } }));
    assert.equal(calls, 1);
  });
}
