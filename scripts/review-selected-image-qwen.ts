// One isolated LAN Qwen attempt to review a real image and complete only its pending Kit semantic step.
// Usage: npx tsx scripts/review-selected-image-qwen.ts --workspace <test-copy-workspace> --portable <preview.exe>
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { OpenCodeAcp } from "../src/service/openCodeAcp";

const root = resolve(import.meta.dirname, "..");
const artifacts = realpathSync(resolve(root, "../artifacts/autopilot-desk"));
const arg = (name: string) => { const at = process.argv.indexOf(name); assert(at >= 0 && process.argv[at + 1]);
  return realpathSync(resolve(process.argv[at + 1])); };
const workspace = arg("--workspace"), portable = arg("--portable");
assert.equal(dirname(workspace).toLowerCase(), artifacts.toLowerCase());
assert.match(basename(workspace), /^kit-selected-image-[a-z0-9]+$/i);
assert.equal(basename(portable).toLowerCase(), "autopilotdesk-community-preview.exe");
const projectPath = join(workspace, "movie.editkin.json");
const resources = join(dirname(portable), "resources");
const run = "videos/_AUTOPILOT/editkin-v4/selected-image";
const statePath = join(workspace, run, "workflow-state.json");
const projectHash = createHash("sha256").update(await readFile(projectPath)).digest("hex");
const state = JSON.parse(await readFile(statePath, "utf8"));
const semanticSteps = Object.entries(state.steps).filter(([name]) => name.startsWith("semantics:"));
assert.equal(semanticSteps.length, 1);
assert.equal((semanticSteps[0][1] as any).status, "pending");
assert.equal(state.steps.plan.status, "pending");
assert.equal(state.binding.project_path, relative(workspace, projectPath).replaceAll("\\", "/"));
const saved = JSON.parse(await readFile(join(process.env.APPDATA || "", "studio.hao.autopilotdesk.communitypreview", "local-story", "origin.json"), "utf8"));
const origin = new URL(saved.origin);
assert.equal(origin.protocol, "http:");
assert(/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/u.test(origin.hostname));
const reportRoot = await mkdtemp(join(artifacts, "qwen-selected-image-"));
const agentState = join(reportRoot, "agent-state");
await mkdir(agentState);
const executable = (name: string) => execFileSync("where.exe", [name], { encoding: "utf8" }).split(/\r?\n/)[0].trim();
const env = Object.entries({ EDITKIN_AGENT_GATEWAY_TARGET: join(resources, "runtime/mcp.mjs"),
  EDITKIN_WORKSPACE: workspace, EDITKIN_AGENT_PROJECT_PATH: projectPath, EDITKIN_AGENT_STATE_ROOT: agentState,
  EDITKIN_VIDEO_AUTOPILOT_SKILL: join(resources, "video-autopilot-kit/SKILL.md"),
  HAO_FFMPEG_PATH: executable("ffmpeg"), HAO_FFPROBE_PATH: executable("ffprobe"),
  EDITKIN_CACHE_ROOT: join(workspace, "cache"), EDITKIN_PLUGIN_ROOTS: join(root, "plugins") })
  .map(([name, value]) => ({ name, value }));
const agent = new OpenCodeAcp();
const report: Record<string, unknown> = { status: "BLOCK", reportRoot, isolatedCopy: true,
  semanticStep: semanticSteps[0][0], model: "pny/qwen3.8-27b-nvfp4" };
try {
  const started = await agent.start({ workspace, projectPath,
    opencodeExecutable: join(resources, "agent-runtime-v3/opencode.exe"), modelOrigin: origin.origin,
    mcp: { command: process.execPath, args: [join(resources, "runtime/agent-gateway.mjs")], env } });
  assert.equal(started.configOptions.find(option => option.id === "model")?.currentValue, report.model);
  report.sessionId = started.sessionId;
  const before = started.seq;
  const prompt = `這是隔離的 Editkin 專案副本：${projectPath}。原 Kit run：${run}。目前只有一個圖片素材的 semantics 步驟 pending；contract、session、prepare、keyframes、context 已完成。請以 run_kit_workflow(next) 核對狀態，依原 Kit claim/receipt 規則完成這一個 semantics 步驟，然後停止，不起稿、不 audit、不 apply、不 render。先透過 editkin 工具實際觀看圖片影格，再以眼見的內容和已有 frame ID 寫語意。不能從檔名猜圖像、不能虛構畫面。若模型工具看不到圖像，直接說明並停下，不提交語意。不要建立新 run，也不要修改原始專案。`;
  agent.prompt(prompt, projectPath, "核對所選圖片內容並完成 Kit 語意證據");
  const deadline = Date.now() + 180_000;
  let turnCompleted = false, permissionPending = false;
  while (Date.now() < deadline) {
    const snapshot = agent.status(0);
    if (snapshot.pendingPermissionIds.length) { permissionPending = true; break; }
    if (snapshot.events.some(event => event.kind === "turn" && event.seq > before) && !snapshot.busy) {
      turnCompleted = true; break;
    }
    await new Promise(done => setTimeout(done, 2000));
  }
  const after = JSON.parse(await readFile(statePath, "utf8"));
  const final = agent.status(0);
  report.turnCompleted = turnCompleted;
  report.permissionPending = permissionPending;
  report.semanticStatus = after.steps[semanticSteps[0][0]].status;
  report.planStatus = after.steps.plan.status;
  report.toolEventCount = final.events.filter(event => event.kind === "tool").length;
  report.projectUnchanged = createHash("sha256").update(await readFile(projectPath)).digest("hex") === projectHash;
  if (report.semanticStatus === "completed") {
    const receiptPath = join(workspace, run, after.steps[semanticSteps[0][0]].receipt.path);
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    report.evidenceFrameCount = receipt.submission?.request?.segments?.reduce((sum: number, segment: any) =>
      sum + (Array.isArray(segment.evidenceFrameIds) ? segment.evidenceFrameIds.length : 0), 0) ?? 0;
  }
  report.status = turnCompleted && !permissionPending && report.semanticStatus === "completed" && report.planStatus === "pending"
    && report.projectUnchanged === true && Number(report.evidenceFrameCount) > 0 ? "PASS" : "BLOCK";
} catch (error) {
  report.errorKind = error instanceof Error ? error.name : "unknown";
} finally {
  agent.close();
  await writeFile(join(reportRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
