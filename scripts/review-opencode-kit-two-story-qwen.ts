// One bounded LAN Qwen attempt to choose and finish a two-source story via embedded OpenCode.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { OpenCodeAcp } from "../src/service/openCodeAcp";
import { parseAutopilotPlan } from "../src/application/autopilotPlan";

const root = resolve(import.meta.dirname, "..");
const artifacts = realpathSync(resolve(root, "../artifacts/autopilot-desk"));
const at = (flag: string) => { const index = process.argv.indexOf(flag); assert(index >= 0 && process.argv[index + 1]);
  return realpathSync(resolve(process.argv[index + 1])); };
const workspace = at("--workspace"), portable = at("--portable");
const sourceGateway = process.argv.includes("--source-gateway");
const internalIntent = process.argv.includes("--internal-intent");
const resumePath = process.argv.includes("--resume-report") ? at("--resume-report") : undefined;
assert.equal(dirname(workspace).toLowerCase(), artifacts.toLowerCase());
assert.match(basename(workspace), /^kit-two-source-[a-z0-9]+$/i);
const resources = join(dirname(portable), "resources");
const openCode = join(resources, "agent-runtime-v3/opencode.exe");
const gateway = sourceGateway ? join(root, "community-desktop-dist/agent-gateway.mjs")
  : join(resources, "runtime/agent-gateway.mjs");
const mcp = sourceGateway ? join(root, "community-desktop-dist/mcp.mjs") : join(resources, "runtime/mcp.mjs");
for (const file of [openCode, gateway, mcp]) assert(existsSync(file));
const projectPath = join(workspace, "movie.editkin.json");
const run = "videos/_AUTOPILOT/editkin-v4/two-source-smoke";
const statePath = join(workspace, run, "workflow-state.json");
const state = JSON.parse(await readFile(statePath, "utf8"));
assert.equal(state.steps.plan.status, "pending");
const skill = realpathSync(state.governance.skill_path);
const sourceReport = JSON.parse(await readFile(join(workspace, "two-source-create-report.json"), "utf8"));
assert.equal(sourceReport.status, "PASS");
const savedOriginPath = join(process.env.APPDATA || "", "studio.hao.autopilotdesk.communitypreview", "local-story", "origin.json");
const saved = JSON.parse(await readFile(savedOriginPath, "utf8"));
const origin = new URL(saved.origin);
assert.equal(origin.protocol, "http:");
assert(/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/u.test(origin.hostname));
const reportRoot = await mkdtemp(join(artifacts, "qwen-two-story-"));
const previous = resumePath ? JSON.parse(await readFile(resumePath, "utf8")) : undefined;
if (previous) {
  assert.equal(previous.workspace, workspace);
  assert.equal(previous.run, run);
  assert(typeof previous.sessionId === "string" && previous.sessionId.startsWith("ses_"));
}
const agentState = join(previous?.reportRoot || reportRoot, "agent-state");
await mkdir(agentState, { recursive: true });
const executable = (name: string) => execFileSync("where.exe", [name], { encoding: "utf8" }).split(/\r?\n/)[0].trim();
const env = Object.entries({ EDITKIN_AGENT_GATEWAY_TARGET: mcp, EDITKIN_WORKSPACE: workspace,
  EDITKIN_AGENT_PROJECT_PATH: projectPath, EDITKIN_AGENT_STATE_ROOT: agentState,
  EDITKIN_VIDEO_AUTOPILOT_SKILL: skill, HAO_FFMPEG_PATH: executable("ffmpeg"),
  HAO_FFPROBE_PATH: executable("ffprobe"), EDITKIN_CACHE_ROOT: join(workspace, "cache"),
  EDITKIN_PLUGIN_ROOTS: join(root, "plugins") }).map(([name, value]) => ({ name, value }));
const agent = new OpenCodeAcp();
const report: Record<string, unknown> = { status: "BLOCK", reportRoot, workspace,
  model: "pny/qwen3.8-27b-nvfp4", sourceGateway, run, resumedSession: Boolean(previous), internalIntent, suppliedExternalSetupPrompt: !internalIntent };
const startedAt = Date.now();
try {
  const started = await agent.start({ workspace, projectPath, opencodeExecutable: openCode,
    modelOrigin: origin.origin, mcp: { command: process.execPath, args: [gateway], env } });
  assert.equal(started.configOptions.find(option => option.id === "model")?.currentValue, report.model);
  if (previous) await agent.loadSession(previous.sessionId, String(report.model));
  const before = agent.status(0).seq;
  const prompt = internalIntent
    ? `目前 Editkin 專案檔：${projectPath}。此專案原 Kit run：${run} 已備妥素材證據。\n\n使用者：現在是紅色畫面接藍色畫面。請改成藍色開場、紅色收尾，各加一行說明顏色的可編輯字幕，輸出让我看。`
    : previous
    ? `接續同一 Editkin 專案 ${projectPath} 與原 Kit run ${run}。上一回合已依藍→紅順序寫入有效 plan.v4.json，但沒有完成使用者明確要求的輸出。先用 get_kit_plan_context 確認 savedDraft 為 VALID 且 plan 仍 pending，然後直接呼叫 editkin_finish_kit_two_clip_edit，在同一 Agent 程序執行原 Kit plan、audit、apply、render，停在真人審片。不需再問確認，不重建 run、不覆蓋草稿。使用者：請完成輸出讓我看。`
    : `目前 Editkin 專案檔：${projectPath}。只用本 session 的 editkin MCP 讀取或修改此專案，不用檔案工具直接改專案。原 Video Autopilot Kit run：${run} 已完成兩份素材證據；先用 get_kit_plan_context 查看 verified semantic outline。若符合兩段 visual-only 素材，使用 editkin_draft_kit_two_clip_story_plan 以故事順序提交兩個 beat，clipId 必須取自索引；這一句已要求輸出，所以草稿有效後立刻呼叫 editkin_finish_kit_two_clip_edit，經原 Kit plan、audit、apply、render，不再等待額外確認。不要把這兩個 gateway 工具傳給 call_editkin_tool。字幕描述要忠於素材，不要把合成色塊說成真實場景；結果停在真人審片。\n\n使用者：現在是紅色畫面接藍色畫面。請改成藍色開場、紅色收尾，各加一行說明顏色的可編輯字幕，輸出讓我看。`;
  agent.prompt(prompt, projectPath, "完成雙素材故事順序與輸出");
  const deadline = Date.now() + 240_000;
  let turnCompleted = false, permissionPending = false, priorTools = -1;
  while (Date.now() < deadline) {
    const snapshot = agent.status(0);
    const tools = snapshot.events.filter(event => event.kind === "tool" && event.seq > before);
    if (tools.length !== priorTools && Date.now() - startedAt > 5000) {
      priorTools = tools.length;
      process.stdout.write(`${JSON.stringify({ stage: "agent", elapsedSec: Math.round((Date.now() - startedAt) / 1000),
        toolEvents: tools.length, lastTool: tools.at(-1)?.text?.slice(0, 60), busy: snapshot.busy })}\n`);
    }
    if (snapshot.pendingPermissionIds.length) { permissionPending = true; break; }
    if (snapshot.events.some(event => event.kind === "turn" && event.seq > before) && !snapshot.busy) {
      turnCompleted = true; break;
    }
    await new Promise(done => setTimeout(done, 1000));
  }
  const snapshot = agent.status(0);
  const after = JSON.parse(await readFile(statePath, "utf8"));
  const planPath = join(workspace, run, "plan.v4.json");
  let storyOrder: string[] = [];
  if (existsSync(planPath)) {
    try {
      const plan = parseAutopilotPlan(JSON.parse(await readFile(planPath, "utf8")));
      storyOrder = plan.commands.flatMap(command => command.type === "add_clip" ? [command.clip.id] : []);
    } catch (error) { report.planError = String(error).slice(0, 350); }
  }
  const output = join(workspace, run, "render/current.mp4");
  const project = JSON.parse(await readFile(projectPath, "utf8"));
  const timelineOrder = project.tracks.flatMap((track: { clips: Array<{ id: string; timelineStart: number }> }) => track.clips)
    .sort((a: { timelineStart: number }, b: { timelineStart: number }) => a.timelineStart - b.timelineStart)
    .map((clip: { id: string }) => clip.id);
  const sourceUnchanged = (await Promise.all(sourceReport.sourceHashes.map(async (item: { clipId: string; sha256: string }) =>
    createHash("sha256").update(await readFile(join(workspace, `${item.clipId.slice(5)}.mp4`))).digest("hex") === item.sha256)))
    .every(Boolean);
  Object.assign(report, { elapsedMs: Date.now() - startedAt, turnCompleted, permissionPending,
    storyOrder, timelineOrder, sourceUnchanged, planStep: after.steps.plan.status,
    auditStep: after.steps.audit.status, applyStep: after.steps.apply.status, renderStep: after.steps.render.status,
    renderExists: existsSync(output), sessionId: snapshot.sessionId,
    toolTitles: snapshot.events.filter(event => event.seq > before && event.kind === "tool").map(event => event.text).slice(-30),
    lastMessages: snapshot.events.filter(event => event.seq > before && event.kind === "message")
      .map(event => event.text?.slice(0, 500)).slice(-3) });
  report.status = turnCompleted && !permissionPending && sourceUnchanged
    && ["plan", "audit", "apply", "render"].every(step => after.steps[step].status === "completed")
    && existsSync(output) && storyOrder.join() === "clip-blue,clip-red"
    && timelineOrder.join() === "clip-blue,clip-red" ? "PASS" : "BLOCK";
  if (internalIntent && !(report.toolTitles as string[]).includes("確認任務操作流程")) { report.status = "BLOCK"; report.reason = "Internal task guidance was not exercised"; }
  if (!turnCompleted && !permissionPending) report.reason = "Bounded four-minute turn elapsed; inspect run before retrying";
} catch (error) {
  report.error = String(error instanceof Error ? error.message : error).replaceAll(origin.origin, "<private-model-origin>").slice(0, 700);
} finally {
  agent.close();
  await writeFile(join(reportRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ status: report.status, reportRoot, elapsedMs: report.elapsedMs,
    storyOrder: report.storyOrder, error: report.error })}\n`);
}
if (report.status !== "PASS") process.exitCode = 1;
