import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectFfmpegCorrespondingSource } from "./lib/ffmpeg-source-evidence.mjs";

const root = await mkdtemp(join(tmpdir(), "editkin-source-evidence-"));
const evidenceRoot = join(root, "evidence");
await mkdir(evidenceRoot);
const archive = async (name, body) => {
  const path = join(evidenceRoot, name); await writeFile(path, body);
  return { path: name, sha256: createHash("sha256").update(body).digest("hex") };
};
const flags = ["--enable-gpl", "--enable-libx264", "--enable-whisper"];
const archives = [
  { role: "ffmpeg-source", ...await archive("ffmpeg-source.tar.xz", "ffmpeg") },
  { role: "build-scripts", ...await archive("build-scripts.tar.xz", "scripts") },
];
const externalSources = [
  { flag: "--enable-libx264", name: "x264", revision: "0123456789abcdef", sourceUrl: "https://code.videolan.org/videolan/x264", archive: await archive("x264.tar.xz", "x264") },
  { flag: "--enable-whisper", name: "whisper.cpp", revision: "abcdef0123456789", sourceUrl: "https://github.com/ggerganov/whisper.cpp", archive: await archive("whisper.tar.xz", "whisper") },
];
const manifestPath = join(evidenceRoot, "corresponding-source.json");
const valid = { schemaVersion: 2, binarySha256: "a".repeat(64), build: "8.0-full_build-www.gyan.dev", ffmpegCommit: "b".repeat(40), configurationFlags: flags, archives, externalSources };
await writeFile(manifestPath, JSON.stringify(valid));
const inspect = () => inspectFfmpegCorrespondingSource({ manifestPath, expectedBinarySha256: valid.binarySha256, expectedBuild: valid.build, expectedConfigurationFlags: flags });
const ready = await inspect();
const wrongBinary = await inspectFfmpegCorrespondingSource({ manifestPath, expectedBinarySha256: "c".repeat(64), expectedBuild: valid.build, expectedConfigurationFlags: flags });
await writeFile(join(evidenceRoot, externalSources[0].archive.path), "tampered");
const tampered = await inspect();
await writeFile(join(evidenceRoot, externalSources[0].archive.path), "x264");
await writeFile(manifestPath, JSON.stringify({ ...valid, externalSources: valid.externalSources.slice(0, 1) }));
const missingCoverage = await inspect();
const green = ready.ready === true && !wrongBinary.ready && !tampered.ready && !missingCoverage.ready;
process.stdout.write(`${JSON.stringify({ status: green ? "GREEN" : "BLOCK", ready: ready.ready, wrongBinaryRejected: !wrongBinary.ready, tamperRejected: !tampered.ready, missingLibraryRejected: !missingCoverage.ready })}\n`);
if (!green) process.exitCode = 1;
