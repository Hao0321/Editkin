import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";
import { renderComposite } from "../render/ffmpegComposite";
import { buildRenderPlan } from "../render/planner";
import { prepareMaterialIntelligence, recordMaterialSemantics } from "./materialIntelligence";
import { colorFileSha } from "./materialColorSamplingRuntime";
import { proposeAutoColorExposure, proposeReferenceWhiteBalance, verifyAutoColorDecisions } from "./autoColorEvidence";

const app = fileURLToPath(new URL("../../", import.meta.url));
const ffmpegPath = join(app, "vendor/ffmpeg/win32-x64/ffmpeg.exe"), ffprobePath = join(app, "vendor/ffmpeg/win32-x64/ffprobe.exe");
async function fixture() {
  await mkdir(join(app, ".rd/tmp"), { recursive: true });
  const root = await mkdtemp(join(app, ".rd/tmp/pq-wb-boundary-")), source = join(root, "owned-neutral-pq.mkv");
  const encoded = spawnSync(ffmpegPath, ["-v", "error", "-nostdin", "-f", "lavfi", "-i",
    "nullsrc=s=64x64:r=10:d=1,format=yuv420p10le,geq=lum=400:cb=512:cr=512,setparams=range=limited:color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc",
    "-an", "-c:v", "ffv1", source], { windowsHide: true, timeout: 15000 });
  expect(encoded.error).toBeUndefined(); expect(encoded.status, encoded.stderr.toString()).toBe(0);
  const project = createEmptyProject("Owned PQ WB refusal", { width: 64, height: 64, fps: 10 });
  project.assets.push({ id: "pq", name: "Neutral PQ engineering source", uri: source, kind: "video", duration: 1,
    color: { interpretation: "pq", primaries: "bt2020", transfer: "smpte2084", matrix: "bt2020nc", range: "tv" } });
  project.tracks[0].clips.push({ id: "clip", assetId: "pq", trackId: project.tracks[0].id, sourceStart: 0, timelineStart: 0, duration: 1,
    volume: 0, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] });
  const runtime = { ffmpegPath, ffprobePath, cacheRoot: root, modelRoot: root, resolveSource: async () => source };
  const sourceSha = await colorFileSha(source);
  const { packet } = await prepareMaterialIntelligence({ assetId: "pq", clipId: "clip", sourcePath: source, sourceStart: 0, duration: 1,
    fps: 10, kind: "video", includeTranscript: false, maxKeyframes: 3, color: project.assets[0].color }, runtime);
  expect(packet.analysis.color?.status).toBe("measured");
  expect(packet.analysis.color?.normalization?.interpretation).toBe("pq");
  const semantics = await recordMaterialSemantics(root, { materialId: packet.materialId, sourceSha256: sourceSha,
    overallTopic: "Owned neutral PQ engineering control", contentType: "engineering-fixture", language: "en", people: [], locations: [],
    segments: [{ start: 0, end: 1, summary: "Uniform synthetic patch, not human-reviewed art or real scene semantics", subjects: [], actions: [], objects: [],
      importance: .5, evidenceFrameIds: packet.keyframes.map(frame => frame.id), transcriptCueIndexes: [] }] });
  const material = { materialId: packet.materialId, semanticReceiptSha256: semantics.semanticReceiptSha256 };
  const request = { ...material, goal: { reference: "caller-declared-neutral" as const, maxGainStops: 1,
    reason: "Independent neutral engineering reference exercises the unsupported PQ decision boundary",
    samples: packet.keyframes.map(frame => ({ sampleId: frame.id, roi: { x: .25, y: .25, width: .5, height: .5 } })) } };
  return { root, source, sourceSha, runtime, project, material, request };
}
let f: Awaited<ReturnType<typeof fixture>>;
const evidence: Record<string, unknown> = {};
beforeAll(async () => { f = await fixture(); }, 90000);
afterAll(async () => {
  if (!f) return;
  const path = join(f.root, "boundary-test-evidence.json");
  await writeFile(path, JSON.stringify({ schema: "editkin.pq-wb-boundary-integration/v1", root: f.root, source: f.source,
    sourceSha256: f.sourceSha, sourceAfterSha256: await colorFileSha(f.source), project: f.project,
    material: f.material, request: f.request, ...evidence, boundary: "Owned synthetic source; no user data, no human colour approval" }, null, 2), { flag: "wx" });
  console.info(`PQ_BOUNDARY_EVIDENCE=${path}`);
});

it("rejects a real PQ reference proposal without a decision receipt or authored-state changes", async () => {
  const before = JSON.stringify(f.project), decisionRoot = join(f.root, "auto-colour-decisions");
  const existing = await readdir(decisionRoot).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
  let error: unknown;
  try { evidence.legacyProposal = await proposeReferenceWhiteBalance(f.project, f.request, f.runtime); }
  catch (value) { error = value; evidence.proposalRejection = String(value); }
  // Save the original real accepted proposal in the RED run for a later explicit
  // receipt-replay probe. Do not manufacture an accepted receipt after the fix.
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toMatch(/PQ.*白平衡.*尚未/);
  const after = await readdir(decisionRoot).catch((value: NodeJS.ErrnoException) => { if (value.code === "ENOENT") return []; throw value; });
  expect(after).toEqual(existing); expect(JSON.stringify(f.project)).toBe(before);
  expect(await colorFileSha(f.source)).toBe(f.sourceSha);
}, 90000);

it("refuses tiny nonzero WB before formal output and retains every authored value", async () => {
  const project = structuredClone(f.project); project.tracks[0].clips[0].color.whiteBalanceRed = 1e-9;
  const before = JSON.stringify(project), output = join(f.root, "unsupported-pq-wb.mp4");
  await expect(renderComposite(ffmpegPath, ffprobePath, output, project, buildRenderPlan(project, uri => uri), undefined, "libx264", 30000))
    .rejects.toThrow(/PQ.*白平衡.*尚未/);
  await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
  expect(JSON.stringify(project)).toBe(before); expect(await colorFileSha(f.source)).toBe(f.sourceSha);
}, 40000);

it("still proposes, audits and renders ordinary PQ exposure with zero WB", async () => {
  const proposal = await proposeAutoColorExposure(f.project, { ...f.material, goal: { medianLinearY: .32, maxExposureChange: .25,
    reason: "Zero white-balance PQ exposure remains an independent supported operation" } }, f.runtime);
  await expect(verifyAutoColorDecisions([{ mode: "exposure", decisionSha256: proposal.decisionSha256, commandIndex: 0, clipId: "clip" }],
    [proposal.command], f.project, f.runtime, [f.material])).resolves.toMatchObject({ decisionCount: 1 });
  const project = structuredClone(f.project); project.tracks[0].clips[0].color.exposure = -.5;
  const output = join(f.root, "ordinary-pq-exposure.mp4");
  await renderComposite(ffmpegPath, ffprobePath, output, project, buildRenderPlan(project, uri => uri), undefined, "libx264", 30000);
  const decoded = spawnSync(ffmpegPath, ["-v", "error", "-i", output, "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"], { windowsHide: true, timeout: 15000 });
  expect(decoded.error).toBeUndefined(); expect(decoded.status, decoded.stderr.toString()).toBe(0); expect(decoded.stdout.length).toBe(64 * 64 * 3);
  evidence.exposureProposal = proposal; evidence.ordinaryOutput = output;
  expect((await readFile(output)).length).toBeGreaterThan(0); expect(await colorFileSha(f.source)).toBe(f.sourceSha);
}, 90000);
