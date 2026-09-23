import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";
import { applyCommand } from "../domain/commands";
import { prepareMaterialIntelligence, recordMaterialSemantics } from "./materialIntelligence";
import { proposeReferenceWhiteBalance, verifyAutoColorDecisions } from "./autoColorEvidence";
import { colorDigest, colorFileSha } from "./materialColorSamplingRuntime";
import { measureReferenceWhiteBalanceFrame } from "./referenceWhiteBalance";
import { renderComposite } from "../render/ffmpegComposite";
import { buildRenderPlan } from "../render/planner";
import { createAutopilotV4Fixture } from "./autopilotPlanFixture";
import { bindCurrentDesignEvidence } from "./testCurrentDesignEvidence";

const app = fileURLToPath(new URL("../../", import.meta.url));
const ffmpegPath = join(app, "vendor/ffmpeg/win32-x64/ffmpeg.exe"), ffprobePath = join(app, "vendor/ffmpeg/win32-x64/ffprobe.exe");
const roi = { x: .25, y: .25, width: .5, height: .5 };
async function makeFixture(cast: [number, number, number] = [137, 128, 119]) {
  await mkdir(join(app, ".rd/tmp"), { recursive: true });
  const root = await mkdtemp(join(app, ".rd/tmp/white-balance-")), source = join(root, "declared-neutral-cast.mp4");
  // Independently specified RGB cast, not output from gradeRgb or a production inverse.
  const pixels = Buffer.alloc(128 * 96 * 3);
  for (let i = 0; i < pixels.length; i += 3) pixels.set(cast, i);
  const encoded = spawnSync(ffmpegPath, ["-v", "error", "-f", "rawvideo", "-pixel_format", "rgb24", "-video_size", "128x96", "-framerate", "10",
    "-i", "pipe:0", "-vf", "loop=loop=9:size=1:start=0,scale=out_color_matrix=bt709:out_range=tv", "-frames:v", "10", "-an", "-c:v", "libx264",
    "-crf", "0", "-pix_fmt", "yuv444p", "-x264-params", "colorprim=bt709:transfer=bt709:colormatrix=bt709:range=tv", source],
  { input: pixels, windowsHide: true, timeout: 30000 });
  expect(encoded.status, encoded.stderr.toString()).toBe(0);
  const sourceSha = await colorFileSha(source), project = createEmptyProject("Declared neutral fixture", { fps: 10, width: 128, height: 96 });
  project.assets.push({ id: "asset", name: "Engineering neutral reference with cast", uri: source, kind: "video", duration: 1 });
  project.tracks[0].clips.push({ id: "clip", assetId: "asset", trackId: project.tracks[0].id, timelineStart: 0, sourceStart: 0, duration: 1,
    volume: 0, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] });
  const runtime = { ffmpegPath, ffprobePath, cacheRoot: root, modelRoot: root, resolveSource: async () => source };
  const { packet } = await prepareMaterialIntelligence({ assetId: "asset", clipId: "clip", sourcePath: source, sourceStart: 0, duration: 1,
    fps: 10, kind: "video", includeTranscript: false, maxKeyframes: 3 }, runtime);
  expect(packet.analysis.color?.status).toBe("measured");
  const semantics = await recordMaterialSemantics(root, { materialId: packet.materialId, sourceSha256: sourceSha, overallTopic: "Synthetic caller-declared neutral cast",
    contentType: "engineering-fixture", language: "en", people: [], locations: [], segments: [{ start: 0, end: 1,
      summary: "Uniform colour patch whose intended neutrality is declared by the test author, not automatically detected or human art approved",
      subjects: [], actions: [], objects: [], importance: .5, evidenceFrameIds: packet.keyframes.map(frame => frame.id), transcriptCueIndexes: [] }] });
  const request = { materialId: packet.materialId, semanticReceiptSha256: semantics.semanticReceiptSha256,
    goal: { reference: "caller-declared-neutral" as const, reason: "Known neutral engineering patch with an independently authored RGB cast", maxGainStops: 1,
      samples: packet.keyframes.map(frame => ({ sampleId: frame.id, roi })) } };
  const proposal = await proposeReferenceWhiteBalance(project, request, runtime);
  const bindings = [{ mode: "reference_white_balance" as const, decisionSha256: proposal.decisionSha256, commandIndex: 0, clipId: "clip" }];
  const receiptPath = join(root, "auto-colour-decisions", `${proposal.decisionSha256}.json`);
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  await writeFile(join(root, "proposal-evidence.json"), JSON.stringify({ proposal, sourceSha }, null, 2));
  return { root, source, sourceSha, project, runtime, packet, request, proposal, bindings, receipt };
}
let f: Awaited<ReturnType<typeof makeFixture>>;
beforeAll(async () => { f = await makeFixture(); }, 120000);

it("corrects an independently specified cast through actual decode and leaves non-WB controls editable", async () => {
  const { selection } = f.receipt.evaluation;
  // Original strong 137/128/119 input and original .08-stop goal are unchanged.
  // Legacy temperature/tint reached .10496 and failed; the new FLOAT reference
  // path must cross that SAME threshold rather than substitute an easier cast.
  expect(f.proposal.status).toBe("candidate"); expect(f.proposal.applicable).toBe(true);
  expect(f.proposal.selected.worstErrorStops).toBeLessThanOrEqual(.08);
  expect(f.proposal.selected.neutralErrorStops).toBeLessThan(selection.candidates[selection.baselineIndex].neutralErrorStops * .5);
  expect(f.proposal.selected.whiteBalanceRed).toBeLessThan(0);
  expect(f.proposal.selected.whiteBalanceBlue).toBeGreaterThan(0);
  expect(f.receipt.schema).toBe("editkin.auto-color-decision/v3");
  expect(f.receipt.evaluation.algorithm).toBe("editkin.source-linear-reference-white-balance/v1");
  for (const surface of f.receipt.evaluation.surfaces) {
    expect(surface.referenceSurface.format).toBe("gbrapf32le");
    expect(surface.referenceSurface.basis).toBe("linear-rec709");
    expect(surface.referenceSurface.floatSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(surface.referenceSurface.filters.some((filter: string) => /^(tonemap=|format=rgb24$|eq=)/.test(filter))).toBe(false);
  }
  expect(f.proposal.referenceAuthority).toBe("caller-declared-not-detected");
  expect(f.proposal.whitePointVerification).toBe("unmeasured");
  await expect(verifyAutoColorDecisions(f.bindings, [f.proposal.command], f.project, f.runtime, [f.request])).resolves.toMatchObject({ decisionCount: 1 });
  const edited = applyCommand(f.project, f.proposal.command), color = edited.tracks[0].clips[0].color;
  expect(color).toEqual({ ...DEFAULT_COLOR, whiteBalanceRed: f.proposal.selected.whiteBalanceRed,
    whiteBalanceGreen: f.proposal.selected.whiteBalanceGreen, whiteBalanceBlue: f.proposal.selected.whiteBalanceBlue });
  const output = join(f.root, "reference-correction.mp4");
  await renderComposite(ffmpegPath, ffprobePath, output, edited, buildRenderPlan(edited, uri => uri), undefined, "libx264", 30000);
  const decoded = spawnSync(ffmpegPath, ["-v", "error", "-i", output, "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"],
    { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 });
  expect(decoded.status, decoded.stderr.toString()).toBe(0);
  const measured = measureReferenceWhiteBalanceFrame({ sampleId: "output", timeSeconds: 0, width: 128, height: 96,
    pixels: decoded.stdout, roi, transfer: "bt709-oetf", reference: "caller-declared-neutral" });
  expect(measured.neutralErrorStops).toBeLessThanOrEqual(.08);
  expect(f.proposal.selected.neutralErrorStops).not.toBeNull();
  expect(Math.abs(measured.neutralErrorStops - f.proposal.selected.neutralErrorStops!)).toBeLessThan(.06);
  const baselineReference = f.receipt.evaluation.candidates[selection.baselineIndex].frames[0];
  expect(Math.abs(Math.log2(measured.meanLinearY / baselineReference.meanLinearY))).toBeLessThanOrEqual(.1);
  expect(await colorFileSha(f.source)).toBe(f.sourceSha);
  expect(f.project.tracks[0].clips[0].color).toEqual(DEFAULT_COLOR);
}, 60000);

it("reaches a moderate cast and stops as soon as the measured target is achieved", async () => {
  const moderate = await makeFixture([134, 131, 124]);
  expect(moderate.proposal.status).toBe("candidate");
  expect(moderate.proposal.selected.worstErrorStops).toBeLessThanOrEqual(.08);
  expect(moderate.proposal.candidateCount).toBeGreaterThan(1);
  expect(moderate.proposal.candidateCount).toBeLessThanOrEqual(9);
  await expect(verifyAutoColorDecisions(moderate.bindings, [moderate.proposal.command], moderate.project,
    moderate.runtime, [moderate.request])).resolves.toMatchObject({ decisionCount: 1 });
}, 120000);

it("solves a mixed green/blue cast from one baseline rather than successive artistic offset probes", async () => {
  const mixed = await makeFixture([132, 132, 124]);
  expect(mixed.proposal.status).toBe("candidate");
  expect(mixed.proposal.selected.worstErrorStops).toBeLessThanOrEqual(.08);
  expect(mixed.proposal.candidateCount).toBe(2);
  expect(mixed.proposal.candidateCount).toBeLessThanOrEqual(9);
  expect(mixed.proposal.selected.whiteBalanceBlue).toBeGreaterThan(0);
  expect(mixed.proposal.selected.whiteBalanceGreen).not.toBe(0);
  expect(mixed.project.tracks[0].clips[0].color.temperature).toBe(0);
  expect(mixed.project.tracks[0].clips[0].color.tint).toBe(0);
}, 120000);

it("leaves neutral references unchanged and refuses clipped declared white", async () => {
  const neutral = await makeFixture([128, 128, 128]);
  expect(neutral.proposal.status).toBe("unchanged"); expect(neutral.proposal.candidateCount).toBe(1);
  expect(neutral.proposal.command).toMatchObject({ patch: { whiteBalanceRed: 0, whiteBalanceGreen: 0, whiteBalanceBlue: 0 } });
  const clipped = await makeFixture([255, 255, 255]);
  expect(clipped.proposal.status).toBe("reference_unusable"); expect(clipped.proposal.candidateCount).toBe(1);
  expect(clipped.proposal.applicable).toBe(false);
  expect(clipped.proposal.command).toMatchObject({ patch: { whiteBalanceRed: 0, whiteBalanceGreen: 0, whiteBalanceBlue: 0 } });
  await expect(verifyAutoColorDecisions(clipped.bindings, [clipped.proposal.command], clipped.project, clipped.runtime, [clipped.request])).rejects.toThrow(/白平衡/);
}, 120000);

it("rejects mode/command drift and rehashed goal changes instead of accepting self-consistent false scope", async () => {
  await expect(verifyAutoColorDecisions([{ ...f.bindings[0], mode: "exposure" }], [f.proposal.command], f.project, f.runtime, [f.request])).rejects.toThrow();
  await expect(verifyAutoColorDecisions(f.bindings, [f.proposal.command,
    { type: "set_clip_color", clipId: "clip", patch: { exposure: .5 } }], f.project, f.runtime, [f.request])).rejects.toThrow();
  const forged = structuredClone(f.receipt); forged.evaluation.goal.samples[0].roi.x = .1;
  forged.decisionSha256 = colorDigest({ ...forged, decisionSha256: undefined });
  await writeFile(join(f.root, "auto-colour-decisions", `${forged.decisionSha256}.json`), JSON.stringify(forged));
  await expect(verifyAutoColorDecisions([{ ...f.bindings[0], decisionSha256: forged.decisionSha256 }], [f.proposal.command],
    f.project, f.runtime, [f.request])).rejects.toThrow();
}, 30000);

it("runs actual STDIO reference proposal, v4 audit/apply and rejects replay", async () => {
  const projectPath = join(f.root, "mcp-project.editkin.json"); await writeFile(projectPath, JSON.stringify(f.project));
  const plugins = join(f.root, "empty-plugins"); await mkdir(plugins);
  const client = new Client({ name: "white-balance-integration", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(app, "node_modules/tsx/dist/cli.mjs"), join(app, "src/mcp/server.ts")], cwd: app,
    env: { ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === "string")),
      EDITKIN_WORKSPACE: app, EDITKIN_CACHE_ROOT: f.root, EDITKIN_MODEL_ROOT: f.root, EDITKIN_PLUGIN_ROOTS: plugins, EDITKIN_WORKFLOW_PROFILE_PATH: "",
      HAO_FFMPEG_PATH: ffmpegPath, HAO_FFPROBE_PATH: ffprobePath }, stderr: "pipe" });
  const call = async (name: string, argumentsValue: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: argumentsValue });
    return { result, value: JSON.parse((result.content as Array<{ text: string }>)[0].text) };
  };
  try {
    await client.connect(transport);
    const contract = await call("get_autopilot_contract", {});
    const proposed = await call("propose_reference_white_balance", { projectPath, ...f.request });
    expect(proposed.result.isError, JSON.stringify(proposed.value)).not.toBe(true);
    const draft = createAutopilotV4Fixture(contract.value.requiredPlanSource);
    const basePlan = { ...draft, editorial: { ...draft.editorial, graphics: [] }, materialEvidence: { ...draft.materialEvidence,
      receipts: [{ materialId: f.packet.materialId, sourceSha256: f.sourceSha, assetId: "asset", clipId: "clip", semanticReceiptSha256: f.request.semanticReceiptSha256 }] },
      commands: [proposed.value.command, { type: "set_aesthetic_system", aestheticSystem: draft.aesthetic }],
      autoColor: [{ ...f.bindings[0], decisionSha256: proposed.value.decisionSha256 }] };
    const plan = await bindCurrentDesignEvidence(call, projectPath, f.project.fps, basePlan);
    const audited = await call("audit_autopilot_plan", { projectPath, plan });
    expect(audited.result.isError, JSON.stringify(audited.value)).not.toBe(true);
    const args = { projectPath, plan, auditReceipt: audited.value.auditReceipt };
    const applied = await call("apply_autopilot_plan", args);
    expect(applied.result.isError, JSON.stringify(applied.value)).not.toBe(true); expect(applied.value.status).toBe("REVIEW_REQUIRED");
    const saved = JSON.parse(await readFile(projectPath, "utf8"));
    expect(saved.tracks[0].clips[0].color.whiteBalanceRed).toBe(f.proposal.selected.whiteBalanceRed);
    expect(saved.tracks[0].clips[0].color.whiteBalanceGreen).toBe(f.proposal.selected.whiteBalanceGreen);
    expect(saved.tracks[0].clips[0].color.whiteBalanceBlue).toBe(f.proposal.selected.whiteBalanceBlue);
    expect(saved.tracks[0].clips[0].color.temperature).toBe(0);
    const replay = await call("apply_autopilot_plan", args); expect(replay.result.isError).toBe(true);
    expect(JSON.parse(await readFile(projectPath, "utf8")).revision).toBe(saved.revision);
    await writeFile(join(f.root, "mcp-live-result.json"), JSON.stringify({ proposal: proposed.value, audit: audited.value, apply: applied.value, replay: replay.value }, null, 2));
  } finally { await client.close(); }
}, 90000);
