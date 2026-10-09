// Packaged gateway regression: a stray Kit evidence flag must not block an ordinary edit.
// Usage: npx tsx scripts/review-agent-direct-edit-retention.ts <portable-preview.exe>
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createDemoProject } from "../src/domain/demo";
import { agentGuidanceTasks } from "../src/application/agentTaskGuidance";
import { estimateAgentContextTokens } from "../src/application/agentContextBudget";

const portable = resolve(process.argv[2] || "");
assert.equal(basename(portable).toLowerCase(), "autopilotdesk-community-preview.exe");
const resources = join(dirname(portable), "resources");
const artifacts = resolve("../artifacts/autopilot-desk");
await mkdir(artifacts, { recursive: true });
const workspace = await mkdtemp(join(artifacts, "agent-direct-edit-retention-"));
const projectPath = join(workspace, "movie.editkin.json");
await writeFile(projectPath, JSON.stringify(createDemoProject(), null, 2));

const client = new Client({ name: "editkin-direct-edit-retention-review", version: "1" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(resources, "runtime/agent-gateway.mjs")],
  cwd: resolve("."),
  env: { ...process.env,
    EDITKIN_AGENT_GATEWAY_TARGET: join(resources, "runtime/mcp.mjs"),
    EDITKIN_WORKSPACE: workspace,
    EDITKIN_AGENT_PROJECT_PATH: projectPath,
    EDITKIN_VIDEO_AUTOPILOT_SKILL: join(resources, "video-autopilot-kit/SKILL.md"),
    EDITKIN_CACHE_ROOT: join(workspace, "cache"),
  } as Record<string, string>,
  stderr: "pipe",
});
const report: { status: "PASS" | "BLOCK"; checks?: Record<string, unknown>; error?: string } = { status: "BLOCK" };
try {
  await client.connect(transport);
  const beforeGuidance = await readFile(projectPath, "utf8");
  const taskPackets: Record<string, number> = {};
  for (const task of agentGuidanceTasks) {
    const response = await client.callTool({ name: "get_editkin_task_guidance", arguments: { task } });
    assert(!response.isError);
    const text = response.content.find((item): item is { type: "text"; text: string } => item.type === "text")?.text;
    const packet = JSON.parse(text || "{}");
    assert.equal(packet.version, "editkin.task-guidance/v1");
    assert.equal(packet.task, task);
    taskPackets[task] = estimateAgentContextTokens(text!);
    assert(taskPackets[task] <= packet.tokenBudget);
  }
  const rejected = await client.callTool({ name: "get_editkin_task_guidance", arguments: { task: "unknown" } });
  assert.equal(rejected.isError, true);
  assert.equal(await readFile(projectPath, "utf8"), beforeGuidance, "Task guidance modified the project");
  const args = { name: "apply_edit_commands", arguments: { projectPath,
    commands: [{ type: "set_clip_volume", clipId: "clip-demo", volume: 0.65 }] }, retainResult: true };
  const ordinary = await client.callTool({ name: "call_editkin_tool", arguments: args });
  assert.notEqual(ordinary.isError, true, "An ordinary edit was rejected for a stray evidence flag");
  const ordinaryText = ordinary.content.find((item): item is { type: "text"; text: string } => item.type === "text")?.text;
  assert.equal(JSON.parse(ordinaryText || "{}").status, "GREEN");
  assert(!ordinary.content.some((item) => item.type === "text" && item.text.includes("resultRef")),
    "An ordinary edit created a Kit evidence reference");
  const after = await readFile(projectPath, "utf8");
  const edited = JSON.parse(after);
  assert.equal(edited.tracks.flatMap((track: any) => track.clips).find((clip: any) => clip.id === "clip-demo")?.volume, 0.65);

  const named = await client.callTool({ name: "call_editkin_tool", arguments: { ...args, run: "not-a-Kit-run" } });
  assert.equal(named.isError, true, "A named Kit run accepted a non-evidence edit as a receipt");
  assert.equal(await readFile(projectPath, "utf8"), after, "The rejected named-run call changed the project");
  report.status = "PASS";
  report.checks = { ordinaryEditSucceeded: true, noEvidenceReference: true, namedRunRejectedBeforeMutation: true,
    selectedClipVolume65: true, internalGuidanceReadOnly: true, taskPackets };
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
} finally {
  await client.close();
  await writeFile(join(workspace, "report.json"), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify({ status: report.status, workspace, checks: report.checks, error: report.error }) + "\n");
}
if (report.status !== "PASS") process.exitCode = 1;
