import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as z from "zod/v4";

const schemas = vi.hoisted(() => new Map<string, unknown>());
vi.mock("@modelcontextprotocol/server", () => ({
  McpServer: class {
    registerTool(name: string, configuration: { inputSchema?: unknown }) { schemas.set(name, configuration.inputSchema); }
  },
}));
vi.mock("@modelcontextprotocol/server/stdio", () => ({ serveStdio: () => ({ close: async () => {} }) }));
import { createServerForEnvironment } from "./server";
import { autopilotPlanSchema } from "../application/autopilotPlan";
import { autopilotAuditReceiptSchema } from "../application/autopilotInvocationIdentity";
import { createAutopilotV4Fixture } from "../application/autopilotPlanFixture";
import { editorCommandSchema } from "../domain/schema";
import { compactAdvertisedToolNames, describeToolInputSchema, fullToolInputJsonSchema } from "./advertisedSchema";

type Standard = { "~standard": { validate: (value: unknown) => unknown; jsonSchema: { input: (options: { target: string }) => Record<string, unknown> } } };
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

/** The four input schemas exactly as HEAD d647290 declared them (before W2-1), rebuilt from the same building blocks. */
const BASELINE: Record<string, z.ZodType> = {
  audit_autopilot_plan: z.object({ projectPath: z.string(), plan: autopilotPlanSchema }),
  apply_autopilot_plan: z.object({ projectPath: z.string(), plan: autopilotPlanSchema, auditReceipt: autopilotAuditReceiptSchema }),
  apply_edit_commands: z.object({
    projectPath: z.string(),
    commands: z.array(editorCommandSchema).min(1).max(100),
    expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  }),
  build_autopilot_roto_keyer_decision: z.object({
    projectPath: z.string(), materialId: sha256Schema, evidenceReceiptSha256: sha256Schema,
    route: z.enum(["no_op", "manual_mask", "self_authored_screen_keyer"]), decisionContextTokens: z.number().int().min(1).max(400),
    screen: z.enum(["green", "blue"]).optional(), settings: z.unknown().optional(), manualCommand: editorCommandSchema.optional(),
  }),
};
const SLIMMED = Object.keys(BASELINE).sort();

function registered(): Map<string, unknown> {
  schemas.clear();
  createServerForEnvironment({});
  return new Map(schemas);
}

const validate = async (schema: unknown, value: unknown) => JSON.stringify(await (schema as Standard)["~standard"].validate(structuredClone(value)));
const advertisedJson = (schema: unknown) => (schema as Standard)["~standard"].jsonSchema.input({ target: "draft-2020-12" });
const baselineJson = (name: string) => ({ type: "object", ...(BASELINE[name] as unknown as Standard)["~standard"].jsonSchema.input({ target: "draft-2020-12" }) });

function fixtureCorpus(): Array<[string, unknown]> {
  const plan = createAutopilotV4Fixture();
  const hex = "a".repeat(64);
  const withoutSource = structuredClone(plan) as Record<string, unknown>; delete withoutSource.source;
  const v3 = { ...structuredClone(plan), schema: "hao.video-autopilot.edit-plan/v3" };
  const rename = { type: "rename_project", name: "x" };
  return [
    ["audit_autopilot_plan", { projectPath: "p.editkin.json", plan }],
    ["audit_autopilot_plan", { projectPath: "p.editkin.json", plan: withoutSource }],
    ["audit_autopilot_plan", { projectPath: "p.editkin.json", plan: v3 }],
    ["audit_autopilot_plan", { projectPath: "p.editkin.json", plan, extra: 1 }],
    ["audit_autopilot_plan", { projectPath: 7, plan }],
    ["audit_autopilot_plan", {}],
    ["audit_autopilot_plan", { projectPath: "p.editkin.json", plan: { ...plan, commands: [{ type: "bogus" }] } }],
    ["apply_autopilot_plan", { projectPath: "p.editkin.json", plan }],
    ["apply_autopilot_plan", { projectPath: "p.editkin.json", plan, auditReceipt: {} }],
    ["apply_autopilot_plan", { projectPath: "p.editkin.json", plan, auditReceipt: { schema: "hao.video-autopilot.audit-receipt/v1" } }],
    ["apply_edit_commands", { projectPath: "p.editkin.json", commands: [rename] }],
    ["apply_edit_commands", { projectPath: "p.editkin.json", commands: [rename], expectedRevision: 3 }],
    ["apply_edit_commands", { projectPath: "p.editkin.json", commands: [rename], expectedRevision: -1 }],
    ["apply_edit_commands", { projectPath: "p.editkin.json", commands: [] }],
    ["apply_edit_commands", { projectPath: "p.editkin.json", commands: Array.from({ length: 101 }, () => rename) }],
    ["apply_edit_commands", { projectPath: "p.editkin.json", commands: [{ type: "no_such_command" }] }],
    ["apply_edit_commands", { projectPath: "p.editkin.json", commands: [{ type: "rename_project" }] }],
    ["apply_edit_commands", { projectPath: "p.editkin.json", commands: [{ type: "batch", commands: [rename, { type: "rename_project", name: 3 }] }] }],
    ["apply_edit_commands", { projectPath: "p.editkin.json", commands: [{ ...rename, unknownKey: true }] }],
    ["apply_edit_commands", { commands: [rename] }],
    ["build_autopilot_roto_keyer_decision", { projectPath: "p.editkin.json", materialId: hex, evidenceReceiptSha256: hex, route: "no_op", decisionContextTokens: 10 }],
    ["build_autopilot_roto_keyer_decision", { projectPath: "p.editkin.json", materialId: "x", evidenceReceiptSha256: hex, route: "no_op", decisionContextTokens: 10 }],
    ["build_autopilot_roto_keyer_decision", { projectPath: "p.editkin.json", materialId: hex, evidenceReceiptSha256: hex, route: "manual_mask", decisionContextTokens: 10, manualCommand: rename }],
    ["build_autopilot_roto_keyer_decision", { projectPath: "p.editkin.json", materialId: hex, evidenceReceiptSha256: hex, route: "manual_mask", decisionContextTokens: 10, manualCommand: { type: "bogus" } }],
    ["build_autopilot_roto_keyer_decision", { projectPath: "p.editkin.json", materialId: hex, evidenceReceiptSha256: hex, route: "warp", decisionContextTokens: 999, settings: { anything: true } }],
  ];
}

/** Optional: every recorded real VA v4 request (read-only) under EDITKIN_W2_RECORDED_REQUESTS_ROOT. */
function recordedCorpus(): Array<[string, unknown]> {
  const root = process.env.EDITKIN_W2_RECORDED_REQUESTS_ROOT;
  if (!root) return [];
  const found: Array<[string, unknown]> = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".request.json")) {
        try {
          const value = JSON.parse(readFileSync(path, "utf8")) as { name?: unknown; arguments?: unknown };
          if (typeof value.name === "string" && SLIMMED.includes(value.name) && value.arguments !== undefined) found.push([value.name, value.arguments]);
        } catch { /* not a tools/call record */ }
      }
    }
  };
  walk(root);
  return found;
}

describe("W2-1 compact advertised schemas", () => {
  it("registers exactly the four slimmed tools behind compact advertisements", () => {
    const tools = registered();
    expect(compactAdvertisedToolNames()).toEqual(SLIMMED);
    for (const name of SLIMMED) {
      expect(tools.has(name)).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(advertisedJson(tools.get(name))))).toBeLessThan(1200);
    }
  });

  it("accepts, rejects and parses every corpus input exactly as the pre-W2-1 schemas did", async () => {
    const tools = registered();
    const corpus = [...fixtureCorpus(), ...recordedCorpus()];
    let accepted = 0, rejected = 0;
    for (const [name, input] of corpus) {
      const before = await validate(BASELINE[name], input);
      const after = await validate(tools.get(name), input);
      expect(after, `${name} ${JSON.stringify(input).slice(0, 120)}`).toBe(before);
      if (JSON.parse(before).issues) rejected += 1; else accepted += 1;
    }
    expect(accepted).toBeGreaterThan(4);
    expect(rejected).toBeGreaterThan(10);
    if (process.env.EDITKIN_W2_RECORDED_REQUESTS_ROOT) console.info(`W2-1 equivalence corpus: ${corpus.length} inputs (${accepted} accepted, ${rejected} rejected)`);
  });

  it("keeps the full schema byte-identical behind describe_tool_input_schema", () => {
    registered();
    for (const name of SLIMMED) {
      const full = fullToolInputJsonSchema(name);
      const expected = baselineJson(name);
      if (name === "apply_edit_commands") {
        // W2-2 adds one optional flag; everything else is the pre-W2-1 advertised schema.
        const properties = { ...(full.json.properties as Record<string, unknown>) };
        expect(properties.allowDirtyGuiSession).toEqual({ type: "boolean" });
        delete properties.allowDirtyGuiSession;
        expect(JSON.stringify({ ...full.json, properties })).toBe(JSON.stringify(expected));
      } else {
        expect(full.text).toBe(JSON.stringify(expected));
      }
      expect(full.sha256).toBe(createHash("sha256").update(full.text).digest("hex"));
    }
  });

  it("advertises a superset: every full property is listed and nothing is required that the full schema does not require", () => {
    const tools = registered();
    for (const name of SLIMMED) {
      const compact = advertisedJson(tools.get(name)) as { properties: Record<string, unknown>; required?: string[] };
      const full = fullToolInputJsonSchema(name).json as { properties: Record<string, unknown>; required?: string[] };
      expect(Object.keys(compact.properties).sort()).toEqual(Object.keys(full.properties).sort());
      for (const key of compact.required ?? []) expect(full.required ?? []).toContain(key);
      expect(JSON.stringify(compact)).not.toContain("$defs");
    }
  });

  it("serves the full schema on demand: root outline, one EditorCommand, and pointer pages within maxBytes", () => {
    registered();
    const root = describeToolInputSchema({ toolName: "apply_edit_commands", maxBytes: 24576 });
    expect(root).toMatchObject({ status: "GREEN", schema: null, validatedServerSide: true });
    expect(root.totalBytes).toBeGreaterThan(100_000);
    const rename = describeToolInputSchema({ toolName: "apply_edit_commands", commandType: "rename_project", maxBytes: 4096 });
    expect((rename.schema as { properties: { type: { const: string } } }).properties.type.const).toBe("rename_project");
    expect(Buffer.byteLength(JSON.stringify(rename))).toBeLessThan(4096);
    // A large command comes back as a bounded outline until maxBytes allows the whole variant.
    const addClipOutline = describeToolInputSchema({ toolName: "apply_edit_commands", commandType: "add_clip", maxBytes: 1024 });
    expect(addClipOutline.schema).toBeNull();
    expect(addClipOutline.outline?.kind).toBe("object");
    const addClip = describeToolInputSchema({ toolName: "apply_edit_commands", commandType: "add_clip", maxBytes: 262144 });
    expect((addClip.schema as { properties: { type: { const: string } } }).properties.type.const).toBe("add_clip");
    const plan = describeToolInputSchema({ toolName: "audit_autopilot_plan", pointer: "/properties/plan", maxBytes: 4096 });
    expect(plan.schema).toBeNull();
    expect(plan.outline?.entries.length).toBeGreaterThan(0);
    const projectPath = describeToolInputSchema({ toolName: "audit_autopilot_plan", pointer: "/properties/projectPath", maxBytes: 4096 });
    expect(projectPath.schema).toEqual({ type: "string" });
    expect(() => describeToolInputSchema({ toolName: "render_project", maxBytes: 4096 })).toThrow(/沒有精簡公告/);
    expect(() => describeToolInputSchema({ toolName: "apply_edit_commands", pointer: "/nope", maxBytes: 4096 })).toThrow(/pointer 找不到/);
  });
});
