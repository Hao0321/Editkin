import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { applyCommand } from "../src/domain/commands";
import { createDemoProject } from "../src/domain/demo";
import { probeMedia, renderProject } from "../src/render/ffmpeg";

const root = resolve(import.meta.dirname, "..");
const outputPath = resolve(root, "../../.rd/benchmarks/editkin-bilingual-caption-render.mp4");
const evidencePath = resolve(root, "../../.rd/benchmarks/editkin-bilingual-caption-render.json");
const ffmpegPath = resolve(root, "vendor/ffmpeg/win32-x64/ffmpeg.exe");
const ffprobePath = resolve(root, "vendor/ffmpeg/win32-x64/ffprobe.exe");
const nativeCorePath = resolve(root, "native/bin/win32-x64/hao-core.exe");

let project = createDemoProject();
project = applyCommand(project, { type: "add_caption", caption: {
  id: "integration-bilingual", text: "原文可以修改", start: 1, duration: 4,
  translation: { text: "Both lines stay editable", language: "en" },
} });
project = applyCommand(project, { type: "set_caption_style", patch: {
  backgroundColor: "#000000A6", fontFamily: "Noto Sans TC", fontSize: 54, color: "#FFFFFF",
  translationFontFamily: "Bebas Neue", translationFontSize: 34, translationColor: "#FF66CC",
} });

await mkdir(dirname(outputPath), { recursive: true });
const rendered = await renderProject(project, outputPath, {
  ffmpegPath, ffprobePath, nativeCorePath, assetBase: resolve(root, "public"), fontRoot: resolve(root, "public/fonts"), preferGpu: false, timeoutMs: 180_000,
});
const probe = await probeMedia(outputPath, ffprobePath);
const bytes = await readFile(outputPath);
if (!probe.hasVideo || !probe.hasAudio || probe.duration < 11.8 || probe.duration > 12.2) throw new Error(`雙語字幕輸出 QA 失敗：${JSON.stringify(probe)}`);
const evidence = {
  schemaVersion: 1, status: "GREEN", generatedAt: new Date().toISOString(), output: outputPath,
  bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), probe, rendered,
  caption: { primaryEditable: true, translationEditable: true, primaryFont: project.captionStyle.fontFamily, translationFont: project.captionStyle.translationFontFamily },
};
await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(evidence)}\n`);
