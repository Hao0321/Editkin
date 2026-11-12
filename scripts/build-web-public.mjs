// Agent integration: urn:uuid:d366cab7-d5a4-44d8-b80d-4c7ce4daf65d. Existing GPL license retained; see AGENT-NOTICE.md.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, cp, mkdir, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { verifyAgentProvenance } from "./lib/agent-provenance.mjs";

const root = resolve(import.meta.dirname, "..");
await verifyAgentProvenance(root);
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
  "public/favicon.svg",
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
  // The social-preview image and root favicon.ico reuse reviewed identity icons instead of
  // adding binaries that the public-source binary policy would not cover.
  await copyFile(resolve(root, "src-tauri/icons/icon.png"), resolve(staging, "og-image.png"));
  await copyFile(resolve(root, "src-tauri/icons/icon.ico"), resolve(staging, "favicon.ico"));
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
