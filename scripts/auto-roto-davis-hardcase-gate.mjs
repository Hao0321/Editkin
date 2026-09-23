import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const appRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(appRoot, "../..");
const packRoot = join(repoRoot, ".rd/model-packs/editkin-auto-roto-sam21-tiny-windows-cuda-1.0.3");
const python = join(packRoot, "runtime/python.exe");
const checkpoint = join(packRoot, "source/checkpoints/sam2.1_hiera_tiny.pt");
const davisRoot = join(repoRoot, ".rd/tmp/auto-roto-davis/DAVIS");
const config = join(appRoot, "config/auto-roto-hardcase-benchmark.json");
const report = join(appRoot, ".rd/benchmarks/editkin-auto-roto-davis-hardcase/report.json");
const benchmark = join(appRoot, "scripts/auto-roto-davis-hardcase.py");
const expectedZip = join(repoRoot, ".rd/tmp/auto-roto-davis/DAVIS-2017-trainval-480p.zip");

const expected = JSON.parse(await readFile(config, "utf8"));
const { createHash } = await import("node:crypto");
const archiveHash = createHash("sha256");
for await (const chunk of createReadStream(expectedZip, { highWaterMark: 4 * 1024 * 1024 })) archiveHash.update(chunk);
const digest = archiveHash.digest("hex");
if (digest !== expected.dataset.zipSha256) throw new Error("DAVIS archive SHA-256 does not match the frozen protocol");

const child = spawn(python, ["-I", "-B", benchmark, packRoot, davisRoot, config, report, checkpoint], {
  cwd: appRoot, windowsHide: true, stdio: "inherit", env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !["PYTHONHOME", "PYTHONPATH"].includes(key.toUpperCase()))),
});
const code = await new Promise((resolveExit, reject) => { child.once("error", reject); child.once("exit", resolveExit); });
if (code !== 0) process.exit(Number(code ?? 1));
