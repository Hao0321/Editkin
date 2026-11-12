// Packaged Agent gateway acceptance: real local ASR must satisfy a required Kit transcript.
// Usage: npx tsx scripts/review-kit-voiced-prepare.ts --portable <preview.exe> --speech <short-wav>
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
const option = (flag: string) => {
  const index = process.argv.indexOf(flag);
  assert(index >= 0 && process.argv[index + 1], `Provide ${flag}`);
  return resolve(process.argv[index + 1]);
};
const portable = option("--portable"), speech = option("--speech");
const untagged = process.argv.includes("--untagged");
assert.equal(basename(portable).toLowerCase(), "autopilotdesk-community-preview.exe");
const resources = join(dirname(portable), "resources");
const runtime = join(resources, "runtime");
const installedTool = (name: string) => execFileSync("where.exe", [name], { encoding: "utf8", windowsHide: true }).split(/\r?\n/u)[0].trim();
const ffmpeg = installedTool("ffmpeg.exe");
const ffprobe = installedTool("ffprobe.exe");
const whisperCli = join(runtime, "whisper-cli.exe");
const whisperModel = join(runtime, "models/ggml-small-q5_1.bin");
const probe = JSON.parse(execFileSync(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "json", speech],
  { encoding: "utf8", windowsHide: true, timeout: 15_000 }));
const duration = Number(probe.format?.duration);
assert(Number.isFinite(duration) && duration >= 2 && duration <= 30, "Use a short voiced WAV sample");
await mkdir(artifacts, { recursive: true });
const workspace = await mkdtemp(join(artifacts, "kit-voiced-prepare-"));
const source = join(workspace, "voiced-source.mp4");
const verifiedColor = ["-vf", "format=yuv420p,setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709",
  "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv"];
execFileSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", `testsrc2=size=320x180:rate=15:duration=${duration}`,
  "-i", speech, "-map", "0:v:0", "-map", "1:a:0", "-shortest",
  ...(untagged ? [] : verifiedColor), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-y", source],
{ windowsHide: true, timeout: 60_000, stdio: "ignore" });
const sourceProbe = JSON.parse(execFileSync(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "json", source],
  { encoding: "utf8", windowsHide: true, timeout: 15_000 }));
const clipDuration = Number(sourceProbe.format?.duration);
assert(Number.isFinite(clipDuration) && clipDuration >= 2 && clipDuration <= 30);
const projectPath = join(workspace, "movie.editkin.json");
const project = createDemoProject();
project.id = "kit-voiced-prepare-review";
project.assets[0] = { ...project.assets[0], id: "asset-voiced", uri: source, duration: clipDuration,
  width: 320, height: 180, ...(untagged ? {} : { color: { interpretation: "rec709" as const } }) };
project.tracks[0].clips[0] = { ...project.tracks[0].clips[0], id: "clip-voiced", assetId: "asset-voiced", duration: clipDuration };
await writeFile(projectPath, `${JSON.stringify(parseProject(project), null, 2)}\n`);
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const projectHash = sha256(await readFile(projectPath));
const sourceHash = sha256(await readFile(source));
const client = new Client({ name: "editkin-voiced-prepare-review", version: "1" });
const transport = new StdioClientTransport({ command: process.execPath, args: [join(runtime, "agent-gateway.mjs")], cwd: root,
  env: { ...process.env, EDITKIN_AGENT_GATEWAY_TARGET: join(runtime, "mcp.mjs"), EDITKIN_WORKSPACE: workspace,
    EDITKIN_AGENT_PROJECT_PATH: projectPath, EDITKIN_VIDEO_AUTOPILOT_SKILL: join(resources, "video-autopilot-kit/SKILL.md"),
    HAO_FFMPEG_PATH: ffmpeg, HAO_FFPROBE_PATH: ffprobe, EDITKIN_WHISPER_CLI_PATH: whisperCli,
    EDITKIN_WHISPER_MODEL_PATH: whisperModel, EDITKIN_MODEL_ROOT: join(workspace, "models"),
    EDITKIN_CACHE_ROOT: join(workspace, "cache"), EDITKIN_PLUGIN_ROOTS: join(root, "plugins") } as Record<string, string>,
  stderr: "pipe" });
const call = async (name: string, args: Record<string, unknown>) => {
  const result = await client.callTool({ name, arguments: args });
  const parts = result.content.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string");
  assert(parts[0], `${name} returned no text`);
  if (result.isError) throw Error(`${name}: ${parts[0].text.slice(0, 800)}`);
  return { value: JSON.parse(parts[0].text) as any, reference: parts[1] ? JSON.parse(parts[1].text) as any : undefined };
};
try {
  await client.connect(transport);
  const created = (await call("run_kit_workflow", { command: "create", runId: "voiced-prepare", clipIds: ["clip-voiced"] })).value;
  const run = created.run_dir as string;
  const binding = JSON.parse(await readFile(join(run, "workflow-state.json"), "utf8"));
  assert.equal(binding.binding.materials[0].clip_id, "clip-voiced");
  assert.notEqual(binding.binding.materials[0].transcript_policy, "visual-only",
    "A video with speech must not be marked visual-only");
  const advance = async (step: string) => {
    const claim = (await call("run_kit_workflow", { command: "claim", run, step })).value;
    const executed = await call("call_editkin_tool", { name: claim.instruction.tool,
      arguments: claim.instruction.request, retainResult: true, run });
    assert(typeof executed.reference?.resultRef === "string", `${step} has no retained receipt`);
    await call("run_kit_workflow", { command: "complete", run, step,
      token: claim.claim_token, receiptTemplate: { $resultRef: executed.reference.resultRef } });
    return executed.value;
  };
  await advance("contract");
  await advance("session");
  const before = JSON.parse(await readFile(join(run, "workflow-state.json"), "utf8"));
  const prepareStep = Object.keys(before.steps).find((step) => step.startsWith("prepare:"));
  assert(prepareStep);
  const prepareClaim = (await call("run_kit_workflow", { command: "claim", run, step: prepareStep })).value;
  const preparation = await call("call_editkin_tool", { name: prepareClaim.instruction.tool,
    arguments: prepareClaim.instruction.request, retainResult: true, run });
  assert(typeof preparation.reference?.resultRef === "string", "prepare has no retained receipt");
  const prepared = preparation.value;
  assert.equal(prepared.packet?.transcript?.state, "ready", "Required transcript did not become ready");
  assert(prepared.packet.transcript.cueCount > 0, "Recognizer returned no speech cues");
  const completionRequest = { command: "complete", run, step: prepareStep,
    token: prepareClaim.claim_token, receiptTemplate: { $resultRef: preparation.reference.resultRef } };
  if (untagged) {
    assert.equal(prepared.packet.keyframes.length, 0, "Untagged control unexpectedly produced trusted keyframes");
    const raw = await client.callTool({ name: "run_kit_workflow", arguments: completionRequest });
    const explanation = raw.content.find((part): part is { type: "text"; text: string } => part.type === "text")?.text ?? "";
    const blocked = JSON.parse(explanation);
    assert.equal(raw.isError, true);
    assert.equal(blocked.status, "BLOCKED_VISUAL_EVIDENCE");
    assert.equal(blocked.reasonCode, "incomplete-color-tags");
    assert.match(blocked.nextAction, /不要重試同一個 prepare claim/u);
    const state = JSON.parse(await readFile(join(run, "workflow-state.json"), "utf8"));
    assert.equal(state.status, "blocked");
    assert.equal(state.steps[prepareStep].status, "failed");
    assert.equal(state.steps[prepareStep].claim, null);
    assert.equal(sha256(await readFile(projectPath)), projectHash);
    assert.equal(sha256(await readFile(source)), sourceHash);
    const report = { status: "PASS", mode: "untagged-control", workspace, run, transcriptState: "ready",
      visualBlockExplained: true, runBlocked: true, projectUnchanged: true, sourceUnchanged: true };
    await writeFile(join(workspace, "voiced-prepare-report.json"), `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } else {
  await call("run_kit_workflow", completionRequest);
  const context = (await call("call_editkin_tool", { name: "get_material_context", arguments: {
    materialId: prepared.packet.materialId, start: 0, end: clipDuration, maxCues: 20, maxTokens: 800,
  } })).value;
  const cues = context.context?.transcript?.cues;
  assert(Array.isArray(cues) && cues.some((cue: { text?: string }) => /[\u4e00-\u9fff]/u.test(cue.text ?? "")),
    "Packaged Agent context did not expose Chinese transcript evidence");
  const state = JSON.parse(await readFile(join(run, "workflow-state.json"), "utf8"));
  assert.equal(state.steps[prepareStep].status, "completed");
  assert.notEqual(state.status, "blocked");
  assert.equal(sha256(await readFile(projectPath)), projectHash);
  assert.equal(sha256(await readFile(source)), sourceHash);
  const report = { status: "PASS", workspace, run, prepareStep, transcriptState: prepared.packet.transcript.state,
    cueCount: prepared.packet.transcript.cueCount, cues: cues.map(({ index, text }: { index: number; text: string }) => ({ index, text })),
    nextReady: (await call("run_kit_workflow", { command: "next", run })).value.ready.map((step: { step: string }) => step.step),
    projectUnchanged: true, sourceUnchanged: true };
  await writeFile(join(workspace, "voiced-prepare-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  }
} finally { await client.close(); }
