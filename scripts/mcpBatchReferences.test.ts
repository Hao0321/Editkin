import { describe, expect, it, vi } from "vitest";
import { batchResultIsBlocked, executeBatchCalls, resolveBatchArguments, validateBatchCalls, type BatchToolResult } from "./mcpBatchReferences";

const response = (payload: unknown, isError = false): BatchToolResult => ({ isError, content: [{ type: "text", text: JSON.stringify(payload) }] });
const reference = (callId: string, path: Array<string | number>) => ({ $result: { callId, path } });

describe("source MCP batch previous-result references", () => {
  it("passes the exact prior response value as inert JSON without changing review state", async () => {
    // Opaque transport fixture only; this is not a valid product audit receipt or a project mutation.
    const opaque = { proof: "opaque-test-transport-value", nested: { count: 1 } };
    const invoke = vi.fn(async (call, _argumentsValue: Record<string, unknown>) => call.id === "audit"
      ? response({ status: "ACCEPTED", auditReceipt: opaque })
      : response({ status: call.id === "apply" ? "REVIEW_REQUIRED" : "GREEN", certified: false }));
    const rows = await executeBatchCalls([
      { id: "audit", name: "audit_autopilot_plan" },
      { id: "apply", name: "apply_autopilot_plan", arguments: { auditReceipt: reference("audit", ["auditReceipt"]) } },
      { id: "preview", name: "render_project" },
    ], invoke);
    const argumentsValue = invoke.mock.calls[1][1] as { auditReceipt: typeof opaque };
    expect(argumentsValue.auditReceipt).toEqual(opaque);
    expect(argumentsValue.auditReceipt).not.toBe(opaque);
    expect(rows).toHaveLength(3);
    expect(rows[1].isError).toBe(false);
    expect(rows[1].content[0].text).toContain("REVIEW_REQUIRED");
    expect(rows[1].resultReferences).toEqual([{ callId: "audit", path: ["auditReceipt"] }]);
  });

  it("supports bounded object and array fields but does not execute nested response markers", () => {
    const previous = new Map([["first", response({ rows: [{ value: 42 }], inert: reference("not-a-real-call", []) })]]);
    expect(resolveBatchArguments({ x: reference("first", ["rows", 0, "value"]), data: reference("first", ["inert"]) }, previous).arguments)
      .toEqual({ x: 42, data: reference("not-a-real-call", []) });
  });

  it.each([
    { $result: { callId: "future", path: [] } },
    { $result: { callId: "first", path: ["missing"] } },
    { $result: { callId: "first", path: ["rows", 5] } },
    { $result: { callId: "first", path: ["rows", -1] } },
    { $result: { callId: "first", path: ["rows", 0.5] } },
    { $result: { callId: "first", path: ["rows", "0"] } },
    { $result: { callId: "first", path: ["__proto__"] } },
    { $result: { callId: "first", path: ["constructor"] } },
    { $result: { callId: "first", path: "rows.0" } },
    { $result: { callId: "first", path: [], extra: true } },
    { $result: { callId: "first", path: [] }, patch: "not permitted" },
  ])("rejects malformed, unsafe, missing and forward references: %j", marker => {
    expect(() => resolveBatchArguments({ marker }, new Map([["first", response({ rows: [1] })]]))).toThrow();
  });

  it.each([response({ status: "BLOCK" }), response({ status: "GREEN" }, true)])("stops on product BLOCK/isError and never calls the next tool", async blocked => {
    const invoke = vi.fn(async () => blocked);
    const rows = await executeBatchCalls([{ id: "first", name: "get_project_summary" }, { id: "never", name: "render_project" }], invoke);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].isError).toBe(true);
  });

  it("preserves successful earlier rows when resolution fails; no automatic retry", async () => {
    const invoke = vi.fn(async () => response({ status: "GREEN" }));
    const rows = await executeBatchCalls([
      { id: "first", name: "get_project_summary" },
      { id: "bad", name: "apply_autopilot_plan", arguments: { auditReceipt: reference("later", []) } },
      { id: "later", name: "render_project" },
    ], invoke);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(rows[1]).toMatchObject({ isError: true, failurePhase: "resolve_arguments", executionMayHaveOccurred: false });
  });

  it("marks a transport failure as potentially executed and does not retry", async () => {
    const invoke = vi.fn(async () => { throw new Error("connection closed"); });
    const rows = await executeBatchCalls([{ id: "apply", name: "apply_autopilot_plan" }, { id: "never", name: "render_project" }], invoke);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(rows[0]).toMatchObject({ isError: true, failurePhase: "call_tool", executionMayHaveOccurred: true });
  });

  it("marks capture failure after a successful call as ambiguous and retains the stop", async () => {
    const invoke = vi.fn(async () => response({ status: "REVIEW_REQUIRED" }));
    const rows = await executeBatchCalls([{ id: "apply", name: "apply_autopilot_plan" }, { id: "never", name: "render_project" }], invoke, async () => { throw new Error("capture disk full"); });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(rows[0]).toMatchObject({ isError: true, failurePhase: "capture_result", executionMayHaveOccurred: true });
  });

  it.each([
    { content: [{ type: "text", text: "not JSON" }] },
    { content: [{ type: "text", text: "{}" }, { type: "text", text: "{}" }] },
    { content: [{ type: "image", data: "irrelevant" }] },
    response({ status: "BLOCK" }),
  ])("rejects ambiguous, non-JSON and blocked referenced payloads", payload => {
    expect(() => resolveBatchArguments({ value: reference("first", []) }, new Map([["first", payload]]))).toThrow();
  });

  it.each(["../escape", "a/b", "a\\b", "", "a:b"])("rejects call ID unsuitable for captured filenames: %s", id => {
    expect(() => validateBatchCalls({ calls: [{ id, name: "get_project_summary" }] })).toThrow();
  });

  it("rejects duplicate IDs before invoking any tool", async () => {
    const invoke = vi.fn();
    await expect(executeBatchCalls([{ id: "same", name: "get_project_summary" }, { id: "same", name: "render_project" }], invoke)).rejects.toThrow(/unique/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("bounds expansion and rejects prototype-pollution data", () => {
    const huge = response({ value: "x".repeat(4 * 1024 * 1024 + 1) });
    expect(() => resolveBatchArguments({ value: reference("first", ["value"]) }, new Map([["first", huge]]))).toThrow(/bound/);
    expect(() => resolveBatchArguments(JSON.parse('{"__proto__":{"polluted":true}}'), new Map())).toThrow(/Unsafe/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("never classifies REVIEW_REQUIRED as failure or certification", () => {
    expect(batchResultIsBlocked(response({ status: "REVIEW_REQUIRED", certified: false }))).toBe(false);
  });
});
