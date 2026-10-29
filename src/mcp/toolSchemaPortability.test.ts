import { describe, expect, it, vi } from "vitest";
import * as z from "zod/v4";

const schemas = vi.hoisted(() => new Map<string, unknown>());
vi.mock("@modelcontextprotocol/server", () => ({
  McpServer: class {
    registerTool(name: string, configuration: { inputSchema?: unknown }) { schemas.set(name, configuration.inputSchema); }
  },
}));
vi.mock("@modelcontextprotocol/server/stdio", () => ({ serveStdio: () => ({ close: async () => {} }) }));
import { createServer } from "./server";
import { fullToolInputJsonSchema } from "./advertisedSchema";

const isZod = (value: unknown): value is z.ZodType => typeof value === "object" && value !== null && "_zod" in value;
type StandardJson = { "~standard": { jsonSchema: { input: (options: { target: string }) => unknown } } };
/** W2-1 compact advertised schemas are Standard Schemas (not zod) whose advertised JSON is what tools/list emits. */
const isCompactAdvertised = (value: unknown): value is StandardJson => typeof value === "object" && value !== null && !("_zod" in value) && "~standard" in value;

/** JSON Schema shapes some MCP clients reject outright, silently dropping the whole tool. */
function rejectedShapes(node: unknown, path: string, found: string[]): void {
  if (Array.isArray(node)) { node.forEach((child, index) => rejectedShapes(child, `${path}/${index}`, found)); return; }
  if (!node || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  if (Array.isArray(record.prefixItems) && record.prefixItems.length === 0) found.push(`${path}/prefixItems is empty`);
  for (const [key, child] of Object.entries(record)) rejectedShapes(child, `${path}/${key}`, found);
}

describe("MCP tool input schemas stay portable across clients", () => {
  it("emits no empty prefixItems anywhere (a z.tuple([]) made clients drop audit/apply on 2026-10-06)", () => {
    schemas.clear();
    createServer();
    const found: string[] = [];
    for (const [name, inputSchema] of schemas) {
      if (inputSchema === undefined) continue;
      if (isCompactAdvertised(inputSchema)) {
        rejectedShapes(inputSchema["~standard"].jsonSchema.input({ target: "draft-2020-12" }), name, found);
        // The full schema describe_tool_input_schema serves must stay portable too.
        rejectedShapes(fullToolInputJsonSchema(name).json, `${name}(full)`, found);
        continue;
      }
      const schema = isZod(inputSchema) ? inputSchema : z.object(inputSchema as z.ZodRawShape);
      rejectedShapes(z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }), name, found);
    }
    expect(schemas.size).toBeGreaterThan(90);
    expect(schemas.has("audit_autopilot_plan") && schemas.has("apply_autopilot_plan")).toBe(true);
    expect(found).toEqual([]);
  });

  it("converts every input schema the way the SDK's tools/list does (a z.custom emptied the whole list on 2026-10-07)", () => {
    schemas.clear();
    createServer();
    const failures: string[] = [];
    for (const [name, inputSchema] of schemas) {
      if (inputSchema === undefined) continue;
      if (isCompactAdvertised(inputSchema)) {
        try { inputSchema["~standard"].jsonSchema.input({ target: "draft-2020-12" }); }
        catch (error) { failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); }
        continue;
      }
      const schema = isZod(inputSchema) ? inputSchema : z.object(inputSchema as z.ZodRawShape);
      // Same call as @modelcontextprotocol/server standardSchemaToJsonSchema: no "unrepresentable" escape hatch.
      try { (schema as unknown as { "~standard": { jsonSchema: { input: (options: { target: string }) => unknown } } })["~standard"].jsonSchema.input({ target: "draft-2020-12" }); }
      catch (error) { failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    expect(schemas.size).toBeGreaterThan(90);
    expect(failures).toEqual([]);
  });
});
