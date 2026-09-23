import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEmptyProject } from "../domain/editGraph";
import { materializeEditorialProject, readEditorialRenderReceipt } from "./editorialBatchResume";
const paths: string[] = [];
afterEach(async () => { for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true }); });
describe("editorial batch retry keeps completed work", () => {
  it("resumes the exact generated project without increasing revision or changing bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "editkin-batch-resume-")); paths.push(root);
    const path = join(root, "one.editkin.json"), project = createEmptyProject();
    const first = await materializeEditorialProject(path, "a".repeat(64), "one", project);
    const bytes = await readFile(path, "utf8");
    const second = await materializeEditorialProject(path, "a".repeat(64), "one", { ...project, updatedAt: new Date(0).toISOString() });
    expect(second.resumed).toBe(true); expect(second.project.revision).toBe(first.project.revision);
    expect(await readFile(path, "utf8")).toBe(bytes);
    await expect(materializeEditorialProject(path, "b".repeat(64), "one", project)).rejects.toThrow(/計畫/);
    await writeFile(path, bytes.replace("未命名影片", "手動修改"));
    await expect(materializeEditorialProject(path, "a".repeat(64), "one", project)).rejects.toThrow(/已經修改/);
    expect(await readFile(path, "utf8")).toContain("手動修改");
  });
  it("never adopts or overwrites a project without an origin receipt", async () => {
    const root = await mkdtemp(join(tmpdir(), "editkin-batch-protect-")); paths.push(root);
    const path = join(root, "one.editkin.json"); await writeFile(path, "precious unrecognized data");
    await expect(materializeEditorialProject(path, "a".repeat(64), "one", createEmptyProject())).rejects.toThrow(/拒絕覆蓋/);
    expect(await readFile(path, "utf8")).toBe("precious unrecognized data");
  });
  it("does not call a missing or forged render receipt completed", async () => {
    const root = await mkdtemp(join(tmpdir(), "editkin-batch-render-")); paths.push(root);
    const receipt = join(root, "receipt.json"), output = join(root, "output.mp4");
    expect(await readEditorialRenderReceipt(receipt, output, "a")).toBeUndefined();
    await writeFile(receipt, JSON.stringify({ schema: "invented", projectSha256: "a" }));
    await expect(readEditorialRenderReceipt(receipt, output, "a")).rejects.toThrow(/已完成輸出/);
  });
});
