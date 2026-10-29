import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { registerColorGradeTools, type ColorGradeToolDependencies } from "./colorGradeTools";

type Handler = (input: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
let root = "";
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "editkin-color-grade-tools-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function tools(overrides: Partial<ColorGradeToolDependencies> = {}) {
  const handlers = new Map<string, Handler>();
  const server = { registerTool: (name: string, _definition: unknown, handler: Handler) => { handlers.set(name, handler); } };
  registerColorGradeTools(server as never, {
    lutRoot: () => join(root, "luts"),
    resolveSourcePath: async path => path,
    readProject: async () => createEmptyProject("tools"),
    workspaceRoot: () => join(root, "workspace"),
    ...overrides,
  });
  const call = async (name: string, input: unknown) => {
    const result = await handlers.get(name)!(input);
    return { error: result.isError === true, body: JSON.parse(result.content[0].text) };
  };
  return { handlers, call };
}

describe("Color Grade v2 MCP tools", () => {
  it("registers list/import/export and imports a LUT with its rights metadata", async () => {
    const { handlers, call } = tools();
    expect([...handlers.keys()].sort()).toEqual(["export_clip_grade_lut", "import_color_lut", "list_color_luts"]);
    expect((await call("list_color_luts", {})).body.luts).toEqual([]);
    const source = join(root, "own.cube");
    await writeFile(source, "LUT_1D_SIZE 2\n0 0 0\n1 1 1\n");
    const imported = await call("import_color_lut", { sourcePath: source, name: "Own", license: "CC0-1.0", provenance: "owner", rightsBasis: "owner-authored", inputSpace: "acescct" });
    expect(imported.error).toBe(false);
    expect(imported.body.nodeReference).toMatchObject({ id: imported.body.entry.id, sha256: imported.body.entry.sha256, strength: 1 });
    const listed = await call("list_color_luts", {});
    expect(listed.body.luts).toHaveLength(1);
    expect(listed.body.filmLooksV2.length).toBeGreaterThanOrEqual(12);
  });

  it("blocks exports outside the workspace and imports without rights", async () => {
    const { call } = tools();
    const outside = await call("export_clip_grade_lut", { projectPath: "p.editkin.json", clipId: "c", outputPath: join(root, "elsewhere.cube") });
    expect(outside).toMatchObject({ error: true, body: { status: "BLOCK" } });
    const anonymous = await call("import_color_lut", { sourcePath: join(root, "x.cube"), name: "x", license: "", provenance: "p", rightsBasis: "r", inputSpace: "rec709_display" });
    expect(anonymous.error).toBe(true);
  });

  it("sends an in-workspace export through the canonical output check before writing", async () => {
    const checked: string[] = [];
    const { call } = tools({ resolveOutputPath: async path => { checked.push(path); throw new Error("路徑透過 junction 超出工作區"); } });
    const target = join(root, "workspace", "linked", "grade.cube");
    const refused = await call("export_clip_grade_lut", { projectPath: "p.editkin.json", clipId: "c", outputPath: target });
    expect(refused.error).toBe(true);
    expect(checked).toEqual([target]);
  });
});
