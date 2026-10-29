import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PNG } from "pngjs";
import { rotoHoldoutFramePathV1, type RotoHoldoutKitV1 } from "../rotoHoldoutLabelKitV1";
import { rotoHoldoutCandidateDigestV1, rotoHoldoutDigestV1 } from "../rotoHoldoutIoV1";
import { blankRotoHoldoutPngV1 } from "../rotoHoldoutPngV1";

/** Instrument fixtures, never real human labels or product-quality evidence. */
export async function makeRotoHoldoutFixtureV1(root: string, sampleMode: "contiguous" | "five-points" = "contiguous") {
  await mkdir(root); const source = Buffer.from("instrument source, not real footage"), implementation = Buffer.from("instrument candidate, not a product engine");
  const sourcePath = join(root, "source.bin"), implementationPath = join(root, "candidate.bin");
  await writeFile(sourcePath, source); await writeFile(implementationPath, implementation);
  const artifacts = [{ id: "candidate", path: implementationPath, bytes: implementation.length, sha256: rotoHoldoutDigestV1(implementation) }];
  const width = 16, height = 16, blank = blankRotoHoldoutPngV1(width, height), samples = [];
  for (let frame = 0; frame < 5; frame++) {
    const image = Buffer.alloc(width * height * 4), mask = Buffer.alloc(image.length);
    for (let i = 0; i < width * height; i++) {
      const p = i * 4, value = (i % width + Math.floor(i / width) + frame) % 2 ? 255 : 0;
      image[p] = frame * 20; image[p + 1] = i % width * 10; image[p + 2] = Math.floor(i / width) * 10; image[p + 3] = 255;
      mask[p] = mask[p + 1] = mask[p + 2] = value; mask[p + 3] = 255;
    }
    const framePng = PNG.sync.write({ width, height, data: image }), maskPng = PNG.sync.write({ width, height, data: mask });
    const framePath = rotoHoldoutFramePathV1("clip-a", frame, "frames"), maskPath = rotoHoldoutFramePathV1("clip-a", frame, "labels");
    for (const [path, bytes] of [[framePath, framePng], [maskPath, maskPng]] as const) {
      const full = join(root, path); await mkdir(join(full, ".."), { recursive: true }); await writeFile(full, bytes);
    }
    samples.push({ frame, timeSeconds: frame / 5, framePath, maskPath, frameSha256: rotoHoldoutDigestV1(framePng), blankMaskSha256: rotoHoldoutDigestV1(blank) });
  }
  const kit: RotoHoldoutKitV1 = { schema: "editkin.roto-holdout-label-kit/v1", datasetId: "instrument", frozenAt: new Date(Date.now() - 1000).toISOString(),
    status: "AWAITING_HUMAN_LABELS", sampleMode, candidate: { engine: "editkin-instrument-only/not-a-product", artifacts,
      implementationSha256: rotoHoldoutCandidateDigestV1(artifacts) }, samplingConvention: "ffmpeg-autorotate-fps-even-display-fit/v1",
    sampleTimeKind: "analysis-grid-not-decoder-pts", clips: [{ id: "clip-a", width, height, analysisFps: 5, frameCount: 5, sourceStart: 0, duration: 1,
      categories: ["hair-fur"], displayRotationDegrees: 0, sourceSampleAspectRatio: 1, videoStreamIndex: 0,
      source: { path: sourcePath, bytes: source.length, sha256: rotoHoldoutDigestV1(source) }, samples }] };
  const kitText = JSON.stringify(kit, null, 2) + "\n", kitPath = join(root, "kit.json"); await writeFile(kitPath, kitText);
  const review = { schema: "editkin.roto-holdout-human-review/v1", kitSha256: rotoHoldoutDigestV1(kitText), reviewerIdHash: "a".repeat(64),
    reviewedAt: new Date().toISOString(), entries: samples.map(s => ({ clipId: "clip-a", frame: s.frame, approved: true,
      maskSha256: "", allBackgroundConfirmed: false, tracking: null })) };
  for (const [i, s] of samples.entries()) review.entries[i].maskSha256 = rotoHoldoutDigestV1(await import("node:fs/promises").then(fs => fs.readFile(join(root, s.maskPath))));
  const reviewPath = join(root, "instrument-review.json"); await writeFile(reviewPath, JSON.stringify(review, null, 2) + "\n");
  return { root, kit, kitPath, review, reviewPath, kitText, blank };
}
