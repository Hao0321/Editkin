import { expect, it } from "vitest";
import { lstat, mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDemoProject } from "../domain/demo";
import { readProjectFile, writeProjectFileAtomic } from "./projectFiles";

async function fixture(run: (path: string, directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "editkin-project-protocol-"));
  const path = join(directory, "project.editkin.json");
  try {
    await writeFile(path, JSON.stringify(createDemoProject()), "utf8");
    await run(path, directory);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

it("reuses a directory left before lease initialization without deleting its identity", async () => fixture(async path => {
  await mkdir(`${path}.lock`);
  const directoryBefore = await lstat(`${path}.lock`);
  const first = await writeProjectFileAtomic(path, await readProjectFile(path));
  const second = await writeProjectFileAtomic(path, { ...first, name: "Second save" });
  expect(second.revision).toBe(first.revision + 1);
  expect((await lstat(`${path}.lock`)).ino).toBe(directoryBefore.ino);
  expect((await lstat(join(`${path}.lock`, "lease.sqlite"))).isFile()).toBe(true);
}));

it("preserves project and invalid SQLite bytes instead of clearing an unknown lock", async () => fixture(async path => {
  await mkdir(`${path}.lock`);
  const database = join(`${path}.lock`, "lease.sqlite");
  const invalid = "not a SQLite database".repeat(100);
  await writeFile(database, invalid, "utf8");
  const original = await readFile(path, "utf8");
  await expect(writeProjectFileAtomic(path, await readProjectFile(path))).rejects.toThrow();
  expect(await readFile(path, "utf8")).toBe(original);
  expect(await readFile(database, "utf8")).toBe(invalid);
}));

it("rejects a linked lock directory without writing through to its target", async () => fixture(async (path, directory) => {
  const outside = join(directory, "do-not-use-as-lock");
  await mkdir(outside);
  await writeFile(join(outside, "sentinel"), "unchanged");
  await symlink(outside, `${path}.lock`, process.platform === "win32" ? "junction" : "dir");
  const original = await readFile(path, "utf8");
  await expect(writeProjectFileAtomic(path, await readProjectFile(path))).rejects.toThrow("連結");
  expect(await readFile(path, "utf8")).toBe(original);
  expect(await readFile(join(outside, "sentinel"), "utf8")).toBe("unchanged");
  await expect(lstat(join(outside, "lease.sqlite"))).rejects.toMatchObject({ code: "ENOENT" });
}));

it("blocks legacy exclusive-file creation and age-based nonrecursive removal", async () => fixture(async path => {
  const saved = await writeProjectFileAtomic(path, await readProjectFile(path));
  await expect(open(`${path}.lock`, "wx")).rejects.toThrow();
  await expect(rm(`${path}.lock`, { force: true })).rejects.toThrow();
  expect((await lstat(`${path}.lock`)).isDirectory()).toBe(true);
  expect(await readProjectFile(path)).toEqual(saved);
}));
