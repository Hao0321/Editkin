import { strict as assert } from "node:assert";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { applyCommand } from "../src/domain/commands";
import { createDemoProject } from "../src/domain/demo";
import { createClipMask } from "../src/domain/masks";
import { probeMedia, renderProject } from "../src/render/ffmpeg";

async function main() {
  const appRoot = resolve(import.meta.dirname, "..");
  const output = resolve(process.argv[2] ?? "reports/editkin-render-smoke.mp4");
  const evidence = resolve(process.argv[3] ?? "../../.rd/benchmarks/editkin-render-smoke.json");
  let project = createDemoProject();
  project.width = 960;
  project.height = 540;
  project.assets[0].uri = process.env.HAO_SMOKE_MEDIA ?? resolve(appRoot, "public/demo-source.mp4");
  project = applyCommand(project, { type: "add_clip_mask", clipId: "clip-demo", mask: { ...createClipMask("mask-render-smoke", "ellipse"), feather: .008 } });
  project = applyCommand(project, {
    type: "add_caption",
    caption: { id: "caption-render-smoke", text: "Editkin：AI 與人，共用同一條 Timeline", start: 2, duration: 4 },
  });
  const result = await renderProject(project, output, {
    ffmpegPath: process.env.HAO_FFMPEG_PATH,
    ffprobePath: process.env.HAO_FFPROBE_PATH,
    nativeCorePath: process.env.HAO_NATIVE_CORE_PATH ?? resolve(appRoot, "native/bin/win32-x64/hao-core.exe"),
    preferGpu: true,
  });
  const probe = await probeMedia(output, process.env.HAO_FFPROBE_PATH);
  assert.equal(probe.hasVideo, true);
  assert.equal(probe.hasAudio, true);
  assert.equal(probe.width, 960);
  assert.equal(probe.height, 540);
  assert.ok(Math.abs(probe.duration - 12) < 0.15, `duration=${probe.duration}`);
  const payload = { status: "GREEN", ...result, probe };
  await mkdir(dirname(evidence), { recursive: true });
  await writeFile(evidence, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(payload));
}

void main();
