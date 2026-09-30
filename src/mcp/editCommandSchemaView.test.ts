import { describe, expect, it } from "vitest";
import { z } from "zod";
import { editorCommandSchema } from "../domain/schema";
import { editCommandSchemaView } from "./editCommandSchemaView";

const schema = z.toJSONSchema(z.object({ projectPath: z.string(), commands: z.array(editorCommandSchema).min(1).max(100) }), { io: "input" });
describe("command-specific native Agent schema queries", () => {
  it("reads the real caption patch without exposing every unrelated command", () => {
    const result = editCommandSchemaView(schema, "update_caption");
    expect(result.inputSchema.properties.commands.items.properties.patch.properties.text.type).toBe("string");
    expect(result.inputSchema.properties.commands.items.required).toContain("patch");
    expect(result.inputSchema.properties.commands.maxItems).toBe(100);
    expect(result.inputSchema.required).toEqual(["projectPath", "commands"]);
    expect(result.referencePaths).toEqual([]);
    expect(JSON.stringify(result).length).toBeLessThan(2200);
    expect(JSON.stringify(result)).not.toContain("import_asset");
  });
  it("preserves the clip volume command and leaves the authoritative schema untouched", () => {
    const before = JSON.stringify(schema);
    const result = editCommandSchemaView(schema, "set_clip_volume");
    expect(result.inputSchema.properties.commands.items.properties.volume).toEqual({ type: "number" });
    expect(result.inputSchema.properties.commands.items.required).toEqual(["type", "clipId", "volume"]);
    result.inputSchema.properties.commands.maxItems = 500;
    expect(JSON.stringify(schema)).toBe(before);
  });
  it("reports recursive command references without expanding the entire union", () => {
    const result = editCommandSchemaView(schema, "batch");
    expect(result.referencePaths.length).toBeGreaterThan(0);
    expect(result.note).toContain("without commandType");
  });
  it("rejects unknown commands, external references, and cyclic references", () => {
    expect(() => editCommandSchemaView(schema, "made_up_command")).toThrow("Unknown");
    expect(() => editCommandSchemaView(schema, "../update_caption")).toThrow("bounded");
    const foreign = { properties: { projectPath: {}, commands: { items: { $ref: "https://example.invalid/schema" } } } };
    expect(() => editCommandSchemaView(foreign, "update_caption")).toThrow("local reference");
    const cycle = { properties: { projectPath: {}, commands: { items: { $ref: "#/properties/commands/items" } } } };
    expect(() => editCommandSchemaView(cycle, "update_caption")).toThrow("local reference");
  });
});
