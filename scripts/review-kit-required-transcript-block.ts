// Packaged gateway acceptance: a missing local recognizer must end the claimed prepare step.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createDemoProject } from "../src/domain/demo";
import { parseProject } from "../src/application/projectFiles";

const root = resolve(import.meta.dirname, "..");
const artifacts = resolve(root, "../artifacts/autopilot-desk");
const index = process.argv.indexOf("--portable");
assert(index >= 0 && process.argv[index + 1], "Provide --portable <EXE>");
const portable = resolve(process.argv[index + 1]);
assert.equal(basename(portable).toLowerCase(), "autopilotdesk-community-preview.exe");
const resources = join(dirname(portable), "resources");
const gateway = join(resources, "runtime/agent-gateway.mjs");
const mcp = join(resources, "runtime/mcp.mjs");
const skill = join(resources, "video-autopilot-kit/SKILL.md");
const executable = (name: string) => execFileSync("where.exe", [name], { encoding: "utf8" }).split(/\r?\n/)[0].trim();
await mkdir(artifacts, { recursive: true });
const workspace = await mkdtemp(join(artifacts, "kit-required-transcript-"));
const source = join(workspace, "source-with-audio.mp4");
execFileSync(executable("ffmpeg"), ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=15:duration=3",
  "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000:duration=3", "-shortest",
  "-c:v", "mpeg4", "-c:a", "aac", "-y", source], { timeout: 60_000, stdio: "ignore" });
const projectPath = join(workspace, "movie.editkin.json");
const project = createDemoProject();
project.id = "kit-required-transcript-review";
project.assets[0] = { ...project.assets[0], id: "asset-synthetic-audio", uri: source, duration: 3, width: 320, height: 180 };
project.tracks[0].clips[0] = { ...project.tracks[0].clips[0], id: "clip-synthetic-audio",
  assetId: "asset-synthetic-audio", duration: 3 };
await writeFile(projectPath, `${JSON.stringify(parseProject(project), null, 2)}\n`);
const client = new Client({ name: "editkin-required-transcript-review", version: "1" });
const transport = new StdioClientTransport({ command: process.execPath, args: [gateway], cwd: root,
  env: { ...process.env, EDITKIN_AGENT_GATEWAY_TARGET: mcp, EDITKIN_WORKSPACE: workspace,
    EDITKIN_AGENT_PROJECT_PATH: projectPath, EDITKIN_VIDEO_AUTOPILOT_SKILL: skill,
    HAO_FFMPEG_PATH: executable("ffmpeg"), HAO_FFPROBE_PATH: executable("ffprobe"),
    EDITKIN_CACHE_ROOT: join(workspace, "cache"), EDITKIN_PLUGIN_ROOTS: join(root, "plugins") } as Record<string, string>,
  stderr: "pipe" });
const call = async (name: string, args: Record<string, unknown>) => {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string");
  assert(text[0], `${name} returned no text`);
  let value: any;
  try { value = JSON.parse(text[0].text); } catch { value = { message: text[0].text }; }
  return { error: result.isError === true, value, reference: text[1] ? JSON.parse(text[1].text) : undefined };
};
try {
  await client.connect(transport);
  const created = await call("run_kit_workflow", { command: "create", runId: "required-transcript", clipIds: ["clip-synthetic-audio"] });
  assert.equal(created.error, false);
  const run = created.value.run_dir;
  for (const step of ["contract", "session"] as const) {
    const claim = await call("run_kit_workflow", { command: "claim", run, step });
    const tool = claim.value.instruction.tool;
    const result = await call("call_editkin_tool", { name: tool, arguments: claim.value.instruction.request, retainResult: true, run });
    assert.equal(result.error, false);
    assert(typeof result.reference?.resultRef === "string");
    const complete = await call("run_kit_workflow", { command: "complete", run, step,
      token: claim.value.claim_token, receiptTemplate: { $resultRef: result.reference.resultRef } });
    assert.equal(complete.error, false);
  }
  const stateBefore = JSON.parse(await readFile(join(run, "workflow-state.json"), "utf8"));
  const step = Object.keys(stateBefore.steps).find(key => key.startsWith("prepare:"));
  assert(step);
  const claim = await call("run_kit_workflow", { command: "claim", run, step });
  const prepared = await call("call_editkin_tool", { name: "prepare_ai_material", arguments: claim.value.instruction.request,
    retainResult: true, run });
  assert.equal(prepared.error, false);
  assert.equal(prepared.value.packet.transcript.state, "blocked");
  assert(typeof prepared.reference?.resultRef === "string");
  const completion = await call("run_kit_workflow", { command: "complete", run, step,
    token: claim.value.claim_token, receiptTemplate: { $resultRef: prepared.reference.resultRef } });
  assert.equal(completion.error, true);
  assert.equal(completion.value.status, "BLOCKED_REQUIRED_TRANSCRIPT");
  const state = JSON.parse(await readFile(join(run, "workflow-state.json"), "utf8"));
  assert.equal(state.status, "blocked");
  assert.equal(state.steps[step].status, "failed");
  assert.equal(state.steps[step].claim, null);
  const report = { status: "PASS", workspace, run, blockedAt: step, state: state.status,
    claimReleased: state.steps[step].claim === null, errorStatus: completion.value.status };
  await writeFile(join(workspace, "required-transcript-block-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally { await client.close(); }
