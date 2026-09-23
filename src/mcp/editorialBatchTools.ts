import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  buildSkillEditorialProject,
  parseSkillEditorialBatchPlan,
  skillEditorialProjectEvidence,
  type SkillEditorialBatchPlan,
} from "../application/skillEditorialBatch";
import { exportVideo } from "../application/exportVideo";
import { inspectMedia } from "../application/inspectMedia";
import { acquireProjectLock } from "../application/projectFiles";
import { batchFileSha256, materializeEditorialProject, readEditorialRenderReceipt } from "../application/editorialBatchResume";
import { errorResult, textResult } from "./toolRuntime";
import { resolveWorkspaceMediaPath, workspaceRoot } from "./storage";

async function sha256(path: string): Promise<string> {
  return batchFileSha256(path);
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

async function readPlan(planPath: string): Promise<{ absolutePlanPath: string; plan: SkillEditorialBatchPlan }> {
  const absolutePlanPath = await resolveWorkspaceMediaPath(planPath);
  const plan = parseSkillEditorialBatchPlan(JSON.parse(await readFile(absolutePlanPath, "utf8")));
  await resolveWorkspaceMediaPath(plan.source.path);
  await resolveWorkspaceMediaPath(plan.music.path);
  if (await sha256(plan.source.path) !== plan.source.sha256) throw new Error("長片來源已變更，拒絕沿用舊拆片計畫");
  if (await sha256(plan.music.path) !== plan.music.sha256) throw new Error("配樂已變更，拒絕沿用舊素材收據");
  for (const soundEffect of plan.soundEffects) {
    await resolveWorkspaceMediaPath(soundEffect.path);
    if (await sha256(soundEffect.path) !== soundEffect.sha256) throw new Error(`SFX 已變更：${soundEffect.assetId}`);
  }
  return { absolutePlanPath, plan };
}

function compactPlan(plan: SkillEditorialBatchPlan) {
  return {
    batchId: plan.batchId,
    expectedDeliverableCount: plan.expectedDeliverableCount,
    actualDeliverableCount: plan.deliverables.length,
    oneEditableProjectPerDeliverable: plan.policy.oneEditableProjectPerDeliverable,
    compilationFallbackAllowed: plan.policy.allowCompilationFallback,
    revisionPolicy: plan.revisionPolicy,
    deliverables: plan.deliverables.map((item) => ({
      id: item.id,
      ordinal: item.ordinal,
      duration: item.segments.reduce((sum, segment) => sum + segment.duration, 0),
      segmentCount: item.segments.length,
      trackingCount: item.trackedLabels.length,
      textEventCount: item.textEvents.length,
    })),
  };
}

async function materialize(planPath: string, outputDirectory: string) {
  const { absolutePlanPath, plan } = await readPlan(planPath);
  const outputRoot = await resolveWorkspaceMediaPath(outputDirectory);
  await mkdir(outputRoot, { recursive: true });
  const projects = [];
  const planSha256 = await sha256(absolutePlanPath);
  for (const deliverable of plan.deliverables) {
    const directory = join(outputRoot, `${String(deliverable.ordinal).padStart(2, "0")}-${deliverable.id}`);
    const projectPath = join(directory, `${deliverable.id}.editkin.json`);
    const project = buildSkillEditorialProject(plan, deliverable);
    const saved = await materializeEditorialProject(projectPath, planSha256, deliverable.id, project);
    projects.push({ deliverable, projectPath, project: saved.project, resumed: saved.resumed, projectSha256: saved.projectSha256, evidence: skillEditorialProjectEvidence(saved.project) });
  }
  if (projects.length !== plan.expectedDeliverableCount || new Set(projects.map((item) => item.projectPath)).size !== projects.length) {
    throw new Error(`拆片 cardinality 失敗：預期 ${plan.expectedDeliverableCount}，實際 ${projects.length}`);
  }
  const manifestPath = join(outputRoot, "editorial-project-manifest.json");
  await atomicJson(manifestPath, {
    schema: "hao.video-autopilot.editorial-project-manifest/v1",
    batchId: plan.batchId,
    planSha256,
    expectedDeliverableCount: plan.expectedDeliverableCount,
    actualProjectCount: projects.length,
    compilationFallbackUsed: false,
    projects: projects.map((item) => ({ deliverableId: item.deliverable.id, ordinal: item.deliverable.ordinal, projectPath: relative(workspaceRoot(), item.projectPath), projectSha256: item.projectSha256, resumed: item.resumed, evidence: item.evidence })),
  });
  return { plan, outputRoot, manifestPath, projects };
}

export function registerEditorialBatchTools(server: McpServer): void {
  server.registerTool("audit_editorial_batch_plan", {
    description: "驗證一支長片拆成 N 支 Reels 的 closed-world 計畫、來源 hash、每支 hook/payoff、不可合輯與重剪差異；只回傳精簡摘要。",
    inputSchema: z.object({ planPath: z.string().min(1) }),
  }, async ({ planPath }) => {
    try {
      const { plan } = await readPlan(planPath);
      return textResult({ status: "GREEN", ...compactPlan(plan) });
    } catch (error) { return errorResult(error); }
  });

  server.registerTool("create_editorial_batch_projects", {
    description: "把已驗證的一支長片→N 支 Reels 計畫一次轉成 N 個獨立可編輯 EditGraph 專案；原片唯讀、原聲靜音、音樂／ACES／字卡／追蹤／轉場皆保留在 Timeline，可各自 Undo 與人工修改。",
    inputSchema: z.object({ planPath: z.string().min(1), outputDirectory: z.string().min(1) }),
  }, async ({ planPath, outputDirectory }) => {
    try {
      const batch = await materialize(planPath, outputDirectory);
      return textResult({
        status: "GREEN",
        expectedDeliverableCount: batch.plan.expectedDeliverableCount,
        actualProjectCount: batch.projects.length,
        editorialState: "STRUCTURED_DRAFT_REQUIRES_CURRENT_V4_DESIGN",
        manifestPath: relative(workspaceRoot(), batch.manifestPath),
        projects: batch.projects.map((item) => ({ id: item.deliverable.id, projectPath: relative(workspaceRoot(), item.projectPath), evidence: item.evidence })),
      });
    } catch (error) { return errorResult(error); }
  });

  server.registerTool("render_editorial_batch", {
    description: "不透過 Computer Use，一次建立並輸出 N 個獨立 Reels；逐支解碼驗證音畫、片長、原聲靜音、配樂、ACES 與可見 motion，最後才寫完整批次收據。長批次可能需數分鐘。",
    inputSchema: z.object({ planPath: z.string().min(1), outputDirectory: z.string().min(1), preferGpu: z.boolean().default(true) }),
  }, async ({ planPath, outputDirectory, preferGpu }) => {
    try {
      const batch = await materialize(planPath, outputDirectory);
      const ffmpegPath = process.env.EDITKIN_FFMPEG_PATH ?? "ffmpeg";
      const ffprobePath = process.env.EDITKIN_FFPROBE_PATH ?? "ffprobe";
      const outputs = [];
      for (const item of batch.projects) {
        const outputPath = join(dirname(item.projectPath), `${item.deliverable.id}-review.mp4`);
        const itemReceiptPath = `${outputPath}.receipt.json`;
        const release = await acquireProjectLock(outputPath);
        try {
        if (await sha256(item.projectPath) !== item.projectSha256) throw new Error(`${item.deliverable.id} 在排隊期間被修改；請重新讀取剪輯`);
        const previous = await readEditorialRenderReceipt(itemReceiptPath, outputPath, item.projectSha256);
        if (previous) {
          outputs.push({ deliverableId: item.deliverable.id, outputPath: relative(workspaceRoot(), outputPath), outputSha256: previous.outputSha256, duration: previous.duration, encoder: previous.encoder, resumed: true });
          continue;
        }
        let occupied = false;
        try { await access(outputPath); occupied = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        if (occupied) throw new Error(`${item.deliverable.id} 有未綁定收據的輸出；拒絕覆蓋，請使用新的输出資料夾`);
        const render = await exportVideo({
          project: item.project,
          outputPath,
          options: {
            ffmpegPath,
            ffprobePath,
            preferGpu,
            timeoutMs: 20 * 60_000,
            fontRoot: process.env.EDITKIN_FONT_ROOT ?? resolve(process.cwd(), "public/fonts"),
            colorRoot: process.env.EDITKIN_COLOR_ROOT ?? resolve(process.cwd(), "public/color/aces2"),
          },
        });
        const decoded = await inspectMedia(outputPath, ffprobePath);
        if (!decoded.hasVideo || !decoded.hasAudio || Math.abs(decoded.duration - item.evidence.duration) > 0.15) throw new Error(`${item.deliverable.id} 解碼驗證失敗`);
        if (!item.evidence.originalAudioMuted || item.evidence.musicClipCount < 1 || item.evidence.sfxClipCount < 2 || item.evidence.motionGraphicCount < 2 || !item.evidence.aces2) throw new Error(`${item.deliverable.id} 創意功能閉環不完整`);
        if (await sha256(item.projectPath) !== item.projectSha256) throw new Error(`${item.deliverable.id} 在輸出期間被修改；保留影片但不簽發完成收據`);
        const outputSha256 = await sha256(outputPath);
        await atomicJson(itemReceiptPath, { schema: "editkin.editorial-render/v1", projectSha256: item.projectSha256, outputSha256, duration: decoded.duration, encoder: render.encoder });
        outputs.push({ deliverableId: item.deliverable.id, outputPath: relative(workspaceRoot(), outputPath), outputSha256, duration: decoded.duration, encoder: render.encoder, resumed: false });
        } finally { await release(); }
      }
      if (outputs.length !== batch.plan.expectedDeliverableCount) throw new Error(`只完成 ${outputs.length}/${batch.plan.expectedDeliverableCount} 支`);
      const receiptPath = join(batch.outputRoot, "editorial-batch-receipt.json");
      await atomicJson(receiptPath, {
        schema: "hao.video-autopilot.editorial-batch-receipt/v1",
        batchId: batch.plan.batchId,
        expectedDeliverableCount: batch.plan.expectedDeliverableCount,
        actualProjectCount: batch.projects.length,
        actualRenderCount: outputs.length,
        oneProjectPerDeliverable: true,
        compilationFallbackUsed: false,
        outputs,
        reviewState: "REVIEW_REQUIRED",
        certified: false,
      });
      return textResult({ status: "REVIEW_REQUIRED", completed: outputs.length, receiptPath: relative(workspaceRoot(), receiptPath), outputs: outputs.map(({ deliverableId, outputPath, duration }) => ({ deliverableId, outputPath, duration })) });
    } catch (error) { return errorResult(error); }
  });
}
