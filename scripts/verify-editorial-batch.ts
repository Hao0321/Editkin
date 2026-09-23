import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseProject } from "../src/application/projectFiles";
import { skillEditorialProjectEvidence } from "../src/application/skillEditorialBatch";
import { probeMedia } from "../src/render/ffmpeg";

interface BatchReceipt {
  schema: string;
  expectedDeliverableCount: number;
  actualProjectCount: number;
  actualRenderCount: number;
  oneProjectPerDeliverable: boolean;
  compilationFallbackUsed: boolean;
  outputs: Array<{ deliverableId: string; projectPath: string; outputPath: string; outputSha256: string }>;
}

function argument(name: string, required = true): string | undefined {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (required && !value) throw new Error(`缺少 ${name}`);
  return value ? resolve(value) : undefined;
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function main() {
  const receiptPath = argument("--receipt")!;
  const reportPath = argument("--output", false);
  const ffprobePath = argument("--ffprobe", false) ?? "ffprobe";
  const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as BatchReceipt;
  if (receipt.schema !== "hao.video-autopilot.editorial-batch-receipt/v1") throw new Error("批次收據 schema 不支援");
  if (receipt.compilationFallbackUsed || !receipt.oneProjectPerDeliverable) throw new Error("批次退化成合輯或共用專案");
  if (receipt.outputs.length !== receipt.expectedDeliverableCount || receipt.actualProjectCount !== receipt.expectedDeliverableCount || receipt.actualRenderCount !== receipt.expectedDeliverableCount) {
    throw new Error(`批次 cardinality 不一致：${receipt.outputs.length}/${receipt.expectedDeliverableCount}`);
  }
  if (new Set(receipt.outputs.map((item) => item.projectPath)).size !== receipt.outputs.length) throw new Error("多個 deliverable 共用同一專案");
  if (new Set(receipt.outputs.map((item) => item.outputPath)).size !== receipt.outputs.length) throw new Error("多個 deliverable 共用同一成片");
  const results = [];
  for (const output of receipt.outputs) {
    const project = parseProject(JSON.parse(await readFile(output.projectPath, "utf8")));
    const evidence = skillEditorialProjectEvidence(project);
    const decoded = await probeMedia(output.outputPath, ffprobePath);
    const currentHash = await sha256(output.outputPath);
    if (currentHash !== output.outputSha256) throw new Error(`${output.deliverableId} 成片 hash 與收據不一致`);
    if (!decoded.hasVideo || !decoded.hasAudio || Math.abs(decoded.duration - evidence.duration) > 0.15) throw new Error(`${output.deliverableId} 重開／解碼失敗`);
    if (!evidence.originalAudioMuted || evidence.musicClipCount < 1 || evidence.sfxClipCount < 2 || evidence.motionGraphicCount < 2 || !evidence.aces2) throw new Error(`${output.deliverableId} 重開後創意閉環遺失`);
    results.push({ deliverableId: output.deliverableId, projectRevision: project.revision, projectDuration: evidence.duration, decodedDuration: decoded.duration, outputSha256: currentHash, evidence });
  }
  const report = { schema: "hao.video-autopilot.editorial-batch-verification/v1", status: "GREEN", receiptPath, expectedDeliverableCount: receipt.expectedDeliverableCount, reopenedProjectCount: results.length, decodedRenderCount: results.length, results };
  if (reportPath) await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ status: report.status, expectedDeliverableCount: report.expectedDeliverableCount, reopenedProjectCount: report.reopenedProjectCount, decodedRenderCount: report.decodedRenderCount, reportPath })}\n`);
}

await main();
