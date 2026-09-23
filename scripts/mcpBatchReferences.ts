/** Source-development batch transport only. Product audit/apply remains the authority. */
export interface BatchCall {
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
  timeoutMs?: number;
}

export interface BatchToolResult {
  isError?: boolean;
  content: Array<Record<string, unknown> & { type: string }>;
}

export interface BatchResultReference { callId: string; path: Array<string | number> }
export interface BatchResultRow {
  id: string;
  name: string;
  isError: boolean;
  content: Array<Record<string, unknown>>;
  resultReferences?: BatchResultReference[];
  failurePhase?: "resolve_arguments" | "call_tool" | "capture_result";
  executionMayHaveOccurred?: boolean;
}

const MAX_ARGUMENT_BYTES = 4 * 1024 * 1024;
const forbiddenKeys = new Set(["__proto__", "prototype", "constructor"]);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

export function validateBatchCalls(input: unknown): BatchCall[] {
  if (!record(input) || !Array.isArray(input.calls) || input.calls.length < 1 || input.calls.length > 128) throw new Error("calls.json must contain 1..128 calls");
  const ids = new Set<string>();
  for (const call of input.calls) {
    if (!record(call) || typeof call.id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(call.id) || ids.has(call.id)) throw new Error("Batch call IDs must be unique, safe file-name identifiers");
    ids.add(call.id);
    if (typeof call.name !== "string" || !/^[a-z][a-z0-9_]{0,127}$/i.test(call.name)) throw new Error(`Invalid tool name for ${call.id}`);
    if (call.arguments !== undefined && !record(call.arguments)) throw new Error(`Arguments must be an object: ${call.id}`);
    if (call.timeoutMs !== undefined && (!Number.isSafeInteger(call.timeoutMs) || Number(call.timeoutMs) < 1 || Number(call.timeoutMs) > 2_147_483_647)) throw new Error(`Invalid timeout: ${call.id}`);
  }
  return input.calls as unknown as BatchCall[];
}

export function jsonToolPayload(result: BatchToolResult): unknown {
  const text = result.content.filter(item => item.type === "text" && typeof item.text === "string");
  if (text.length !== 1) throw new Error("Result references require exactly one JSON text payload");
  if (Buffer.byteLength(text[0].text as string, "utf8") > MAX_ARGUMENT_BYTES) throw new Error("Result JSON exceeds the batch reference byte bound");
  return JSON.parse(text[0].text as string) as unknown;
}

export function batchResultIsBlocked(result: BatchToolResult): boolean {
  if (result.isError === true) return true;
  // A tool may emit BLOCK without setting isError. REVIEW_REQUIRED is intentionally retained, not promoted.
  return result.content.some(item => {
    if (item.type !== "text" || typeof item.text !== "string") return false;
    try { const payload: unknown = JSON.parse(item.text); return record(payload) && payload.status === "BLOCK"; }
    catch { return false; }
  });
}

export function resolveBatchArguments(
  input: Record<string, unknown>, previous: ReadonlyMap<string, BatchToolResult>,
): { arguments: Record<string, unknown>; references: BatchResultReference[] } {
  const references: BatchResultReference[] = [];
  let visited = 0;
  const cloneData = (value: unknown, depth: number, allowReferences: boolean): unknown => {
    if (++visited > 100_000 || depth > 48) throw new Error("Batch arguments exceed structural bounds");
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (Array.isArray(value)) return value.map(item => cloneData(item, depth + 1, allowReferences));
    if (!record(value)) throw new Error("Batch arguments must contain JSON values only");
    if (allowReferences && Object.hasOwn(value, "$result")) {
      if (Object.keys(value).length !== 1) throw new Error("$result cannot be mixed with literal fields");
      const reference = value.$result;
      if (!record(reference) || Object.keys(reference).sort().join(",") !== "callId,path" || typeof reference.callId !== "string" || !Array.isArray(reference.path) || reference.path.length > 16) throw new Error("Invalid $result reference; use {callId,path:[...]}");
      if (references.length >= 64) throw new Error("Too many result references");
      const prior = previous.get(reference.callId);
      if (!prior || batchResultIsBlocked(prior)) throw new Error(`Reference must name a prior successful call: ${reference.callId}`);
      let resolvedValue = jsonToolPayload(prior);
      for (const part of reference.path) {
        if (typeof part === "string") {
          if (forbiddenKeys.has(part) || !record(resolvedValue) || !Object.hasOwn(resolvedValue, part)) throw new Error(`Missing or unsafe result field: ${String(part)}`);
          resolvedValue = resolvedValue[part];
        } else if (typeof part === "number" && Number.isSafeInteger(part) && part >= 0 && Array.isArray(resolvedValue) && part < resolvedValue.length) resolvedValue = resolvedValue[part];
        else throw new Error("Result path requires existing object keys or bounded array indexes");
      }
      references.push({ callId: reference.callId, path: [...reference.path] as Array<string | number> });
      // Returned data is inert: a $result inside it is never recursively executed.
      return cloneData(resolvedValue, depth + 1, false);
    }
    const entries = Object.entries(value).map(([key, item]) => {
      if (forbiddenKeys.has(key)) throw new Error(`Unsafe JSON key: ${key}`);
      return [key, cloneData(item, depth + 1, allowReferences)] as const;
    });
    return Object.fromEntries(entries);
  };
  const argumentsValue = cloneData(input, 0, true);
  if (!record(argumentsValue) || Buffer.byteLength(JSON.stringify(argumentsValue), "utf8") > MAX_ARGUMENT_BYTES) throw new Error("Resolved arguments exceed the batch byte bound or are not an object");
  return { arguments: argumentsValue, references };
}

/** One invocation callback, one long-lived MCP connection; no retries after ambiguous writes. */
export async function executeBatchCalls(
  calls: BatchCall[],
  invoke: (call: BatchCall, argumentsValue: Record<string, unknown>) => Promise<BatchToolResult>,
  capture: (call: BatchCall, result: BatchToolResult) => Promise<Array<Record<string, unknown>>> = async (_call, result) => result.content,
): Promise<BatchResultRow[]> {
  validateBatchCalls({ calls });
  const previous = new Map<string, BatchToolResult>();
  const rows: BatchResultRow[] = [];
  for (const call of calls) {
    let phase: NonNullable<BatchResultRow["failurePhase"]> = "resolve_arguments";
    let references: BatchResultReference[] = [];
    try {
      const resolved = resolveBatchArguments(call.arguments ?? {}, previous);
      references = resolved.references;
      phase = "call_tool";
      const result = await invoke(call, resolved.arguments);
      const blocked = batchResultIsBlocked(result);
      phase = "capture_result";
      const content = await capture(call, result);
      rows.push({ id: call.id, name: call.name, isError: blocked, content, ...(references.length ? { resultReferences: references } : {}) });
      if (blocked) break;
      previous.set(call.id, result);
    } catch (error) {
      rows.push({ id: call.id, name: call.name, isError: true, failurePhase: phase,
        executionMayHaveOccurred: phase !== "resolve_arguments", resultReferences: references,
        content: [{ type: "text", text: JSON.stringify({ status: "BLOCK", error: error instanceof Error ? error.message : String(error), retryPolicy: "Do not automatically retry a possibly executed mutation; reconcile project and receipt first." }) }] });
      break;
    }
  }
  return rows;
}
