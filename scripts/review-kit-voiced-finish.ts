// Exercise the packaged one-clip spoken-caption draft and original Kit gates.
// Usage: npx tsx scripts/review-kit-voiced-finish.ts --workspace <kit-voiced-prepare-*> --portable <preview.exe> --draft|--finish
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { AUTOPILOT_PLAN_SCHEMA, parseAutopilotPlan } from "../src/application/autopilotPlan";

const root = resolve(import.meta.dirname, "..");
const artifacts = realpathSync(resolve(root, "../artifacts/autopilot-desk"));
function argument(flag: string) {
  const index = process.argv.indexOf(flag);
  assert(index >= 0 && process.argv[index + 1], `Missing ${flag}`);
  return realpathSync(resolve(process.argv[index + 1]));
}
const workspace = argument("--workspace"), portable = argument("--portable");
assert.equal(dirname(workspace).toLowerCase(), artifacts.toLowerCase());
assert.match(basename(workspace), /^kit-voiced-prepare-[a-z0-9]+$/iu);
assert.equal(basename(portable).toLowerCase(), "autopilotdesk-community-preview.exe");
const draftOnly = process.argv.includes("--draft");
assert(draftOnly !== process.argv.includes("--finish"), "Choose --draft or --finish");
const resources = join(dirname(portable), "resources");
const runtime = join(resources, "runtime");
const projectPath = join(workspace, "movie.editkin.json");
const sourcePath = join(workspace, "voiced-source.mp4");
const run = join(workspace, "videos/_AUTOPILOT/editkin-v4/voiced-prepare");
const sha = (buffer: Buffer) => createHash("sha256").update(buffer).digest("hex");
const stateBefore = JSON.parse(await readFile(join(run, "workflow-state.json"), "utf8"));
const pinnedSkill = realpathSync(stateBefore.governance.skill_path);
assert.equal(sha(await readFile(pinnedSkill)), stateBefore.governance.skill_sha256,
  "Original Kit Skill changed after the run was created");
const sourceHash = sha(await readFile(sourcePath));
const projectHash = sha(await readFile(projectPath));
const executable = (name: string) => execFileSync("where.exe", [name], { encoding: "utf8", windowsHide: true }).split(/\r?\n/u)[0].trim();
const client = new Client({ name: "editkin-voiced-finish-review", version: "1" });
const transport = new StdioClientTransport({ command: process.execPath, args: [join(runtime, "agent-gateway.mjs")], cwd: root,
  env: { ...process.env, EDITKIN_AGENT_GATEWAY_TARGET: join(runtime, "mcp.mjs"),
    EDITKIN_WORKSPACE: workspace, EDITKIN_AGENT_PROJECT_PATH: projectPath,
    EDITKIN_VIDEO_AUTOPILOT_SKILL: pinnedSkill,
    HAO_FFMPEG_PATH: executable("ffmpeg.exe"), HAO_FFPROBE_PATH: executable("ffprobe.exe"),
    EDITKIN_WHISPER_CLI_PATH: join(runtime, "whisper-cli.exe"),
    EDITKIN_WHISPER_MODEL_PATH: join(runtime, "models/ggml-small-q5_1.bin"),
    EDITKIN_MODEL_ROOT: join(workspace, "models"), EDITKIN_CACHE_ROOT: join(workspace, "cache"),
    EDITKIN_PLUGIN_ROOTS: join(root, "plugins") } as Record<string, string>, stderr: "pipe" });
const tool = async (name: string, args: Record<string, unknown>, expectError = false) => {
  const result = await client.callTool({ name, arguments: args });
  const first = result.content.find((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string");
  assert(first, `${name} returned no text`);
  assert.equal(Boolean(result.isError), expectError, `${name}: ${first.text.slice(0, 800)}`);
  if (expectError) return first.text;
  return JSON.parse(first.text) as any;
};
try {
  await client.connect(transport);
  const context = await tool("get_kit_plan_context", { run });
  assert.equal(context.materials.length, 1);
  assert.equal(context.materials[0].transcriptPolicy, "required");
  assert.equal(context.materials[0].transcriptState, "ready");
  assert.equal(context.materials[0].transcriptCueCount, 2);
  assert.deepEqual(context.materials[0].semanticCueIndexes, [0, 1]);
  const materialId = context.sourceBoundSeed.materialEvidence.receipts[0].materialId;
  const evidence = await tool("call_editkin_tool", { name: "get_material_context",
    arguments: { materialId, start: 0, end: context.materials[0].duration, maxCues: 20, maxTokens: 800 } });
  const firstCue = evidence.context?.transcript?.cues?.find((cue: { index: number }) => cue.index === 0);
  assert(typeof firstCue?.text === "string" && firstCue.text.length > 3);
  const captionText = firstCue.text.split(/[，,。]/u)[0].trim();
  const fixtureTranscriptMatchesReference = /剪好/u.test(firstCue.text);
  const intent = { run, captionText, captionCueIndex: 0,
    topic: "中文口述剪輯指令與合成測試畫面的可編輯預覽",
    beatSummary: "保留來源中文語音並以逐字稿片段呈現其開頭",
    subject: "合成彩色測試圖樣與來源語音", audience: "剪輯台驗收人員" };
  if (draftOnly) {
    assert.equal(context.savedDraft.status, "MISSING");
    const missingCue = await tool("draft_kit_single_clip_plan", (({ captionCueIndex: _cue, ...rest }) => rest)(intent), true);
    assert.match(missingCue, /captionCueIndex/u);
    const inventedCaption = await tool("draft_kit_single_clip_plan", { ...intent,
      captionText: "影片裡有一架飛機" }, true);
    assert.match(inventedCaption, /transcript cue/u);
    const unsafeCut = await tool("draft_kit_single_clip_plan", { ...intent,
      keepRanges: [{ start: 0, end: 1 }, { start: 2, end: 3 }] }, true);
    assert.match(unsafeCut, /Smart Cut/u);
    const draft = await tool("draft_kit_single_clip_plan", intent);
    assert.equal(draft.status, "DRAFT_WRITTEN");
    const plan = parseAutopilotPlan(JSON.parse(await readFile(join(run, "plan.v4.json"), "utf8")));
    assert(plan.schema === AUTOPILOT_PLAN_SCHEMA, "Voice draft must use the current v4 plan contract");
    assert.deepEqual(plan.commands.map(command => command.type), ["set_aesthetic_system", "add_caption"]);
    assert.equal(plan.editorial.audio.layers.length, 1);
    assert.equal(plan.editorial.audio.layers[0].role, "dialogue");
    const caption = plan.commands[1];
    assert(caption.type === "add_caption" && caption.caption.start === 0 && caption.caption.duration > 3.7
      && caption.caption.duration < 3.9);
    const validated = await tool("call_editkin_tool", { name: "validate_autopilot_plan_draft",
      arguments: context.planValidationTool.arguments });
    assert.equal(validated.status, "GREEN_DRAFT_SCHEMA");
    assert.equal(sha(await readFile(projectPath)), projectHash);
    assert.equal(sha(await readFile(sourcePath)), sourceHash);
    const report = { status: "PASS", phase: "draft", workspace, transcriptPolicy: "required", cueCount: 2,
      rejectedMissingCue: true, rejectedInventedCaption: true, rejectedSmartCut: true,
      fixtureTranscriptMatchesReference, observedFirstCue: firstCue.text,
      captionStart: caption.caption.start, captionDuration: caption.caption.duration,
      dialoguePreservedInPlan: true, sourceUnchanged: true, projectUnchanged: true };
    await writeFile(join(workspace, "voiced-draft-report.json"), `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } else {
    assert.equal(context.savedDraft.status, "VALID");
    const finished = await tool("finish_kit_single_clip_edit", { run });
    assert.equal(finished.status, "RENDERED_AWAITING_HUMAN_REVIEW");
    const output = realpathSync(join(workspace, finished.outputPath));
    assert(!relative(workspace, output).startsWith(".."));
    const state = JSON.parse(await readFile(join(run, "workflow-state.json"), "utf8"));
    for (const step of ["plan", "audit", "apply", "render"]) assert.equal(state.steps[step].status, "completed");
    assert.equal(state.steps["human-review"].status, "pending");
    const project = JSON.parse(await readFile(projectPath, "utf8"));
    assert(project.captions.some((item: { text: string }) => item.text === intent.captionText));
    assert.equal(sha(await readFile(sourcePath)), sourceHash);
    const probe = JSON.parse(execFileSync(executable("ffprobe.exe"), ["-v", "error", "-show_entries",
      "format=duration,size:stream=codec_type,codec_name", "-of", "json", output], { encoding: "utf8", windowsHide: true, timeout: 30_000 }));
    assert(probe.streams.some((stream: { codec_type: string }) => stream.codec_type === "video"));
    assert(probe.streams.some((stream: { codec_type: string }) => stream.codec_type === "audio"));
    assert(Number(probe.format.duration) > 5 && Number(probe.format.duration) < 5.3);
    execFileSync(executable("ffmpeg.exe"), ["-v", "error", "-i", output, "-f", "null", "-"],
      { windowsHide: true, timeout: 60_000, stdio: "ignore" });
    const report = { status: "PASS", phase: "render", workspace, output, duration: Number(probe.format.duration),
      outputBytes: Number(probe.format.size), audioStream: true, videoDecoded: true,
      sourceUnchanged: true, editableCaptionCount: project.captions.length,
      fixtureTranscriptMatchesReference, observedFirstCue: firstCue.text, nextStep: "human-review" };
    await writeFile(join(workspace, "voiced-render-report.json"), `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report)}\n`);
  }
} finally { await client.close(); }
