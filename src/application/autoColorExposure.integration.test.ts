import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";
import { applyCommand, type EditorCommand } from "../domain/commands";
import { prepareMaterialIntelligence, recordMaterialSemantics } from "./materialIntelligence";
import { proposeAutoColorExposure, verifyAutoColorDecisions } from "./autoColorEvidence";
import { colorFileSha } from "./materialColorSamplingRuntime";
import { renderComposite } from "../render/ffmpegComposite";
import { buildRenderPlan } from "../render/planner";
import { analyzeShotColor } from "../color/shotColorAnalysis";
import { createAutopilotV4Fixture } from "./autopilotPlanFixture";
import { bindCurrentDesignEvidence } from "./testCurrentDesignEvidence";

const app = fileURLToPath(new URL("../../", import.meta.url));
const ffmpegPath = join(app, "vendor/ffmpeg/win32-x64/ffmpeg.exe"), ffprobePath = join(app, "vendor/ffmpeg/win32-x64/ffprobe.exe");
async function makeFixture() {
  await mkdir(join(app, ".rd/tmp"), { recursive: true });
  const root = await mkdtemp(join(app, ".rd/tmp/auto-colour-")), source = join(root, "ramp.mp4");
  const encode = spawnSync(ffmpegPath, ["-v", "error", "-f", "lavfi", "-i", "nullsrc=s=128x96:r=10:d=1,geq=lum='32+X/W*100':cb=128:cr=128",
    "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-x264-params", "colorprim=bt709:transfer=bt709:colormatrix=bt709:range=tv", source], { windowsHide: true, timeout: 30000 });
  expect(encode.status, encode.stderr.toString()).toBe(0);
  const sourceSha = await colorFileSha(source), project = createEmptyProject("Exposure integration fixture", { fps: 10, width: 256, height: 192 });
  project.assets.push({ id: "asset", name: "Synthetic ramp", uri: source, kind: "video", duration: 1 });
  project.tracks[0].clips.push({ id: "clip", assetId: "asset", trackId: project.tracks[0].id, sourceStart: 0, duration: 1,
    timelineStart: 0, volume: 0, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] });
  const runtime = { ffmpegPath, ffprobePath, cacheRoot: root, modelRoot: root, resolveSource: async () => source };
  const { packet } = await prepareMaterialIntelligence({ assetId: "asset", clipId: "clip", sourcePath: source, sourceSha256: sourceSha,
    sourceStart: 0, duration: 1, fps: 10, kind: "video", includeTranscript: false, maxKeyframes: 3 }, runtime);
  expect(packet.analysis.color?.status).toBe("measured");
  const semantics = await recordMaterialSemantics(root, { materialId: packet.materialId, sourceSha256: sourceSha,
    overallTopic: "Owned synthetic exposure test", contentType: "fixture", language: "en", people: [], locations: [],
    segments: [{ start: 0, end: 1, summary: "Known grey ramp; engineering fixture, not human aesthetic approval", subjects: [], actions: [], objects: [],
      importance: .5, evidenceFrameIds: [packet.keyframes[0].id], transcriptCueIndexes: [] }] });
  const request = { materialId: packet.materialId, semanticReceiptSha256: semantics.semanticReceiptSha256,
    goal: { medianLinearY: packet.analysis.color!.measurements!.frames[0].linearRelativeY.p50 * 1.5,
      maxExposureChange: .5, reason: "Explicit brighter-grey engineering target, not scene inference" } };
  const proposal = await proposeAutoColorExposure(project, request, runtime);
  const bindings = [{ decisionSha256: proposal.decisionSha256, commandIndex: 0, clipId: "clip" }];
  return { root, source, sourceSha, project, runtime, packet, request, proposal, bindings };
}
let f: Awaited<ReturnType<typeof makeFixture>>;
beforeAll(async () => { f = await makeFixture(); }, 120000);

it("selects real decoded exposure, preserves other controls and renders the selected command", async () => {
  expect(f.proposal.exposure).toBeGreaterThan(0);
  expect(f.proposal.whiteBalance).toBe("unmeasured"); expect(f.proposal.aestheticQuality).toBe("unmeasured");
  await expect(verifyAutoColorDecisions(f.bindings, [f.proposal.command], f.project, f.runtime, [f.request])).resolves.toMatchObject({ decisionCount: 1 });
  const edited = applyCommand(f.project, f.proposal.command);
  expect(edited.tracks[0].clips[0].color).toEqual({ ...DEFAULT_COLOR, exposure: f.proposal.exposure });
  expect(f.project.tracks[0].clips[0].color).toEqual(DEFAULT_COLOR);
  const output = join(f.root, "command-render.mp4");
  await renderComposite(ffmpegPath, ffprobePath, output, edited, buildRenderPlan(edited, uri => uri), undefined, "libx264", 30000);
  const decoded = spawnSync(ffmpegPath, ["-v", "error", "-i", output, "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"], { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 });
  expect(decoded.status, decoded.stderr.toString()).toBe(0);
  const measured = analyzeShotColor([{ sampleId: "render", timeSeconds: 0, width: 256, height: 192, format: "rgb8", primaries: "bt709", transfer: "bt709-oetf", range: "full", pixels: decoded.stdout }]);
  expect(Math.abs(Math.log2(measured.frames[0].linearRelativeY.p50 / f.request.goal.medianLinearY))).toBeLessThan(.3);
  expect(await colorFileSha(f.source)).toBe(f.sourceSha);
}, 60000);

it("rejects wrong commands, repeated colour, missing material, changed window/revision and stale source", async () => {
  const verify = (commands: EditorCommand[], project = f.project, materials = [f.request]) => verifyAutoColorDecisions(f.bindings, commands, project, f.runtime, materials);
  await expect(verify([{ type: "set_clip_color", clipId: "clip", patch: { exposure: -.5 } }])).rejects.toThrow(/mismatch/);
  await expect(verify([f.proposal.command, f.proposal.command])).rejects.toThrow(/疊加/);
  await expect(verify([{ type: "batch", commands: [f.proposal.command] }])).rejects.toThrow(/batch/);
  await expect(verify([f.proposal.command], f.project, [])).rejects.toThrow(/missing/);
  const trim = structuredClone(f.project); trim.tracks[0].clips[0].duration = .8;
  await expect(verify([f.proposal.command], trim)).rejects.toThrow(/時間窗/);
  await expect(verify([f.proposal.command], { ...f.project, revision: f.project.revision + 1 })).rejects.toThrow(/revision/);
  const original = await readFile(f.source);
  try { await writeFile(f.source, Buffer.concat([original, Buffer.from("changed")])); await expect(verify([f.proposal.command])).rejects.toThrow(/SHA-256/); }
  finally { await writeFile(f.source, original); }
}, 60000);

it("rejects an additional unmeasured look after the bound exposure command", async () => {
  await expect(verifyAutoColorDecisions(f.bindings, [f.proposal.command,
    { type: "set_clip_creative", clipId: "clip", patch: { lookPresetId: "hao-blue-clean" } }], f.project, f.runtime, [f.request])).rejects.toThrow(/modified|baseline|疊加/);
}, 30000);

it("executes actual STDIO audit/apply once with colour evidence and preserves review-required", async () => {
  const projectPath = join(f.root, "mcp-project.editkin.json"); await writeFile(projectPath, JSON.stringify(f.project));
  const plugins = join(f.root, "empty-plugins"); await mkdir(plugins);
  const client = new Client({ name: "colour-integration-test", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(app, "node_modules/tsx/dist/cli.mjs"), join(app, "src/mcp/server.ts")], cwd: app,
    env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
      EDITKIN_WORKSPACE: app, EDITKIN_CACHE_ROOT: f.root, EDITKIN_MODEL_ROOT: f.root, EDITKIN_PLUGIN_ROOTS: plugins, EDITKIN_WORKFLOW_PROFILE_PATH: "",
      HAO_FFMPEG_PATH: ffmpegPath, HAO_FFPROBE_PATH: ffprobePath }, stderr: "pipe" });
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    const value = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    return { result, value };
  };
  try {
    await client.connect(transport);
    const contract = await call("get_autopilot_contract", {}); expect(contract.result.isError, JSON.stringify(contract.value)).not.toBe(true);
    const proposed = await call("propose_auto_color_exposure", { projectPath, ...f.request });
    expect(proposed.result.isError, JSON.stringify(proposed.value)).not.toBe(true);
    expect(proposed.value.exposure).toBe(f.proposal.exposure);
    const draft = createAutopilotV4Fixture(contract.value.requiredPlanSource);
    const basePlan = { ...draft, editorial: { ...draft.editorial, graphics: [] }, materialEvidence: { ...draft.materialEvidence,
      receipts: [{ materialId: f.packet.materialId, sourceSha256: f.sourceSha, assetId: "asset", clipId: "clip", semanticReceiptSha256: f.request.semanticReceiptSha256 }] },
      commands: [proposed.value.command, { type: "set_aesthetic_system", aestheticSystem: draft.aesthetic }],
      autoColor: [{ decisionSha256: proposed.value.decisionSha256, commandIndex: 0, clipId: "clip" }] };
    const plan = await bindCurrentDesignEvidence(call, projectPath, f.project.fps, basePlan);
    const audited = await call("audit_autopilot_plan", { projectPath, plan });
    expect(audited.result.isError, JSON.stringify(audited.value)).not.toBe(true);
    expect(audited.value.autoColor.decisionCount).toBe(1);
    const args = { projectPath, plan, auditReceipt: audited.value.auditReceipt };
    const applied = await call("apply_autopilot_plan", args);
    expect(applied.result.isError, JSON.stringify(applied.value)).not.toBe(true);
    expect(applied.value.status).toBe("REVIEW_REQUIRED");
    expect(applied.value.receipt.autoColor.decisionCount).toBe(1);
    const saved = JSON.parse(await readFile(projectPath, "utf8"));
    expect(saved.tracks[0].clips[0].color.exposure).toBe(f.proposal.exposure);
    const replay = await call("apply_autopilot_plan", args); expect(replay.result.isError).toBe(true);
    expect(JSON.parse(await readFile(projectPath, "utf8")).revision).toBe(saved.revision);
    await writeFile(join(f.root, "mcp-live-result.json"), JSON.stringify({ proposal: proposed.value, audit: audited.value, apply: applied.value, replay: replay.value }, null, 2));
  } finally { await client.close(); }
}, 60000);
