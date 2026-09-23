import { createHash, randomUUID } from "node:crypto";
import { access, link, lstat, mkdir, open, readFile, rename } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import * as z from "zod/v4";
import { canonicalJson } from "../shared/canonicalJson";
import { acquireProjectLock } from "./projectFiles";
import { batchFileSha256 } from "./editorialBatchResume";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/);
export const autopilotBatchManifestSchema = z.strictObject({
  schema: z.literal("editkin.autopilot-batch/v1"), batchId: id,
  expectedDeliverableCount: z.number().int().min(1).max(64),
  items: z.array(z.strictObject({ id, projectPath: z.string().min(1), planPath: z.string().min(1), outputPath: z.string().min(1) })).min(1).max(64),
}).superRefine((manifest, ctx) => {
  if (manifest.items.length !== manifest.expectedDeliverableCount || new Set(manifest.items.map(item => item.id)).size !== manifest.items.length) {
    ctx.addIssue({ code: "custom", message: "每個 deliverable 必須有獨立且唯一的項目，數量須等於 expectedDeliverableCount" });
  }
});
export type AutopilotBatchManifest = z.infer<typeof autopilotBatchManifestSchema>;
export type AutopilotBatchItem = AutopilotBatchManifest["items"][number];
const itemStateSchema = z.strictObject({
  id, planSha256: digest.optional(), beforeProjectSha256: digest.optional(),
  phase: z.enum(["queued", "applying", "applied", "rendering", "review_required"]),
  appliedProjectSha256: digest.optional(), executionReceipt: z.record(z.string(), z.unknown()).optional(),
  candidatePath: z.string().optional(), candidateSha256: digest.optional(), outputSha256: digest.optional(),
  render: z.record(z.string(), z.unknown()).optional(), error: z.string().optional(),
}).superRefine((item, ctx) => {
  if (item.phase !== "queued" && (!item.planSha256 || !item.beforeProjectSha256)) {
    ctx.addIssue({ code: "custom", message: "已啟動項目缺少凍結的輸入身份" });
  }
});
export type AutopilotBatchItemState = z.infer<typeof itemStateSchema>;
const stateSchema = z.strictObject({
  schema: z.literal("editkin.autopilot-batch-state/v1"), manifestSha256: digest,
  items: z.array(itemStateSchema), updatedAt: z.string(),
});
export type AutopilotBatchState = z.infer<typeof stateSchema>;
export interface AutopilotBatchRuntime {
  readPlan(item: AutopilotBatchItem): Promise<{ plan: unknown; sha256: string }>;
  audit(item: AutopilotBatchItem, plan: unknown): Promise<unknown>;
  apply(item: AutopilotBatchItem, plan: unknown, audit: unknown): Promise<Record<string, unknown>>;
  reconcile(item: AutopilotBatchItem, planSha256: string): Promise<Record<string, unknown> | undefined>;
  render(item: AutopilotBatchItem, candidatePath: string): Promise<Record<string, unknown>>;
  verifyRender(item: AutopilotBatchItem, candidatePath: string): Promise<void>;
  validatePaths(): Promise<void>;
}

export function autopilotBatchManifestSha256(manifest: AutopilotBatchManifest) {
  return createHash("sha256").update(canonicalJson(manifest)).digest("hex");
}
async function exists(path: string) {
  try { await access(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
async function atomicJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx");
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8"); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, path);
}
export async function readAutopilotBatchState(statePath: string, manifest: AutopilotBatchManifest) {
  if (!await exists(statePath)) return undefined;
  const state = stateSchema.parse(JSON.parse(await readFile(statePath, "utf8")));
  if (state.manifestSha256 !== autopilotBatchManifestSha256(manifest) || state.items.length !== manifest.items.length ||
      state.items.some((item, index) => item.id !== manifest.items[index].id)) {
    throw new Error("批次清單已變更；請用新的清單路徑，既有剪輯不會被覆蓋");
  }
  return state;
}
export function summarizeAutopilotBatch(state: AutopilotBatchState) {
  const completed = state.items.filter(item => item.phase === "review_required" && !item.error).length;
  return { status: completed === state.items.length ? "REVIEW_REQUIRED" : "PARTIAL", completed, expected: state.items.length,
    certified: false, items: state.items.map(({ id, phase, error, outputSha256 }) => ({ id, phase, error, outputSha256 })) };
}

/** Uses the single-edit gates through the runtime. Journals never infer an uncertain apply succeeded. */
export async function executeAutopilotBatch(manifest: AutopilotBatchManifest, statePath: string, runtime: AutopilotBatchRuntime,
  options: { itemId?: string; through?: "apply" | "render" } = {}) {
  if (options.itemId && !manifest.items.some(item => item.id === options.itemId)) throw new Error("未知批次項目");
  await runtime.validatePaths();
  const unlock = await acquireProjectLock(statePath);
  try {
    let state = await readAutopilotBatchState(statePath, manifest);
    if (!state) {
      const items: AutopilotBatchItemState[] = manifest.items.map(item => ({ id: item.id, phase: "queued" }));
      state = { schema: "editkin.autopilot-batch-state/v1", manifestSha256: autopilotBatchManifestSha256(manifest), items, updatedAt: new Date().toISOString() };
    }
    // Freeze readable inputs before any mutation. A missing/corrupt input belongs
    // to its item, and an already known identity is never replaced on retry.
    for (const [index, item] of manifest.items.entries()) {
      const progress = state.items[index];
      if (progress.phase !== "queued") continue;
      const errors: string[] = [];
      if (!progress.planSha256) {
        try { progress.planSha256 = (await runtime.readPlan(item)).sha256; }
        catch (error) { errors.push(`plan: ${error instanceof Error ? error.message : String(error)}`); }
      }
      if (!progress.beforeProjectSha256) {
        try { progress.beforeProjectSha256 = await batchFileSha256(item.projectPath); }
        catch (error) { errors.push(`project: ${error instanceof Error ? error.message : String(error)}`); }
      }
      if (errors.length) progress.error = `輸入未就緒；${errors.join("；")}`;
    }
    const save = async () => { state.updatedAt = new Date().toISOString(); await atomicJson(statePath, state); };
    await save();
    for (const [index, item] of manifest.items.entries()) {
      if (options.itemId && options.itemId !== item.id) continue;
      const progress = state.items[index];
      let releaseItem: (() => Promise<void>) | undefined;
      try {
        // Different batch manifests must not operate on the same project/output concurrently.
        releaseItem = await acquireProjectLock(`${item.projectPath}.autopilot-execution`);
        const releaseOutput = await acquireProjectLock(item.outputPath);
        const releaseProject = releaseItem;
        releaseItem = async () => { try { await releaseOutput(); } finally { await releaseProject(); } };
        await runtime.validatePaths();
        if (!progress.planSha256 || !progress.beforeProjectSha256) throw new Error(progress.error ?? "輸入未就緒");
        const { plan, sha256 } = await runtime.readPlan(item);
        if (sha256 !== progress.planSha256) throw new Error("批次 v4 計畫已變更；不覆蓋既有結果");
        delete progress.error;
        if (progress.phase === "review_required") {
          await assertAppliedProject(item, progress);
          if (!progress.outputSha256 || await batchFileSha256(item.outputPath) !== progress.outputSha256) throw new Error("已完成影片已變更；不重用或覆蓋");
          continue;
        }
        if (progress.phase === "queued" && await exists(item.outputPath)) throw new Error("輸出已存在但不屬於本批次；拒絕覆蓋");
        if (progress.phase === "applying") {
          const committed = await runtime.reconcile(item, sha256);
          if (committed) {
            progress.executionReceipt = committed;
            progress.appliedProjectSha256 = await batchFileSha256(item.projectPath);
            progress.phase = "applied";
            await save();
          } else if (await batchFileSha256(item.projectPath) === progress.beforeProjectSha256) {
            progress.phase = "queued"; // Proven unchanged, so a fresh audit is safe.
          } else throw new Error("套用中斷且專案已改變，缺可核對的 committed receipt；請先 reconcile，禁止重套");
        }
        if (progress.phase === "queued") {
          if (await batchFileSha256(item.projectPath) !== progress.beforeProjectSha256) throw new Error("專案已手動修改；批次不會覆蓋你的剪輯");
          const audit = await runtime.audit(item, plan);
          progress.phase = "applying";
          await save();
          progress.executionReceipt = await runtime.apply(item, plan, audit);
          const committed = await runtime.reconcile(item, sha256);
          if (!committed) throw new Error("套用後找不到綁定目前專案的 committed receipt");
          progress.appliedProjectSha256 = await batchFileSha256(item.projectPath);
          progress.phase = "applied";
          await save();
        }
        await assertAppliedProject(item, progress);
        if (options.through === "apply") continue;
        await renderItem(item, progress, runtime, save);
      } catch (error) {
        progress.error = error instanceof Error ? error.message : String(error);
        await save(); // An independent item is still allowed to run.
      } finally { await releaseItem?.(); }
    }
    return { ...summarizeAutopilotBatch(state), statePath };
  } finally { await unlock(); }
}
async function assertAppliedProject(item: AutopilotBatchItem, progress: AutopilotBatchItemState) {
  if (!progress.appliedProjectSha256 || await batchFileSha256(item.projectPath) !== progress.appliedProjectSha256) {
    throw new Error("已套用專案已變更；保留人工修改，不重套或輸出舊計畫");
  }
}
async function renderItem(item: AutopilotBatchItem, progress: AutopilotBatchItemState, runtime: AutopilotBatchRuntime, save: () => Promise<void>) {
  if (progress.candidateSha256 && progress.candidatePath) {
    const candidate = resolve(progress.candidatePath);
    const normalize = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
    if (normalize(dirname(candidate)) !== normalize(dirname(resolve(item.outputPath))) ||
        !new RegExp(`^\\.editkin-${item.id}-[a-f0-9-]{36}\\.mp4$`).test(basename(candidate))) throw new Error("candidate 不屬於本批次輸出目錄");
    const entry = await lstat(candidate);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("candidate 不可使用連結或非檔案");
    // A verified candidate was durably recorded before atomic promotion. Finish that transaction.
    if (await exists(item.outputPath)) {
      if (await batchFileSha256(item.outputPath) !== progress.candidateSha256) throw new Error("輸出與已驗證 candidate 不同；拒絕覆蓋");
    } else {
      if (await batchFileSha256(progress.candidatePath) !== progress.candidateSha256) throw new Error("已驗證 candidate 已變更");
      await link(progress.candidatePath, item.outputPath);
    }
  } else {
    if (await exists(item.outputPath)) throw new Error("輸出存在但缺可核對的收據；拒絕覆蓋");
    // Interrupted unverified attempts are retained; a retry always owns a new file.
    progress.candidatePath = join(dirname(item.outputPath), `.editkin-${item.id}-${randomUUID()}.mp4`);
    progress.phase = "rendering";
    await save();
    progress.render = await runtime.render(item, progress.candidatePath);
    await runtime.verifyRender(item, progress.candidatePath);
    await assertAppliedProject(item, progress);
    progress.candidateSha256 = await batchFileSha256(progress.candidatePath);
    await save();
    await runtime.validatePaths();
    await link(progress.candidatePath, item.outputPath); // Atomic, no replacement; candidate is on the same volume.
  }
  await assertAppliedProject(item, progress);
  progress.outputSha256 = progress.candidateSha256;
  progress.phase = "review_required";
  await save();
}
