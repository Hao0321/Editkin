// Resume one existing, isolated Kit run through machine evidence. Stop before semantic interpretation.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, relative, sep } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const root = resolve(import.meta.dirname, "..");
const artifacts = resolve(root, "../artifacts/autopilot-desk");
const argument = (name: string) => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1]; };
const workspace = resolve(argument("--workspace") || "");
const portable = resolve(argument("--portable") || "");
assert(argument("--workspace") && argument("--portable"), "Provide --workspace and --portable");
assert(relative(artifacts, workspace) && !relative(artifacts, workspace).startsWith("..")
  && !relative(artifacts, workspace).includes(`${sep}..${sep}`), "Use an isolated artifacts workspace");
assert.equal(basename(portable).toLowerCase(), "autopilotdesk-community-preview.exe");
const resources = join(dirname(portable), "resources");
const gateway = join(resources, "runtime/agent-gateway.mjs");
const mcp = join(resources, "runtime/mcp.mjs");
const skill = join(resources, "video-autopilot-kit/SKILL.md");
const projectPath = join(workspace, "movie.editkin.json");
const run = join(workspace, "videos/_AUTOPILOT/editkin-v4/all-materials");
const state = JSON.parse(await readFile(join(run, "workflow-state.json"), "utf8"));
assert.equal(state.run_id, "all-materials");
assert.equal(state.binding.materials.length, 10);
assert.equal(state.status, "active");
const projectHash = createHash("sha256").update(await readFile(projectPath)).digest("hex");
assert.equal(projectHash, state.binding.project_initial_sha256, "Isolated project changed since run creation");
for (const [stepId, step] of Object.entries(state.steps as Record<string, { status: string; receipt?: { path: string } }>)) {
  if (!stepId.startsWith("prepare:") || step.status !== "completed" || !step.receipt) continue;
  const material = state.binding.materials.find((item: { key: string }) => stepId === `prepare:${item.key}`);
  if (material?.transcript_policy === "visual-only") continue;
  const receipt = JSON.parse(await readFile(join(run, step.receipt.path), "utf8"));
  if (receipt.payload?.packet?.transcript?.state !== "ready") {
    throw Error(`Existing run has a sealed, non-ready required transcript at ${stepId}; do not retry its context step`);
  }
}
const executable = (name: string) => execFileSync("where.exe", [name], { encoding: "utf8" }).split(/\r?\n/)[0].trim();
const client = new Client({ name: "editkin-mixed-evidence-review", version: "1" });
const transport = new StdioClientTransport({ command: process.execPath, args: [gateway], cwd: root,
  env: { ...process.env, EDITKIN_AGENT_GATEWAY_TARGET: mcp, EDITKIN_WORKSPACE: workspace,
    EDITKIN_AGENT_PROJECT_PATH: projectPath, EDITKIN_VIDEO_AUTOPILOT_SKILL: skill,
    HAO_FFMPEG_PATH: executable("ffmpeg"), HAO_FFPROBE_PATH: executable("ffprobe"),
    EDITKIN_CACHE_ROOT: join(workspace, "cache"), EDITKIN_PLUGIN_ROOTS: join(root, "plugins") } as Record<string, string>,
  stderr: "pipe" });
const call = async (name: string, args: Record<string, unknown>) => {
  const result = await client.callTool({ name, arguments: args });
  const parts = result.content.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string");
  if (result.isError || !parts[0]) throw Error(`${name}: ${String(parts[0]?.text || "no result").slice(0, 900)}`);
  return { value: JSON.parse(parts[0].text), reference: parts[1] ? JSON.parse(parts[1].text) : undefined,
    imageCount: result.content.filter(part => part.type === "image").length };
};
const completed: string[] = [];
let frames = 0;
let stoppedAt = "";
try {
  await client.connect(transport);
  for (let iteration = 0; iteration < 40; iteration++) {
    const next = (await call("run_kit_workflow", { command: "next", run })).value;
    const ready = next.ready as Array<{ step: string }>;
    const item = ready.find(entry => !entry.step.startsWith("semantics:") && entry.step !== "plan");
    if (!item) { stoppedAt = ready.map(entry => entry.step).join(",") || next.status || "no ready step"; break; }
    const step = item.step;
    const claim = (await call("run_kit_workflow", { command: "claim", run, step })).value;
    const instruction = claim.instruction;
    let receiptTemplate: Record<string, unknown>;
    try {
    if (step.startsWith("keyframes:") || step.startsWith("context:")) {
      const calls = instruction.request.calls as Array<{ tool: string; arguments: Record<string, unknown> }>;
      const records = [];
      for (const spec of calls) {
        const result = await call("call_editkin_tool", { name: spec.tool, arguments: spec.arguments, retainResult: true, run });
        assert(typeof result.reference?.resultRef === "string");
        frames += result.imageCount;
        records.push({ request: spec.arguments, result: { $resultRef: result.reference.resultRef } });
      }
      receiptTemplate = { status: "GREEN", [step.startsWith("keyframes:") ? "batches" : "windows"]: records };
    } else {
      const result = await call("call_editkin_tool", { name: instruction.tool, arguments: instruction.request,
        retainResult: true, run });
      assert(typeof result.reference?.resultRef === "string");
      if (step.startsWith("prepare:")) {
        assert(["GREEN", "PARTIAL"].includes(result.value.status), `Preparation incomplete: ${result.value.status}`);
      }
      receiptTemplate = { $resultRef: result.reference.resultRef };
    }
    await call("run_kit_workflow", { command: "complete", run, step, token: claim.claim_token, receiptTemplate });
    completed.push(step);
    process.stderr.write(`completed ${step}\n`);
    } catch (error) {
      await call("run_kit_workflow", { command: "fail", run, step, token: claim.claim_token,
        reason: String(error instanceof Error ? error.message : error).slice(0, 500) });
      throw error;
    }
  }
  assert(stoppedAt, "Evidence loop exceeded 40 steps");
  const finalState = JSON.parse(await readFile(join(run, "workflow-state.json"), "utf8"));
  const report = { status: "PASS", workspace, completed, stoppedAt, viewedFrameImages: frames,
    projectUnchanged: projectHash === createHash("sha256").update(await readFile(projectPath)).digest("hex"),
    completedEvidenceSteps: Object.values(finalState.steps as Record<string, { status: string }>).filter(step => step.status === "completed").length };
  await writeFile(join(workspace, "mixed-evidence-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally { await client.close(); }
