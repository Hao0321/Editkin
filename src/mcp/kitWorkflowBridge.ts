// Agent integration: urn:uuid:d366cab7-d5a4-44d8-b80d-4c7ce4daf65d. Existing GPL license retained; see AGENT-NOTICE.md.
/** Bounded bridge to the selected Kit checkout's original durable controller. */
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { stageKitProjectSources, verifyKitRunExternalSources, type KitSourceOptions } from "./kitSourceStaging";
import { AUTOPILOT_PLAN_SCHEMA, autopilotPlanSha256, parseAutopilotPlan } from "../application/autopilotPlan";
import { timedEvidenceFrameCount } from "./kitSingleClipCut";
import { readOriginalSkillResource, listOriginalSkillResources } from "./agentSkillResources";

const execFileAsync = promisify(execFile);
const commands = ["create", "status", "next", "claim", "complete", "fail", "context-next", "resume", "verify", "reject-render"] as const;
type Command = typeof commands[number];
const within = (root: string, file: string) => {
  const rel = relative(root, file);
  return Boolean(rel) && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

function locations() {
  const skill = process.env.EDITKIN_VIDEO_AUTOPILOT_SKILL || "";
  const workspace = process.env.EDITKIN_WORKSPACE || "";
  const project = process.env.EDITKIN_AGENT_PROJECT_PATH || "";
  if (!isAbsolute(skill) || basename(skill) !== "SKILL.md" || !existsSync(skill)) throw Error("Selected Kit skill is unavailable");
  const root = realpathSync(resolve(skill, ".."));
  for (const name of ["workflow_contract.py", "workflow_contract.json"]) if (!existsSync(join(root, name))) throw Error("Selected Kit controller is incomplete");
  if (!isAbsolute(workspace) || !existsSync(workspace) || !isAbsolute(project) || !existsSync(project)) throw Error("Agent project binding is unavailable");
  const canonicalWorkspace = realpathSync(workspace), canonicalProject = realpathSync(project);
  if (!statSync(canonicalWorkspace).isDirectory() || !statSync(canonicalProject).isFile() || !within(canonicalWorkspace, canonicalProject)) throw Error("Agent project is outside the workspace");
  return { root, workspace: canonicalWorkspace, project: canonicalProject, projectRelative: relative(canonicalWorkspace, canonicalProject) };
}

function pythonExecutable() {
  const name = process.platform === "win32" ? "python.exe" : "python3";
  const candidate = String(process.env.PATH || "").split(delimiter).filter(Boolean).map((part) => join(part, name))
    .find((path) => isAbsolute(path) && existsSync(path));
  if (!candidate) throw Error("Python 3 is not installed on PATH; Kit durable controller cannot run");
  return candidate;
}

const pythonEnvironment = () => ({ ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1" });

function boundedString(value: unknown, label: string, required = true): string | undefined {
  if (value === undefined || value === null || value === "") {
    if (required) throw Error(`${label} is required`);
    return undefined;
  }
  if (typeof value !== "string" || value.length > 1024 || /[\x00-\x1f]/u.test(value)) throw Error(`${label} is invalid`);
  return value;
}

function workspaceFile(value: unknown, label: string, workspace: string): string {
  const raw = boundedString(value, label)!;
  const candidate = resolve(workspace, raw);
  if (!existsSync(candidate)) throw Error(`${label} must be an existing workspace file`);
  const file = realpathSync(candidate);
  if (!within(workspace, file) || !statSync(file).isFile()) throw Error(`${label} must be an existing workspace file`);
  return file;
}

async function assertMaterialBindings(project: string, workspace: string, materials: Array<Record<string, unknown>>, stagedSources = new Map<string, string>()) {
  if (statSync(project).size > 64 * 1024 * 1024) throw Error("Editkin project exceeds the Agent binding limit");
  let editProject: any;
  try { editProject = JSON.parse(await readFile(project, "utf8")); }
  catch { throw Error("Editkin project is not valid JSON"); }
  if (!Array.isArray(editProject?.assets) || !Array.isArray(editProject?.tracks)) throw Error("Editkin project has no asset/track bindings");
  const assets = new Map<string, any>(editProject.assets.filter((item: any) => typeof item?.id === "string").map((item: any) => [item.id, item]));
  const clips = new Map<string, any>();
  const kinds = new Map<string, string>();
  for (const track of editProject.tracks) for (const clip of Array.isArray(track?.clips) ? track.clips : []) {
    if (typeof clip?.id !== "string" || clips.has(clip.id)) throw Error("Editkin project has an invalid or duplicate clip ID");
    clips.set(clip.id, clip);
  }
  for (const material of materials) {
    const clipId = boundedString(material.clipId, "clipId")!;
    const clip = clips.get(clipId), asset = assets.get(clip?.assetId);
    if (!asset || typeof asset.uri !== "string" || !asset.uri.trim()) throw Error(`Kit material ${clipId} is not a clip with a local source in the open project`);
    if (asset.uri.startsWith("creative://") || asset.uri.startsWith("editkin-composition://") || asset.uri.startsWith("blob:"))
      throw Error(`Kit material ${clipId} needs a real workspace source file`);
    const rawUri = asset.uri.startsWith("file:") ? fileURLToPath(asset.uri) : asset.uri;
    const original = realpathSync(resolve(workspace, rawUri));
    const actualSource = stagedSources.get(original) ?? workspaceFile(rawUri, "project asset source", workspace);
    const requestedSource = workspaceFile(material.sourcePath, "sourcePath", workspace);
    if (actualSource !== requestedSource) throw Error(`Kit material ${clipId} does not match the open project's asset source`);
    kinds.set(clipId, asset.kind);
  }
  return kinds;
}

export async function deriveOpenProjectMaterials(project: string, workspace: string): Promise<Array<{ clipId: string; sourcePath: string }>> {
  const canonicalWorkspace = realpathSync(workspace), canonicalProject = realpathSync(project);
  if (!statSync(canonicalWorkspace).isDirectory() || !within(canonicalWorkspace, canonicalProject))
    throw Error("Agent project is outside the workspace");
  workspace = canonicalWorkspace;
  project = canonicalProject;
  if (statSync(project).size > 64 * 1024 * 1024) throw Error("Editkin project exceeds the Agent binding limit");
  let editProject: any;
  try { editProject = JSON.parse(await readFile(project, "utf8")); }
  catch { throw Error("Editkin project is not valid JSON"); }
  if (!Array.isArray(editProject?.assets) || !Array.isArray(editProject?.tracks)) throw Error("Editkin project has no asset/track bindings");
  const assets = new Map<string, any>(editProject.assets.filter((item: any) => typeof item?.id === "string").map((item: any) => [item.id, item]));
  const materials: Array<{ clipId: string; sourcePath: string }> = [];
  const seen = new Set<string>();
  for (const track of editProject.tracks) for (const clip of Array.isArray(track?.clips) ? track.clips : []) {
    if (typeof clip?.id !== "string" || seen.has(clip.id)) throw Error("Editkin project has an invalid or duplicate clip ID");
    seen.add(clip.id);
    const asset = assets.get(clip.assetId);
    if (!asset) throw Error(`Kit material ${clip.id} has no source asset in the open project`);
    if (asset.id === "asset-demo") continue;
    if (typeof asset.uri !== "string" || !asset.uri.trim() || asset.uri.startsWith("creative://")
      || asset.uri.startsWith("editkin-composition://") || asset.uri.startsWith("blob:"))
      throw Error(`Kit material ${clip.id} needs a real workspace source file`);
    const rawUri = asset.uri.startsWith("file:") ? fileURLToPath(asset.uri) : asset.uri;
    materials.push({ clipId: clip.id, sourcePath: workspaceFile(rawUri, "project asset source", workspace) });
    if (materials.length > 32) throw Error("Kit create supports at most 32 source clips");
  }
  if (!materials.length) throw Error("請先加入自己的素材；示範片段不能建立完整自動剪輯流程");
  return materials;
}

export async function readKitResource(name: string, input: { offset?: unknown; maxChars?: unknown } = {}) {
  const { root } = locations();
  return readOriginalSkillResource(root, name, input);
}

export function listKitResources(input: { filter?: unknown; offset?: unknown; limit?: unknown } = {}) {
  locations(); // Availability and project binding are verified even for the read-only catalog.
  return listOriginalSkillResources(input);
}

async function controller(args: string[], timeout = 60_000) {
  const { root, workspace } = locations();
  try {
    const { stdout } = await execFileAsync(pythonExecutable(), ["-B", join(root, "workflow_contract.py"), "--workspace", workspace, ...args],
      { cwd: workspace, env: pythonEnvironment(), windowsHide: true, timeout, maxBuffer: 512 * 1024 });
    const parsed = JSON.parse(stdout);
    if (parsed?.ok !== true) throw Error("Kit controller rejected the operation");
    return parsed.result;
  } catch (error) {
    if ((error as { killed?: boolean }).killed) throw Error("Kit controller timed out; outcome may be unknown. Inspect run status before retrying");
    const output = (error as { stdout?: string }).stdout;
    if (output && output.length < 16_000) {
      try { const parsed = JSON.parse(output); if (parsed?.ok === false) throw Error(`Kit controller: ${String(parsed.detail || parsed.error).slice(0, 900)}`); }
      catch (parsedError) { if (parsedError instanceof Error && parsedError.message.startsWith("Kit controller:")) throw parsedError; }
    }
    throw Error(`Kit controller failed: ${error instanceof Error ? error.message.slice(0, 700) : String(error)}`);
  }
}

async function controllerFromMemory(args: string[], payload: Record<string, unknown>) {
  const { root, workspace } = locations();
  const input = JSON.stringify(payload);
  if (Buffer.byteLength(input) > 64 * 1024 * 1024) throw Error("Kit receipt exceeds the in-memory submission limit");
  const outputLimit = args[0] === "context-next" ? 8 * 1024 * 1024 : 512 * 1024;
  return new Promise<any>((resolveResult, rejectResult) => {
    const child = spawn(pythonExecutable(), ["-B", join(root, "workflow_contract.py"), "--workspace", workspace, ...args],
      { cwd: workspace, env: pythonEnvironment(), windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    let output = "", timedOut = false, settled = false;
    const finish = (error?: Error, result?: any) => { if (settled) return; settled = true; clearTimeout(timer); if (error) rejectResult(error); else resolveResult(result); };
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 60_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (output.length > outputLimit) { child.kill(); finish(Error("Kit controller output exceeds limit; outcome may be unknown")); }
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (timedOut) return finish(Error("Kit controller timed out; outcome may be unknown. Check run status before retrying"));
      try {
        const parsed = JSON.parse(output);
        if (code !== 0 || parsed?.ok !== true) return finish(Error(`Kit controller: ${String(parsed?.detail || parsed?.error || "operation failed").slice(0, 900)}`));
        finish(undefined, parsed.result);
      } catch (error) { finish(Error(`Kit controller returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`)); }
    });
    child.stdin.on("error", (error) => { child.kill(); finish(Error(`Kit receipt submission failed: ${error.message}`)); });
    child.stdin.end(input);
  });
}

export async function runKitWorkflow(input: Record<string, unknown>, receiptPayload?: Record<string, unknown>,
  preparation?: KitSourceOptions & { onControllerStart?: () => void }) {
  const { workspace, project, projectRelative } = locations();
  const command = boundedString(input.command, "command") as Command;
  if (!commands.includes(command)) throw Error("Unsupported Kit workflow command");
  const args: string[] = [command];
  if (receiptPayload && command !== "complete" && command !== "context-next") throw Error("In-memory receipt is only allowed for complete or context-next");
  if (command === "create") {
    if (input.project !== undefined && workspaceFile(input.project, "project", workspace) !== project) throw Error("Run must bind the current Editkin project");
    args.push("--project", projectRelative);
    const runId = boundedString(input.runId, "runId", false); if (runId) args.push("--run-id", runId);
    if (input.clipIds !== undefined && input.materials !== undefined) throw Error("Use clipIds or materials for Kit create, not both");
    const clipIds = input.clipIds === undefined ? undefined : input.clipIds;
    const staged = input.materials === undefined ? await stageKitProjectSources(workspace, project, preparation, clipIds as string[] | undefined) : undefined;
    const materials = staged?.materials ?? input.materials;
    if (!Array.isArray(materials) || materials.length < 1 || materials.length > 32) throw Error("create requires 1–32 real clip/source bindings");
    const materialKinds = await assertMaterialBindings(project, workspace, materials as Array<Record<string, unknown>>, staged?.stagedSources);
    for (const item of materials) {
      if (typeof item !== "object" || !item) throw Error("material binding is invalid");
      const clipId = boundedString((item as any).clipId, "clipId")!;
      if (clipId.includes("=")) throw Error("clipId is invalid");
      const source = workspaceFile((item as any).sourcePath, "sourcePath", workspace);
      args.push("--material", `${clipId}=${source}`);
    }
    if (input.maxRetries !== undefined) {
      const retries = Number(input.maxRetries);
      if (!Number.isInteger(retries) || retries < 0 || retries > 5) throw Error("maxRetries must be 0–5");
      args.push("--max-retries", String(retries));
    }
    if (input.keyframeTimes !== undefined) {
      if (!Array.isArray(input.keyframeTimes) || input.keyframeTimes.length > materials.length) throw Error("keyframeTimes is invalid");
      for (const item of input.keyframeTimes) {
        if (typeof item !== "object" || !item) throw Error("keyframe selection is invalid");
        const clipId = boundedString((item as any).clipId, "clipId")!;
        if (!materials.some((material: any) => material.clipId === clipId)) throw Error("keyframeTimes clipId is outside this Kit run");
        const times = (item as any).times;
        if (!Array.isArray(times) || times.length < 1 || times.length > 12 || !times.every((time) => typeof time === "number" && Number.isFinite(time) && time >= 0)) throw Error("keyframe times must contain 1–12 nonnegative seconds");
        if (times.some((time, index) => index > 0 && time <= times[index - 1])) throw Error("keyframe times must increase");
        args.push("--keyframe-times", `${clipId}=${times.join(",")}`);
      }
    }
    const transcriptPolicies = new Map<string, string>();
    if (input.transcriptPolicies !== undefined) {
      if (!Array.isArray(input.transcriptPolicies) || input.transcriptPolicies.length > materials.length) throw Error("transcriptPolicies is invalid");
      for (const item of input.transcriptPolicies) {
        if (typeof item !== "object" || !item) throw Error("transcript policy is invalid");
        const clipId = boundedString((item as any).clipId, "clipId")!;
        if (!materials.some((material: any) => material.clipId === clipId)) throw Error("transcriptPolicies clipId is outside this Kit run; use clipIds to select materials");
        const policy = boundedString((item as any).policy, "policy")!;
        if (!["required", "visual-only"].includes(policy)) throw Error("transcript policy is invalid");
        if (transcriptPolicies.has(clipId)) throw Error("transcriptPolicies has a duplicate clipId");
        transcriptPolicies.set(clipId, policy);
      }
    }
    for (const [clipId, kind] of materialKinds) if (kind === "image") {
      if (transcriptPolicies.get(clipId) === "required") throw Error("An image clip cannot require transcription; use visual-only");
      transcriptPolicies.set(clipId, "visual-only");
    }
    for (const [clipId, policy] of transcriptPolicies) args.push("--transcript-policy", `${clipId}=${policy}`);
    const taskClass = boundedString(input.taskClass, "taskClass", false);
    if (taskClass) { if (!["bulk_analysis", "rough_cut", "editorial_plan", "quality_critical", "contract_audit"].includes(taskClass)) throw Error("taskClass is invalid"); args.push("--task-class", taskClass); }
    const priority = boundedString(input.priority, "priority", false);
    if (priority) { if (!["economy", "balanced", "quality"].includes(priority)) throw Error("priority is invalid"); args.push("--priority", priority); }
    preparation?.signal?.throwIfAborted();
    preparation?.onControllerStart?.();
    const result = await controller(args, 5 * 60_000);
    return staged?.snapshot ? { ...result, sourceStaging: { copiedExternalSources: staged.stagedSources.size, verifiedSnapshot: true } } : result;
  }
  const run = boundedString(input.run, "run")!;
  // The original controller verifies the run; this session additionally pins it to the currently open project.
  const status = await controller(["status", run]);
  if (workspaceFile(status?.project, "run project", workspace) !== project) throw Error("Workflow run belongs to another Editkin project");
  if (command === "status") return status;
  await verifyKitRunExternalSources(workspace, project, status.run_dir, command === "verify" || command === "complete" && ["apply", "render"].includes(String(input.step)));
  if (command === "complete" && input.step === "plan") {
    const planPath = workspaceFile(join(status.run_dir, "plan.v4.json"), "plan draft", workspace);
    const plan = parseAutopilotPlan(JSON.parse(await readFile(planPath, "utf8")));
    if (plan.schema !== "hao.video-autopilot.edit-plan/v4") throw Error("Kit plan completion requires a current v4 draft");
  }
  args.push(run);
  if (command === "next") {
    const limit = input.limit === undefined ? 16 : Number(input.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 32) throw Error("limit must be 1–32");
    args.push("--limit", String(limit));
  } else if (command === "claim") {
    const step = boundedString(input.step, "step", false); if (step) args.push(step);
    args.push("--actor-type", "machine", "--worker", "editkin-agent-dock");
  } else if (command === "complete" || command === "fail" || command === "context-next") {
    args.push(boundedString(input.step, "step")!, "--token", boundedString(input.token, "token")!);
    if (command === "fail") args.push("--reason", boundedString(input.reason, "reason")!);
    else args.push("--receipt", receiptPayload ? "-" : workspaceFile(input.receipt, "receipt", workspace));
    if (command === "complete") args.push("--actor-type", "machine");
  } else if (command === "reject-render") args.push("--evidence", workspaceFile(input.evidence, "evidence", workspace));
  else if (command === "resume" && input.applyResolution !== undefined) throw Error("An uncertain apply requires human reconciliation outside the Agent dock");
  const result = receiptPayload ? await controllerFromMemory(args, receiptPayload) : await controller(args);
  if (command === "context-next" && result && Array.isArray(result.cue_indexes)) {
    // The controller validated the complete prefix. Keep model-visible output bounded.
    const { cue_indexes, ...summary } = result;
    return { ...summary, cue_index_range: cue_indexes.length ? [cue_indexes[0], cue_indexes.at(-1)] : [] };
  }
  return result;
}

export async function verifyKitRunOriginalSources(run: string): Promise<void> {
  const { workspace, project } = locations();
  const status = await controller(["status", run]);
  if (workspaceFile(status?.project, "run project", workspace) !== project) throw Error("Workflow run belongs to another Editkin project");
  await verifyKitRunExternalSources(workspace, project, status.run_dir, true);
}

/** A bounded index of controller-verified plan evidence; the Kit still owns every claim and receipt. */
export async function readKitPlanContext(run: string, options: { includeTranscriptCues?: boolean } = {}) {
  const { workspace, project } = locations();
  const status = await runKitWorkflow({ command: "status", run });
  const runDir = realpathSync(status.run_dir);
  if (!within(workspace, runDir)) throw Error("Kit run is outside the bound workspace");
  await verifyKitRunExternalSources(workspace, project, runDir);
  const statePath = realpathSync(join(runDir, "workflow-state.json"));
  if (!within(runDir, statePath) || statSync(statePath).size > 512 * 1024) throw Error("Kit state is unavailable or too large");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  if (state.run_id !== status.run_id || state.updated_at !== status.updated_at
    || state.binding?.binding_sha256 !== status.binding_sha256
    || state.steps?.plan?.tool !== "write_v4_plan") throw Error("Kit state differs from controller status");
  const receipt = async (step: string) => {
    const entry = state.steps?.[step]?.receipt;
    if (state.steps?.[step]?.status !== "completed" || !entry?.path || !entry?.file_sha256) return null;
    const file = realpathSync(join(runDir, entry.path));
    if (!within(runDir, file) || statSync(file).size > 256 * 1024) throw Error(`Kit ${step} receipt is invalid`);
    const bytes = await readFile(file);
    if (createHash("sha256").update(bytes).digest("hex") !== entry.file_sha256) throw Error(`Kit ${step} receipt changed`);
    const value = JSON.parse(bytes.toString("utf8"));
    if (value.step_id !== step || value.binding_sha256 !== status.binding_sha256) throw Error(`Kit ${step} receipt binding changed`);
    return value;
  };
  const contract = await receipt("contract");
  const session = await receipt("session");
  const route = await receipt("route");
  const plugins = await receipt("plugin-discovery");
  const savedPath = join(runDir, "plan.v4.json");
  let savedDraft: { status: "MISSING" | "VALID" | "INVALID"; planSha256?: string; commandTypes?: string[] } = { status: "MISSING" };
  if (existsSync(savedPath)) {
    try {
      const canonical = realpathSync(savedPath);
      if (!within(workspace, canonical) || statSync(canonical).size > 1024 * 1024) throw Error("Saved plan is outside the allowed draft boundary");
      const plan = parseAutopilotPlan(JSON.parse(await readFile(canonical, "utf8")));
      if (plan.schema !== AUTOPILOT_PLAN_SCHEMA) throw Error("Saved plan is not v4");
      savedDraft = { status: "VALID", planSha256: autopilotPlanSha256(plan), commandTypes: plan.commands.map(command => command.type) };
    } catch { savedDraft = { status: "INVALID" }; }
  }
  const materials = [];
  const materialSeedReceipts = [];
  const semanticOutlines = [];
  for (const binding of state.binding.materials || []) {
    if (materials.length >= 32 || typeof binding.key !== "string" || !/^[a-z0-9_-]{1,128}$/i.test(binding.key)) throw Error("Kit material index is invalid");
    const [prepare, context, semantics] = await Promise.all([
      receipt(`prepare:${binding.key}`), receipt(`context:${binding.key}`), receipt(`semantics:${binding.key}`),
    ]);
    const semanticCueIndexes = [...new Set((Array.isArray(semantics?.submission?.request?.segments)
      ? semantics.submission.request.segments : []).flatMap((segment: any) =>
        Array.isArray(segment?.transcriptCueIndexes) ? segment.transcriptCueIndexes : []))];
    const transcriptCues = options.includeTranscriptCues && context?.facts?.complete === true
      ? (Array.isArray(context?.payload?.windows) ? context.payload.windows : [])
        .flatMap((window: any) => Array.isArray(window?.context?.transcript?.cues)
          ? window.context.transcript.cues : [])
        .filter((cue: any) => Number.isInteger(cue?.index) && cue.index >= 0
          && Number.isFinite(cue?.start) && Number.isFinite(cue?.end)
          && typeof cue?.text === "string" && cue.text.length <= 180)
        .filter((cue: any, index: number, all: any[]) => all.findIndex(item => item.index === cue.index) === index)
        .slice(0, 80).map((cue: any) => ({ index: cue.index, start: cue.start, end: cue.end, text: cue.text }))
      : undefined;
    materials.push({ key: binding.key, clipId: binding.clip_id, sourcePath: binding.source_path,
      sourceSha256: binding.source_sha256,
      transcriptPolicy: prepare?.facts?.transcript_policy ?? binding.transcript_policy ?? null,
      transcriptState: prepare?.payload?.packet?.transcript?.state ?? null,
      transcriptCueCount: prepare?.payload?.packet?.transcript?.cueCount ?? null,
      semanticCueIndexes,
      ...(options.includeTranscriptCues ? { transcriptCues } : {}),
      duration: prepare?.facts?.duration ?? null, contextComplete: context?.facts?.complete === true,
      contextEvidenceSha256: context?.facts?.evidence_sha256 ?? null,
      semanticReceiptSha256: semantics?.facts?.semantic_receipt_sha256 ?? null,
      semanticSegmentCount: semantics?.facts?.segment_count ?? null,
      receiptPaths: {
        prepare: prepare ? state.steps[`prepare:${binding.key}`].receipt.path : null,
        context: context ? state.steps[`context:${binding.key}`].receipt.path : null,
        semantics: semantics ? state.steps[`semantics:${binding.key}`].receipt.path : null,
      } });
    if (semantics?.facts) materialSeedReceipts.push({ materialId: semantics.facts.material_id,
      sourceSha256: semantics.facts.source_sha256, assetId: semantics.facts.asset_id,
      clipId: semantics.facts.clip_id, semanticReceiptSha256: semantics.facts.semantic_receipt_sha256 });
    const submitted = semantics?.submission?.request;
    const frameTimes = new Map<string, number>((Array.isArray(prepare?.payload?.packet?.keyframes)
      ? prepare.payload.packet.keyframes : []).filter((frame: any) => typeof frame?.id === "string"
        && Number.isFinite(frame?.time)).map((frame: any) => [frame.id, frame.time]));
    if (semanticOutlines.length < 8 && submitted && typeof submitted.overallTopic === "string")
      semanticOutlines.push({ clipId: binding.clip_id, overallTopic: submitted.overallTopic.slice(0, 180),
        contentType: String(submitted.contentType ?? "").slice(0, 120),
        segments: (Array.isArray(submitted.segments) ? submitted.segments : []).slice(0, 8).map((segment: any) => ({
          start: segment.start, end: segment.end, summary: String(segment.summary ?? "").slice(0, 240),
          evidenceFrameCount: timedEvidenceFrameCount(segment, frameTimes) })) });
  }
  return { run: relative(workspace, runDir).replaceAll("\\", "/"), status: status.status,
    ready: status.ready, planStep: state.steps.plan.status, planAttempts: state.steps.plan.attempts,
    project: status.project, bindingSha256: status.binding_sha256, sourceSetSha256: status.source_set_sha256,
    requiredPlanSource: contract?.payload?.requiredPlanSource ?? null, planSchema: contract?.facts?.plan_schema ?? null,
    planStructureTool: { gateway: "call_editkin_tool", name: "get_autopilot_plan_structure", arguments: {} },
    savedDraft,
    planDraftTool: { gateway: "draft_kit_single_clip_plan", openCodeName: "editkin_draft_kit_single_clip_plan",
      finishOpenCodeName: "editkin_finish_kit_single_clip_edit",
      scope: "one source clip proof caption at its project timeline position; required speech uses a cited transcript cue and keeps source dialogue; Smart Cut only on a visual-only, otherwise empty single-clip timeline",
      requiredIntent: materials.length === 1 && materials[0].transcriptPolicy === "required"
        ? ["captionText", "captionCueIndex", "topic", "beatSummary", "subject", "audience"]
        : ["captionText", "topic", "beatSummary", "subject", "audience"] },
    twoClipStoryTool: { gateway: "draft_kit_two_clip_story_plan", openCodeName: "editkin_draft_kit_two_clip_story_plan",
      finishOpenCodeName: "editkin_finish_kit_two_clip_edit", scope: "two adjacent visual-only source clips",
      requiredIntent: ["topic", "audience", "beats[0].clipId", "beats[1].clipId", "summary", "focus", "captionText"],
      outputRequested: "Once savedDraft is VALID and the user asked for a rendered video, call finishOpenCodeName in this Agent process; no second confirmation is needed." },
    planValidationTool: { gateway: "call_editkin_tool", name: "validate_autopilot_plan_draft", arguments: { planPath: `${relative(workspace, runDir).replaceAll("\\", "/")}/plan.v4.json` } },
    planSchemaLookup: { tool: "inspect_editkin_tool", name: "audit_autopilot_plan",
      path: "/properties/plan/anyOf/0", detailPath: "/properties/plan/anyOf/0/properties/<field>" },
    authoringCalls: {
      designBrief: { gateway: "call_editkin_tool", name: "get_autopilot_design_brief",
        argumentShape: { projectPath: project, request: { format: "<chosen format>", domain: "<chosen domain>",
          topic: "<evidence-backed topic>", duration: "<project duration seconds>", beats: "<chosen beat array>" },
          pageId: "context, then beat:<beatId>", offset: 0, maxTokens: 900 } },
      aesthetic: { gateway: "call_editkin_tool", name: "get_autopilot_aesthetic_system",
        argumentShape: { domain: "<chosen domain>", format: "<chosen format>", selectedFamily: "<design beat recipe route.primary_family>" } },
      factualCaptionCommandShape: { type: "add_caption", caption: { id: "<unique id>", text: "<verified wording>", start: 0, duration: "<actual seconds>" } },
    },
    sourceBoundSeed: { status: "EVIDENCE_ONLY", source: contract?.payload?.requiredPlanSource ?? null,
      materialEvidence: { schema: "hao.editkin.material-intelligence/v1", receipts: materialSeedReceipts },
      submittedSemanticOutlines: semanticOutlines, omittedSemanticOutlines: Math.max(0, materials.length - semanticOutlines.length),
      projectSummary: session?.payload?.summary ?? null,
      routeRecommendation: route?.payload?.route ?? null,
      routerSha256: route?.payload?.context?.markdownRouterSha256 ?? null,
      note: "Verified receipt fields only. This is not an editorial plan. The actual Agent model, narrative, commands, design evidence, quality, budget and extensions must be authored and validated for this run." },
    route: route?.facts ?? null, pluginDiscovery: plugins?.facts ?? null, materials,
    guidance: "This is a verified evidence index, not a scene interpretation or plan. For one clip with savedDraft MISSING, use planDraftTool.openCodeName with reviewed visual evidence; a required transcript also needs a cue index and caption text quoted from get_material_context. Smart Cut is available only for visual-only material. This is a gateway tool, not a target Editkin tool for call_editkin_tool. If savedDraft is VALID and the user asked to finish the video, call planDraftTool.finishOpenCodeName to run original Kit plan, audit, apply and render in one Agent process; do not use it for draft-only requests. If savedDraft is INVALID, repair and validate the plan first. For more complex material, copy sourceBoundSeed.source and materialEvidence into a hand-authored draft. routeRecommendation is not proof of the actual Agent model. authoringCalls gives design tool and caption shapes; page design output until hasMore=false. JSON parsing is not validation. The original Kit controller validates completed plans; never claim human review." };
}
