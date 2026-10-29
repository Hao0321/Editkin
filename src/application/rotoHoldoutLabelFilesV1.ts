import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MediaProbe } from "../render/ffmpegContracts";
import { parseRotoHoldoutKitV1, parseRotoHoldoutRequestV1, planRotoHoldoutClipV1, rotoHoldoutFramePathV1,
  rotoHoldoutReviewTemplateV1, ROTO_HOLDOUT_MAX_FRAMES_V1, type RotoHoldoutKitV1 } from "./rotoHoldoutLabelKitV1";
import { createRotoHoldoutOutputV1, rotoHoldoutBudgetV1, rotoHoldoutCandidateDigestV1, rotoHoldoutDigestV1,
  rotoHoldoutFileIdentityV1, rotoHoldoutProcessV1, type RotoHoldoutRuntimeV1 } from "./rotoHoldoutIoV1";
import { blankRotoHoldoutPngV1, readRotoHoldoutPngV1 } from "./rotoHoldoutPngV1";
import { mediaDisplayRotation, mediaSampleAspectRatio } from "../render/mediaDisplayGeometry";

function probeValue(stdout: Buffer): MediaProbe & { videoStreamIndex: number } {
  const value = JSON.parse(stdout.toString("utf8")) as { format?: { duration?: string }; streams?: Array<{
    codec_type?: string; index?: number; width?: number; height?: number; sample_aspect_ratio?: string;
    side_data_list?: Array<{ side_data_type?: string; rotation?: unknown }>; tags?: { rotate?: unknown };
    disposition?: { attached_pic?: number } }> };
  const video = value.streams?.find(s => s.codec_type === "video" && !s.disposition?.attached_pic);
  return { duration: Number(value.format?.duration), width: video?.width, height: video?.height, hasVideo: Boolean(video), hasAudio: false,
    displayRotationDegrees: mediaDisplayRotation(video), sampleAspectRatio: mediaSampleAspectRatio(video?.sample_aspect_ratio), videoStreamIndex: video?.index ?? -1 };
}
const instructions = `Editkin private holdout labels — no quality approval is created here.
1. Open clips/<id>/frames/<frame>.png. Paint its labels/<frame>.png mask: white foreground, black background, gray partial coverage.
2. Keep the exact raster and an opaque grayscale/RGB PNG with 8-bit channels. Do not resize, use image transparency, or alter the reference frame.
3. Run review-draft after painting. Inspect every frame, fill your privacy-safe reviewer hash and review time, and change approved to true only after review.
4. An all-black mask requires allBackgroundConfirmed=true (for example a fully hidden subject). Untouched templates never approve themselves.
5. Import labels into a NEW directory. Source/frame/candidate/mask drift or incomplete review is refused.
6. five-points is a sparse annotation starter. Only complete contiguous mode can prepare temporal truth. Independent candidate/formal alpha, object identities,
   rights, correction journals and performance remain required by roto-quality-acceptance-gate.ts. A labelled kit is not a passed holdout.
`;

/** Creates only a new directory. The manifest is the last commit; failure leaves bounded, visibly incomplete owned files. */
export async function createRotoHoldoutLabelKitV1(input: unknown, outputPath: string, runtime: RotoHoldoutRuntimeV1) {
  const request = parseRotoHoldoutRequestV1(input), check = rotoHoldoutBudgetV1(runtime);
  const tools = await Promise.all([runtime.ffmpegPath, runtime.ffprobePath].map(path => rotoHoldoutFileIdentityV1(path, check)));
  const artifacts = [];
  for (const a of request.candidate.artifacts) {
    const actual = await rotoHoldoutFileIdentityV1(a.path, check);
    if (actual.sha256 !== a.sha256) throw Error("ROTO_HOLDOUT_CANDIDATE_CHANGED"); artifacts.push({ id: a.id, ...actual });
  }
  const sources = [], plans = [], processReceipts: unknown[] = [];
  for (const [index, c] of request.clips.entries()) {
    const source = await rotoHoldoutFileIdentityV1(c.sourcePath, check);
    if (source.sha256 !== c.sourceSha256) throw Error("ROTO_HOLDOUT_SOURCE_HASH_MISMATCH"); sources.push(source);
    const args = ["-v", "error", "-show_format", "-show_streams", "-of", "json", source.path];
    const result = await rotoHoldoutProcessV1(tools[1].path, args, 1024 * 1024, runtime, check);
    processReceipts.push({ program: tools[1], args, closed: true, exitCode: 0, stdoutSha256: rotoHoldoutDigestV1(result.stdout), stderr: result.stderr });
    plans.push(planRotoHoldoutClipV1(request, index, probeValue(result.stdout)));
  }
  const total = plans.reduce((sum, p) => sum + p.selectedFrames.length, 0);
  if (total > ROTO_HOLDOUT_MAX_FRAMES_V1) throw Error("ROTO_HOLDOUT_FRAME_BUDGET_EXCEEDED");
  const output = await createRotoHoldoutOutputV1(outputPath, check); let completed = 0;
  const kit: RotoHoldoutKitV1 = { schema: "editkin.roto-holdout-label-kit/v1", datasetId: request.datasetId,
    frozenAt: new Date().toISOString(), status: "AWAITING_HUMAN_LABELS", sampleMode: request.sampleMode,
    candidate: { engine: request.candidate.engine, artifacts, implementationSha256: rotoHoldoutCandidateDigestV1(artifacts) },
    samplingConvention: "ffmpeg-autorotate-fps-even-display-fit/v1", sampleTimeKind: "analysis-grid-not-decoder-pts", clips: [] };
  try {
    for (const [index, p] of plans.entries()) {
      const samples = [], blank = blankRotoHoldoutPngV1(p.width, p.height);
      for (const frame of p.selectedFrames) {
        const filter = `fps=${p.analysisFps},scale=${p.width}:${p.height}:flags=bilinear,format=rgb24,select=eq(n\\,${frame})`;
        const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-ss", String(p.sourceStart), "-t", String(p.duration), "-i", sources[index].path,
          "-map", `0:${p.videoStreamIndex}`, "-an", "-sn", "-dn", "-vf", filter, "-frames:v", "1", "-fps_mode", "passthrough", "-f", "image2pipe", "-c:v", "png", "-pix_fmt", "rgb24", "pipe:1"];
        const result = await rotoHoldoutProcessV1(tools[0].path, args, p.width * p.height * 4 + 65536, runtime, check);
        readRotoHoldoutPngV1(result.stdout, p.width, p.height);
        const framePath = rotoHoldoutFramePathV1(p.id, frame, "frames"), maskPath = rotoHoldoutFramePathV1(p.id, frame, "labels");
        await output.write(framePath, result.stdout); await output.write(maskPath, blank);
        samples.push({ frame, timeSeconds: p.sourceStart + frame / p.analysisFps, framePath, maskPath,
          frameSha256: rotoHoldoutDigestV1(result.stdout), blankMaskSha256: rotoHoldoutDigestV1(blank) });
        processReceipts.push({ program: tools[0], args, closed: true, exitCode: 0, stdoutSha256: rotoHoldoutDigestV1(result.stdout), stderr: result.stderr });
        completed++; runtime.onProgress?.({ clipId: p.id, frame, completed, total }); check();
      }
      const { selectedFrames: _selection, ...plan } = p; kit.clips.push({ ...plan, source: sources[index], samples });
    }
    parseRotoHoldoutKitV1(kit);
    for (const pinned of [...sources, ...artifacts, ...tools]) {
      const current = await rotoHoldoutFileIdentityV1(pinned.path, check);
      if (current.sha256 !== pinned.sha256 || current.bytes !== pinned.bytes) throw Error("ROTO_HOLDOUT_INPUT_DRIFT");
    }
    const text = JSON.stringify(kit, null, 2) + "\n", kitSha256 = rotoHoldoutDigestV1(text);
    await output.write("READ_ME.txt", instructions);
    await output.write("review-template.json", JSON.stringify(rotoHoldoutReviewTemplateV1(kit, kitSha256), null, 2) + "\n");
    await output.write("process-receipts.json", JSON.stringify({ tools, processes: processReceipts, scope: "Decoded analysis-grid frames only; quality and human labels unmeasured" }, null, 2) + "\n");
    await output.write("kit.json", text);
    return { manifestPath: join(output.path, "kit.json"), kitSha256, clips: kit.clips.length, frames: completed,
      writtenBytes: output.writtenBytes, status: "AWAITING_HUMAN_LABELS" as const, qualityAcceptanceReady: false as const };
  } catch (error) {
    // This directory was exclusively created by this call. No automatic recursive deletion or later re-use.
    try { await writeFile(join(output.path, "INCOMPLETE.json"), JSON.stringify({ status: "INCOMPLETE", error: String(error),
      writtenBytes: output.writtenBytes, completedFrames: completed, originalSourcesUntouched: true }) + "\n", { flag: "wx" }); } catch { /* Preserve the original failure. */ }
    throw error;
  }
}
