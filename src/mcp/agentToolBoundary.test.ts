// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 djguan-jpg (https://github.com/djguan-jpg)
// Agent contribution: urn:uuid:d366cab7-d5a4-44d8-b80d-4c7ce4daf65d. See AGENT-NOTICE.md.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentKitMutationClaimGuard, allowsUnreferencedKitReceipt, assertAgentToolBoundary, bindAgentToolRegistration, expectedKitReceiptTools, kitReceiptReferences } from "./agentToolBoundary";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("single-project Agent tool boundary", () => {
  it("accepts the open project and rejects another project or workspace-wide tools", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "editkin-agent-scope-")); roots.push(workspace);
    const project = join(workspace, "open.editkin.json"), other = join(workspace, "other.editkin.json");
    await writeFile(project, "{}"); await writeFile(other, "{}");
    expect(() => assertAgentToolBoundary("get_project_summary", { projectPath: "open.editkin.json" }, workspace, project)).not.toThrow();
    expect(() => assertAgentToolBoundary("apply_edit_commands", { projectPath: other }, workspace, project)).toThrow(/another project/);
    expect(() => assertAgentToolBoundary("create_project", { projectPath: "new.editkin.json" }, workspace, project)).toThrow(/single-project/);
    expect(() => assertAgentToolBoundary("configure_remote_access", {}, workspace, project)).toThrow(/single-project/);
    expect(() => assertAgentToolBoundary("run_autopilot_batch", {}, workspace, project)).toThrow(/single-project/);
  });

  it("applies the same boundary when the original MCP is launched directly", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "editkin-direct-scope-")); roots.push(workspace);
    const project = join(workspace, "open.editkin.json"), other = join(workspace, "other.editkin.json");
    await writeFile(project, "{}"); await writeFile(other, "{}");
    const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
    const server = { registerTool(name: string, _configuration: unknown, callback: (args: Record<string, unknown>) => Promise<unknown>) {
      handlers.set(name, callback);
    } };
    bindAgentToolRegistration(server as never, { EDITKIN_WORKSPACE: workspace, EDITKIN_AGENT_PROJECT_PATH: project });
    let invoked = 0;
    server.registerTool("get_project_summary", {}, async () => { invoked++; return { status: "GREEN" }; });
    server.registerTool("create_project", {}, async () => { invoked++; return { status: "GREEN" }; });
    await expect(handlers.get("get_project_summary")!({ projectPath: project })).resolves.toEqual({ status: "GREEN" });
    await expect(handlers.get("get_project_summary")!({ projectPath: other })).rejects.toThrow(/another project/);
    await expect(handlers.get("create_project")!({ projectPath: project })).rejects.toThrow(/single-project/);
    expect(invoked).toBe(1);
  });

  it("allows exactly one apply with the live Kit claim and exact request", () => {
    const guard = new AgentKitMutationClaimGuard("apply", "apply_autopilot_plan");
    const request = { projectPath: "project.editkin.json", plan: { schema: "v4", beats: [1] }, auditReceipt: { id: "a" } };
    guard.record("run-1", { step: "apply", claim_token: "claim-1", instruction: { tool: "apply_autopilot_plan", request } });
    expect(() => guard.use("run-2", "claim-1", request)).toThrow(/active Kit apply claim/);
    expect(() => guard.use("run-1", "claim-1", { ...request, auditReceipt: { id: "b" } })).toThrow(/differ/);
    expect(() => guard.use("run-1", "claim-1", { auditReceipt: { id: "a" }, plan: { beats: [1], schema: "v4" }, projectPath: "project.editkin.json" })).not.toThrow();
    expect(() => guard.use("run-1", "claim-1", request)).toThrow(/already been attempted/);
    guard.forget("claim-1");
    expect(() => guard.use("run-1", "claim-1", request)).toThrow(/active Kit apply claim/);
  });

  it("requires one exact Kit render claim for a long export", () => {
    const guard = new AgentKitMutationClaimGuard("render", "render_project");
    const request = { projectPath: "project.editkin.json", outputPath: "result.mp4", preferGpu: true };
    guard.record("run-1", { step: "render", claim_token: "render-1", instruction: { tool: "render_project", request } });
    expect(() => guard.use("run-1", "render-1", { ...request, outputPath: "other.mp4" })).toThrow(/differ/);
    expect(() => guard.use("run-1", "render-1", request)).not.toThrow();
    expect(() => guard.use("run-1", "render-1", request)).toThrow(/already been attempted/);
  });

  it("maps machine receipts to the tool that produced them", () => {
    expect(expectedKitReceiptTools("contract")).toEqual(["get_autopilot_contract"]);
    expect(expectedKitReceiptTools("prepare:m01-clip")).toContain("get_material_preparation_job");
    expect(expectedKitReceiptTools("keyframes:m01-clip")).toEqual(["view_material_keyframes"]);
    expect(expectedKitReceiptTools("apply")).toEqual(["apply_autopilot_plan"]);
    expect(expectedKitReceiptTools("plan")).toEqual([]);
    expect(allowsUnreferencedKitReceipt("complete", "plan", { artifact: "plan.v4.json" })).toBe(true);
    expect(allowsUnreferencedKitReceipt("complete", "keyframes:m01-clip", { status: "N/A", batches: [] })).toBe(true);
    expect(allowsUnreferencedKitReceipt("complete", "contract", { status: "GREEN" })).toBe(false);
    expect(allowsUnreferencedKitReceipt("context-next", "plan", {})).toBe(false);
    expect(kitReceiptReferences("complete", "contract", { $resultRef: "actual" })).toEqual([{ id: "actual" }]);
    expect(() => kitReceiptReferences("complete", "contract", { status: "GREEN", decoy: { $resultRef: "actual" } })).toThrow(/exactly/);
    expect(kitReceiptReferences("complete", "context:m01-clip", { status: "GREEN", windows: [
      { request: { materialId: "m1" }, result: { $resultRef: "page-1" } },
    ] })).toEqual([{ id: "page-1", request: { materialId: "m1" } }]);
    expect(() => kitReceiptReferences("complete", "context:m01-clip", { status: "GREEN", windows: [
      { request: { materialId: "m1" }, result: { status: "GREEN" }, decoy: { $resultRef: "page-1" } },
    ] })).toThrow(/resultRef/);
  });
});
