// Two independent visual-only source files through the original Kit evidence DAG.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createDemoProject } from "../src/domain/demo";
import { parseProject } from "../src/application/projectFiles";

const root = resolve(import.meta.dirname, "..");
const artifacts = resolve(root, "../artifacts/autopilot-desk");
const previewAt = process.argv.indexOf("--portable");
const portable = previewAt >= 0 ? resolve(process.argv[previewAt + 1] || "") : undefined;
if (portable) assert.equal(basename(portable).toLowerCase(), "autopilotdesk-community-preview.exe");
const resources = portable ? join(dirname(portable), "resources") : undefined;
const gateway = resources ? join(resources, "runtime/agent-gateway.mjs") : join(root, "community-desktop-dist/agent-gateway.mjs");
const mcp = resources ? join(resources, "runtime/mcp.mjs") : join(root, "community-desktop-dist/mcp.mjs");
const kitSkill = resources ? join(resources, "video-autopilot-kit/SKILL.md")
  : resolve(root, "../video-tool-research/video-autopilot-kit/codex-skill/video-autopilot/SKILL.md");
const executable = (name: string) => execFileSync("where.exe", [name], { encoding: "utf8" }).split(/\r?\n/)[0].trim();
await mkdir(artifacts, { recursive: true });
const workspace = await mkdtemp(join(artifacts, "kit-two-source-"));
const projectPath = join(workspace, "movie.editkin.json");
const sources = ["red", "blue"].map(color => ({ color, clipId: `clip-${color}`, assetId: `asset-${color}`,
  path: join(workspace, `${color}.mp4`) }));
for (const source of sources) execFileSync(executable("ffmpeg"), ["-v", "error", "-f", "lavfi", "-i",
  `color=c=${source.color}:s=640x360:r=30:d=2`, "-vf", "setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv",
  "-c:v", "libx264", "-preset", "ultrafast", "-crf", "32", "-pix_fmt", "yuv420p",
  "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
  "-x264-params", "colorprim=bt709:transfer=bt709:colormatrix=bt709", "-color_range", "tv",
  "-an", "-y", source.path], { timeout: 60_000, stdio: "ignore" });
const project = createDemoProject();
project.id = "kit-two-source";
project.name = "Isolated two-source story";
project.width = 640; project.height = 360;
project.assets = sources.map((source, index) => ({ ...structuredClone(project.assets[0]), id: source.assetId,
  name: `${source.color} synthetic source`, uri: source.path, duration: 2, width: 640, height: 360 }));
project.tracks[0].clips = sources.map((source, index) => ({ ...structuredClone(project.tracks[0].clips[0]),
  id: source.clipId, assetId: source.assetId, timelineStart: index * 2, duration: 2, sourceStart: 0 }));
await writeFile(projectPath, `${JSON.stringify(parseProject(project), null, 2)}\n`);
const sourceHashes = await Promise.all(sources.map(async source => ({ clipId: source.clipId,
  sha256: createHash("sha256").update(await readFile(source.path)).digest("hex") })));
const projectHash = createHash("sha256").update(await readFile(projectPath)).digest("hex");
const client = new Client({ name: "editkin-two-source-create-review", version: "1" });
const transport = new StdioClientTransport({ command: process.execPath, args: [gateway], cwd: root,
  env: { ...process.env, EDITKIN_AGENT_GATEWAY_TARGET: mcp, EDITKIN_WORKSPACE: workspace,
    EDITKIN_AGENT_PROJECT_PATH: projectPath, EDITKIN_VIDEO_AUTOPILOT_SKILL: kitSkill,
    HAO_FFMPEG_PATH: executable("ffmpeg"), HAO_FFPROBE_PATH: executable("ffprobe"),
    EDITKIN_CACHE_ROOT: join(workspace, "cache"), EDITKIN_PLUGIN_ROOTS: join(root, "plugins") } as Record<string, string>,
  stderr: "pipe" });
const tool = async (name: string, args: Record<string, unknown>) => {
  const result = await client.callTool({ name, arguments: args });
  const parts = result.content.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string");
  if (result.isError || !parts.length) throw Error(`${name} failed: ${String(parts[0]?.text || "no text").slice(0, 700)}`);
  return { value: JSON.parse(parts[0].text), reference: parts[1] ? JSON.parse(parts[1].text) : undefined };
};
const viewed = new Map<string, string[]>();
let completedSteps = 0;
try {
  await client.connect(transport);
  const created = (await tool("run_kit_workflow", { command: "create", runId: "two-source-smoke",
    transcriptPolicies: sources.map(source => ({ clipId: source.clipId, policy: "visual-only" })) })).value;
  assert(typeof created.run_dir === "string");
  const run = relative(workspace, created.run_dir).replaceAll("\\", "/");
  for (let round = 0; round < 40; round++) {
    const next = (await tool("run_kit_workflow", { command: "next", run })).value;
    const ready: Array<{ step: string }> = next.ready || [];
    if (ready.length === 1 && ready[0].step === "plan") break;
    assert(ready.length > 0, `Kit stalled before plan in round ${round}`);
    for (const { step } of ready) {
      const claim = (await tool("run_kit_workflow", { command: "claim", run, step })).value;
      const instruction = claim.instruction;
      assert(typeof claim.claim_token === "string" && instruction?.tool);
      let receiptTemplate: Record<string, unknown>;
      if (step.startsWith("keyframes:")) {
        const batches = [];
        const ids: string[] = [];
        for (const spec of instruction.request.calls) {
          assert.equal(spec.tool, "view_material_keyframes");
          const called = await client.callTool({ name: "call_editkin_tool", arguments: {
            name: spec.tool, arguments: spec.arguments, retainResult: true, run } });
          assert.equal(called.isError, undefined);
          const images = called.content.filter(part => part.type === "image");
          assert.equal(images.length, spec.arguments.frameIds.length);
          const texts = called.content.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string");
          const reference = JSON.parse(texts.at(-1)!.text);
          assert(typeof reference.resultRef === "string");
          ids.push(...spec.arguments.frameIds);
          batches.push({ request: spec.arguments, result: { $resultRef: reference.resultRef } });
        }
        viewed.set(step.split(":").at(-1)!, ids);
        receiptTemplate = { status: "GREEN", batches };
      } else if (step.startsWith("context:")) {
        const windows = [];
        for (const spec of instruction.request.calls) {
          assert.equal(spec.tool, "get_material_context");
          const called = await tool("call_editkin_tool", { name: spec.tool, arguments: spec.arguments,
            retainResult: true, run });
          assert(typeof called.reference?.resultRef === "string");
          windows.push({ request: spec.arguments, result: { $resultRef: called.reference.resultRef } });
        }
        receiptTemplate = { status: "GREEN", windows };
      } else if (step.startsWith("semantics:")) {
        const request = structuredClone(instruction.request);
        const clipId = request.clipId || sources.find(source => step.includes(source.clipId))?.clipId;
        const source = sources.find(source => source.clipId === clipId);
        assert(source, `Unknown semantics source for ${step}`);
        request.overallTopic = `${source.color} synthetic color scene`;
        request.contentType = "synthetic visual test fixture";
        request.language = "none";
        request.segments[0].summary = `${source.color} solid color scene generated by FFmpeg`;
        request.segments[0].evidenceFrameIds = viewed.get(step.split(":").at(-1)!) || [];
        request.segments[0].transcriptCueIndexes = [];
        assert(request.segments[0].evidenceFrameIds.length > 0);
        const called = await tool("call_editkin_tool", { name: "record_material_semantics", arguments: request,
          retainResult: true, run });
        assert.equal(called.value.status, "GREEN");
        receiptTemplate = { request, result: { $resultRef: called.reference?.resultRef } };
      } else {
        const called = await tool("call_editkin_tool", { name: instruction.tool, arguments: instruction.request,
          retainResult: true, run });
        assert(typeof called.reference?.resultRef === "string");
        receiptTemplate = { $resultRef: called.reference.resultRef };
      }
      await tool("run_kit_workflow", { command: "complete", run, step,
        token: claim.claim_token, receiptTemplate });
      completedSteps++;
    }
  }
  const next = (await tool("run_kit_workflow", { command: "next", run })).value;
  assert.deepEqual(next.ready.map((entry: { step: string }) => entry.step), ["plan"]);
  assert.equal((await tool("run_kit_workflow", { command: "verify", run })).value.status, "GREEN");
  assert.equal(createHash("sha256").update(await readFile(projectPath)).digest("hex"), projectHash);
  for (const source of sources) assert.equal(createHash("sha256").update(await readFile(source.path)).digest("hex"),
    sourceHashes.find(item => item.clipId === source.clipId)?.sha256);
  const report = { status: "PASS", workspace, run, sourceHashes, completedSteps,
    viewedFrames: Object.fromEntries(viewed), nextStep: "plan", projectUnchanged: true, syntheticOnly: true };
  await writeFile(join(workspace, "two-source-create-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ status: report.status, workspace, completedSteps, nextStep: "plan" })}\n`);
} finally { await client.close(); }
