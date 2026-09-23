import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const SHA256 = /^[a-f0-9]{64}$/;

async function fileIdentity(path) {
  const bytes = await readFile(path);
  return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

export function evaluatePinnedProductRuntime(entries) {
  const failures = [];
  for (const entry of entries) {
    if (!entry.path || !Number.isSafeInteger(entry.expectedBytes) || entry.expectedBytes <= 0 || !SHA256.test(entry.expectedSha256 ?? "")) {
      failures.push(`${entry.path ?? "unknown"}:invalid-expected-identity`);
      continue;
    }
    if (entry.actualBytes !== entry.expectedBytes) failures.push(`${entry.path}:byte-mismatch`);
    if (entry.actualSha256 !== entry.expectedSha256) failures.push(`${entry.path}:sha256-mismatch`);
  }
  return { status: failures.length ? "BLOCK" : "GREEN_PINNED_PRODUCT_RUNTIME", failures };
}

export async function inspectPinnedWindowsProductRuntime(root = process.cwd()) {
  const base = resolve(root);
  const nodeManifest = JSON.parse(await readFile(resolve(base, "vendor/node/win32-x64/manifest.json"), "utf8"));
  const ffmpegManifest = JSON.parse(await readFile(resolve(base, "vendor/ffmpeg/win32-x64/manifest.json"), "utf8"));
  const whisperManifest = JSON.parse(await readFile(resolve(base, "vendor/whisper/win32-x64/manifest.json"), "utf8"));
  if (!String(nodeManifest.source).startsWith("https://nodejs.org/dist/") || nodeManifest.version !== "22.23.2") throw new Error("Pinned Node publisher/version policy mismatch");
  if (ffmpegManifest.source !== "https://www.gyan.dev/ffmpeg/builds/" || ffmpegManifest.license !== "GPLv3") throw new Error("Pinned FFmpeg publisher/license policy mismatch");
  if (!String(whisperManifest.source).startsWith("https://github.com/ggml-org/whisper.cpp/releases/") || whisperManifest.license !== "MIT") throw new Error("Pinned Whisper publisher/license policy mismatch");
  const requested = [
    { path: "vendor/node/win32-x64/node.exe", expectedBytes: Number((await fileIdentity(resolve(base, "vendor/node/win32-x64/node.exe"))).bytes), expectedSha256: nodeManifest.nodeExeSha256 },
    { path: "vendor/node/win32-x64/NODE-LICENSE.txt", expectedBytes: Number((await fileIdentity(resolve(base, "vendor/node/win32-x64/NODE-LICENSE.txt"))).bytes), expectedSha256: nodeManifest.licenseSha256 },
    { path: "vendor/ffmpeg/win32-x64/ffmpeg.exe", expectedBytes: ffmpegManifest.ffmpeg.bytes, expectedSha256: ffmpegManifest.ffmpeg.sha256 },
    { path: "vendor/ffmpeg/win32-x64/ffprobe.exe", expectedBytes: ffmpegManifest.ffprobe.bytes, expectedSha256: ffmpegManifest.ffprobe.sha256 },
    { path: "vendor/whisper/win32-x64/WHISPER-LICENSE.txt", expectedBytes: Number((await fileIdentity(resolve(base, "vendor/whisper/win32-x64/WHISPER-LICENSE.txt"))).bytes), expectedSha256: whisperManifest.licenseSha256 },
    ...whisperManifest.files.map((entry) => ({ path: `vendor/whisper/win32-x64/${entry.name}`, expectedBytes: entry.bytes, expectedSha256: entry.sha256 })),
  ];
  const entries = await Promise.all(requested.map(async (entry) => {
    const actual = await fileIdentity(resolve(base, entry.path));
    return { ...entry, actualBytes: actual.bytes, actualSha256: actual.sha256 };
  }));
  return { ...evaluatePinnedProductRuntime(entries), entries };
}

export async function assertPinnedWindowsProductRuntime(root = process.cwd()) {
  const report = await inspectPinnedWindowsProductRuntime(root);
  if (report.status !== "GREEN_PINNED_PRODUCT_RUNTIME") throw new Error(`Pinned product runtime rejected: ${report.failures.join(", ")}`);
  return report;
}
