import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readBoundedFile, readBoundedFileSync } from "./boundedFile";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "editkin-bounded-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe.each([
  ["async", (path: string, max: number, options?: Parameters<typeof readBoundedFile>[2]) => readBoundedFile(path, max, options)],
  ["sync", async (path: string, max: number, options?: Parameters<typeof readBoundedFile>[2]) => readBoundedFileSync(path, max, options)],
])("%s bounded read", (_name, read) => {
  it("returns exactly the bytes of a file at the limit and rejects one byte more", async () => {
    const file = join(root, "data.bin");
    await writeFile(file, Buffer.from([1, 2, 3, 4]));
    expect([...await read(file, 4)]).toEqual([1, 2, 3, 4]);
    await expect(read(file, 3, { messages: { tooLarge: "too big" } })).rejects.toThrow("too big");
  });

  it("reads an empty file", async () => {
    const file = join(root, "empty");
    await writeFile(file, "");
    expect((await read(file, 0)).length).toBe(0);
  });

  it("rejects directories", async () => {
    const directory = join(root, "dir");
    await mkdir(directory);
    await expect(read(directory, 10, { messages: { notRegular: "not regular" } })).rejects.toThrow();
  });

  it("rejects a symlink unless following is explicitly requested", async () => {
    const target = join(root, "target.txt");
    const link = join(root, "link.txt");
    await writeFile(target, "secret");
    await symlink(target, link);
    await expect(read(link, 100, { messages: { notRegular: "no links" } })).rejects.toThrow("no links");
    expect((await read(link, 100, { followSymlinks: true })).toString()).toBe("secret");
  });
});
