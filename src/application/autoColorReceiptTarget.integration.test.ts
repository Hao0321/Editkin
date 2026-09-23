import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";
import type { EditorCommand } from "../domain/commands";
import { prepareMaterialIntelligence, recordMaterialSemantics } from "./materialIntelligence";
import { colorFileSha } from "./materialColorSamplingRuntime";
import { proposeAutoColorExposure, proposeReferenceWhiteBalance, verifyAutoColorDecisions } from "./autoColorEvidence";

const app = fileURLToPath(new URL("../../", import.meta.url));
const ffmpegPath = join(app, "vendor/ffmpeg/win32-x64/ffmpeg.exe"), ffprobePath = join(app, "vendor/ffmpeg/win32-x64/ffprobe.exe");
async function fixture() {
  await mkdir(join(app, ".rd/tmp"), { recursive: true });
  const root = await mkdtemp(join(app, ".rd/tmp/color-receipt-target-")), source = join(root, "declared-neutral-cast.mp4");
  const pixels = Buffer.alloc(128 * 96 * 3); for (let i = 0; i < pixels.length; i += 3) pixels.set([137, 128, 119], i);
  const encoded = spawnSync(ffmpegPath, ["-v", "error", "-nostdin", "-f", "rawvideo", "-pixel_format", "rgb24", "-video_size", "128x96", "-framerate", "10",
    "-i", "pipe:0", "-vf", "loop=loop=9:size=1:start=0,scale=out_color_matrix=bt709:out_range=tv", "-frames:v", "10", "-an", "-c:v", "libx264", "-crf", "0", "-pix_fmt", "yuv444p",
    "-x264-params", "colorprim=bt709:transfer=bt709:colormatrix=bt709:range=tv", source], { input: pixels, windowsHide: true, timeout: 15000 });
  expect(encoded.error).toBeUndefined(); expect(encoded.status, encoded.stderr.toString()).toBe(0);
  const project = createEmptyProject("Exact colour decision target", { width: 128, height: 96, fps: 10 });
  project.assets.push({ id: "asset", name: "Owned neutral patch with known cast", uri: source, kind: "video", duration: 1 });
  const clip = { id: "analysed", assetId: "asset", trackId: project.tracks[0].id, sourceStart: 0, timelineStart: 0, duration: 1,
    volume: 0, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] };
  project.tracks[0].clips.push(clip, { ...structuredClone(clip), id: "existing-clone", timelineStart: 1 });
  const runtime = { ffmpegPath, ffprobePath, cacheRoot: root, modelRoot: root, resolveSource: async () => source };
  const sourceSha = await colorFileSha(source);
  const { packet } = await prepareMaterialIntelligence({ assetId: "asset", clipId: clip.id, sourcePath: source, sourceSha256: sourceSha,
    sourceStart: 0, duration: 1, fps: 10, kind: "video", includeTranscript: false, maxKeyframes: 3 }, runtime);
  expect(packet.analysis.color?.status).toBe("measured");
  const semantics = await recordMaterialSemantics(root, { materialId: packet.materialId, sourceSha256: sourceSha, overallTopic: "Owned exact-target engineering control",
    contentType: "engineering-fixture", language: "en", people: [], locations: [], segments: [{ start: 0, end: 1, summary: "Synthetic neutral cast, not human visual or location evidence",
      subjects: [], actions: [], objects: [], importance: .5, evidenceFrameIds: packet.keyframes.map(frame => frame.id), transcriptCueIndexes: [] }] });
  const material = { materialId: packet.materialId, semanticReceiptSha256: semantics.semanticReceiptSha256 };
  const exposure = await proposeAutoColorExposure(project, { ...material, goal: { medianLinearY: .32, maxExposureChange: .25, reason: "Explicit engineering exposure target for exact receipt binding" } }, runtime);
  const wb = await proposeReferenceWhiteBalance(project, { ...material, goal: { reference: "caller-declared-neutral", maxGainStops: 1,
    reason: "Independent authored neutral RGB cast for exact clip-target validation", samples: packet.keyframes.map(frame => ({ sampleId: frame.id, roi: { x: .25, y: .25, width: .5, height: .5 } })) } }, runtime);
  expect(wb.status).toBe("candidate"); expect(wb.applicable).toBe(true);
  return { root, source, sourceSha, runtime, project, clip, material, proposals: { exposure, reference_white_balance: wb } };
}
let f: Awaited<ReturnType<typeof fixture>>;
beforeAll(async () => { f = await fixture(); }, 120000);

describe("actual colour receipt cannot be borrowed by an unanalysed clip", () => {
  it.each(["exposure", "reference_white_balance"] as const)("accepts exact %s target and rejects both existing and batch-created clones", async mode => {
    const proposal = f.proposals[mode], path = join(f.root, "auto-colour-decisions", `${proposal.decisionSha256}.json`);
    const receiptBefore = await readFile(path), projectBefore = JSON.stringify(f.project);
    const originalCommand = proposal.command;
    if (originalCommand.type !== "set_clip_color") throw Error("Unexpected colour producer command");
    const verify = (target: string, prefix: EditorCommand[] = []) => {
      const command: EditorCommand = { type: "set_clip_color", clipId: target, patch: originalCommand.patch };
      return verifyAutoColorDecisions([{ mode, decisionSha256: proposal.decisionSha256, commandIndex: prefix.length, clipId: target }],
        [...prefix, command], f.project, f.runtime, [f.material]);
    };
    await expect(verify("analysed")).resolves.toMatchObject({ decisionCount: 1 });
    await expect(verify("existing-clone")).rejects.toThrow(/clip|片段|target/i);
    const clone = { ...structuredClone(f.clip), id: "batch-clone", timelineStart: 2 };
    await expect(verify(clone.id, [{ type: "add_clip", clip: clone }])).rejects.toThrow(/clip|片段|target/i);
    await expect(verify(clone.id, [{ type: "add_clip", clip: { ...clone, duration: .8 } }])).rejects.toThrow();
    expect((await readFile(path)).equals(receiptBefore)).toBe(true);
    expect(JSON.stringify(f.project)).toBe(projectBefore);
    expect(await colorFileSha(f.source)).toBe(f.sourceSha);
  }, 30000);
});
