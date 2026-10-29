import { afterEach, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverWorkspaceMedia } from "./mediaDiscovery";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it("never offers an export's temporary work frames beside its output as workspace media", async () => {
  const root = await mkdtemp(join(tmpdir(), "editkin-discovery-render-work-")); roots.push(root);
  await writeFile(join(root, "clip.mp4"), "owned media bytes");
  const work = join(root, ".editkin-render-work", "editkin-render-AbC123", "display-sequence");
  await mkdir(work, { recursive: true });
  await writeFile(join(work, "frame-00000000.png"), "temporary frame");
  const result = await discoverWorkspaceMedia({ directory: "." }, { workspaceRoot: root });
  expect(result.results.map(file => file.sourcePath)).toEqual(["clip.mp4"]);
  expect(result.skipped.excludedDirectories).toBe(1);
  expect(result.excludedDirectoryNames).toContain(".editkin-render-work");
});
