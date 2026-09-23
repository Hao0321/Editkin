import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { buildSkillEditorialProject, parseSkillEditorialBatchPlan, skillEditorialProjectEvidence } from "../src/application/skillEditorialBatch";
import { writeProjectFileAtomic } from "../src/application/projectFiles";
import { exportVideo } from "../src/application/exportVideo";
import { probeMedia } from "../src/render/ffmpeg";

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`缺少 ${name}`);
  return resolve(value);
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function main() {
  const planPath = argument("--plan");
  const outputRoot = argument("--output-root");
  const ffmpegPath = process.argv.includes("--ffmpeg") ? argument("--ffmpeg") : "ffmpeg";
  const ffprobePath = process.argv.includes("--ffprobe") ? argument("--ffprobe") : "ffprobe";
  const plan = parseSkillEditorialBatchPlan(JSON.parse(await readFile(planPath, "utf8")));
  if (await sha256(plan.source.path) !== plan.source.sha256) throw new Error("來源影片 SHA-256 與批次計畫不一致");
  if (await sha256(plan.music.path) !== plan.music.sha256) throw new Error("配樂 SHA-256 與批次計畫不一致");
  for (const soundEffect of plan.soundEffects) if (await sha256(soundEffect.path) !== soundEffect.sha256) throw new Error(`SFX SHA-256 不一致：${soundEffect.assetId}`);
  await mkdir(outputRoot, { recursive: true });
  const results = [];
  for (const deliverable of plan.deliverables) {
    const directory = join(outputRoot, `${String(deliverable.ordinal).padStart(2, "0")}-${deliverable.id}`);
    await mkdir(directory, { recursive: true });
    const projectPath = join(directory, `${deliverable.id}.editkin.json`);
    const outputPath = join(directory, `${deliverable.id}-review.mp4`);
    const project = buildSkillEditorialProject(plan, deliverable);
    const saved = await writeProjectFileAtomic(projectPath, project, null);
    const render = await exportVideo({
      project: saved,
      outputPath,
      options: {
        ffmpegPath,
        ffprobePath,
        preferGpu: true,
        timeoutMs: 20 * 60_000,
        fontRoot: resolve(process.cwd(), "public/fonts"),
        colorRoot: resolve(process.cwd(), "public/color/aces2"),
      },
    });
    const decoded = await probeMedia(outputPath, ffprobePath);
    const evidence = skillEditorialProjectEvidence(saved);
    if (!decoded.hasVideo || !decoded.hasAudio || Math.abs(decoded.duration - evidence.duration) > 0.15) throw new Error(`${deliverable.id} 解碼驗證失敗`);
    if (!evidence.originalAudioMuted || evidence.musicClipCount < 1 || evidence.sfxClipCount < 2 || evidence.motionGraphicCount < 2 || !evidence.aces2) throw new Error(`${deliverable.id} 可見／可聽功能閉環不完整`);
    const receipt = {
      schema: "hao.video-autopilot.editorial-deliverable-receipt/v1",
      batchId: plan.batchId,
      deliverableId: deliverable.id,
      ordinal: deliverable.ordinal,
      expectedDeliverableCount: plan.expectedDeliverableCount,
      projectPath,
      projectRevision: saved.revision,
      outputPath,
      outputSha256: await sha256(outputPath),
      outputBytes: (await readFile(outputPath)).byteLength,
      decoded,
      evidence,
      sourceSha256: plan.source.sha256,
      musicSha256: plan.music.sha256,
      reviewState: "REVIEW_REQUIRED",
      certified: false,
    };
    await writeFile(join(directory, "editorial-deliverable-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    results.push(receipt);
    process.stdout.write(`${JSON.stringify({ status: "REVIEW_REQUIRED", ordinal: deliverable.ordinal, id: deliverable.id, output: basename(outputPath), evidence })}\n`);
  }
  if (results.length !== plan.expectedDeliverableCount) throw new Error(`批次只完成 ${results.length}/${plan.expectedDeliverableCount} 支`);
  const batchReceipt = {
    schema: "hao.video-autopilot.editorial-batch-receipt/v1",
    batchId: plan.batchId,
    expectedDeliverableCount: plan.expectedDeliverableCount,
    actualProjectCount: results.length,
    actualRenderCount: results.length,
    oneProjectPerDeliverable: new Set(results.map((result) => result.projectPath)).size === results.length,
    compilationFallbackUsed: false,
    sourceSha256: plan.source.sha256,
    planPath,
    planSha256: await sha256(planPath),
    outputs: results.map((result) => ({ deliverableId: result.deliverableId, projectPath: result.projectPath, outputPath: result.outputPath, outputSha256: result.outputSha256 })),
    reviewState: "REVIEW_REQUIRED",
    certified: false,
  };
  await writeFile(join(outputRoot, "editorial-batch-receipt.json"), `${JSON.stringify(batchReceipt, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ status: "REVIEW_REQUIRED", batchReceipt: join(outputRoot, "editorial-batch-receipt.json"), completed: results.length })}\n`);
}

await main();
