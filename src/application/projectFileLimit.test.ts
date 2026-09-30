import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readProjectFile, readProjectText } from "./projectFiles";

describe("project file size limit", () => {
  let root: string;
  beforeAll(async () => { root = await mkdtemp(join(tmpdir(), "editkin-project-limit-")); });
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });

  it("reads a file within the limit and refuses one over it before parsing", async () => {
    const path = join(root, "small.editkin.json");
    await writeFile(path, `{"a":"${"x".repeat(100)}"}`);
    expect(JSON.parse(await readProjectText(path, 1_000)).a).toHaveLength(100);
    await expect(readProjectText(path, 50)).rejects.toThrow("上限");
  });

  it("refuses a directory and an oversized project through readProjectFile", async () => {
    await mkdir(join(root, "dir.editkin.json"));
    await expect(readProjectText(join(root, "dir.editkin.json"))).rejects.toThrow("不是一般檔案");
    const huge = join(root, "huge.editkin.json");
    await writeFile(huge, Buffer.alloc(65 * 1024 * 1024, 32));
    await expect(readProjectFile(huge)).rejects.toThrow("上限");
  });
});
