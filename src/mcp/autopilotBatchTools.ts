import { basename, dirname, join, relative, resolve } from "node:path";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { canonicalJson } from "../shared/canonicalJson";
import { autopilotPlanSha256, parseAutopilotPlan } from "../application/autopilotPlan";
import { createAutopilotProjectAuditIdentity } from "../application/autopilotInvocationIdentity";
import { autopilotBatchManifestSchema, executeAutopilotBatch, readAutopilotBatchState, summarizeAutopilotBatch,
  type AutopilotBatchManifest, type AutopilotBatchItem, type AutopilotBatchRuntime } from "../application/autopilotBatchExecution";
import { batchFileSha256 } from "../application/editorialBatchResume";
import { projectDuration } from "../domain/editGraph";
import { inspectMedia } from "../application/inspectMedia";
import { runProcess } from "../render/ffmpegMedia";
import { auditAutopilotPlan, applyAutopilotPlan } from "./autopilotTools";
import { renderAutopilotProject } from "./renderTools";
import { errorResult, textResult } from "./toolRuntime";
import { readProject, resolveProjectPath, resolveRenderPath, resolveWorkspaceMediaPath, workspaceRoot } from "./storage";

async function boundedJson(path: string, limit = 4 * 1024 * 1024) {
  if ((await stat(path)).size > limit) throw new Error("批次或計畫超出有界檔案大小");
  return JSON.parse(await readFile(path, "utf8"));
}
function payload(result: { content: Array<{ type: string; text?: string }> }) {
  return JSON.parse(result.content.find(item => item.type === "text")?.text ?? "{}");
}
async function canonicalPath(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonicalPath(parent), basename(path));
  }
}
async function verifyDistinctPaths(manifest: AutopilotBatchManifest, batchPath: string, statePath: string) {
  const seen = new Set<string>();
  const paths = [batchPath, statePath, ...manifest.items.flatMap(item => [item.projectPath, item.planPath, item.outputPath])];
  const inodes = new Set<string>();
  for (const path of paths) {
    await resolveWorkspaceMediaPath(path);
    const actual = await canonicalPath(path);
    const key = process.platform === "win32" ? actual.toLowerCase() : actual;
    if (seen.has(key)) throw new Error("批次項目不能共用 project／plan／output，含 junction、大小寫別名");
    seen.add(key);
    try {
      const info = await stat(path, { bigint: true });
      const identity = `${info.dev}:${info.ino}`;
      if (info.ino !== 0n && inodes.has(identity)) throw new Error("批次路徑不可透過 hard link 共用同一檔案");
      if (info.ino !== 0n) inodes.add(identity);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
async function loadBatch(batchPath: string) {
  const path = await resolveWorkspaceMediaPath(batchPath);
  if (!path.endsWith(".json")) throw new Error("批次清單須為 JSON");
  const manifest = autopilotBatchManifestSchema.parse(await boundedJson(path));
  for (const item of manifest.items) {
    item.projectPath = await resolveProjectPath(item.projectPath);
    item.planPath = await resolveWorkspaceMediaPath(item.planPath);
    item.outputPath = await resolveRenderPath(item.outputPath);
  }
  const statePath = await resolveWorkspaceMediaPath(`${path}.state.json`);
  await verifyDistinctPaths(manifest, path, statePath);
  return { path, manifest, statePath };
}
async function readCommittedReceipt(item: AutopilotBatchItem, planSha256: string) {
  const project = await readProject(item.projectPath);
  const expected = createAutopilotProjectAuditIdentity(item.projectPath, project);
  const directory = await resolveWorkspaceMediaPath(join(dirname(item.projectPath), ".editkin-receipts"));
  let names: string[];
  try { names = await readdir(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  const prefix = `${basename(item.projectPath).replace(/\.(?:editkin|haoedit)\.json$/i, "")}.`;
  for (const name of names.filter(name => name.startsWith(prefix) && name.endsWith(".committed.json")).sort().reverse().slice(0, 512)) {
    const receipt = await boundedJson(await resolveWorkspaceMediaPath(join(directory, name)));
    if (receipt.schema !== "hao.video-autopilot.execution-receipt/v1" || receipt.state !== "committed" || receipt.planSha256 !== planSha256) continue;
    if (receipt.planSchema !== "hao.video-autopilot.edit-plan/v4" || !receipt.design ||
        canonicalJson(receipt.projectIdentityAfter ?? null) !== canonicalJson(expected)) {
      throw new Error("committed receipt 與目前專案不符；不推測套用結果");
    }
    return { ...receipt, receiptFile: name } as Record<string, unknown>;
  }
  return undefined;
}
function createRuntime(batch: Awaited<ReturnType<typeof loadBatch>>, preferGpu: boolean): AutopilotBatchRuntime {
  return {
    validatePaths: () => verifyDistinctPaths(batch.manifest, batch.path, batch.statePath),
    async readPlan(item) {
      const raw = await boundedJson(item.planPath);
      try {
        const plan = parseAutopilotPlan(raw);
        return { plan, sha256: autopilotPlanSha256(plan) };
      } catch {
        // Preserve the invalid item's identity; its audit fails without stopping other items.
        return { plan: raw, sha256: createHash("sha256").update(canonicalJson(raw)).digest("hex") };
      }
    },
    async audit(item, plan) { return payload(await auditAutopilotPlan(item.projectPath, plan)).auditReceipt; },
    async apply(item, plan, audit) { return payload(await applyAutopilotPlan(item.projectPath, plan, audit)).receipt; },
    reconcile: readCommittedReceipt,
    async render(item, candidate) { return payload(await renderAutopilotProject(item.projectPath, candidate, preferGpu)); },
    async verifyRender(item, candidate) {
      const project = await readProject(item.projectPath);
      const probe = await inspectMedia(candidate, process.env.HAO_FFPROBE_PATH);
      if (!probe.hasVideo || !probe.hasAudio || Math.abs(probe.duration - projectDuration(project)) > Math.max(0.15, 2 / project.fps)) throw new Error("批次成片音畫／時長驗證失敗");
      await runProcess(process.env.HAO_FFMPEG_PATH ?? "ffmpeg", ["-v", "error", "-xerror", "-i", candidate, "-map", "0:v:0", "-map", "0:a:0", "-f", "null", "-"], 20 * 60_000);
    },
  };
}
export function registerAutopilotBatchTools(server: McpServer) {
  server.registerTool("run_autopilot_batch", {
    description: "執行完整 current-v4 批次的 audit→atomic apply→render→全片解碼。AI 必須先逐支判讀素材、取得 current designEvidence 並封存 v4 plan；本工具不代替 AI 判讀。batchPath JSON schema=editkin.autopilot-batch/v1，含 batchId、expectedDeliverableCount、items[{id,projectPath,planPath,outputPath}]。各支保留独立時間軸與收據；失敗不阻擋其他項目、相同清單可續跑、人工修改與既有輸出不覆蓋。through=apply 可先停在套用。永遠不代簽人審。",
    inputSchema: z.object({ batchPath: z.string(), itemId: z.string().optional(), through: z.enum(["apply", "render"]).default("render"), preferGpu: z.boolean().default(true) }),
  }, async ({ batchPath, itemId, through, preferGpu }) => {
    try {
      const batch = await loadBatch(batchPath);
      const result = await executeAutopilotBatch(batch.manifest, batch.statePath, createRuntime(batch, preferGpu), { itemId, through });
      return textResult({ ...result, statePath: relative(workspaceRoot(), result.statePath) });
    } catch (error) { return errorResult(error); }
  });
  server.registerTool("get_autopilot_batch_status", {
    description: "讀取完整 v4 批次進度並重驗已完成的專案／輸出 SHA；不套用、不輸出、不代簽審片。",
    inputSchema: z.object({ batchPath: z.string() }),
  }, async ({ batchPath }) => {
    try {
      const batch = await loadBatch(batchPath);
      const state = await readAutopilotBatchState(batch.statePath, batch.manifest);
      if (!state) return textResult({ status: "READY", expected: batch.manifest.expectedDeliverableCount, completed: 0 });
      const runtime = createRuntime(batch, true);
      for (const [index, item] of batch.manifest.items.entries()) {
        const progress = state.items[index];
        try {
          if (!progress.planSha256 || !progress.beforeProjectSha256) throw new Error(progress.error ?? "輸入未就緒");
          if ((await runtime.readPlan(item)).sha256 !== progress.planSha256) throw new Error("v4 計畫已變更");
          const expectedProject = progress.appliedProjectSha256 ?? progress.beforeProjectSha256;
          if (await batchFileSha256(item.projectPath) !== expectedProject) throw new Error("專案已變更");
          if (progress.phase === "review_required" && await batchFileSha256(item.outputPath) !== progress.outputSha256) throw new Error("影片已變更");
        } catch (error) { progress.error = error instanceof Error ? error.message : String(error); }
      }
      return textResult(summarizeAutopilotBatch(state));
    } catch (error) { return errorResult(error); }
  });
}
