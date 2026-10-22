import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Reproduces the stream-v2 race deterministically: the owner deletes a staged entry right after the watch listed it.
const vanish = vi.hoisted(() => ({ names: new Set<string>() }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: async (path: string) => {
      const names = await actual.readdir(path);
      for (const name of names) if (vanish.names.has(name)) await actual.rm(join(path, name), { recursive: true, force: true });
      return names;
    },
  };
});

const { ownedStagingBytesV1 } = await import("./renderVolumeWatchV1");

const roots: string[] = [];
afterEach(async () => {
  vanish.names.clear();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function stagingRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rvw-"));
  roots.push(root);
  await writeFile(join(root, "kept.png"), Buffer.alloc(10));
  await writeFile(join(root, "consumed.png"), Buffer.alloc(20));
  await mkdir(join(root, "consumed-dir"));
  await writeFile(join(root, "consumed-dir", "inner.png"), Buffer.alloc(40));
  return root;
}

describe("owned staging walk under concurrent owner deletion", () => {
  it("skips entries the owner deleted after they were listed", async () => {
    const root = await stagingRoot();
    vanish.names.add("consumed.png").add("consumed-dir");
    await expect(ownedStagingBytesV1(root)).resolves.toBe(10);
  });

  it("still counts every entry when nothing vanishes", async () => {
    const root = await stagingRoot();
    await expect(ownedStagingBytesV1(root)).resolves.toBe(70);
  });

  it("still fails loudly when the work root itself is missing", async () => {
    const root = await stagingRoot();
    await expect(ownedStagingBytesV1(join(root, "missing"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
