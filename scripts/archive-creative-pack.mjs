import { copyFile, readFile, rename, rm, stat } from "node:fs/promises";
import { constants, createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDeterministicZip } from "./lib/deterministic-zip.mjs";
import { evaluateCreativePack } from "./lib/creative-pack-gate.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(root, "../..");
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const packParent = resolve(root, ".creative-packs");
const packName = "hao-creator-library";
const packRoot = resolve(packParent, packName);
const manifestPath = resolve(packRoot, "editkin-pack.json");
const artifactRoot = resolve(workspaceRoot, ".rd/artifacts");
const output = resolve(artifactRoot, `Hao-Creator-Library-${packageJson.version}.editkin-pack.zip`);

await stat(manifestPath);
const pack = JSON.parse(await readFile(manifestPath, "utf8"));
if (evaluateCreativePack(pack, { root: packRoot }).status !== "GREEN") throw new Error("Cannot archive an invalid public creative pack");
async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
const first = `${output}.${process.pid}.a.zip`;
const second = `${output}.${process.pid}.b.zip`;
try {
  const candidateA = await createDeterministicZip({ sourceRoot: packRoot, archiveRootName: packName, outputPath: first });
  const candidateB = await createDeterministicZip({ sourceRoot: packRoot, archiveRootName: packName, outputPath: second });
  if (candidateA.bytes !== candidateB.bytes || candidateA.sha256 !== candidateB.sha256) throw new Error("Creator Pack archive is not reproducible across identical builds");
  let retainedPrevious;
  try {
    const previousSha256 = await digest(output);
    retainedPrevious = resolve(artifactRoot, `Hao-Creator-Library-${packageJson.version}-${previousSha256}.retained.editkin-pack.zip`);
    try { await copyFile(output, retainedPrevious, constants.COPYFILE_EXCL); }
    catch (error) { if (error?.code !== "EEXIST") throw error; }
    if (await digest(retainedPrevious) !== previousSha256 || await digest(output) !== previousSha256) throw new Error("Previous creator archive backup mismatch");
  } catch (error) { if (error?.code !== "ENOENT") throw error; }
  await rm(output, { force: true });
  await rename(first, output);
  process.stdout.write(`${JSON.stringify({ status: "GREEN", version: packageJson.version, output, retainedPrevious, files: candidateA.files, bytes: candidateA.bytes, sha256: candidateA.sha256, reproducible: true })}\n`);
} finally {
  await rm(first, { force: true });
  await rm(second, { force: true });
}
