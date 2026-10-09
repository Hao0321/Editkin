// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 djguan-jpg (https://github.com/djguan-jpg)
// Agent contribution: urn:uuid:d366cab7-d5a4-44d8-b80d-4c7ce4daf65d. See AGENT-NOTICE.md.
/** The dock owns one saved project. Workspace-wide operations need a separate UI flow. */
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import { assertAgentMaterialId, boundAgentProjectScope } from "./agentMaterialAccess";

const workspaceWideTools = new Set([
  "create_project", "audit_editorial_batch_plan", "create_editorial_batch_projects", "render_editorial_batch",
  "run_autopilot_batch", "start_autopilot_batch_job", "get_autopilot_batch_job", "get_autopilot_batch_status", "cancel_autopilot_batch_job",
  "prepare_remote_setup", "get_remote_setup_status", "configure_remote_access", "verify_remote_access", "list_remote_provider_connectors",
]);

export function assertAgentToolBoundary(name: string, args: Record<string, unknown>, workspace: string, project: string): void {
  if (workspaceWideTools.has(name)) throw new Error(`${name} is outside this single-project Agent session`);
  if (!Object.prototype.hasOwnProperty.call(args, "projectPath")) return;
  if (typeof args.projectPath !== "string" || !args.projectPath.trim()) throw new Error("Editkin projectPath must name the open project");
  const candidate = isAbsolute(args.projectPath) ? args.projectPath : resolve(workspace, args.projectPath);
  let actual: string;
  try { actual = realpathSync(candidate); } catch { throw new Error("Editkin projectPath is unavailable"); }
  if (actual !== realpathSync(project)) throw new Error("Editkin tool targets another project; switch the editor project and reconnect the Agent first");
}

/** The original MCP is also launched directly by the formal Agent runtime. */
export function bindAgentToolRegistration(server: McpServer, environment: NodeJS.ProcessEnv): McpServer {
  const scope = boundAgentProjectScope(environment);
  if (!scope) return server;
  const workspace = environment.EDITKIN_WORKSPACE || "";
  const project = environment.EDITKIN_AGENT_PROJECT_PATH || "";
  const modelRoot = environment.EDITKIN_MODEL_ROOT ?? join(workspace, ".editkin-models");
  const cacheRoot = environment.EDITKIN_CACHE_ROOT ?? resolve(modelRoot, "../media-cache");
  const original = server.registerTool.bind(server) as (name: string, configuration: any, callback: (...args: any[]) => any) => any;
  server.registerTool = ((name: string, configuration: any, callback: (...args: any[]) => any) =>
    original(name, configuration, async (...values: any[]) => {
      const args = values[0];
      if (!args || typeof args !== "object" || Array.isArray(args)) throw Error("Editkin tool arguments must be an object");
      assertAgentToolBoundary(name, args, workspace, project);
      const materialId = name === "record_roto_keyer_evidence" ? args.evidence?.materialId : args.materialId;
      if (typeof materialId === "string") await assertAgentMaterialId(cacheRoot, scope, materialId);
      return callback(...values);
    })) as typeof server.registerTool;
  return server;
}

export function expectedKitReceiptTools(step: string): string[] {
  if (step.startsWith("prepare:")) return ["prepare_ai_material", "get_material_preparation_job"];
  if (step.startsWith("keyframes:")) return ["view_material_keyframes"];
  if (step.startsWith("context:")) return ["get_material_context"];
  if (step.startsWith("semantics:")) return ["record_material_semantics"];
  const byStep: Record<string, string> = {
    contract: "get_autopilot_contract", session: "start_ai_editing_session", route: "resolve_autopilot_inference_route",
    "plugin-discovery": "list_installed_plugins", audit: "audit_autopilot_plan", apply: "apply_autopilot_plan",
    render: "render_project", outcome: "record_autopilot_outcome",
  };
  return byStep[step] ? [byStep[step]] : [];
}

export function allowsUnreferencedKitReceipt(command: string, step: string, receipt: Record<string, unknown>): boolean {
  return command === "complete" && (step === "plan"
    || step.startsWith("keyframes:") && String(receipt.status).toUpperCase() === "N/A"
      && Array.isArray(receipt.batches) && receipt.batches.length === 0);
}

type ReceiptReference = { id: string; request?: Record<string, unknown> };
function reference(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Kit receipt result must be a resultRef object");
  const object = value as Record<string, unknown>;
  if (Object.keys(object).length !== 1 || typeof object.$resultRef !== "string" || !object.$resultRef)
    throw new Error("Kit receipt result must be exactly {$resultRef:id}");
  return object.$resultRef;
}

export function kitReceiptReferences(command: string, step: string, template: Record<string, unknown>): ReceiptReference[] {
  if (allowsUnreferencedKitReceipt(command, step, template)) return [];
  if (step.startsWith("keyframes:") || step.startsWith("context:")) {
    const field = step.startsWith("keyframes:") ? "batches" : "windows";
    const records = template[field];
    if (!Array.isArray(records) || !records.length) throw new Error(`Kit ${field} receipt requires real tool call records`);
    return records.map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Kit ${field} record is invalid`);
      const record = value as Record<string, unknown>;
      if (!record.request || typeof record.request !== "object" || Array.isArray(record.request)) throw new Error(`Kit ${field} record needs its exact request`);
      return { id: reference(record.result), request: record.request as Record<string, unknown> };
    });
  }
  if (step.startsWith("semantics:")) {
    if (!template.request || typeof template.request !== "object" || Array.isArray(template.request)) throw new Error("Kit semantics receipt needs its exact request");
    return [{ id: reference(template.result), request: template.request as Record<string, unknown> }];
  }
  if (!expectedKitReceiptTools(step).length) throw new Error("Kit step has no machine tool receipt policy");
  return [{ id: reference(template) }];
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export const sameCanonicalJson = (left: unknown, right: unknown) => canonical(left) === canonical(right);

export class AgentKitMutationClaimGuard {
  private readonly claims = new Map<string, { run: string; requestSha256: string; attempted: boolean }>();

  constructor(private readonly step: "apply" | "render", private readonly tool: "apply_autopilot_plan" | "render_project") {}

  record(run: string, claim: { step?: string; claim_token?: string; instruction?: { tool?: string; request?: unknown } }): void {
    if (claim.step !== this.step || claim.instruction?.tool !== this.tool || !claim.claim_token || !claim.instruction.request) return;
    const requestSha256 = createHash("sha256").update(canonical(claim.instruction.request)).digest("hex");
    this.claims.set(claim.claim_token, { run, requestSha256, attempted: false });
  }

  use(run: unknown, token: unknown, request: unknown): void {
    const claim = typeof token === "string" ? this.claims.get(token) : undefined;
    const label = this.step === "apply" ? "Apply" : "Render";
    if (!claim || typeof run !== "string" || claim.run !== run) throw new Error(`${label} requires the active Kit ${this.step} claim from this Agent session`);
    if (claim.attempted) throw new Error(`This Kit ${this.step} claim has already been attempted; inspect the run before any retry`);
    const requestSha256 = createHash("sha256").update(canonical(request)).digest("hex");
    if (requestSha256 !== claim.requestSha256) throw new Error(`${this.step} arguments differ from the exact Kit claim request`);
    claim.attempted = true;
  }

  forget(token: unknown): void { if (typeof token === "string") this.claims.delete(token); }
}
