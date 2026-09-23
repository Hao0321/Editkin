import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const binaryPath = resolve(root, "vendor/ffmpeg/win32-x64/ffmpeg.exe");
const outputPath = resolve(process.argv[2] ?? "../../.rd/benchmarks/editkin-ffmpeg-binary-receipt-20260822.json");
const result = spawnSync(binaryPath, ["-hide_banner", "-version"], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 30_000 });
if (result.status !== 0) throw new Error(result.stderr || result.error?.message || "FFmpeg inspection failed");
const bytes = await readFile(binaryPath);
const info = await stat(binaryPath);
const configurationFlags = (result.stdout.match(/^configuration:\s*(.+)$/m)?.[1] ?? "").trim().split(/\s+/).filter(Boolean);
const payload = {
  status: configurationFlags.length ? "GREEN" : "BLOCK", capturedAt: new Date().toISOString(),
  binary: { path: "vendor/ffmpeg/win32-x64/ffmpeg.exe", bytes: info.size, sha256: createHash("sha256").update(bytes).digest("hex"), version: result.stdout.split(/\r?\n/)[0] },
  upstream: { distributorRelease: "https://github.com/GyanD/codexffmpeg/releases/tag/8.0", ffmpegCommit: "140fd653aed8cad774f991ba083e2d01e86420c7" },
  compiler: result.stdout.match(/^built with (.+)$/m)?.[1] ?? null, configurationFlags,
  limitation: "This receipt proves binary identity and declared configuration only. It does not prove exact external-library revisions or corresponding-source retention.",
};
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(payload)}\n`);
if (payload.status !== "GREEN") process.exitCode = 1;
