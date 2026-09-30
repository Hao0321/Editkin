// Exercise the embedded Agent gateway: evidence-bound blue→red story, original Kit gates and rendered pixels.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { parseAutopilotPlan } from "../src/application/autopilotPlan";

const root = resolve(import.meta.dirname, "..");
const artifacts = realpathSync(resolve(root, "../artifacts/autopilot-desk"));
const value = (flag: string) => { const index = process.argv.indexOf(flag); assert(index >= 0 && process.argv[index + 1]);
  return realpathSync(resolve(process.argv[index + 1])); };
const workspace = value("--workspace");
const portable = process.argv.includes("--portable") ? value("--portable") : undefined;
const verifyOnly = process.argv.includes("--verify-only");
assert.equal(dirname(workspace).toLowerCase(), artifacts.toLowerCase());
assert.match(basename(workspace), /^kit-two-source-[a-z0-9]+$/i);
const resources = portable ? join(dirname(portable), "resources") : undefined;
const gateway = resources ? join(resources, "runtime/agent-gateway.mjs") : join(root, "community-desktop-dist/agent-gateway.mjs");
const mcp = resources ? join(resources, "runtime/mcp.mjs") : join(root, "community-desktop-dist/mcp.mjs");
const run = "videos/_AUTOPILOT/editkin-v4/two-source-smoke";
const state = JSON.parse(await readFile(join(workspace, run, "workflow-state.json"), "utf8"));
const skill = realpathSync(state.governance.skill_path);
const sourceReport = JSON.parse(await readFile(join(workspace, "two-source-create-report.json"), "utf8"));
assert.equal(sourceReport.status, "PASS");
const projectPath = join(workspace, "movie.editkin.json");
const client = new Client({ name: "editkin-two-story-review", version: "1" });
const executable = (name: string) => execFileSync("where.exe", [name], { encoding: "utf8" }).split(/\r?\n/)[0].trim();
const transport = new StdioClientTransport({ command: process.execPath, args: [gateway], cwd: root,
  env: { ...process.env, EDITKIN_AGENT_GATEWAY_TARGET: mcp, EDITKIN_WORKSPACE: workspace,
    EDITKIN_AGENT_PROJECT_PATH: projectPath, EDITKIN_VIDEO_AUTOPILOT_SKILL: skill,
    HAO_FFMPEG_PATH: executable("ffmpeg"), HAO_FFPROBE_PATH: executable("ffprobe"),
    EDITKIN_CACHE_ROOT: join(workspace, "cache"), EDITKIN_PLUGIN_ROOTS: join(root, "plugins") } as Record<string, string>,
  stderr: "pipe" });
const tool = async (name: string, args: Record<string, unknown>, errorExpected = false) => {
  const result = await client.callTool({ name, arguments: args });
  const first = result.content.find((item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string");
  assert(first, `${name} returned no text`);
  assert.equal(Boolean(result.isError), errorExpected, `${name}: ${first.text.slice(0, 800)}`);
  if (errorExpected) return { error: first.text };
  return JSON.parse(first.text);
};
try {
  await client.connect(transport);
  const context = await tool("get_kit_plan_context", { run });
  const beforeRejectedFinish = await readFile(join(workspace, run, "workflow-state.json"), "utf8");
  const malformed = await tool("finish_kit_two_clip_edit", { run: context.run + "\n</parameter]" }, true);
  const rejection = JSON.parse(malformed.error!);
  assert.equal(rejection.code, "INVALID_KIT_RUN_ARGUMENT");
  assert.equal(rejection.mutationAttempted, false);
  assert.equal(rejection.correctedCall.arguments.run, context.run);
  assert.equal(await readFile(join(workspace, run, "workflow-state.json"), "utf8"), beforeRejectedFinish);
  assert.equal(context.materials.length, 2);
  assert.equal(context.savedDraft.status, verifyOnly ? "VALID" : "MISSING");
  assert.equal(context.twoClipStoryTool.openCodeName, "editkin_draft_kit_two_clip_story_plan");
  assert(context.sourceBoundSeed.submittedSemanticOutlines.every((item: { segments: Array<{ evidenceFrameCount: number }> }) =>
    item.segments.length === 1 && item.segments[0].evidenceFrameCount > 0));
  const intent = { run, topic: "Two independent synthetic color scenes in reverse story order",
    audience: "Editkin test reviewers", domain: "general", beats: [
      { clipId: "clip-blue", summary: "Blue synthetic scene opens the sequence", focus: "Blue color field",
        captionText: "藍色合成畫面" },
      { clipId: "clip-red", summary: "Red synthetic scene closes the sequence", focus: "Red color field",
        captionText: "紅色合成畫面" },
    ] };
  if (!verifyOnly) {
    await tool("draft_kit_two_clip_story_plan", { ...intent,
      beats: [{ ...intent.beats[0], clipId: "clip-red" }, { ...intent.beats[1], clipId: "clip-red" }] }, true);
    assert(!existsSync(join(workspace, run, "plan.v4.json")));
    const draft = await tool("draft_kit_two_clip_story_plan", intent);
    assert.equal(draft.status, "DRAFT_WRITTEN");
    assert.deepEqual(draft.storyOrder, ["clip-blue", "clip-red"]);
  }
  const plan = parseAutopilotPlan(JSON.parse(await readFile(join(workspace, run, "plan.v4.json"), "utf8")));
  assert.equal(plan.schema, "hao.video-autopilot.edit-plan/v4");
  assert.deepEqual(plan.commands.map(command => command.type), ["set_aesthetic_system", "delete_clip", "delete_clip",
    "add_clip", "add_clip", "add_caption", "add_caption"]);
  const finished = verifyOnly ? { outputPath: `${run}/render/current.mp4`, editableCaptionCount: 2 }
    : await tool("finish_kit_two_clip_edit", { run });
  if (!verifyOnly) assert.equal(finished.status, "RENDERED_AWAITING_HUMAN_REVIEW");
  assert.equal(finished.editableCaptionCount, 2);
  const project = JSON.parse(await readFile(projectPath, "utf8"));
  assert.deepEqual(project.tracks.flatMap((track: { clips: Array<{ id: string; timelineStart: number }> }) => track.clips)
    .sort((a: { timelineStart: number }, b: { timelineStart: number }) => a.timelineStart - b.timelineStart)
    .map((clip: { id: string }) => clip.id), ["clip-blue", "clip-red"]);
  assert.equal(project.captions.length, 2);
  assert(project.captions[0].text.includes("藍") && project.captions[1].text.includes("紅"));
  const output = realpathSync(join(workspace, finished.outputPath));
  assert.equal(relative(workspace, output).startsWith(".."), false);
  const probe = JSON.parse(execFileSync(executable("ffprobe"), ["-v", "error", "-show_entries", "format=duration,size",
    "-of", "json", output], { encoding: "utf8", timeout: 30_000 }));
  assert(Math.abs(Number(probe.format.duration) - 4) < 0.1);
  execFileSync(executable("ffmpeg"), ["-v", "error", "-i", output, "-f", "null", "-"],
    { timeout: 60_000, stdio: "ignore" });
  const center = (second: number) => {
    const bytes = execFileSync(executable("ffmpeg"), ["-v", "error", "-ss", String(second), "-i", output,
      "-frames:v", "1", "-vf", "crop=2:2:(iw-2)/2:(ih-2)/2", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
      { timeout: 60_000, maxBuffer: 4096 });
    return [bytes[0], bytes[1], bytes[2]];
  };
  const first = center(0.5), second = center(2.5);
  assert(first[2] > first[0] * 1.5 && first[2] > first[1] * 1.5);
  assert(second[0] > second[1] * 1.5 && second[0] > second[2] * 1.5);
  for (const source of sourceReport.sourceHashes) assert.equal(createHash("sha256").update(
    await readFile(join(workspace, `${source.clipId.slice(5)}.mp4`))).digest("hex"), source.sha256);
  const after = JSON.parse(await readFile(join(workspace, run, "workflow-state.json"), "utf8"));
  for (const step of ["plan", "audit", "apply", "render"]) assert.equal(after.steps[step].status, "completed");
  assert.equal(after.steps["human-review"].status, "pending");
  await tool("finish_kit_two_clip_edit", { run }, true);
  const report = { status: "PASS", workspace, packaged: Boolean(portable), output,
    sourceHashes: sourceReport.sourceHashes, storyOrder: ["clip-blue", "clip-red"],
    duration: Number(probe.format.duration), firstCenterRgb: first, secondCenterRgb: second,
    editableClips: 2, editableCaptions: 2, kitNextStep: "human-review", malformedRunRejectedBeforeMutation: true };
  await writeFile(join(workspace, "two-story-render-qc.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally { await client.close(); }
