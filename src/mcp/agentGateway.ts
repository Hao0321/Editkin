// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 djguan-jpg (https://github.com/djguan-jpg)
// Agent contribution: urn:uuid:d366cab7-d5a4-44d8-b80d-4c7ce4daf65d. See AGENT-NOTICE.md.
/** A compact ACP-facing catalog. Calls still execute in the original Editkin MCP. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readKitPlanContext, readKitResource, listKitResources, runKitWorkflow, verifyKitRunOriginalSources } from "./kitWorkflowBridge";
import { originalAgentSkills } from "./agentSkillResources";
import { inspectKitProjectExternalSources, pinKitProjectExternalSources } from "./kitSourceStaging";
import { KitSourceJobs } from "./kitSourceJobs";
import { AgentKitMutationClaimGuard, assertAgentToolBoundary, expectedKitReceiptTools, kitReceiptReferences, sameCanonicalJson } from "./agentToolBoundary";
import { AgentResultStore } from "./agentResultStore";
import { draftKitSingleClipPlan } from "./kitSingleClipDraft";
import { draftKitTwoClipStoryPlan } from "./kitTwoClipDraft";
import { finishKitSingleClipEdit, finishKitTwoClipEdit } from "./kitSingleClipFinish";
import { editCommandSchemaView } from "./editCommandSchemaView";
import { readOwnSchemaProperty } from "./jsonSchemaTraversal";
import { agentToolCallSchema } from "./agentGatewaySchemas";
import { getAgentTaskGuidance, agentGuidanceTasks } from "../application/agentTaskGuidance";
import { agentRunArgument } from "./agentRunArgument";
import agentProvenance from "../shared/agentProvenance.json";

type Frame = { jsonrpc: "2.0"; id?: number | string; method?: string; params?: any; result?: any; error?: { code: number; message: string } };
const targetPath = process.env.EDITKIN_AGENT_GATEWAY_TARGET;
if (!targetPath || !isAbsolute(targetPath) || !existsSync(targetPath) || resolve(targetPath) === fileURLToPath(import.meta.url)) {
  throw new Error("Editkin Agent gateway target is missing or invalid");
}
if (process.env.EDITKIN_WORKSPACE && process.env.EDITKIN_AGENT_PROJECT_PATH)
  pinKitProjectExternalSources(process.env.EDITKIN_WORKSPACE, process.env.EDITKIN_AGENT_PROJECT_PATH);
const target = spawn(process.execPath, [targetPath], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "EDITKIN_AGENT_GATEWAY_TARGET")) });
let targetAlive = true;
let incoming = "";
let targetIncoming = "";
let nextTargetId = 0;
let catalog: any[] | undefined;
let catalogPromise: Promise<any[]> | undefined;
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; toolName?: string }>();
const calls = new Map<number | string, number>();
let uncertainApply = false;
let uncertainRender = false;
const applyClaims = new AgentKitMutationClaimGuard("apply", "apply_autopilot_plan");
const renderClaims = new AgentKitMutationClaimGuard("render", "render_project");
const retained = new AgentResultStore<{ run: string; tool: string; arguments: Record<string, unknown>; result: any; bytes: number; expiresAt: number }>(4096, 64 * 1024 * 1024);
const retainableTools = new Set(["get_autopilot_contract", "start_ai_editing_session", "prepare_ai_material", "view_material_keyframes",
  "get_material_preparation_job", "get_material_context", "record_material_semantics", "resolve_autopilot_inference_route",
  "list_installed_plugins", "audit_autopilot_plan", "apply_autopilot_plan", "render_project", "record_autopilot_outcome"]);
const retentionMs = 6 * 60 * 60_000;
let sourceJobs: KitSourceJobs | undefined;
function kitSourceJobs() {
  return sourceJobs ??= new KitSourceJobs(process.env.EDITKIN_WORKSPACE || "", process.env.EDITKIN_AGENT_PROJECT_PATH || "",
    (input, options) => runKitWorkflow(input, undefined, options));
}
function retainResult(run: string, tool: string, args: Record<string, unknown>, result: any) {
  const bytes = Buffer.byteLength(JSON.stringify(result));
  if (bytes > 8 * 1024 * 1024) return undefined;
  const resultRef = randomUUID();
  return retained.put(resultRef, { run, tool, arguments: args, result, bytes, expiresAt: Date.now() + retentionMs }) ? resultRef : undefined;
}
function resolveReceipt(value: unknown, run: string, step: string, used: Set<string>, depth = 0, budget = { nodes: 0 }): any {
  if (++budget.nodes > 65536 || depth > 32) throw Error("Receipt template is too large");
  if (Array.isArray(value)) return value.map((part) => resolveReceipt(part, run, step, used, depth + 1, budget));
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (Object.keys(object).length === 1 && typeof object.$resultRef === "string") {
      const item = retained.get(object.$resultRef);
      if (!item || item.run !== run) throw Error("Result reference is expired or belongs to another run");
      if (!expectedKitReceiptTools(step).includes(item.tool)) throw Error("Result reference came from the wrong Editkin tool for this Kit step");
      used.add(object.$resultRef);
      return item.result;
    }
    return Object.fromEntries(Object.entries(object).map(([key, part]) => [key, resolveReceipt(part, run, step, used, depth + 1, budget)]));
  }
  return value;
}
const send = (stream: NodeJS.WritableStream, frame: Frame) => stream.write(JSON.stringify(frame) + "\n");
const failure = (error: unknown) => error instanceof Error ? error.message : String(error);
function readLines(chunk: string, current: string, accept: (frame: Frame) => void): string {
  current += chunk;
  if (current.length > 5_000_000) throw new Error("Editkin Agent gateway frame too large");
  for (;;) {
    const index = current.indexOf("\n");
    if (index < 0) return current;
    const line = current.slice(0, index).trim(); current = current.slice(index + 1);
    if (line) accept(JSON.parse(line) as Frame);
  }
}
function targetRequest(method: string, params: any, timeoutMs = 30_000, outerId?: number | string): Promise<any> {
  if (!targetAlive) return Promise.reject(Error("Editkin MCP is unavailable; the Kit controller can still inspect existing runs"));
  const id = ++nextTargetId;
  return new Promise((resolve, reject) => {
    if (outerId !== undefined) calls.set(outerId, id);
    const timer = setTimeout(() => {
      pending.delete(id); if (outerId !== undefined) calls.delete(outerId);
      if (method === "tools/call" && params?.name === "apply_autopilot_plan") uncertainApply = true;
      if (method === "tools/call" && params?.name === "render_project") uncertainRender = true;
      reject(new Error(`${method} timed out; outcome may be unknown. Inspect the Kit run and project receipt before any retry`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer, toolName: method === "tools/call" ? params?.name : undefined });
    try { send(target.stdin, { jsonrpc: "2.0", id, method, params }); }
    catch (error) { clearTimeout(timer); pending.delete(id); if (outerId !== undefined) calls.delete(outerId); reject(error); }
  });
}
target.stdout.setEncoding("utf8");
target.stdout.on("data", (chunk: string) => {
  try { targetIncoming = readLines(chunk, targetIncoming, (frame) => {
    if (typeof frame.id !== "number") return;
    const waiter = pending.get(frame.id); if (!waiter) return;
    clearTimeout(waiter.timer); pending.delete(frame.id);
    for (const [outerId, targetId] of calls) if (targetId === frame.id) calls.delete(outerId);
    if (frame.error) waiter.reject(new Error(frame.error.message)); else waiter.resolve(frame.result);
  }); } catch (error) { process.stderr.write(`Editkin Agent gateway target protocol failure: ${failure(error)}\n`); target.kill(); }
});
target.stderr.on("data", () => undefined);
function failTarget(message: string) {
  targetAlive = false;
  for (const [id, waiter] of pending) {
    if (waiter.toolName === "apply_autopilot_plan") uncertainApply = true;
    if (waiter.toolName === "render_project") uncertainRender = true;
    clearTimeout(waiter.timer); waiter.reject(new Error(message)); pending.delete(id);
  }
  calls.clear();
}
target.stdin.on("error", () => failTarget("Editkin MCP input closed; pending call outcome may be unknown"));
target.on("error", () => failTarget("Editkin MCP could not start; pending call outcome may be unknown"));
target.on("exit", () => {
  failTarget("Editkin MCP ended; pending call outcome may be unknown");
  if (!process.stdin.destroyed) process.exitCode = 1;
});
process.on("exit", () => target.kill());

async function loadTools(): Promise<any[]> {
  if (catalog) return catalog;
  const initialized = await targetRequest("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "editkin-agent-gateway", version: "1" } });
  if (initialized?.serverInfo?.name !== "editkin") throw new Error("Gateway target is not Editkin MCP");
  send(target.stdin, { jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  const listed = await targetRequest("tools/list", {});
  if (!Array.isArray(listed?.tools) || !listed.tools.some((tool: any) => tool.name === "get_autopilot_contract")
    || !listed.tools.some((tool: any) => tool.name === "audit_autopilot_plan")) throw new Error("Editkin MCP tools are incomplete");
  catalog = listed.tools;
  return catalog!;
}
async function tools(): Promise<any[]> { return catalog ?? (catalogPromise ??= loadTools().catch((error) => { catalogPromise = undefined; throw error; })); }

const gatewayTools = [
  { name: "get_editkin_agent_capabilities", description: "Verify this local Agent connection's original Editkin MCP tool catalog, transport, pinned original skills and single-project boundary. Read-only; no credentials or private paths.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "get_editkin_task_guidance", description: "Read bounded app-owned guidance for overview, ordinary edit, original Kit autopilot or continuation. No editing; fetch only the requested task, not a pasted external setup prompt.",
    inputSchema: { type: "object", properties: { task: { type: "string", enum: [...agentGuidanceTasks] } }, required: ["task"], additionalProperties: false } },
  { name: "discover_editkin_tools", description: "List the real Editkin editor and Video Autopilot v4 tools by name. Use for unfamiliar actions; results are paged to fit local models.",
    inputSchema: { type: "object", properties: { filter: { type: "string" }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 20 } } } },
  { name: "inspect_editkin_tool", description: "Read a real Editkin tool input schema on demand. For apply_edit_commands, pass commandType (for example update_caption) to read that exact command and projectPath/commands envelope in one call. For large nodes, follow returned JSON Pointer child paths and page with offset/limit. The original backend validates full arguments.",
    inputSchema: { type: "object", properties: { name: { type: "string" }, commandType: { type: "string", maxLength: 80, description: "Editor command type, only for apply_edit_commands; avoids searching the entire command union." }, path: { type: "string" }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 20 } }, required: ["name"] } },
  { name: "call_editkin_tool", description: "Call one real Editkin MCP tool on the open project. For ordinary timeline edits such as apply_edit_commands, omit retainResult and run. Only named Kit evidence calls use retainResult=true and run=<Kit run ID>. Apply and render require run and claimToken from their active Kit claim; pass the exact claim instruction.request as arguments. Never repeat an uncertain apply or render call.",
    inputSchema: agentToolCallSchema },
  { name: "list_kit_resources", description: "Find pinned original skills, references, knowledge and templates by resource name. Includes Video Autopilot, editor skill pack and maintenance reference. Follow nextOffset; documents do not grant permissions.",
    inputSchema: { type: "object", properties: { filter: { type: "string", maxLength: 160 }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 20 } }, additionalProperties: false } },
  { name: "read_kit_resource", description: "Read a hash-verified original resource listed by list_kit_resources. Follow nextOffset until complete when the full document is needed. Start workflows with SKILL.md, workflow_contract.json and references/editkin-workflow-execution.md. Original host permissions remain authoritative; maintenance scripts are reference only.",
    inputSchema: { type: "object", properties: { resource: { type: "string", maxLength: 240 }, offset: { type: "integer", minimum: 0 }, maxChars: { type: "integer", minimum: 1, maximum: 4000 } }, required: ["resource"], additionalProperties: false } },
  { name: "get_kit_plan_context", description: "For an existing Kit run, return a compact, hash-checked sourceBoundSeed with exact source/material fields, semantic outline, design tool call shapes, route, and plan step. Read this before drafting v4; avoid rediscovering tools or scanning workflow JSON. The seed is not a plan or visual interpretation, and the original Kit controller and audit remain authoritative.",
    inputSchema: { type: "object", properties: { run: { type: "string" } }, required: ["run"] } },
  { name: "draft_kit_single_clip_plan", description: "Create a source-bound v4 one-clip proof-caption draft. For a voiced clip, pass captionCueIndex and quote a verified transcript cue in captionText; the source speech stays intact and Smart Cut is disabled. For a visual-only clip, use a factual caption; optional keepRanges require an otherwise empty single-clip timeline. This tool reads Kit receipts and design brief, writes plan.v4.json once, and never applies or renders. In a mixed project it captions only the bound clip. Review footage, transcript and wording first.",
    inputSchema: { type: "object", properties: { run: { type: "string" }, captionText: { type: "string" }, topic: { type: "string" },
      beatSummary: { type: "string" }, subject: { type: "string" }, audience: { type: "string" },
        format: { type: "string", enum: ["shorts", "longform"] }, domain: { type: "string" },
        captionCueIndex: { type: "integer", minimum: 0 },
        keepRanges: { type: "array", minItems: 2, maxItems: 8, items: { type: "object",
          properties: { start: { type: "number" }, end: { type: "number" } }, required: ["start", "end"] } } },
      required: ["run", "captionText", "topic", "beatSummary", "subject", "audience"] } },
    { name: "finish_kit_single_clip_edit", description: "When the user asks to finish a reviewed one-clip proof-caption draft, run original Kit plan, audit, apply and render gates in one Agent process. A voiced clip must preserve its source dialogue, use a caption timed to a cited transcript cue and cannot be Smart Cut. A visual-only clip may use an evidence-aligned Smart Cut. In a mixed project only the bound clip receives a caption; this does not fulfill a full-story request. Stops at human-review. Never retry an uncertain mutation without checking Kit state.",
    inputSchema: { type: "object", properties: { run: { type: "string" } }, required: ["run"] } },
  { name: "draft_kit_two_clip_story_plan", description: "Create a source-bound v4 story draft for exactly two silent source clips. Give two ordered beats, each with its bound clipId, factual summary, focus and editable caption. Editkin verifies both Kit semantic receipts and writes a plan that actually reorders the source clips. This tool only drafts. If the user already requested an output video, call finish_kit_two_clip_edit immediately after a valid draft; do not ask for another confirmation.",
    inputSchema: { type: "object", properties: { run: { type: "string" }, topic: { type: "string" },
      audience: { type: "string" }, domain: { type: "string" },
      beats: { type: "array", minItems: 2, maxItems: 2, items: { type: "object", properties: {
        clipId: { type: "string" }, summary: { type: "string" }, focus: { type: "string" },
        captionText: { type: "string" } }, required: ["clipId", "summary", "focus", "captionText"] } } },
      required: ["run", "topic", "audience", "beats"] } },
  { name: "finish_kit_two_clip_edit", description: "When the user's request includes output/render/show me the video, finish a valid two-clip visual-only story draft through original Kit plan, audit, apply and render in one Agent process without an extra confirmation. Accepts only the two bound source clips and one editable caption per beat; stops at human-review. Do not invoke for a draft-only request or retry an uncertain mutation.",
    inputSchema: { type: "object", properties: { run: { type: "string" } }, required: ["run"] } },
  { name: "run_kit_workflow", description: "Invoke the original Kit workflow_contract.py controller for create/status/next/claim/complete/fail/context-next/resume/verify/reject-render. For create, pass clipIds with the selected clip ID to bind only that clip, or omit clipIds and materials to bind all real clips. Editkin automatically binds project image clips as visual-only; transcriptPolicies controls transcription, not clip selection. Do not guess source paths. Editkin copies selected external imports into a verified workspace snapshot without changing the project or originals; demo clips are excluded. Large external sources return PREPARING with preparationId: use source-status, source-cancel or source-resume. If create fails before returning a run, do not call status without a run or blindly retry. Do not create again while preparation is active. Use next then claim; execute the issued Editkin tool with retainResult=true. A required transcript with blocked recognition cannot complete prepare; report the recognizer error and stop this run, never relabel failed speech recognition as visual-only. Missing trusted keyframes due to incomplete or contradictory source colour tags also stops the run; correct the source or interpretation before creating another run. Apply/render need claim_token. Machine steps require receiptTemplate with {$resultRef:id}; only plan accepts a workspace receipt file. Human review and uncertain apply reconciliation cannot be claimed by this Agent.",
    inputSchema: { type: "object", properties: {
      command: { type: "string", enum: ["create", "status", "next", "claim", "complete", "fail", "context-next", "resume", "verify", "reject-render", "source-status", "source-cancel", "source-resume"] },
      preparationId: { type: "string" },
      run: { type: "string" }, step: { type: "string" }, token: { type: "string" }, receipt: { type: "string" }, receiptTemplate: { type: "object" }, reason: { type: "string" }, evidence: { type: "string" },
      runId: { type: "string" }, project: { type: "string" }, materials: { type: "array", items: { type: "object", properties: { clipId: { type: "string" }, sourcePath: { type: "string" } }, required: ["clipId", "sourcePath"] } },
      taskClass: { type: "string" }, priority: { type: "string" }, maxRetries: { type: "integer" },
      keyframeTimes: { type: "array", items: { type: "object", properties: { clipId: { type: "string" }, times: { type: "array", items: { type: "number" } } }, required: ["clipId", "times"] } },
      clipIds: { type: "array", minItems: 1, maxItems: 32, items: { type: "string" }, description: "Clip IDs from the current project to bind; omit for all real clips. Mutually exclusive with materials." },
      transcriptPolicies: { type: "array", items: { type: "object", properties: { clipId: { type: "string" }, policy: { type: "string", enum: ["required", "visual-only"] } }, required: ["clipId", "policy"] } }, limit: { type: "integer" }
    }, required: ["command"] } },
];
const textResult = (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
const pointerPart = (part: string) => part.replace(/~/g, "~0").replace(/\//g, "~1");
function schemaPart(schema: any, path: string): any {
  if (!path) return schema;
  if (!path.startsWith("/") || path.length > 512) throw Error("Schema path must be a bounded JSON Pointer");
  const parts = path.slice(1).split("/");
  if (parts.length > 20) throw Error("Schema path is too deep");
  let current = schema;
  for (const part of parts) {
    const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
    current = readOwnSchemaProperty(current, key, "Schema path does not exist");
  }
  return current;
}
let verifiedContextRun: string | undefined;
async function call(name: string, args: any, outerId?: number | string) {
  if (name === "get_editkin_agent_capabilities") {
    const catalog = await tools();
    return textResult({ schema: "editkin.agent-capabilities/v1", editor: "editkin", transport: "local-stdio-mcp",
      agentControl: "local-stdio-acp", desktopControl: "tauri-ipc/resident-service",
      editorToolCount: catalog.length, editorToolCatalogSha256: createHash("sha256").update(JSON.stringify(catalog.map((tool) => tool.name).sort())).digest("hex"),
      projectProtocol: "EditorCommand/applyCommand; validated revisioned atomic working-project writes; desktop reload and undo",
      skills: originalAgentSkills, skillAccess: "paged pinned references; editor skill packs require original host grants",
      scope: "one bound project; workspace-wide creation, batches and remote setup require a separate host flow" });
  }
  if (name === "get_editkin_task_guidance") return textResult(getAgentTaskGuidance(args?.task));
  if (name === "list_kit_resources") return textResult(listKitResources(args ?? {}));
  if (name === "read_kit_resource") return textResult(await readKitResource(String(args?.resource || ""), args ?? {}));
  if (name === "get_kit_plan_context") {
    const context = await readKitPlanContext(agentRunArgument(args?.run, name));
    verifiedContextRun = context.run;
    return textResult(context);
  }
  if (name === "draft_kit_single_clip_plan") return textResult(await draftKitSingleClipPlan(args || {}, async (tool, input) => {
    const result = await targetRequest("tools/call", { name: tool, arguments: input }, 60_000, outerId);
    const content = result?.content?.find((part: any) => part?.type === "text" && typeof part.text === "string")?.text;
    if (result?.isError || !content) throw Error(`${tool} failed: ${String(content || "no text").slice(0, 500)}`);
    return JSON.parse(content);
  }));
  if (name === "finish_kit_single_clip_edit") return textResult(await finishKitSingleClipEdit({ run: agentRunArgument(args?.run, name, verifiedContextRun) }, call));
  if (name === "draft_kit_two_clip_story_plan") return textResult(await draftKitTwoClipStoryPlan(args || {}, async (tool, input) => {
    const result = await targetRequest("tools/call", { name: tool, arguments: input }, 60_000, outerId);
    const content = result?.content?.find((part: any) => part?.type === "text" && typeof part.text === "string")?.text;
    if (result?.isError || !content) throw Error(`${tool} failed: ${String(content || "no text").slice(0, 500)}`);
    return JSON.parse(content);
  }));
  if (name === "finish_kit_two_clip_edit") return textResult(await finishKitTwoClipEdit({ run: agentRunArgument(args?.run, name, verifiedContextRun) }, call));
  if (name === "run_kit_workflow") {
    if (args?.receiptTemplate === undefined) {
      if (["source-status", "source-cancel", "source-resume"].includes(args?.command)) {
        const id = String(args?.preparationId || "");
        return textResult(args.command === "source-status" ? kitSourceJobs().status(id)
          : args.command === "source-cancel" ? kitSourceJobs().cancel(id) : kitSourceJobs().resume(id));
      }
      if (args?.command === "context-next" || args?.command === "complete" && args?.step !== "plan")
        throw Error("Machine tool completion requires an in-memory result reference; only the plan artifact accepts a receipt file");
      if (args?.command === "create" && args.materials === undefined) {
        const checked = inspectKitProjectExternalSources(process.env.EDITKIN_WORKSPACE || "", process.env.EDITKIN_AGENT_PROJECT_PATH || "", args.clipIds);
        if (checked.bytes > 64 * 1024 * 1024) return textResult(kitSourceJobs().start(args, checked.sources));
      }
      const result = await runKitWorkflow(args || {});
      if (args?.command === "claim") { applyClaims.record(String(args.run || ""), result); renderClaims.record(String(args.run || ""), result); }
      if (args?.command === "complete" || args?.command === "fail") { applyClaims.forget(args.token); renderClaims.forget(args.token); }
      return textResult(result);
    }
    if (!args || typeof args !== "object" || !["complete", "context-next"].includes(args.command)
      || !args.run || typeof args.step !== "string" || !args.receiptTemplate || typeof args.receiptTemplate !== "object" || Array.isArray(args.receiptTemplate)) throw Error("Receipt template requires complete/context-next, a Kit run and step");
    const references = kitReceiptReferences(args.command, args.step, args.receiptTemplate);
    for (const reference of references) {
      const item = retained.get(reference.id);
      if (item && reference.request && !sameCanonicalJson(item.arguments, reference.request)) throw Error("Kit receipt request differs from the actual Editkin tool call");
    }
    const used = new Set<string>();
    const receipt = resolveReceipt(args.receiptTemplate, String(args.run), args.step, used) as Record<string, unknown>;
    if (used.size !== references.length) throw Error("Kit receipt references must each be used once in the result field");
    let result: unknown;
    try { result = await runKitWorkflow(args, receipt); }
    catch (error) {
      const detail = failure(error);
      if (args.command === "complete" && args.step.startsWith("prepare:")
        && typeof args.token === "string" && detail.includes("Required transcript is not ready at material preparation")) {
        const reason = `REQUIRED_TRANSCRIPT_UNAVAILABLE: ${detail.replace(/[\x00-\x1f]/g, " ")}`.slice(0, 900);
        const failed = await runKitWorkflow({ command: "fail", run: args.run, step: args.step, token: args.token, reason });
        for (const id of used) retained.delete(id);
        return { content: [{ type: "text", text: JSON.stringify({ status: "BLOCKED_REQUIRED_TRANSCRIPT",
          run: args.run, step: args.step, failure: failed,
          detail, nextAction: "本機語音辨識器無法完成必要逐字稿；此 run 已停止。配置語音辨識器後建立新 run，或由使用者明確指定無對白片段採 visual-only。不要重試同一個 prepare claim。" }) }], isError: true };
      }
      if (args.command === "complete" && args.step.startsWith("prepare:") && typeof args.token === "string"
        && (detail.includes("source colour tags are incomplete")
          || detail.includes("source colour tags contradict the project interpretation"))) {
        const reason = `MATERIAL_VISUAL_EVIDENCE_UNAVAILABLE: ${detail.replace(/[\x00-\x1f]/g, " ")}`.slice(0, 900);
        const failed = await runKitWorkflow({ command: "fail", run: args.run, step: args.step, token: args.token, reason });
        for (const id of used) retained.delete(id);
        return { content: [{ type: "text", text: JSON.stringify({ status: "BLOCKED_VISUAL_EVIDENCE",
          reasonCode: detail.includes("source colour tags are incomplete") ? "incomplete-color-tags" : "contradictory-color-interpretation",
          run: args.run, step: args.step, failure: failed,
          nextAction: "來源影片無法產生可信畫面證據；此 run 已停止。請核對原片色彩標籤，使用具完整色彩資訊的副本或修正相衝突的解讀後再建立新 run。不要重試同一個 prepare claim，也不要把語音改標為無對白。" }) }], isError: true };
      }
      throw error;
    }
    if (args.command === "complete") for (const id of used) retained.delete(id);
    if (args.command === "complete") { applyClaims.forget(args.token); renderClaims.forget(args.token); }
    return textResult(result);
  }
  const all = await tools();
  if (name === "discover_editkin_tools") {
    const filter = String(args?.filter || "").toLowerCase().slice(0, 100);
    const offset = Math.max(0, Math.min(1000, Number(args?.offset) || 0));
    const limit = Math.max(1, Math.min(20, Number(args?.limit) || 12));
    const matches = all.filter((item) => item.name.toLowerCase().includes(filter));
    return textResult({ total: matches.length, offset, tools: matches.slice(offset, offset + limit).map((item) => ({ name: item.name,
      description: String(item.description || "").slice(0, 180) })) });
  }
  if (name === "inspect_editkin_tool") {
    const selected = all.find((item) => item.name === args?.name);
    if (!selected) throw new Error("Unknown Editkin tool");
    if (args?.commandType !== undefined && selected.name !== "apply_edit_commands") throw Error("commandType is only supported for apply_edit_commands");
    const view = args?.commandType !== undefined ? editCommandSchemaView(selected.inputSchema || {}, args.commandType) : undefined;
    const schema = view?.inputSchema || selected.inputSchema || {};
    const path = typeof args?.path === "string" ? args.path : "";
    const part = schemaPart(schema, path);
    const schemaBytes = Buffer.byteLength(JSON.stringify(part));
    const base = { name: selected.name, path, description: String(selected.description || "").slice(0, 800), schemaBytes,
      ...(view ? { commandType: view.commandType, sourceSchemaPath: view.sourceSchemaPath, referencePaths: view.referencePaths, note: view.note } : {}) };
    if (schemaBytes <= 20_000) return textResult({ ...base, inputSchema: part });
    if (!part || typeof part !== "object") throw Error("Schema node exceeds the reading limit");
    const offset = Math.max(0, Math.min(10_000, Number(args?.offset) || 0));
    const limit = Math.max(1, Math.min(20, Number(args?.limit) || 12));
    const keys = Object.keys(part);
    const children = keys.slice(offset, offset + limit).map((key) => {
      const value = readOwnSchemaProperty(part, key, "Schema path does not exist");
      const record = value && typeof value === "object" ? value as Record<string, unknown> : undefined;
      return { key, path: `${path}/${pointerPart(key)}`, bytes: Buffer.byteLength(JSON.stringify(value)),
        type: record && typeof record.type === "string" ? record.type : record ? (Array.isArray(value) ? "array" : "object") : typeof value,
        description: String(record?.description || "").slice(0, 180) };
    });
    return textResult({ ...base, totalChildren: keys.length, offset, hasMore: offset + limit < keys.length, children,
      note: "Follow child paths to inspect the full schema in bounded pieces; use the Kit contract and Editkin audit for final validation." });
  }
  if (name === "call_editkin_tool") {
    const selected = all.find((item) => item.name === args?.name);
    if (!selected) throw new Error("Unknown Editkin tool");
    if (!args.arguments || typeof args.arguments !== "object" || Array.isArray(args.arguments)) throw new Error("Editkin arguments must be an object");
    const workspace = process.env.EDITKIN_WORKSPACE || "", project = process.env.EDITKIN_AGENT_PROJECT_PATH || "";
    assertAgentToolBoundary(selected.name, args.arguments, workspace, project);
    // A model can add the optional evidence flag to an ordinary timeline edit.
    // With no Kit run there is nothing to retain, so execute the edit normally.
    // A named run still must reject this non-evidence tool as a Kit receipt.
    const retainEvidence = args?.retainResult === true
      && !(selected.name === "apply_edit_commands" && !args?.run);
    if ((selected.name === "apply_autopilot_plan" || selected.name === "render_project") && args?.retainResult !== true)
      throw Error(`${selected.name} requires retained evidence for Kit completion`);
    const run = retainEvidence ? String(args?.run || "") : "";
    if (retainEvidence) {
      if (!retainableTools.has(selected.name) || !run || run.length > 1024) throw Error("Only evidence tools in a named Kit run can retain raw results");
      await runKitWorkflow({ command: "status", run });
    }
    if (selected.name === "apply_autopilot_plan" || selected.name === "render_project")
      await verifyKitRunOriginalSources(String(args.run || ""));
    if (selected.name === "apply_autopilot_plan") {
      if (uncertainApply) throw Error("An earlier apply outcome is unknown in this Agent session; reconcile the Kit run before another apply");
      applyClaims.use(args.run, args.claimToken, args.arguments);
    }
    if (selected.name === "render_project") {
      if (uncertainRender) throw Error("An earlier render outcome is unknown in this Agent session; inspect the Kit run and output before another render");
      renderClaims.use(args.run, args.claimToken, args.arguments);
    }
    const result = await targetRequest("tools/call", { name: selected.name, arguments: args.arguments },
      selected.name === "render_project" ? 25 * 60_000 : 10 * 60_000, outerId);
    if (!retainEvidence || result?.isError === true) return result;
    const resultRef = retainResult(run, selected.name, args.arguments, result);
    return { ...result, content: [...(Array.isArray(result?.content) ? result.content : []),
      { type: "text", text: JSON.stringify(resultRef ? { resultRef, expiresInSeconds: retentionMs / 1000,
        note: "Use {$resultRef:id} inside run_kit_workflow receiptTemplate; this gateway keeps the raw result in memory and writes no receipt file." }
        : { retained: false, note: "Evidence store is full or this result exceeds its limit; existing references were preserved. Complete a pending Kit step or reconnect after inspecting run state. Do not retry a mutating call without reconciliation." }) }] };
  }
  throw new Error("Unknown gateway tool");
}
async function handle(frame: Frame) {
  if (frame.method === "initialize" && frame.id !== undefined) {
    send(process.stdout, { jsonrpc: "2.0", id: frame.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} },
      serverInfo: { name: "editkin-agent-gateway", version: "1" },
      _meta: { "editkin.agentProvenance": agentProvenance },
      instructions: "Compact tools expose the Editkin editor and Video Autopilot Kit controller. Inspect the available tools, then follow Kit claim requests. For image evidence use in-memory resultRef and receiptTemplate. Audit and apply stay in the original v4 workflow." } });
  } else if (frame.method === "tools/list" && frame.id !== undefined) {
    send(process.stdout, { jsonrpc: "2.0", id: frame.id, result: { tools: gatewayTools } });
  } else if (frame.method === "tools/call" && frame.id !== undefined) {
    try { const result = await call(String(frame.params?.name || ""), frame.params?.arguments || {}, frame.id);
      send(process.stdout, { jsonrpc: "2.0", id: frame.id, result }); }
    catch (error) { send(process.stdout, { jsonrpc: "2.0", id: frame.id, result: { content: [{ type: "text", text: failure(error) }], isError: true } }); }
  } else if (frame.method === "notifications/cancelled") {
    const targetId = calls.get(frame.params?.requestId);
    if (targetId) {
      if (pending.get(targetId)?.toolName === "apply_autopilot_plan") uncertainApply = true;
      if (pending.get(targetId)?.toolName === "render_project") uncertainRender = true;
      send(target.stdin, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: targetId } });
    }
  } else if (frame.method && frame.id !== undefined) {
    send(process.stdout, { jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: "Unsupported MCP method" } });
  }
}
process.stdin.setEncoding("utf8");
process.stdin.on("end", () => { sourceJobs?.interrupt(); target.kill(); process.exit(0); });
process.stdin.on("data", (chunk: string) => {
  try { incoming = readLines(chunk, incoming, (frame) => { void handle(frame).catch((error) => process.stderr.write(`${failure(error)}\n`)); }); }
  catch (error) { process.stderr.write(`Editkin Agent gateway input failure: ${failure(error)}\n`); process.exitCode = 1; process.stdin.destroy(); }
});
