// Isolated acceptance of the Kit controller's project-bound create path.
// Usage: npx tsx scripts/review-kit-open-project-create.ts [--portable <preview.exe>]
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createDemoProject } from "../src/domain/demo";
import { parseProject } from "../src/application/projectFiles";
import { runKitWorkflow } from "../src/mcp/kitWorkflowBridge";

const root = resolve(import.meta.dirname, "..");
const previewArg = process.argv.indexOf("--portable");
const preview = previewArg >= 0 ? resolve(process.argv[previewArg + 1] || "") : undefined;
const segmentedCut = process.argv.includes("--segmented-cut-fixture");
const sourceDuration = segmentedCut ? 6 : 4;
if (preview) assert.equal(basename(preview).toLowerCase(), "autopilotdesk-community-preview.exe");
const resourceRoot = preview ? join(dirname(preview), "resources") : undefined;
const gatewayFile = resourceRoot ? join(resourceRoot, "runtime/agent-gateway.mjs") : join(root, "community-desktop-dist/agent-gateway.mjs");
const mcpFile = resourceRoot ? join(resourceRoot, "runtime/mcp.mjs") : join(root, "community-desktop-dist/mcp.mjs");
const kitSkill = resourceRoot ? join(resourceRoot, "video-autopilot-kit/SKILL.md")
  : resolve(root, "../video-tool-research/video-autopilot-kit/codex-skill/video-autopilot/SKILL.md");
const executableOnPath = (name: string) => execFileSync("where.exe", [name], { encoding: "utf8" }).split(/\r?\n/)[0].trim();
const artifactRoot = resolve(root, "../artifacts/autopilot-desk");
await mkdir(artifactRoot, { recursive: true });
const workspace = await mkdtemp(join(artifactRoot, "kit-bound-create-"));
const source = join(workspace, "source.mp4");
const projectPath = join(workspace, "movie.editkin.json");
const sourceInputs = segmentedCut
  ? ["red", "green", "blue"].flatMap(color => ["-f", "lavfi", "-i", `color=c=${color}:s=640x360:r=30:d=2`])
  : ["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=4"];
execFileSync(executableOnPath("ffmpeg"), ["-hide_banner", "-loglevel", "error", ...sourceInputs,
  ...(segmentedCut ? ["-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0,format=yuv420p[out]", "-map", "[out]"]
    : ["-vf", "setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv"]),
  "-c:v", "libx264", "-preset", "ultrafast", "-crf", "32",
  "-pix_fmt", "yuv420p", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
  "-x264-params", "colorprim=bt709:transfer=bt709:colormatrix=bt709",
  "-color_range", "tv", "-an", "-y", source], { stdio: "ignore", timeout: 60_000 });
const project = createDemoProject();
project.id = "kit-bound-create";
project.name = "Kit isolated source test";
project.assets[0].id = "asset-source";
project.assets[0].name = "Isolated source";
project.assets[0].uri = source;
project.assets[0].duration = sourceDuration;
project.assets[0].width = 640;
project.assets[0].height = 360;
project.tracks[0].clips[0].id = "clip-source";
project.tracks[0].clips[0].assetId = "asset-source";
project.tracks[0].clips[0].duration = sourceDuration;
// Mirror a real Editkin save. The editor normalizes legacy/demo fields before
// writing; the Kit's raw-file audit identity must see those same bytes.
await writeFile(projectPath, `${JSON.stringify(parseProject(project), null, 2)}\n`);
const projectHash = createHash("sha256").update(await readFile(projectPath)).digest("hex");

process.env.EDITKIN_WORKSPACE = workspace;
process.env.EDITKIN_AGENT_PROJECT_PATH = projectPath;
process.env.EDITKIN_VIDEO_AUTOPILOT_SKILL = kitSkill;

const createArgs = { transcriptPolicies: [{ clipId: "clip-source", policy: "visual-only" }] };
const created = await runKitWorkflow({ command: "create", ...createArgs });
assert(typeof created?.run_dir === "string");
const runRelative = relative(workspace, created.run_dir);
assert(runRelative && runRelative !== ".." && !runRelative.startsWith(`..${sep}`) && !isAbsolute(runRelative));
const next = await runKitWorkflow({ command: "next", run: created.run_dir });
assert.deepEqual(next?.ready?.map((item: { step: string }) => item.step), ["contract"]);
const status = await runKitWorkflow({ command: "status", run: created.run_dir });
assert.equal(resolve(workspace, status?.project || "").toLowerCase(), resolve(projectPath).toLowerCase());
assert.equal(createHash("sha256").update(await readFile(projectPath)).digest("hex"), projectHash);
const client = new Client({ name: "editkin-kit-bound-create-review", version: "1" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [gatewayFile],
  cwd: root,
  env: {
    ...process.env,
    EDITKIN_AGENT_GATEWAY_TARGET: mcpFile,
    EDITKIN_WORKSPACE: workspace,
    EDITKIN_AGENT_PROJECT_PATH: projectPath,
    EDITKIN_VIDEO_AUTOPILOT_SKILL: process.env.EDITKIN_VIDEO_AUTOPILOT_SKILL,
    HAO_FFMPEG_PATH: executableOnPath("ffmpeg"),
    HAO_FFPROBE_PATH: executableOnPath("ffprobe"),
    EDITKIN_CACHE_ROOT: join(workspace, "cache"),
    EDITKIN_PLUGIN_ROOTS: join(root, "plugins"),
  } as Record<string, string>,
  stderr: "pipe",
});
const tool = async (name: string, args: Record<string, unknown>) => {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, `${name} failed: ${String(result.content[0]?.type === "text" ? result.content[0].text : "no error detail").slice(0, 600)}`);
  const entry = result.content.find((item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string");
  assert(entry, `${name} returned no text`);
  return JSON.parse(entry.text);
};
let completedSteps = 0;
let viewedFrameFiles = 0;
try {
  await client.connect(transport);
  const gatewayRun = await tool("run_kit_workflow", { command: "create", runId: "gateway-smoke", ...createArgs });
  assert(typeof gatewayRun.run_dir === "string");
  const advance = async (step: string, expectedTool: string, nextStep: string) => {
    const ready = await tool("run_kit_workflow", { command: "next", run: gatewayRun.run_dir });
    assert.deepEqual(ready.ready.map((item: { step: string }) => item.step), [step]);
    const claimed = await tool("run_kit_workflow", { command: "claim", run: gatewayRun.run_dir, step });
    assert.equal(claimed.instruction?.tool, expectedTool);
    const executed = await client.callTool({ name: "call_editkin_tool", arguments: {
      name: claimed.instruction.tool, arguments: claimed.instruction.request, retainResult: true, run: gatewayRun.run_dir,
    } });
    assert.equal(executed.isError, undefined, `${expectedTool} failed: ${String(executed.content[0]?.type === "text" ? executed.content[0].text : "no error detail").slice(0, 500)}`);
    const first = executed.content.find((item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string");
    assert(first, `${expectedTool} returned no result`);
    const result = JSON.parse(first.text);
    assert(["GREEN", "PARTIAL"].includes(result.status), `${expectedTool} did not return completed evidence`);
    if (expectedTool === "prepare_ai_material") process.stderr.write(`${JSON.stringify({ stage: "prepare",
      status: result.status, sourceKind: result.packet?.source?.kind, frameCount: result.packet?.keyframes?.length,
      keyframeState: result.packet?.keyframeAnalysis?.state, keyframeReason: result.packet?.keyframeAnalysis?.omitted?.[0]?.reason })}\n`);
    const retained = executed.content.slice().reverse().find((item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string");
    assert(retained, "Gateway did not return retained evidence");
    const reference = JSON.parse(retained.text);
    assert(typeof reference.resultRef === "string", "Gateway did not retain the tool result");
    await tool("run_kit_workflow", { command: "complete", run: gatewayRun.run_dir, step,
      token: claimed.claim_token, receiptTemplate: { $resultRef: reference.resultRef } });
    completedSteps++;
    const after = await tool("run_kit_workflow", { command: "next", run: gatewayRun.run_dir });
    assert.deepEqual(after.ready.map((item: { step: string }) => item.step), [nextStep]);
    return result;
  };
  await advance("contract", "get_autopilot_contract", "session");
  await advance("session", "start_ai_editing_session", "prepare:m01-clip-source");
  const prepared = await advance("prepare:m01-clip-source", "prepare_ai_material", "keyframes:m01-clip-source");
  const frameStep = "keyframes:m01-clip-source";
  const frameClaim = await tool("run_kit_workflow", { command: "claim", run: gatewayRun.run_dir, step: frameStep });
  const calls = frameClaim.instruction?.request?.calls;
  assert(Array.isArray(calls) && calls.length > 0, "Kit did not issue bounded keyframe calls");
  const batches = [];
  for (const [batchIndex, spec] of calls.entries()) {
    assert.equal(spec.tool, "view_material_keyframes");
    const executed = await client.callTool({ name: "call_editkin_tool", arguments: {
      name: spec.tool, arguments: spec.arguments, retainResult: true, run: gatewayRun.run_dir,
    } });
    assert.equal(executed.isError, undefined, "Keyframe image tool failed");
    const images = executed.content.filter((item): item is { type: "image"; data: string; mimeType: string } => item.type === "image");
    assert.equal(images.length, spec.arguments.frameIds.length, "Image evidence count differs from Kit claim");
    for (const [imageIndex, item] of images.entries()) {
      assert.equal(item.mimeType, "image/jpeg");
      await writeFile(join(workspace, `keyframe-${batchIndex + 1}-${imageIndex + 1}.jpg`), Buffer.from(item.data, "base64"));
      viewedFrameFiles++;
    }
    const retained = executed.content.slice().reverse().find((item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string");
    assert(retained, "Gateway did not retain keyframe evidence");
    const reference = JSON.parse(retained.text);
    assert(typeof reference.resultRef === "string");
    batches.push({ request: spec.arguments, result: { $resultRef: reference.resultRef } });
  }
  await tool("run_kit_workflow", { command: "complete", run: gatewayRun.run_dir, step: frameStep,
    token: frameClaim.claim_token, receiptTemplate: { status: "GREEN", batches } });
  completedSteps++;
  const afterFrames = await tool("run_kit_workflow", { command: "next", run: gatewayRun.run_dir });
  assert.deepEqual(afterFrames.ready.map((item: { step: string }) => item.step), ["context:m01-clip-source"]);
  const contextStep = "context:m01-clip-source";
  const contextClaim = await tool("run_kit_workflow", { command: "claim", run: gatewayRun.run_dir, step: contextStep });
  const contextCalls = contextClaim.instruction?.request?.calls;
  assert(Array.isArray(contextCalls) && contextCalls.length > 0, "Kit did not issue bounded context calls");
  const windows = [];
  for (const spec of contextCalls) {
    assert.equal(spec.tool, "get_material_context");
    const executed = await client.callTool({ name: "call_editkin_tool", arguments: {
      name: spec.tool, arguments: spec.arguments, retainResult: true, run: gatewayRun.run_dir,
    } });
    assert.equal(executed.isError, undefined, "Bounded material context call failed");
    const resultBlock = executed.content.find((item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string");
    assert(resultBlock && JSON.parse(resultBlock.text).status === "GREEN", "Material context was not ready");
    const retained = executed.content.slice().reverse().find((item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string");
    assert(retained, "Gateway did not retain context evidence");
    const reference = JSON.parse(retained.text);
    assert(typeof reference.resultRef === "string");
    windows.push({ request: spec.arguments, result: { $resultRef: reference.resultRef } });
  }
  await tool("run_kit_workflow", { command: "complete", run: gatewayRun.run_dir, step: contextStep,
    token: contextClaim.claim_token, receiptTemplate: { status: "GREEN", windows } });
  completedSteps++;
  const afterContext = await tool("run_kit_workflow", { command: "next", run: gatewayRun.run_dir });
  assert.deepEqual(afterContext.ready.map((item: { step: string }) => item.step), ["semantics:m01-clip-source"]);
  const semanticStep = "semantics:m01-clip-source";
  const semanticClaim = await tool("run_kit_workflow", { command: "claim", run: gatewayRun.run_dir, step: semanticStep });
  assert.equal(semanticClaim.instruction?.tool, "record_material_semantics");
  const semanticRequest = structuredClone(semanticClaim.instruction.request);
  semanticRequest.overallTopic = segmentedCut
    ? "FFmpeg-generated red, green and blue test pattern" : "FFmpeg-generated moving test pattern";
  semanticRequest.contentType = "synthetic visual test fixture";
  semanticRequest.language = "none";
  const viewedFrameIds = calls.flatMap((spec: { arguments: { frameIds: string[] } }) => spec.arguments.frameIds);
  if (segmentedCut) {
    const keyframes: Array<{ id: string; time: number }> = prepared.packet?.keyframes || [];
    assert(keyframes.length > 0, "Segmented fixture needs timestamped keyframes");
    semanticRequest.segments = [[0, 2, "Red synthetic scene"], [2, 4, "Green synthetic scene"],
      [4, 6, "Blue synthetic scene"]].map(([start, end, summary]) => {
      const evidenceFrameIds = keyframes.filter(frame => frame.time >= Number(start) && frame.time < Number(end)
        && viewedFrameIds.includes(frame.id)).map(frame => frame.id);
      assert(evidenceFrameIds.length > 0, `No reviewed frame for ${summary}`);
      return { ...structuredClone(semanticRequest.segments[0]), start, end, summary,
        evidenceFrameIds, transcriptCueIndexes: [] };
    });
  } else {
    semanticRequest.segments[0].summary = "Synthetic testsrc2 imagery generated for this isolated fixture; no real-world scene or narrative event is asserted.";
    semanticRequest.segments[0].evidenceFrameIds = viewedFrameIds;
    semanticRequest.segments[0].transcriptCueIndexes = [];
    assert.equal(semanticRequest.segments[0].evidenceFrameIds.length, viewedFrameFiles);
  }
  const semanticResult = await client.callTool({ name: "call_editkin_tool", arguments: {
    name: "record_material_semantics", arguments: semanticRequest, retainResult: true, run: gatewayRun.run_dir,
  } });
  assert.equal(semanticResult.isError, undefined, `Semantic tool failed: ${String(semanticResult.content[0]?.type === "text" ? semanticResult.content[0].text : "no detail").slice(0, 600)}`);
  const semanticTexts = semanticResult.content.filter((item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string");
  assert.equal(JSON.parse(semanticTexts[0].text).status, "GREEN");
  const semanticRef = JSON.parse(semanticTexts.at(-1)!.text);
  assert(typeof semanticRef.resultRef === "string");
  await tool("run_kit_workflow", { command: "complete", run: gatewayRun.run_dir, step: semanticStep,
    token: semanticClaim.claim_token, receiptTemplate: { request: semanticRequest, result: { $resultRef: semanticRef.resultRef } } });
  completedSteps++;
  const afterSemantics = await tool("run_kit_workflow", { command: "next", run: gatewayRun.run_dir });
  assert.deepEqual(afterSemantics.ready.map((item: { step: string }) => item.step).sort(), ["plugin-discovery", "route"]);
  for (const [step, expectedTool] of [["route", "resolve_autopilot_inference_route"], ["plugin-discovery", "list_installed_plugins"]] as const) {
    const claim = await tool("run_kit_workflow", { command: "claim", run: gatewayRun.run_dir, step });
    assert.equal(claim.instruction?.tool, expectedTool);
    const executed = await client.callTool({ name: "call_editkin_tool", arguments: {
      name: expectedTool, arguments: claim.instruction.request, retainResult: true, run: gatewayRun.run_dir,
    } });
    assert.equal(executed.isError, undefined, `${expectedTool} failed: ${String(executed.content[0]?.type === "text" ? executed.content[0].text : "no detail").slice(0, 600)}`);
    const texts = executed.content.filter((item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string");
    assert(["GREEN", "EMPTY"].includes(JSON.parse(texts[0].text).status || "GREEN"));
    const reference = JSON.parse(texts.at(-1)!.text);
    assert(typeof reference.resultRef === "string");
    await tool("run_kit_workflow", { command: "complete", run: gatewayRun.run_dir, step,
      token: claim.claim_token, receiptTemplate: { $resultRef: reference.resultRef } });
    completedSteps++;
  }
  const afterDiscovery = await tool("run_kit_workflow", { command: "next", run: gatewayRun.run_dir });
  assert.deepEqual(afterDiscovery.ready.map((item: { step: string }) => item.step), ["plan"]);
  const verified = await tool("run_kit_workflow", { command: "verify", run: gatewayRun.run_dir });
  assert.equal(verified?.status, "GREEN", `Original Kit rejected the semantic receipt chain: ${JSON.stringify(verified?.errors || [])}`);
} finally {
  await client.close();
}
assert.equal(createHash("sha256").update(await readFile(projectPath)).digest("hex"), projectHash);
await writeFile(join(workspace, "review-report.json"), `${JSON.stringify({
  status: "PASS", isolated: true, bundledPreview: Boolean(preview), autoBoundMaterials: 1, kitRunCreated: true,
  firstReadyStep: "contract", completedSteps, keyframeImageFiles: viewedFrameFiles, segmentedCut,
  nextReadySteps: ["plan"], semanticFixtureOnly: true, projectUnchanged: true,
}, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ status: "PASS", artifact: workspace, completedSteps,
  keyframeImageFiles: viewedFrameFiles, nextReadySteps: ["plan"] })}\n`);
