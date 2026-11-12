// Verify packaged gateway large-source cancellation, resume, progress, and Kit create.
// Usage: npx tsx scripts/review-kit-source-job-gateway.ts --portable <preview.exe>
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createDemoProject } from "../src/domain/demo";
import { requestCurrentKitSourceCancellation } from "../src/mcp/kitSourceJobs";

const root = resolve(import.meta.dirname, "..");
const at = process.argv.indexOf("--portable");
const portable = resolve(process.argv[at + 1] || "");
assert(at > 0 && basename(portable).toLowerCase() === "autopilotdesk-community-preview.exe");
const fixture = await mkdtemp(join(tmpdir(), "editkin-kit-large-source-"));
const workspace = join(fixture, "workspace"), imports = join(fixture, "imports");
await mkdir(workspace); await mkdir(imports);
const source = join(imports, "large.mp4"), projectPath = join(workspace, "movie.editkin.json");
const handle = await open(source, "wx");
try { await handle.write(Buffer.from("synthetic-large-source\n")); await handle.truncate(65 * 1024 * 1024); }
finally { await handle.close(); }
const project = createDemoProject();
project.id = "large-kit-source-gateway";
project.assets[0].id = "asset-large"; project.assets[0].uri = source;
project.tracks[0].clips[0].id = "clip-large"; project.tracks[0].clips[0].assetId = "asset-large";
await writeFile(projectPath, JSON.stringify(project));
const digest = async (path: string) => { const hash = createHash("sha256"); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest("hex"); };
const projectSha = await digest(projectPath), originalSha = await digest(source);
const executableOnPath = (name: string) => execFileSync("where.exe", [name], { encoding: "utf8" }).split(/\r?\n/)[0].trim();
const resources = join(dirname(portable), "resources/runtime");
const client = new Client({ name: "editkin-kit-source-job-review", version: "1" });
const transport = new StdioClientTransport({ command: process.execPath, args: [join(resources, "agent-gateway.mjs")], cwd: root,
  env: { ...process.env, EDITKIN_AGENT_GATEWAY_TARGET: join(resources, "mcp.mjs"),
    EDITKIN_WORKSPACE: workspace, EDITKIN_AGENT_PROJECT_PATH: projectPath,
    EDITKIN_VIDEO_AUTOPILOT_SKILL: join(dirname(portable), "resources/video-autopilot-kit/SKILL.md"),
    HAO_FFMPEG_PATH: executableOnPath("ffmpeg"), HAO_FFPROBE_PATH: executableOnPath("ffprobe"),
    EDITKIN_CACHE_ROOT: join(workspace, "cache"), EDITKIN_PLUGIN_ROOTS: join(root, "plugins") } as Record<string, string>, stderr: "pipe" });
const call = async (args: Record<string, unknown>, mayFail = false) => {
  const response = await client.callTool({ name: "run_kit_workflow", arguments: args });
  if (!mayFail) assert.equal(response.isError, undefined, JSON.stringify(response.content).slice(0, 400));
  const text = response.content.find((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")?.text;
  assert(text);
  return response.isError ? { error: text } : JSON.parse(text);
};
const runId = "large-source-gateway-review";
const report: Record<string, unknown> = { status: "FAIL", sizeBytes: 65 * 1024 * 1024 };
try {
  await client.connect(transport);
  const started = await call({ command: "create", runId, transcriptPolicies: [{ clipId: "clip-large", policy: "visual-only" }] });
  assert.equal(started.status, "PREPARING");
  assert(typeof started.preparationId === "string");
  report.preparationId = started.preparationId;
  assert.equal(requestCurrentKitSourceCancellation(workspace, projectPath), true);
  let cancelled: any;
  for (let index = 0; index < 100; index++) {
    cancelled = await call({ command: "source-status", preparationId: started.preparationId });
    if (cancelled.status === "CANCELLED") break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(cancelled.status, "CANCELLED");
  const absent = await call({ command: "status", run: runId }, true);
  assert(absent.error, "Cancelled preparation unexpectedly created a Kit run");
  const resumed = await call({ command: "source-resume", preparationId: started.preparationId });
  assert.equal(resumed.status, "PREPARING");
  const phases = new Set<string>();
  let completed: any;
  for (let index = 0; index < 600; index++) {
    completed = await call({ command: "source-status", preparationId: started.preparationId });
    if (completed.progress?.phase) phases.add(completed.progress.phase);
    if (["COMPLETED", "FAILED", "UNCERTAIN", "CANCELLED"].includes(completed.status)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(completed.status, "COMPLETED", JSON.stringify(completed).slice(0, 700));
  assert.equal(completed.result.sourceStaging?.verifiedSnapshot, true);
  const state = JSON.parse(await readFile(join(completed.result.run_dir, "workflow-state.json"), "utf8"));
  const staged = resolve(workspace, state.binding.materials[0].source_path);
  assert.notEqual(staged, source);
  assert.equal(await digest(staged), originalSha);
  assert.equal(await digest(source), originalSha);
  assert.equal(await digest(projectPath), projectSha);
  report.status = "PASS";
  report.phases = [...phases];
  report.cancelledBeforeKitRun = true;
  report.cancelledViaDesktopMarker = true;
  report.resumedCreatedRun = true;
  report.originalSourceUnchanged = true;
  report.originalProjectUnchanged = true;
  report.stagedSha256 = originalSha;
} finally {
  await client.close().catch(() => undefined);
  const outputDirectory = resolve(root, "../artifacts/autopilot-desk");
  await mkdir(outputDirectory, { recursive: true });
  const output = join(outputDirectory, `kit-source-job-review-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  await rm(fixture, { recursive: true, force: true });
  process.stdout.write(`${JSON.stringify({ ...report, report: output })}\n`);
}
