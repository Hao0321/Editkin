import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, cp, mkdir, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, ".web-public");
const staging = resolve(root, `.web-public-staging-${process.pid}-${randomUUID()}`);
const backup = resolve(root, `.web-public-backup-${process.pid}-${randomUUID()}`);
const relation = relative(root, output);
if (!relation || relation.startsWith("..") || isAbsolute(relation) || dirname(output) !== root) {
  throw new Error(`Refusing unsafe web-public target: ${output}`);
}

const files = [
  "public/demo-source.mp4",
  "public/editkin-demo-preview.mp4",
  "public/fonts/NotoSansTC[wght].ttf",
  "public/fonts/NotoSerifTC[wght].ttf",
  "public/fonts/LXGWWenKaiMonoTC-Regular.ttf",
  "public/fonts/BebasNeue-Regular.ttf",
  "public/fonts/Fredoka[wdth,wght].ttf",
];

let previousMoved = false;
let promoted = false;
try {
  await mkdir(staging, { recursive: false });
  await cp(resolve(root, "public/benchmarks"), resolve(staging, "benchmarks"), { recursive: true, force: false, errorOnExist: true });
  for (const source of files) {
    const sourcePath = resolve(root, source);
    const targetPath = resolve(staging, relative(resolve(root, "public"), sourcePath));
    const targetRelation = relative(staging, targetPath);
    if (!targetRelation || targetRelation.startsWith("..") || isAbsolute(targetRelation)) throw new Error(`Web asset escapes staging: ${source}`);
    await mkdir(dirname(targetPath), { recursive: true });
    await copyFile(sourcePath, targetPath);
  }
  if (existsSync(output)) {
    await rename(output, backup);
    previousMoved = true;
  }
  await rename(staging, output);
  promoted = true;
  if (previousMoved) await rm(backup, { recursive: true, force: true });
} catch (error) {
  if (previousMoved && !existsSync(output) && existsSync(backup)) await rename(backup, output);
  throw error;
} finally {
  if (!promoted) await rm(staging, { recursive: true, force: true });
}

const normalizedFiles = files.map((path) => path.split(sep).join("/"));
process.stdout.write(`${JSON.stringify({ status: "GREEN_WEB_PUBLIC", output: ".web-public", files: normalizedFiles.length, directories: ["benchmarks"] })}\n`);
