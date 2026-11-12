// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 djguan-jpg (https://github.com/djguan-jpg)
// Agent contribution: urn:uuid:d366cab7-d5a4-44d8-b80d-4c7ce4daf65d. See AGENT-NOTICE.md.
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
  it("does not traverse prototype keys or invoke schema accessors", () => {
    const poisoned = JSON.parse('{"properties":{"projectPath":{},"commands":{"items":{"$ref":"#/__proto__/branch"}}},"__proto__":{"branch":{}}}');
    expect(() => editCommandSchemaView(poisoned, "update_caption")).toThrow("does not exist");
    const accessor = { properties: { projectPath: {}, commands: { items: { $ref: "#/defs/branch" } } }, defs: {} } as any;
    Object.defineProperty(accessor.defs, "branch", { enumerable: true, get: () => ({}) });
    expect(() => editCommandSchemaView(accessor, "update_caption")).toThrow("does not exist");
  });
});
