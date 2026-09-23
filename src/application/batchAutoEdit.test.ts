import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { batchArtifactPaths, createBatchSourceProject, runBatchAutoEditItem } from "./batchAutoEdit";

describe("batch auto edit", () => {
  it("fans one source into an editable project, render and receipt without changing the source", async () => {
    const root = await mkdtemp(join(tmpdir(), "editkin-batch-test-"));
    const source = join(root, "new-footage.mp4");
    await writeFile(source, "source-bytes");
    let renderedProjectCaptions = 0;
    let hashCalls = 0;
    try {
      const result = await runBatchAutoEditItem({
        jobId: "job-001",
        sourcePath: source,
        outputRoot: root,
        targetRatio: 0.5,
        addMusic: false,
      }, {
        ffmpegPath: "ffmpeg",
        ffprobePath: "ffprobe",
        modelRoot: join(root, "models"),
      }, {
        hashFile: async () => { hashCalls += 1; return "a".repeat(64); },
        inspect: async () => ({ duration: 10, width: 1920, height: 1080, hasVideo: true, hasAudio: true }),
        transcribe: async () => ({
          cues: [
            { start: 0, end: 4, text: "這是關鍵結果！" },
            { start: 5, end: 9, text: "最後總結方法" },
          ],
          engine: "fixture",
          modelId: "fixture",
          modelSha256: "b".repeat(64),
          language: "zh",
          analyzedSeconds: 10,
          elapsedMs: 1,
          modelDownloaded: false,
          cacheHit: true,
          acceleration: "cpu",
        }),
        detectScenes: async () => ({ cuts: [{ time: 5, score: 20, frame: 150 }], engine: "ffmpeg-scdet-8", threshold: 10, minSceneDuration: 0.5, analyzedSeconds: 10, elapsedMs: 1, cacheHit: true }),
        writeProject: async (path, project) => { await writeFile(path, JSON.stringify(project)); return { ...project, revision: 1 }; },
        render: async ({ project, outputPath }) => {
          renderedProjectCaptions = project.captions.length;
          await writeFile(outputPath, "rendered");
          return { outputPath, duration: 5, encoder: "libx264", planner: "fixture-planner", ffmpegVersion: "fixture-ffmpeg" };
        },
        now: () => new Date("2026-08-22T00:00:00.000Z"),
      });
      expect(result.status).toBe("completed");
      expect(result.project?.revision).toBe(1);
      expect(renderedProjectCaptions).toBeGreaterThan(0);
      expect(hashCalls).toBe(2);
      const receipt = JSON.parse(await readFile(result.receiptPath, "utf8")) as Record<string, unknown>;
      expect(receipt).toMatchObject({ status: "COMPLETED", reviewState: "REVIEW_REQUIRED", sourcePreserved: true, productVersion: "0.15.0" });
      expect(receipt.editorialFingerprint).toBe(result.editorialFingerprint);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes an isolated failed receipt so another batch item can continue", async () => {
    const root = await mkdtemp(join(tmpdir(), "editkin-batch-failure-"));
    const source = join(root, "broken.mp4");
    await writeFile(source, "broken");
    try {
      const result = await runBatchAutoEditItem({ jobId: "job-002", sourcePath: source, outputRoot: root, addMusic: false }, {
        ffmpegPath: "ffmpeg", ffprobePath: "ffprobe", modelRoot: join(root, "models"),
      }, {
        hashFile: async () => "c".repeat(64),
        inspect: async () => { throw new Error("fixture decode failure"); },
        now: () => new Date("2026-08-22T00:00:00.000Z"),
      });
      expect(result.status).toBe("failed");
      expect(result.error).toContain("fixture decode failure");
      const receipt = JSON.parse(await readFile(result.receiptPath, "utf8")) as Record<string, unknown>;
      expect(receipt).toMatchObject({ status: "FAILED", jobId: "job-002" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps vertical footage vertical and rejects unsafe job identities", () => {
    const built = createBatchSourceProject({
      sourcePath: "C:\\media\\vertical.mp4",
      jobId: "job-003",
      duration: 8,
      width: 1080,
      height: 1920,
      sourceSha256: "d".repeat(64),
      now: new Date("2026-08-22T00:00:00.000Z"),
    });
    expect([built.project.width, built.project.height]).toEqual([1080, 1920]);
    const square = createBatchSourceProject({
      sourcePath: "C:\\media\\square.mp4", jobId: "job-004", duration: 8, width: 1080, height: 1080,
      sourceSha256: "e".repeat(64), now: new Date("2026-08-22T00:00:00.000Z"),
    });
    expect([square.project.width, square.project.height]).toEqual([1080, 1080]);
    expect(() => batchArtifactPaths({ jobId: "../escape", sourcePath: "C:\\media\\x.mp4", outputRoot: "C:\\output" })).toThrow(/ID/);
  });
});
