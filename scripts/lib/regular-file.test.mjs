import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileIdentity, readRegularFile } from "./regular-file.mjs";

async function withTempDir(run) {
  const root = await mkdtemp(join(tmpdir(), "editkin-regular-file-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("reads a regular file and reports the size and hash of the same bytes", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "input.bin");
    const payload = Buffer.from([0, 1, 2, 250, 251, 252]);
    await writeFile(path, payload);
    assert.deepEqual(await readRegularFile(path), payload);
    assert.deepEqual(await fileIdentity(path), { bytes: payload.length, sha256: createHash("sha256").update(payload).digest("hex") });
  });
});

test("reads an empty file", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "empty");
    await writeFile(path, "");
    assert.equal((await readRegularFile(path)).length, 0);
  });
});

test("rejects a directory", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "folder");
    await mkdir(path);
    await assert.rejects(readRegularFile(path));
  });
});

test("rejects a symlink where the platform can refuse to follow one", { skip: process.platform === "win32" }, async () => {
  await withTempDir(async (root) => {
    const target = join(root, "target");
    const link = join(root, "link");
    await writeFile(target, "secret");
    await symlink(target, link);
    await assert.rejects(readRegularFile(link));
  });
});

test("reports a missing file with ENOENT so callers can treat it as absent", async () => {
  await withTempDir(async (root) => {
    await assert.rejects(readRegularFile(join(root, "missing")), { code: "ENOENT" });
  });
});
