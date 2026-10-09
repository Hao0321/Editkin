// Isolated gateway acceptance for a selected still image in a mixed-source project.
// Optional: --project <saved Editkin project> --clip-id <image clip ID> copies the project first.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createDemoProject } from "../src/domain/demo";
import { parseProject } from "../src/application/projectFiles";

const root = resolve(import.meta.dirname, "..");
const artifacts = resolve(root, "../artifacts/autopilot-desk");
const argument = (name: string) => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1]; };
const sourceProject = argument("--project"), requestedClipId = argument("--clip-id");
assert.equal(Boolean(sourceProject), Boolean(requestedClipId), "Provide --project and --clip-id together");
const portable = argument("--portable");
if (portable) assert.equal(basename(portable).toLowerCase(), "autopilotdesk-community-preview.exe");
const resources = portable ? join(dirname(resolve(portable)), "resources") : undefined;
const gateway = resources ? join(resources, "runtime/agent-gateway.mjs") : join(root, "community-desktop-dist/agent-gateway.mjs");
const mcp = resources ? join(resources, "runtime/mcp.mjs") : join(root, "community-desktop-dist/mcp.mjs");
const skill = resources ? join(resources, "video-autopilot-kit/SKILL.md")
  : resolve(root, "../video-tool-research/video-autopilot-kit/codex-skill/video-autopilot/SKILL.md");
const executable = (name: string) => execFileSync("where.exe", [name], { encoding: "utf8" }).split(/\r?\n/)[0].trim();
await mkdir(artifacts, { recursive: true });
const workspace = await mkdtemp(join(artifacts, "kit-selected-image-"));
const projectPath = join(workspace, "movie.editkin.json");
let selectedId = requestedClipId || "clip-selected-image";
if (sourceProject) {
  const original = JSON.parse(await readFile(resolve(sourceProject), "utf8"));
  const selected = original.tracks.flatMap((track: any) => track.clips).find((clip: any) => clip.id === selectedId);
  const asset = original.assets.find((item: any) => item.id === selected?.assetId);
  assert(selected && asset?.kind === "image" && typeof asset.uri === "string", "Selected clip must be a project image");
  await writeFile(projectPath, `${JSON.stringify(original, null, 2)}\n`);
} else {
  const source = join(workspace, "..", `${basename(workspace)}-source.jpg`);
  execFileSync(executable("ffmpeg"), ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=640x360",
    "-frames:v", "1", "-y", source], { timeout: 60_000, stdio: "ignore" });
  const project = createDemoProject();
  project.id = "kit-selected-image-review";
  project.assets[0] = { ...project.assets[0], id: "asset-selected-image", name: "selected synthetic image",
    kind: "image", uri: source, duration: 5, width: 640, height: 360 };
  project.tracks[0].clips[0] = { ...project.tracks[0].clips[0], id: selectedId,
    assetId: "asset-selected-image", timelineStart: 5, duration: 5, sourceStart: 0 };
  await writeFile(projectPath, `${JSON.stringify(parseProject(project), null, 2)}\n`);
}
const before = createHash("sha256").update(await readFile(projectPath)).digest("hex");
const client = new Client({ name: "editkin-selected-image-review", version: "1" });
const transport = new StdioClientTransport({ command: process.execPath, args: [gateway], cwd: root,
  env: { ...process.env, EDITKIN_AGENT_GATEWAY_TARGET: mcp, EDITKIN_WORKSPACE: workspace,
    EDITKIN_AGENT_PROJECT_PATH: projectPath, EDITKIN_VIDEO_AUTOPILOT_SKILL: skill,
    HAO_FFMPEG_PATH: executable("ffmpeg"), HAO_FFPROBE_PATH: executable("ffprobe"),
    EDITKIN_CACHE_ROOT: join(workspace, "cache"), EDITKIN_PLUGIN_ROOTS: join(root, "plugins") } as Record<string, string>,
  stderr: "pipe" });
const call = async (name: string, args: Record<string, unknown>) => {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content.find((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")?.text;
  if (result.isError || !text) throw Error(`${name}: ${String(text || "no result").slice(0, 700)}`);
  return { value: JSON.parse(text), reference: result.content.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")[1],
    imageCount: result.content.filter(part => part.type === "image").length };
};
try {
  await client.connect(transport);
  if (!sourceProject) {
    const project = JSON.parse(await readFile(projectPath, "utf8"));
    const unrelated = join(workspace, "..", `${basename(workspace)}-unrelated.jpg`);
    await writeFile(unrelated, await readFile(project.assets[0].uri));
    project.assets.push({ ...project.assets[0], id: "asset-unrelated", uri: unrelated });
    project.tracks[0].clips.push({ ...project.tracks[0].clips[0], id: "clip-unrelated", assetId: "asset-unrelated", timelineStart: 0 });
    await writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`);
    const all = await client.callTool({ name: "run_kit_workflow", arguments: { command: "create", runId: "all-clips" } });
    assert.equal(all.isError, true, "Automatic all-project binding must still reject the later outside source");
    const wrongPolicy = await client.callTool({ name: "run_kit_workflow", arguments: { command: "create",
      runId: "image-required", clipIds: [selectedId], transcriptPolicies: [{ clipId: selectedId, policy: "required" }] } });
    assert.equal(wrongPolicy.isError, true, "A still image cannot silently require transcription");
  }
  const created = (await call("run_kit_workflow", { command: "create", runId: "selected-image",
    clipIds: [selectedId] })).value;
  assert.equal(created.sourceStaging?.copiedExternalSources, 1);
  const state = JSON.parse(await readFile(join(created.run_dir, "workflow-state.json"), "utf8"));
  assert.deepEqual(state.binding.materials.map((item: any) => item.clip_id), [selectedId]);
  assert.equal(state.binding.materials[0].transcript_policy, "visual-only", "Images must bind visual-only without model-supplied policy");
  const advance = async (step: string, tool: string) => {
    const claim = (await call("run_kit_workflow", { command: "claim", run: created.run_dir, step })).value;
    assert.equal(claim.instruction?.tool, tool);
    const executed = await call("call_editkin_tool", { name: tool, arguments: claim.instruction.request,
      retainResult: true, run: created.run_dir });
    const reference = executed.reference && JSON.parse(executed.reference.text);
    assert(typeof reference?.resultRef === "string");
    await call("run_kit_workflow", { command: "complete", run: created.run_dir, step,
      token: claim.claim_token, receiptTemplate: { $resultRef: reference.resultRef } });
    return executed.value;
  };
  await advance("contract", "get_autopilot_contract");
  await advance("session", "start_ai_editing_session");
  const next = (await call("run_kit_workflow", { command: "next", run: created.run_dir })).value;
  const preparation = next.ready.find((item: any) => item.step.startsWith("prepare:"));
  assert(preparation, "Image preparation should be ready");
  const prepared = await advance(preparation.step, "prepare_ai_material");
  assert(["GREEN", "PARTIAL"].includes(prepared.status));
  let viewedImageCount = 0;
  const viewedFrameIds: string[] = [];
  let evidenceSteps = 3;
  for (let index = 0; index < 15; index++) {
    const current = (await call("run_kit_workflow", { command: "next", run: created.run_dir })).value;
    const ready = current.ready as Array<{ step: string }>;
    if (ready.some(item => item.step === "plan")) break;
    const item = ready.find(entry => !sourceProject || !entry.step.startsWith("semantics:"));
    if (!item) break;
    const claim = (await call("run_kit_workflow", { command: "claim", run: created.run_dir, step: item.step })).value;
    const instruction = claim.instruction;
    let receiptTemplate: Record<string, unknown>;
    if (item.step.startsWith("keyframes:") || item.step.startsWith("context:")) {
      const calls = instruction.request.calls as Array<{ tool: string; arguments: Record<string, unknown> }>;
      const records = [];
      for (const spec of calls) {
        const executed = await call("call_editkin_tool", { name: spec.tool, arguments: spec.arguments,
          retainResult: true, run: created.run_dir });
        const reference = executed.reference && JSON.parse(executed.reference.text);
        assert(typeof reference?.resultRef === "string");
        if (item.step.startsWith("keyframes:")) {
          viewedImageCount += executed.imageCount;
          viewedFrameIds.push(...spec.arguments.frameIds as string[]);
        }
        records.push({ request: spec.arguments, result: { $resultRef: reference.resultRef } });
      }
      receiptTemplate = { status: "GREEN", [item.step.startsWith("keyframes:") ? "batches" : "windows"]: records };
    } else if (item.step.startsWith("semantics:")) {
      const request = structuredClone(instruction.request);
      request.overallTopic = "Blue synthetic still image";
      request.contentType = "synthetic visual test fixture";
      request.language = "none";
      request.segments[0].summary = "Solid blue synthetic image generated by FFmpeg";
      request.segments[0].evidenceFrameIds = viewedFrameIds;
      request.segments[0].transcriptCueIndexes = [];
      assert(viewedFrameIds.length > 0);
      const executed = await call("call_editkin_tool", { name: "record_material_semantics", arguments: request,
        retainResult: true, run: created.run_dir });
      const reference = executed.reference && JSON.parse(executed.reference.text);
      receiptTemplate = { request, result: { $resultRef: reference.resultRef } };
    } else {
      const executed = await call("call_editkin_tool", { name: instruction.tool, arguments: instruction.request,
        retainResult: true, run: created.run_dir });
      const reference = executed.reference && JSON.parse(executed.reference.text);
      receiptTemplate = { $resultRef: reference.resultRef };
    }
    await call("run_kit_workflow", { command: "complete", run: created.run_dir, step: item.step,
      token: claim.claim_token, receiptTemplate });
    evidenceSteps++;
  }
  assert(viewedImageCount > 0, "The original Kit keyframe step must deliver the actual image bytes");
  const after = createHash("sha256").update(await readFile(projectPath)).digest("hex");
  const remaining = (await call("run_kit_workflow", { command: "next", run: created.run_dir })).value.ready.map((item: any) => item.step);
  assert(sourceProject ? remaining.some((step: string) => step.startsWith("semantics:")) : remaining.includes("plan"));
  let draftCaptionStart: number | undefined;
  let finished: string | undefined;
  if (!sourceProject) {
    await call("draft_kit_single_clip_plan", { run: created.run_dir, captionText: "Verified blue frame",
      topic: "A verified blue image", beatSummary: "A blue synthetic image remains visible for five seconds",
      subject: "Blue synthetic image", audience: "Test reviewer" });
    const plan = JSON.parse(await readFile(join(created.run_dir, "plan.v4.json"), "utf8"));
    draftCaptionStart = plan.commands.find((command: any) => command.type === "add_caption")?.caption.start;
    assert.equal(draftCaptionStart, 5, "Caption must follow the selected clip's timeline position");
    const projectFps = JSON.parse(await readFile(projectPath, "utf8")).fps;
    assert.equal(plan.editorial.narrative.beats[0].range.startFrame, 5 * projectFps);
    if (process.argv.includes("--finish")) {
      const rendered = (await call("finish_kit_single_clip_edit", { run: created.run_dir })).value;
      assert.equal(rendered.status, "RENDERED_AWAITING_HUMAN_REVIEW");
      finished = rendered.status;
    }
  }
  const report = { status: "PASS", workspace, copiedRealProject: Boolean(sourceProject), selectedClipId: selectedId,
    materialCount: state.binding.materials.length, preparedImage: true, viewedImageCount, evidenceSteps,
    projectUnchanged: sourceProject ? before === after : undefined, nextSteps: remaining, draftCaptionStart, finished };
  await writeFile(join(workspace, "selected-image-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally { await client.close(); }
