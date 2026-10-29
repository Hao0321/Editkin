import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { useTempRoots } from "../test/tempRoot.mjs";
import { hashMaterialSource, materialSourceHashSnapshot } from "./materialEvidenceCache";
const temp = useTempRoots();
it("hashes real ordinary/empty files exactly and closes all owned handles", async () => {
  const root = await temp.create("hash-"), path = join(root, "source");
  for (const data of [Buffer.alloc(0), Buffer.from("ordinary source"), Buffer.alloc(131073, 19)]) {
    await writeFile(path, data);
    expect(await hashMaterialSource(path)).toBe(createHash("sha256").update(data).digest("hex"));
  }
  expect(materialSourceHashSnapshot()).toMatchObject({ callers: 0, activeIO: 0, openHandles: 0, reservedHandles: 0, bufferBytes: 0 });
});
it("does not warm-hit a prior source digest after an ordinary sequential rewrite", async () => {
  const root = await temp.create("hash-"), path = join(root, "source");
  await writeFile(path, "first"); const a = await hashMaterialSource(path);
  await writeFile(path, "other"); const b = await hashMaterialSource(path);
  expect(a).not.toBe(b); expect(b).toBe(createHash("sha256").update("other").digest("hex"));
});
it("an already aborted caller performs no file metadata/read/open work", async () => {
  const before = materialSourceHashSnapshot(), abort = new AbortController(); abort.abort();
  await expect(hashMaterialSource("not-opened", { signal: abort.signal })).rejects.toMatchObject({ name: "AbortError" });
  expect(materialSourceHashSnapshot()).toEqual(before);
});
