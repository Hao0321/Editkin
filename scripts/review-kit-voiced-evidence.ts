// Resume the isolated voiced Kit run through viewed frames, transcript context and semantics.
// Usage: npx tsx scripts/review-kit-voiced-evidence.ts --workspace <kit-voiced-prepare-*> --portable <preview.exe> --frames|--to-plan
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const root = resolve(import.meta.dirname, "..");
const artifacts = realpathSync(resolve(root, "../artifacts/autopilot-desk"));
function argument(name: string) {
  const index = process.argv.indexOf(name);
  assert(index >= 0 && process.argv[index + 1], `Missing ${name}`);
  return realpathSync(resolve(process.argv[index + 1]));
}
const workspace = argument("--workspace"), portable = argument("--portable");
assert.equal(dirname(workspace).toLowerCase(), artifacts.toLowerCase());
assert.match(basename(workspace), /^kit-voiced-prepare-[a-z0-9]+$/iu);
assert.equal(basename(portable).toLowerCase(), "autopilotdesk-community-preview.exe");
const framesOnly = process.argv.includes("--frames");
assert(framesOnly !== process.argv.includes("--to-plan"), "Choose --frames or --to-plan");
const resources = join(dirname(portable), "resources");
const runtime = join(resources, "runtime");
const projectPath = join(workspace, "movie.editkin.json");
const sourcePath = join(workspace, "voiced-source.mp4");
const run = join(workspace, "videos/_AUTOPILOT/editkin-v4/voiced-prepare");
const stateBefore = JSON.parse(await readFile(join(run, "workflow-state.json"), "utf8"));
assert.equal(stateBefore.status, "active");
assert.equal(stateBefore.steps["prepare:m01-clip-voiced"].status, "completed");
const sha = (buffer: Buffer) => createHash("sha256").update(buffer).digest("hex");
const sourceHash = sha(await readFile(sourcePath));
const executable = (name: string) => execFileSync("where.exe", [name], { encoding: "utf8", windowsHide: true }).split(/\r?\n/u)[0].trim();
const client = new Client({ name: "editkin-voiced-evidence-review", version: "1" });
const transport = new StdioClientTransport({ command: process.execPath, args: [join(runtime, "agent-gateway.mjs")], cwd: root,
  env: { ...process.env, EDITKIN_AGENT_GATEWAY_TARGET: join(runtime, "mcp.mjs"),
    EDITKIN_WORKSPACE: workspace, EDITKIN_AGENT_PROJECT_PATH: projectPath,
    EDITKIN_VIDEO_AUTOPILOT_SKILL: join(resources, "video-autopilot-kit/SKILL.md"),
    HAO_FFMPEG_PATH: executable("ffmpeg.exe"), HAO_FFPROBE_PATH: executable("ffprobe.exe"),
    EDITKIN_WHISPER_CLI_PATH: join(runtime, "whisper-cli.exe"),
    EDITKIN_WHISPER_MODEL_PATH: join(runtime, "models/ggml-small-q5_1.bin"),
    EDITKIN_MODEL_ROOT: join(workspace, "models"), EDITKIN_CACHE_ROOT: join(workspace, "cache"),
    EDITKIN_PLUGIN_ROOTS: join(root, "plugins") } as Record<string, string>, stderr: "pipe" });
const call = async (name: string, args: Record<string, unknown>) => {
  const result = await client.callTool({ name, arguments: args });
  const texts = result.content.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string");
  assert(texts[0], `${name} returned no text`);
  if (result.isError) throw Error(`${name}: ${texts[0].text.slice(0, 800)}`);
  return { value: JSON.parse(texts[0].text) as any,
    reference: texts[1] ? JSON.parse(texts.at(-1)!.text) as any : undefined,
    images: result.content.filter((part): part is { type: "image"; data: string; mimeType: string } => part.type === "image") };
};
const workflow = async (args: Record<string, unknown>) => (await call("run_kit_workflow", { run, ...args })).value;
const finishStep = async (step: string, receiptTemplate: Record<string, unknown>, token: string) => {
  await workflow({ command: "complete", step, token, receiptTemplate });
  assert.equal(JSON.parse(await readFile(join(run, "workflow-state.json"), "utf8")).steps[step].status, "completed");
};
try {
  await client.connect(transport);
  if (framesOnly) {
    const next = await workflow({ command: "next" });
    assert.deepEqual(next.ready.map((item: { step: string }) => item.step), ["keyframes:m01-clip-voiced"]);
    const step = "keyframes:m01-clip-voiced";
    const claim = await workflow({ command: "claim", step });
    const batches = [], reviewedFrameIds: string[] = [];
    for (const [batchIndex, spec] of claim.instruction.request.calls.entries()) {
      assert.equal(spec.tool, "view_material_keyframes");
      const result = await call("call_editkin_tool", { name: spec.tool, arguments: spec.arguments,
        retainResult: true, run });
      assert.equal(result.images.length, spec.arguments.frameIds.length);
      for (const [imageIndex, image] of result.images.entries()) {
        assert.equal(image.mimeType, "image/jpeg");
        await writeFile(join(workspace, `review-keyframe-${batchIndex + 1}-${imageIndex + 1}.jpg`), Buffer.from(image.data, "base64"));
      }
      assert(typeof result.reference?.resultRef === "string");
      reviewedFrameIds.push(...spec.arguments.frameIds);
      batches.push({ request: spec.arguments, result: { $resultRef: result.reference.resultRef } });
    }
    assert(reviewedFrameIds.length > 0);
    await finishStep(step, { status: "GREEN", batches }, claim.claim_token);
    await writeFile(join(workspace, "reviewed-frame-ids.json"), `${JSON.stringify(reviewedFrameIds, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ status: "PASS", phase: "frames", workspace,
      frameCount: reviewedFrameIds.length, next: (await workflow({ command: "next" })).ready.map((item: { step: string }) => item.step) })}\n`);
  } else {
    const reviewedFrameIds = JSON.parse(await readFile(join(workspace, "reviewed-frame-ids.json"), "utf8"));
    assert(Array.isArray(reviewedFrameIds) && reviewedFrameIds.length > 0);
    const contextStep = "context:m01-clip-voiced";
    assert.deepEqual((await workflow({ command: "next" })).ready.map((item: { step: string }) => item.step), [contextStep]);
    const contextClaim = await workflow({ command: "claim", step: contextStep });
    const windows = [], cues: Array<{ index: number; text: string }> = [];
    for (const spec of contextClaim.instruction.request.calls) {
      assert.equal(spec.tool, "get_material_context");
      const result = await call("call_editkin_tool", { name: spec.tool, arguments: spec.arguments,
        retainResult: true, run });
      assert(typeof result.reference?.resultRef === "string");
      for (const cue of result.value.context?.transcript?.cues ?? [])
        if (!cues.some(item => item.index === cue.index)) cues.push({ index: cue.index, text: cue.text });
      windows.push({ request: spec.arguments, result: { $resultRef: result.reference.resultRef } });
    }
    assert(cues.length > 0 && cues.some(cue => /[\u4e00-\u9fff]/u.test(cue.text)));
    await finishStep(contextStep, { status: "GREEN", windows }, contextClaim.claim_token);
    const semanticStep = "semantics:m01-clip-voiced";
    assert.deepEqual((await workflow({ command: "next" })).ready.map((item: { step: string }) => item.step), [semanticStep]);
    const semanticClaim = await workflow({ command: "claim", step: semanticStep });
    const request = structuredClone(semanticClaim.instruction.request);
    request.overallTopic = "中文口述剪輯指令與合成彩色測試畫面";
    request.contentType = "synthetic voiced video test fixture";
    request.language = "zh";
    request.segments[0].summary = "合成彩色測試圖樣配上中文人聲；語音內容要求剪好影片並聽清每一句。";
    request.segments[0].evidenceFrameIds = reviewedFrameIds;
    request.segments[0].transcriptCueIndexes = cues.map(cue => cue.index);
    const semantic = await call("call_editkin_tool", { name: "record_material_semantics", arguments: request,
      retainResult: true, run });
    assert.equal(semantic.value.status, "GREEN");
    await finishStep(semanticStep, { request, result: { $resultRef: semantic.reference.resultRef } }, semanticClaim.claim_token);
    for (const [step, name] of [["route", "resolve_autopilot_inference_route"], ["plugin-discovery", "list_installed_plugins"]]) {
      const claim = await workflow({ command: "claim", step });
      assert.equal(claim.instruction.tool, name);
      const result = await call("call_editkin_tool", { name, arguments: claim.instruction.request,
        retainResult: true, run });
      await finishStep(step, { $resultRef: result.reference.resultRef }, claim.claim_token);
    }
    const next = await workflow({ command: "next" });
    assert.deepEqual(next.ready.map((item: { step: string }) => item.step), ["plan"]);
    assert.equal((await workflow({ command: "verify" })).status, "GREEN");
    assert.equal(sha(await readFile(sourcePath)), sourceHash);
    const report = { status: "PASS", workspace, phase: "to-plan", transcriptCues: cues,
      viewedFrames: reviewedFrameIds.length, sourceUnchanged: true, nextStep: "plan" };
    await writeFile(join(workspace, "voiced-evidence-report.json"), `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report)}\n`);
  }
} finally { await client.close(); }
