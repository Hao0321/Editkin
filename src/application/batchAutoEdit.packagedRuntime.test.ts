import { existsSync } from "node:fs";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveMediaPath } from "../render/mediaProcess";
import { serviceBatchAutoEditRuntimeV1, serviceCaptionRuntimeV1 } from "../service/serviceMediaRuntimeV1";
import { assertAutomaticCaptionRuntime } from "./automaticCaptions";
import type { AutomaticCaptionRuntime } from "./automaticCaptionTypes";
import { runBatchAutoEditItem } from "./batchAutoEdit";
import type { CreativeLibraryAsset } from "./creativeLibrary";
import { writeProjectFileAtomic } from "./projectFiles";

/** Runtime JSON the release desktop host sends (resource_dir/runtime/*, packs under resource_dir), see runtime_paths in main.rs. */
function packagedServiceRuntime(resources: string) {
  return {
    ffmpeg: join(resources, "runtime", "ffmpeg.exe"),
    ffprobe: join(resources, "runtime", "ffprobe.exe"),
    whisperCli: join(resources, "runtime", "whisper-cli.exe"),
    nativeCore: join(resources, "runtime", "hao-core.exe"),
    cacheRoot: join(resources, "..", "cache", "media-cache"),
    modelRoot: join(resources, "..", "data", "models"),
    creativePackRoot: join(resources, "creative-packs", "hao-creator-library"),
    personalMusicRoot: join(resources, "personal-packs", "hao-music-library"),
    fontRoot: join(resources, "font-packs", "editkin-open-fonts"),
    colorRoot: join(resources, "color", "aces2"),
  };
}

const communityTrack: CreativeLibraryAsset = {
  id: "music:community-bright-loop", name: "Bright loop", category: "music", mediaKind: "audio", role: "background-music",
  domains: ["general"], duration: 30, bpm: 110, license: "community-grant", provenance: "fixture", redistributable: false,
} as unknown as CreativeLibraryAsset;

describe("batch auto-edit uses the packaged runtime like the single-project routes", () => {
  it("hands the bundled whisper-cli to batch captions exactly as single-clip captions get it", () => {
    const service = packagedServiceRuntime(resolve(tmpdir(), "Editkin", "resources"));
    const env = { EDITKIN_WHISPER_MODEL_PATH: "C:\\models\\pinned.bin" } as NodeJS.ProcessEnv;
    const single = serviceCaptionRuntimeV1(service, env);
    const batch = serviceBatchAutoEditRuntimeV1(service, env);
    expect(single.whisperCliPath).toBe(service.whisperCli);
    expect({ ffmpegPath: batch.ffmpegPath, whisperCliPath: batch.whisperCliPath, modelRoot: batch.modelRoot, modelPath: batch.modelPath, cacheRoot: batch.cacheRoot })
      .toEqual(single);
    expect(batch).toMatchObject({ creativePackRoot: service.creativePackRoot, personalMusicRoot: service.personalMusicRoot, ffprobePath: service.ffprobe });
  });

  const vendorFfmpeg = resolve("vendor/ffmpeg/win32-x64/ffmpeg.exe");
  const vendorWhisper = resolve("vendor/whisper/win32-x64/whisper-cli.exe");
  it.skipIf(!existsSync(vendorFfmpeg) || !existsSync(vendorWhisper))("finds the bundled recogniser with the shipped FFmpeg (no whisper filter)", async () => {
    const service = { ffmpeg: vendorFfmpeg, whisperCli: vendorWhisper, modelRoot: join(tmpdir(), "editkin-unused-models") };
    const previous = process.env.EDITKIN_WHISPER_CLI_PATH;
    delete process.env.EDITKIN_WHISPER_CLI_PATH;
    try {
      const batch = serviceBatchAutoEditRuntimeV1({ ...service, ffprobe: "ffprobe" }, {});
      const capability = await assertAutomaticCaptionRuntime({ ffmpegPath: batch.ffmpegPath, whisperCliPath: batch.whisperCliPath });
      expect(capability).toMatchObject({ engine: "whisper-cli", ffmpegWhisperFilter: false, whisperCli: true });
      // The old batch route passed no whisper-cli: the same FFmpeg then has no recogniser at all.
      await expect(assertAutomaticCaptionRuntime({ ffmpegPath: batch.ffmpegPath })).rejects.toThrow(/whisper-cli/);
    } finally {
      if (previous === undefined) delete process.env.EDITKIN_WHISPER_CLI_PATH; else process.env.EDITKIN_WHISPER_CLI_PATH = previous;
    }
  }, 30_000);

  it("forwards the recogniser and resolves community music to a packaged file before export", async () => {
    const root = await mkdtemp(join(tmpdir(), "editkin-batch-packaged-"));
    const resources = join(root, "Editkin", "resources");
    const service = packagedServiceRuntime(resources);
    const trackPath = join(service.personalMusicRoot, "assets", "bright-loop.m4a");
    const source = join(root, "talk.mp4");
    await mkdir(join(service.personalMusicRoot, "assets"), { recursive: true });
    await writeFile(trackPath, "music-bytes");
    await writeFile(source, "source-bytes");
    let captionRuntime: AutomaticCaptionRuntime | undefined;
    let renderedMusicPath: string | undefined;
    try {
      const result = await runBatchAutoEditItem({ jobId: "job-packaged", sourcePath: source, outputRoot: root, targetRatio: 0.5, addMusic: true },
        serviceBatchAutoEditRuntimeV1(service, {}), {
          hashFile: async () => "a".repeat(64),
          inspect: async () => ({ duration: 10, width: 1920, height: 1080, hasVideo: true, hasAudio: true }),
          transcribe: async (_request, runtime) => {
            captionRuntime = runtime;
            return {
              cues: [{ start: 0, end: 4, text: "這是關鍵結果！" }, { start: 5, end: 9, text: "最後總結方法" }],
              engine: "fixture", modelId: "fixture", modelSha256: "b".repeat(64), language: "zh", analyzedSeconds: 10,
              elapsedMs: 1, modelDownloaded: false, cacheHit: true, acceleration: "cpu",
            };
          },
          detectScenes: async () => ({ cuts: [{ time: 5, score: 20, frame: 150 }], engine: "ffmpeg-scdet-8", threshold: 10, minSceneDuration: 0.5, analyzedSeconds: 10, elapsedMs: 1, cacheHit: true }),
          smartCut: async () => { throw new Error("no narration evidence in this fixture"); },
          listLibrary: async () => ({ assets: [communityTrack] }) as unknown as Awaited<ReturnType<typeof import("./creativeLibrary").listCreativeLibrary>>,
          resolveLibraryAsset: async (packRoot, assetId, personalMusicRoot) => {
            expect([packRoot, assetId, personalMusicRoot]).toEqual([service.creativePackRoot, communityTrack.id, service.personalMusicRoot]);
            return { asset: communityTrack, absolutePath: trackPath, sha256: "c".repeat(64) };
          },
          writeProject: writeProjectFileAtomic,
          render: async ({ project, outputPath, options }) => {
            // The real renderer resolves every asset URI this way (renderProject → resolveMediaPath) and then opens the file.
            for (const asset of project.assets) await access(resolveMediaPath(asset.uri, options?.assetBase));
            renderedMusicPath = project.assets.find((asset) => asset.role === "background-music")?.uri;
            await writeFile(outputPath, "rendered");
            return { outputPath, duration: 5, encoder: "libx264", planner: "fixture-planner", ffmpegVersion: "fixture-ffmpeg" };
          },
          now: () => new Date("2026-10-22T00:00:00.000Z"),
        });
      expect(result.status, result.error).toBe("completed");
      expect(captionRuntime).toMatchObject({ ffmpegPath: service.ffmpeg, whisperCliPath: service.whisperCli, modelRoot: service.modelRoot });
      expect(renderedMusicPath).toBe(trackPath);
      // The saved, editable project keeps the portable creative:// reference.
      expect(result.project?.assets.find((asset) => asset.role === "background-music")?.uri).toMatch(/^creative:\/\//);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
