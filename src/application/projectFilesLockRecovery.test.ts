import { expect, it } from "vitest";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDemoProject } from "../domain/demo";
import { readProjectFile, writeProjectFileAtomic } from "./projectFiles";

it("keeps edits recoverable at a new path when an abandoned legacy lock cannot be safely reclaimed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hao-project-lock-save-as-"));
  const originalPath = join(directory, "original.editkin.json");
  const saveAsPath = join(directory, "recovered.editkin.json");
  try {
    const base = createDemoProject();
    await writeFile(originalPath, JSON.stringify(base), "utf8");
    const original = await readFile(originalPath, "utf8");
    const token = "legacy owner identity unavailable\n";
    await writeFile(`${originalPath}.lock`, token, { flag: "wx", encoding: "utf8" });
    const old = new Date(Date.now() - 180_000);
    await utimes(`${originalPath}.lock`, old, old);
    const edits = { ...base, name: "仍可另存的修改" };
    await expect(writeProjectFileAtomic(originalPath, edits)).rejects.toThrow("另存新檔");
    const recovered = await writeProjectFileAtomic(saveAsPath, edits, null);
    expect(await readProjectFile(saveAsPath)).toEqual(recovered);
    expect(recovered.name).toBe(edits.name);
    expect(recovered.revision).toBe(base.revision + 1);
    expect(edits).toEqual({ ...base, name: "仍可另存的修改" });
    expect(await readFile(originalPath, "utf8")).toBe(original);
    expect(await readFile(`${originalPath}.lock`, "utf8")).toBe(token);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
