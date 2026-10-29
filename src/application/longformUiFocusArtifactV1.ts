import { mkdtemp, mkdir, realpath, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readBoundedFile } from "../shared/boundedFile";
import { colorBytesSha, colorDigest } from "./materialColorSamplingRuntime";
import { verifyLongformUiFocusDraftV1, findLongformUiFocusCandidatesV1 } from "./longformUiFocusV1";
import { longformUiFocusFileRequestV1Schema, type LongformUiFocusArtifactV1 } from "../domain/longformUiFocusFileV1";

export const LONGFORM_UI_FOCUS_ARTIFACT_BYTES_V1 = 32 * 1024 * 1024;
const ARTIFACT = /^[a-f0-9]{64}$/;
const FRAME = /^focus-frame-(?:[1-9]|1[0-2])$/;
const sourceModules = ["longformUiFocusArtifactV1.ts", "longformUiFocusV1.ts", "longformUiFocusRuntimeV1.ts",
  "windowsOcrRuntimeV1.ts", "windowsOcrScriptV1.ts", "../domain/windowsOcrV1.ts", "../domain/longformUiFocusV1.ts",
  "../domain/longformUiFocusFileV1.ts", "../mcp/longformUiFocusFileV1.ts"];

/** Source closure while developing; a packaged MCP hashes its actual bundle.
 * No claim that an integrity digest signs or authenticates an external file. */
export async function longformUiFocusAlgorithmSha256V1() {
  const entry = fileURLToPath(import.meta.url);
  if (extname(entry) !== ".ts") return colorDigest({ mode: "bundle", sha256: colorBytesSha(await readBoundedFile(entry, 64 * 1024 * 1024)) });
  return colorDigest(await Promise.all(sourceModules.map(async path => ({ path,
    sha256: colorBytesSha(await readBoundedFile(resolve(dirname(entry), path), 1024 * 1024)) }))));
}
export function sealLongformUiFocusArtifactV1(body: Omit<LongformUiFocusArtifactV1, "artifactId">): LongformUiFocusArtifactV1 {
  return { ...body, artifactId: colorDigest(body) };
}
export function verifyLongformUiFocusArtifactV1(value: LongformUiFocusArtifactV1, expectedId: string) {
  longformUiFocusFileRequestV1Schema.parse(value.request);
  const { artifactId, ...body } = value;
  if (!ARTIFACT.test(expectedId) || artifactId !== expectedId || artifactId !== colorDigest(body)
    || value.schema !== "editkin.longform-ui-focus-artifact/v1") throw Error("UI_FOCUS_ARTIFACT_INTEGRITY");
  verifyLongformUiFocusDraftV1(value.draft);
}
async function directory(cacheRoot: string, id: string) {
  if (!ARTIFACT.test(id) || !isAbsolute(cacheRoot)) throw Error("UI_FOCUS_ARTIFACT_PATH");
  const root = await realpath(cacheRoot), lexical = join(root, "longform-ui-focus-v1", id), actual = await realpath(lexical);
  if (resolve(actual) !== resolve(lexical)) throw Error("UI_FOCUS_ARTIFACT_CANONICAL_BOUNDARY"); return actual;
}
export async function readLongformUiFocusArtifactV1(cacheRoot: string, id: string) {
  const root = await directory(cacheRoot, id);
  const path = join(root, "manifest.json");
  if (resolve(await realpath(path)) !== resolve(path)) throw Error("UI_FOCUS_MANIFEST_CANONICAL_BOUNDARY");
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readBoundedFile(path, LONGFORM_UI_FOCUS_ARTIFACT_BYTES_V1))) as LongformUiFocusArtifactV1;
  verifyLongformUiFocusArtifactV1(value, id); return value;
}
export async function readLongformUiFocusImageV1(cacheRoot: string, artifact: LongformUiFocusArtifactV1, frameId: string) {
  if (!FRAME.test(frameId)) throw Error("UI_FOCUS_FRAME_ID");
  const frame = artifact.draft.frames.find(row => row.id === frameId); if (!frame) throw Error("UI_FOCUS_FRAME_NOT_FOUND");
  const root = await directory(cacheRoot, artifact.artifactId), path = join(root, frameId + ".jpg");
  if (resolve(await realpath(path)) !== resolve(path)) throw Error("UI_FOCUS_IMAGE_CANONICAL_BOUNDARY");
  const data = await readBoundedFile(path, 8 * 1024 * 1024);
  if (data.length !== frame.display.jpeg.bytes || colorBytesSha(data) !== frame.ocr.imageSha256) throw Error("UI_FOCUS_IMAGE_INTEGRITY");
  return { frame, data };
}

/** Fresh temporary directory and immutable publication. Cleanup is limited to
 * the exact helper files this call created; unexpected names stop cleanup. */
export async function publishLongformUiFocusArtifactV1(cacheRoot: string, artifact: LongformUiFocusArtifactV1,
  images: ReadonlyMap<string, Uint8Array>) {
  verifyLongformUiFocusArtifactV1(artifact, artifact.artifactId);
  if (!isAbsolute(cacheRoot)) throw Error("UI_FOCUS_ARTIFACT_PATH");
  const bytes = Buffer.from(JSON.stringify(artifact) + "\n");
  if (bytes.length > LONGFORM_UI_FOCUS_ARTIFACT_BYTES_V1 || images.size !== artifact.draft.frames.length) throw Error("UI_FOCUS_ARTIFACT_BUDGET");
  await mkdir(cacheRoot, { recursive: true }); const base = await realpath(cacheRoot);
  const parent = join(base, "longform-ui-focus-v1"); await mkdir(parent, { recursive: true });
  if (resolve(await realpath(parent)) !== resolve(parent)) throw Error("UI_FOCUS_ARTIFACT_CANONICAL_BOUNDARY");
  const staging = await mkdtemp(join(parent, ".pending-")), created: string[] = []; let moved = false;
  try {
    for (const frame of artifact.draft.frames) {
      if (!FRAME.test(frame.id)) throw Error("UI_FOCUS_FRAME_ID");
      const image = images.get(frame.id);
      if (!image || image.length !== frame.display.jpeg.bytes || colorBytesSha(image) !== frame.ocr.imageSha256) throw Error("UI_FOCUS_IMAGE_INTEGRITY");
      const path = join(staging, frame.id + ".jpg"); await writeFile(path, image, { flag: "wx" }); created.push(path);
    }
    const path = join(staging, "manifest.json"); await writeFile(path, bytes, { flag: "wx" }); created.push(path);
    try { await rename(staging, join(parent, artifact.artifactId)); moved = true; }
    catch (error) {
      if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      const winner = await readLongformUiFocusArtifactV1(base, artifact.artifactId);
      if (colorDigest(winner) !== colorDigest(artifact)) throw Error("UI_FOCUS_ARTIFACT_COLLISION");
      for (const frame of winner.draft.frames) await readLongformUiFocusImageV1(base, winner, frame.id);
    }
  } finally {
    if (!moved) {
      if (resolve(await realpath(staging)) !== resolve(staging)) throw Error("UI_FOCUS_CLEANUP_BOUNDARY");
      const relation = relative(parent, staging); if (!relation || relation.startsWith("..") || isAbsolute(relation)) throw Error("UI_FOCUS_CLEANUP_BOUNDARY");
      for (const path of created) await unlink(path); await rmdir(staging);
    }
  }
}

export function summarizeLongformUiFocusArtifactV1(artifact: LongformUiFocusArtifactV1) {
  return { artifactId: artifact.artifactId, draftId: artifact.draft.draftId, state: artifact.draft.state,
    frameCount: artifact.draft.frames.length, candidateCount: artifact.draft.candidates.length, omittedFrameCount: artifact.draft.omitted.length,
    projectRevision: artifact.project.revision, projectModified: false as const, focusHintsReady: false as const,
    targetMatches: artifact.draft.targetTexts.map(text => { const match = findLongformUiFocusCandidatesV1(artifact.draft, text);
      return { text, state: match.state, matchCount: match.candidates.length }; }), artworkStatus: "ART_PENDING_CLAUDE" as const, selectableByDefault: false as const };
}
