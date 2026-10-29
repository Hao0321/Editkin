import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateSubjectMatteDerivativeV1, parseSubjectMatteReceiptV1, readSubjectMatteDerivativeV1, subjectMatteCacheDirectory } from "./subjectMatteDerivative";

const SOURCE = "a".repeat(64);
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
function receipt(matteBytes: Buffer, overrides: Record<string, unknown> = {}) {
  return {
    schema: "editkin.subject-matte-receipt/v1", status: "GREEN", qualityState: "diagnostic", generatedAt: "2026-10-22T10:00:00+0800",
    models: [{ id: "mediapipe-selfie-segmentation-general-256x256", sha256: "c".repeat(64), licence: "Apache-2.0" }],
    licence: { spdx: "Apache-2.0" },
    source: { sha256: SOURCE, width: 1080, height: 1920, frameRate: { numerator: 30, denominator: 1 }, decodedFrames: 168 },
    output: { sha256: sha(matteBytes), bytes: matteBytes.length, codec: "ffv1", pixelFormat: "bgra", matteFormat: "alpha8", trackMatteMode: "alpha", range: "pc",
      width: 1080, height: 1920, frameRate: { numerator: 30, denominator: 1 }, frames: 168, coversWholeSource: true },
    ...overrides,
  };
}
const expected = { sourceSha256: SOURCE, matteUri: "D:/m.mkv", receiptUri: "D:/r.json" };
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("subject matte derivative v1", () => {
  it("admits a GREEN Apache-2.0 receipt that covers the whole source", () => {
    const d = parseSubjectMatteReceiptV1(receipt(Buffer.from("matte")), expected);
    expect(d).toMatchObject({ schema: "editkin.subject-matte-derivative/v1", sourceSha256: SOURCE, frames: 168, trackMatteMode: "alpha", pixelFormat: "bgra", licence: "Apache-2.0", qualityState: "diagnostic" });
  });

  it.each([
    ["source identity", { source: { sha256: "f".repeat(64), width: 1080, height: 1920, frameRate: { numerator: 30, denominator: 1 }, decodedFrames: 168 } }, "SUBJECT_MATTE_SOURCE_IDENTITY_CHANGED"],
    ["licence", { licence: { spdx: "GPL-3.0" } }, "SUBJECT_MATTE_LICENCE_NOT_APACHE_2"],
    ["model licence", { models: [{ id: "non-apache-model", sha256: "c".repeat(64), licence: "Apache-2.0-with-extra" }] }, "SUBJECT_MATTE_LICENCE_NOT_APACHE_2"],
    ["status", { status: "BLOCK" }, "SUBJECT_MATTE_RECEIPT_SCHEMA"],
  ])("refuses %s", (_name, overrides, code) => {
    expect(() => parseSubjectMatteReceiptV1(receipt(Buffer.from("m"), overrides), expected)).toThrow(code);
  });

  it("refuses frame-count, prefix and mode drift", () => {
    const base = receipt(Buffer.from("m"));
    expect(() => parseSubjectMatteReceiptV1({ ...base, output: { ...base.output, frames: 167 } }, expected)).toThrow("SUBJECT_MATTE_FRAME_CONTRACT");
    expect(() => parseSubjectMatteReceiptV1({ ...base, output: { ...base.output, coversWholeSource: false } }, expected)).toThrow("SUBJECT_MATTE_FRAME_CONTRACT");
    expect(() => parseSubjectMatteReceiptV1({ ...base, output: { ...base.output, trackMatteMode: "luma" } }, expected)).toThrow("SUBJECT_MATTE_FORMAT");
    expect(() => parseSubjectMatteReceiptV1(base, { ...expected, format: "gray" })).toThrow("SUBJECT_MATTE_FORMAT");
  });

  it("reads a cache entry keyed by source sha only while every file hash still matches", async () => {
    const root = await mkdtemp(join(tmpdir(), "subject-matte-cache-")); roots.push(root);
    const directory = subjectMatteCacheDirectory(root, SOURCE); await mkdir(directory, { recursive: true });
    const matteBytes = Buffer.from("ffv1-matte-bytes"), receiptText = JSON.stringify(receipt(matteBytes));
    await writeFile(join(directory, "matte.mkv"), matteBytes); await writeFile(join(directory, "receipt.json"), receiptText);
    const manifest = { schema: "editkin.subject-matte-cache/v1", sourceSha256: SOURCE, derivative: {},
      files: { "matte.mkv": { bytes: matteBytes.length, sha256: sha(matteBytes) }, "receipt.json": { bytes: Buffer.byteLength(receiptText), sha256: sha(receiptText) } } };
    await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
    const hit = await readSubjectMatteDerivativeV1(root, SOURCE, "alpha8");
    expect(hit).toMatchObject({ matteUri: join(directory, "matte.mkv"), matteSha256: sha(matteBytes), frames: 168 });
    expect(await readSubjectMatteDerivativeV1(root, SOURCE, "gray")).toBeUndefined();
    await writeFile(join(directory, "matte.mkv"), Buffer.from("tampered-matte-xx"));
    expect(await readSubjectMatteDerivativeV1(root, SOURCE)).toBeUndefined();
    expect(() => subjectMatteCacheDirectory(root, "../escape")).toThrow("SUBJECT_MATTE_SOURCE_SHA_INVALID");
  });

  // Real producer run: python -I + mediapipe + FFmpeg on a real clip. Opt-in, because it takes
  // minutes on CPU. EDITKIN_SUBJECT_MATTE_E2E_SOURCE=<local video> enables it.
  const e2eSource = process.env.EDITKIN_SUBJECT_MATTE_E2E_SOURCE;
  it.skipIf(!e2eSource)("runs the real producer, publishes once and then hits the cache", async () => {
    const root = process.env.EDITKIN_SUBJECT_MATTE_E2E_CACHE ?? await mkdtemp(join(tmpdir(), "subject-matte-e2e-"));
    if (!process.env.EDITKIN_SUBJECT_MATTE_E2E_CACHE) roots.push(root);
    const app = resolve(__dirname, "../..");
    const request = { sourcePath: e2eSource!, cacheRoot: root, scriptPath: join(app, "scripts", "subject-matte", "subject_matte_v1.py"),
      ffmpegPath: join(app, "vendor", "ffmpeg", "win32-x64", "ffmpeg.exe"), ffprobePath: join(app, "vendor", "ffmpeg", "win32-x64", "ffprobe.exe"), format: "alpha8" as const };
    const progress: number[] = [];
    const first = await generateSubjectMatteDerivativeV1({ ...request, onProgress: p => progress.push(p.framesDone) });
    expect(first.cacheHit).toBe(false);
    expect(first.derivative).toMatchObject({ trackMatteMode: "alpha", pixelFormat: "bgra", licence: "Apache-2.0" });
    const second = await generateSubjectMatteDerivativeV1(request);
    expect(second).toMatchObject({ cacheHit: true, derivative: { matteSha256: first.derivative.matteSha256 } });
  }, 30 * 60_000);
});
