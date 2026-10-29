import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createMaterialCacheStagingDirectoryV1 } from "./materialCacheStagingDirectoryV1";

const roots: string[] = [];
const materialId = "7e".repeat(32);
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "editkin-material-staging-"));
  roots.push(root);
  return root;
}

it.each(["ordinary", "long"])("publishes unique ordinary paths from a real %s cache parent", async kind => {
  const root = await fixture();
  let parent = root;
  if (kind === "long") {
    while (join(parent, `.pending-${materialId}-`).length <= 300) parent = join(parent, "nested-material-cache");
    await mkdir(parent, { recursive: true });
    expect(join(parent, `.pending-${materialId}-`).length).toBeGreaterThan(300);
  }
  const [first, second] = await Promise.all([
    createMaterialCacheStagingDirectoryV1(parent, materialId),
    createMaterialCacheStagingDirectoryV1(parent, materialId),
  ]);
  expect(first).not.toBe(second);
  for (const path of [first, second]) {
    expect(dirname(resolve(path))).toBe(resolve(parent));
    expect(path.startsWith("\\\\?\\")).toBe(false);
    expect(basename(path)).toMatch(new RegExp(`^\\.pending-${materialId}-[a-zA-Z0-9]{6}$`));
  }
  const bytes = Buffer.from("material cache integrity \u0000\u0001\u00ff");
  await writeFile(join(first, "manifest.json"), bytes);
  const published = join(parent, materialId);
  await rename(first, published);
  expect(await readFile(join(published, "manifest.json"))).toEqual(bytes);
  expect((await readdir(parent)).sort()).toEqual([basename(second), materialId].sort());
});

it("preserves ENOENT when the parent is absent", async () => {
  const root = await fixture();
  await expect(createMaterialCacheStagingDirectoryV1(join(root, "absent"), materialId)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readdir(root)).toEqual([]);
});

it.each(["../outside", "a".repeat(63), "G".repeat(64)])("rejects malformed cache identities before creating anything (%s)", async invalid => {
  const root = await fixture();
  await expect(createMaterialCacheStagingDirectoryV1(root, invalid)).rejects.toThrow("invalid-material-staging-id");
  expect(await readdir(root)).toEqual([]);
});
