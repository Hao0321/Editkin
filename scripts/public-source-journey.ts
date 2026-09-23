import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { applyCommand } from "../src/domain/commands";
import { createDemoProject } from "../src/domain/demo";
import { createClipMask } from "../src/domain/masks";
import { readProjectFile, writeProjectFileAtomic } from "../src/application/projectFiles";
import { previewTransitionState } from "../src/creative/corePack";
import { probeMedia, renderProject } from "../src/render/ffmpeg";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const ffmpeg = process.env.HAO_FFMPEG_PATH || "ffmpeg";
const ffprobe = process.env.HAO_FFPROBE_PATH || "ffprobe";
const fixture = resolve(root, "public/demo-source.mp4");
const evidenceRoot = resolve(root, ".rd");
await mkdir(evidenceRoot, { recursive: true });
const work = await mkdtemp(join(evidenceRoot, "public-source-journey-"));
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

const input = await probeMedia(fixture, ffprobe);
assert(input.hasVideo && input.hasAudio && input.width === 960 && input.height === 540);
assert(Math.abs(input.duration - 12) < 0.15);

let project = createDemoProject();
project.width = 960;
project.height = 540;
project.assets[0].uri = fixture;
project = applyCommand(project, {
  type: "add_clip_mask",
  clipId: "clip-demo",
  mask: { ...createClipMask("community-mask", "ellipse"), feather: 0.008 },
});
project = applyCommand(project, {
  type: "add_caption",
  caption: { id: "community-caption", text: "Editkin community source", start: 2, duration: 4 },
});
const previewClip = structuredClone(project.tracks[0].clips[0]);
previewClip.creative = {
  effectPresetIds: [],
  transitionIn: { presetId: "lens_blur_cut", duration: 0.4 },
};
const previewStart = previewTransitionState(previewClip, 0);
const previewEnd = previewTransitionState(previewClip, 0.4);
assert.equal(previewStart.scale, 1.08);
assert.equal(previewEnd.scale, 1);

const projectPath = join(work, "community.editkin.json");
const saved = await writeProjectFileAtomic(projectPath, project, 0, { createOnly: true });
const reopened = await readProjectFile(projectPath);
assert.equal(reopened.revision, saved.revision);
assert.equal(reopened.captions[0]?.text, "Editkin community source");
assert.equal(reopened.tracks[0].clips[0].masks?.[0]?.id, "community-mask");
assert.equal(reopened.assets[0].uri, fixture);

const output = join(work, "community-output.mp4");
const render = await renderProject(reopened, output, { ffmpegPath: ffmpeg, ffprobePath: ffprobe, preferGpu: false });
const delivered = await probeMedia(output, ffprobe);
assert(delivered.hasVideo && delivered.hasAudio);
assert.equal(delivered.width, 960);
assert.equal(delivered.height, 540);
assert(Math.abs(delivered.duration - 12) < 0.15);

const previewPath = join(work, "decoded-preview.png");
await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-ss", "2", "-i", output, "-frames:v", "1", previewPath], { timeout: 30000, windowsHide: true });
const previewBytes = await readFile(previewPath);
assert(previewBytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
assert.equal(previewBytes.readUInt32BE(16), 960);
assert.equal(previewBytes.readUInt32BE(20), 540);

const receipt = {
  schema: "editkin.public-source-journey/v1",
  status: "GREEN",
  scope: "synthetic fixture; source import, EditGraph change, preview state, save/reopen, render, and decoded frame",
  fixtureSha256: hash(await readFile(fixture)),
  projectSha256: hash(await readFile(projectPath)),
  outputSha256: hash(await readFile(output)),
  outputBytes: (await stat(output)).size,
  decodedPreviewSha256: hash(previewBytes),
  reopenedRevision: reopened.revision,
  ffmpegVersion: render.ffmpegVersion,
  encoded: delivered,
  evidenceDirectory: work,
  limits: ["No desktop installer or native UI tested", "No human editorial-quality verdict"],
};
await writeFile(join(work, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
process.stdout.write(`${JSON.stringify(receipt)}\n`);
