import { createHash } from "node:crypto";
import type { McpServer, StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { errorResult, textResult } from "./toolRuntime";

/** The JSON Schema draft the MCP SDK converts every tool input schema to (standardSchemaToJsonSchema). */
const TOOL_INPUT_SCHEMA_TARGET = "draft-2020-12";

const fullInputSchemas = new Map<string, z.ZodType>();

/**
 * A tool input schema that tools/list advertises in compact form while every call is still validated by the unchanged
 * full schema. The MCP SDK validates tools/call through `~standard.validate` and builds tools/list through
 * `~standard.jsonSchema.input`, so delegating `validate` to the full zod schema keeps acceptance, error text and the
 * parsed arguments byte-identical, and only the advertised JSON changes. The full schema stays available through
 * describe_tool_input_schema.
 */
export type CompactAdvertisedInput<Full extends z.ZodType> = StandardSchemaWithJSON<z.input<Full>, z.output<Full>>
  & Pick<Full, "parse" | "safeParse" | "parseAsync" | "safeParseAsync">;

export function compactAdvertisedInput<Full extends z.ZodType>(toolName: string, full: Full, advertised: z.ZodType): CompactAdvertisedInput<Full> {
  fullInputSchemas.set(toolName, full);
  fullSchemaCache.delete(toolName);
  const fullStandard = full["~standard"] as unknown as StandardSchemaWithJSON<z.input<Full>, z.output<Full>>["~standard"];
  const advertisedStandard = advertised["~standard"] as unknown as StandardSchemaWithJSON["~standard"];
  return {
    // Direct zod-style callers (tests, harnesses) parse with the same full schema.
    parse: full.parse.bind(full),
    safeParse: full.safeParse.bind(full),
    parseAsync: full.parseAsync.bind(full),
    safeParseAsync: full.safeParseAsync.bind(full),
    "~standard": {
      version: 1,
      vendor: "editkin-compact-advertised",
      validate: (value: unknown, options?: Parameters<typeof fullStandard.validate>[1]) => fullStandard.validate(value, options),
      jsonSchema: {
        input: (options: Parameters<typeof advertisedStandard.jsonSchema.input>[0]) => advertisedStandard.jsonSchema.input(options),
        output: (options: Parameters<typeof advertisedStandard.jsonSchema.output>[0]) => advertisedStandard.jsonSchema.output(options),
      },
    },
  } as CompactAdvertisedInput<Full>;
}

/** Advertised stand-in for one EditorCommand: every command is an object discriminated by `type` (a superset, never stricter). */
export const advertisedEditorCommandSchema = z.looseObject({ type: z.string() })
  .describe("EditorCommand, validated server-side; full schema: describe_tool_input_schema {toolName, commandType}");

/** Advertised stand-in for an autopilot plan (every plan schema version is an object). */
export const advertisedAutopilotPlanSchema = z.looseObject({})
  .describe("hao.video-autopilot.edit-plan/v4 (v1-v3 import-only), validated server-side; full schema: describe_tool_input_schema {toolName, pointer}");

/** Advertised stand-in for the audit receipt (both receipt versions are objects discriminated by `schema`). */
export const advertisedAuditReceiptSchema = z.looseObject({ schema: z.string() })
  .describe("The auditReceipt audit_autopilot_plan returned in this Editkin process, passed back unchanged");

/** Tools whose advertised input schema is compact; describe_tool_input_schema serves their full schema. */
export function compactAdvertisedToolNames(): string[] {
  return [...fullInputSchemas.keys()].sort();
}

const fullSchemaCache = new Map<string, { json: Record<string, unknown>; text: string; sha256: string }>();

/** The exact JSON Schema tools/list advertised for this tool before compaction (the SDK's input conversion). */
export function fullToolInputJsonSchema(toolName: string): { json: Record<string, unknown>; text: string; sha256: string } {
  const cached = fullSchemaCache.get(toolName);
  if (cached) return cached;
  const full = fullInputSchemas.get(toolName);
  if (!full) throw new Error(`${toolName} 沒有精簡公告的 input schema`);
  const converted = (full["~standard"] as unknown as StandardSchemaWithJSON["~standard"]).jsonSchema.input({ target: TOOL_INPUT_SCHEMA_TARGET }) as Record<string, unknown>;
  // Same root normalisation as @modelcontextprotocol/server standardSchemaToJsonSchema(schema, "input").
  const json = { type: "object", ...converted };
  const text = JSON.stringify(json);
  const entry = { json, text, sha256: createHash("sha256").update(text).digest("hex") };
  fullSchemaCache.set(toolName, entry);
  return entry;
}

function bytesOf(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}

function resolvePointer(root: unknown, pointer: string): unknown {
  if (pointer === "" || pointer === "/") return root;
  if (!pointer.startsWith("/")) throw new Error("pointer 必須是 JSON Pointer（以 / 開頭，例如 /properties/plan）");
  let node = root;
  for (const raw of pointer.slice(1).split("/")) {
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(node) && /^\d+$/.test(key) && Number(key) < node.length) node = node[Number(key)];
    else if (node && typeof node === "object" && !Array.isArray(node) && Object.hasOwn(node, key)) node = (node as Record<string, unknown>)[key];
    else throw new Error(`pointer 找不到：${pointer}`);
  }
  return node;
}

function memberHint(member: unknown): string | undefined {
  if (!member || typeof member !== "object") return undefined;
  const record = member as Record<string, unknown>;
  const properties = record.properties as Record<string, { const?: unknown }> | undefined;
  for (const key of ["type", "schema", "kind", "mode", "route"]) {
    const constant = properties?.[key]?.const;
    if (typeof constant === "string") return `${key}=${constant}`;
  }
  if (typeof record.$ref === "string") return record.$ref;
  if (typeof record.type === "string") return record.type;
  return undefined;
}

/** A bounded map of one schema node: its children with byte sizes, so a caller can descend by pointer. */
function outline(node: unknown, limit = 160) {
  if (Array.isArray(node)) {
    return { kind: "array", length: node.length, entries: node.slice(0, limit).map((child, index) => ({ pointer: String(index), bytes: bytesOf(child), ...(memberHint(child) ? { hint: memberHint(child) } : {}) })), truncated: node.length > limit };
  }
  if (node && typeof node === "object") {
    const entries = Object.entries(node as Record<string, unknown>);
    return { kind: "object", length: entries.length, entries: entries.slice(0, limit).map(([key, child]) => ({ pointer: key.replaceAll("~", "~0").replaceAll("/", "~1"), bytes: bytesOf(child), ...(memberHint(child) ? { hint: memberHint(child) } : {}) })), truncated: entries.length > limit };
  }
  return { kind: typeof node, length: 0, entries: [], truncated: false };
}

/** Find the union member describing one command (`properties.type.const`) anywhere in the schema's $defs. */
function findCommandMember(json: Record<string, unknown>, commandType: string): { pointer: string; schema: unknown } | undefined {
  const visit = (node: unknown, pointer: string, depth: number): { pointer: string; schema: unknown } | undefined => {
    if (depth > 8 || !node || typeof node !== "object") return undefined;
    if (Array.isArray(node)) {
      for (const [index, child] of node.entries()) {
        const hit = visit(child, `${pointer}/${index}`, depth + 1);
        if (hit) return hit;
      }
      return undefined;
    }
    const record = node as Record<string, unknown>;
    if ((record.properties as Record<string, { const?: unknown }> | undefined)?.type?.const === commandType) return { pointer, schema: node };
    for (const key of ["$defs", "oneOf", "anyOf", "allOf", "properties", "items", "commands"]) {
      if (!(key in record)) continue;
      const hit = visit(record[key], `${pointer}/${key}`, depth + 1);
      if (hit) return hit;
    }
    if (pointer.startsWith("/$defs") || pointer.startsWith("/properties")) {
      for (const [key, child] of Object.entries(record)) {
        if (["$defs", "oneOf", "anyOf", "allOf", "properties", "items"].includes(key)) continue;
        const hit = visit(child, `${pointer}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`, depth + 1);
        if (hit) return hit;
      }
    }
    return undefined;
  };
  return visit(json, "", 0);
}

export const describeToolInputSchemaInput = z.object({
  toolName: z.string().min(1).max(128),
  pointer: z.string().max(1024).optional().describe("JSON Pointer into the full schema, e.g. /properties/plan/anyOf/0; omitted = root outline"),
  commandType: z.string().min(1).max(128).optional().describe("Return one EditorCommand variant, e.g. add_clip"),
  maxBytes: z.number().int().min(1024).max(262144).default(24576),
});

export interface DescribeToolInputSchemaResult {
  status: "GREEN";
  toolName: string;
  schemaSha256: string;
  totalBytes: number;
  validatedServerSide: true;
  pointer: string;
  bytes: number;
  /** The schema node when it fits in maxBytes, else null with an outline to descend by pointer. */
  schema: unknown;
  outline?: ReturnType<typeof outline>;
  note?: string;
}

export function describeToolInputSchema(input: z.output<typeof describeToolInputSchemaInput>): DescribeToolInputSchemaResult {
  const { json, text, sha256 } = fullToolInputJsonSchema(input.toolName);
  const base = { status: "GREEN" as const, toolName: input.toolName, schemaSha256: sha256, totalBytes: Buffer.byteLength(text, "utf8"), validatedServerSide: true as const };
  if (input.commandType) {
    const found = findCommandMember(json, input.commandType);
    if (!found) throw new Error(`${input.toolName} 的 schema 沒有 command type ${input.commandType}`);
    const bytes = bytesOf(found.schema);
    if (bytes > input.maxBytes) return { ...base, pointer: found.pointer, bytes, schema: null, outline: outline(found.schema), note: "超過 maxBytes；用 pointer 逐層讀取" };
    return { ...base, pointer: found.pointer, bytes, schema: found.schema, note: "\"$ref\": \"#/$defs/...\" 指向同一份 schema 的 $defs；用 pointer 讀取" };
  }
  const pointer = input.pointer ?? "";
  const node = resolvePointer(json, pointer);
  const bytes = bytesOf(node);
  if (pointer !== "" && bytes <= input.maxBytes) return { ...base, pointer, bytes, schema: node };
  return { ...base, pointer, bytes, schema: null, outline: outline(node), note: pointer === "" ? "用 pointer 下鑽；EditorCommand 可直接用 commandType" : "超過 maxBytes；用更深的 pointer 讀取" };
}

/** describe_tool_input_schema: the full input schema of a tool whose tools/list entry is compact, read on demand. */
export function registerToolSchemaDescribeTool(server: McpServer): void {
  server.registerTool("describe_tool_input_schema", {
    description: "讀取精簡公告工具（audit_autopilot_plan、apply_autopilot_plan、apply_edit_commands、build_autopilot_roto_keyer_decision）的完整 input schema。tools/list 只列精簡欄位，伺服器端每次呼叫仍以完整 schema 驗證。無 pointer 回傳根層大綱；pointer（JSON Pointer）下鑽；commandType 直接取單一 EditorCommand。",
    inputSchema: describeToolInputSchemaInput,
  }, async (input) => {
    try { return textResult(describeToolInputSchema(input)); }
    catch (error) { return errorResult(error); }
  });
}
