import type { McpServer } from "@modelcontextprotocol/server";
import { join, resolve } from "node:path";
import * as z from "zod/v4";
import { longformUiFocusFileRequestV1Schema } from "../domain/longformUiFocusFileV1";
import { ownLongformUiFocusJobsV1, type LongformUiFocusJobsV1 } from "../application/longformUiFocusJobsV1";
import { readLongformUiFocusImageV1, summarizeLongformUiFocusArtifactV1 } from "../application/longformUiFocusArtifactV1";
import { confirmLongformUiFocusFileV1, prepareLongformUiFocusFileV1, readCurrentLongformUiFocusFileV1,
  type LongformUiFocusFileRuntimeV1 } from "./longformUiFocusFileV1";
import { LongformUiFocusConfirmationsV1 } from "../application/longformUiFocusHoldJobsV1";
import { errorResult, textResult } from "./toolRuntime";

export const LONGFORM_UI_FOCUS_TOOLS_V1 = ["start_longform_ui_focus_detection", "get_longform_ui_focus_job", "cancel_longform_ui_focus_job",
  "read_longform_ui_focus_candidates", "view_longform_ui_focus_frames", "confirm_longform_ui_focus_targets"] as const;
export const LONGFORM_UI_FOCUS_RESPONSE_BYTES_V1 = 256 * 1024;
const id = z.string().regex(/^[a-f0-9]{64}$/), frameId = z.string().regex(/^focus-frame-(?:[1-9]|1[0-2])$/);
const jobSchema = z.strictObject({ jobId: z.string().regex(/^uf-[a-f0-9]{24}$/) });
const pageSchema = z.strictObject({ artifactId: id, frameId: frameId.optional(), offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(100).default(50) });
export function longformUiFocusFileRuntimeV1(environment: NodeJS.ProcessEnv = process.env): LongformUiFocusFileRuntimeV1 {
  const sourceRoot = resolve(environment.EDITKIN_WORKSPACE ?? environment.HAO_EDITOR_WORKSPACE ?? process.cwd());
  const cacheRoot = resolve(environment.EDITKIN_CACHE_ROOT ?? join(sourceRoot, ".editkin-cache")), app = resolve(import.meta.dirname, "../..");
  return { sourceRoot, cacheRoot, workRoot: resolve(environment.EDITKIN_LONGFORM_WORK_ROOT ?? join(cacheRoot, "longform-work")),
    ffmpegPath: environment.HAO_FFMPEG_PATH ?? join(app, "vendor/ffmpeg/win32-x64/ffmpeg.exe"),
    ffprobePath: environment.HAO_FFPROBE_PATH ?? join(app, "vendor/ffmpeg/win32-x64/ffprobe.exe") };
}
export interface LongformUiFocusToolDepsV1 {
  jobs: Pick<LongformUiFocusJobsV1, "start" | "get" | "cancel" | "assertArtifactOwned" | "markFramesReturned" | "assertFramesReturned">;
  read: typeof readCurrentLongformUiFocusFileV1; confirm: typeof confirmLongformUiFocusFileV1; image: typeof readLongformUiFocusImageV1;
}
function bounded(value: unknown) {
  if (Buffer.byteLength(JSON.stringify(value)) > LONGFORM_UI_FOCUS_RESPONSE_BYTES_V1) throw Error("UI_FOCUS_RESPONSE_BUDGET: reduce limit or selection");
  return textResult(value);
}
export function registerLongformUiFocusToolsV1(server: McpServer, environment: NodeJS.ProcessEnv = process.env, injected?: LongformUiFocusToolDepsV1) {
  const runtime = longformUiFocusFileRuntimeV1(environment);
  const deps: LongformUiFocusToolDepsV1 = injected ?? {
    jobs: ownLongformUiFocusJobsV1({ prepare: async (request, signal, progress) =>
      (await prepareLongformUiFocusFileV1(request, { ...runtime, signal }, progress)).summary }),
    read: readCurrentLongformUiFocusFileV1, confirm: confirmLongformUiFocusFileV1, image: readLongformUiFocusImageV1,
  };
  const confirmations = new LongformUiFocusConfirmationsV1();
  const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  const read = async (artifactId: string) => {
    deps.jobs.assertArtifactOwned(artifactId); const artifact = await deps.read(artifactId, runtime);
    deps.jobs.assertArtifactOwned(artifactId); return artifact;
  };
  server.registerTool("start_longform_ui_focus_detection", {
    description: "在目前專案的錄影片段中抽取實際影格並用 Windows 已安裝 OCR 辨識文字區域，背景回 jobId。frameTimes 是片段來源相對秒數。"
      + "可指定最多16個目標文字，座標完全來自影格辨識，不接受手填框位。小字漏辨與重複文字保留待確認；不修改專案。每次連線最多一個工作，約每10秒查詢進度。",
    inputSchema: longformUiFocusFileRequestV1Schema, annotations,
  }, async input => { try { return bounded(deps.jobs.start(input)); } catch (error) { return errorResult(error); } });
  server.registerTool("get_longform_ui_focus_job", {
    description: "查詢本連線 OCR 工作；完成回 artifactId 與候選數，結果仍待查看影格和確認。RUNNING/CANCELLING 都不是完成。",
    inputSchema: jobSchema, annotations,
  }, async ({ jobId }) => { try { return bounded(deps.jobs.get(jobId)); } catch (error) { return errorResult(error); } });
  server.registerTool("cancel_longform_ui_focus_job", {
    description: "取消本連線 OCR 工作；等所有實際分析程序關閉後才回 CANCELLED。連線結束也會取消；不可用舊 jobId 續跑。",
    inputSchema: jobSchema, annotations: { ...annotations, readOnlyHint: false },
  }, async ({ jobId }) => { try { return bounded(deps.jobs.cancel(jobId)); } catch (error) { return errorResult(error); } });
  server.registerTool("read_longform_ui_focus_candidates", {
    description: "分頁讀工具實際產生的候選 ID、原始辨識文字、座標與影格 PTS；可按 frameId 篩選。先驗證目前專案、素材、程式及影像證據。"
      + "文字區域不代表按鈕邊緣、可點擊性或整段持續可見。MISSING/AMBIGUOUS 不會自動挑選。",
    inputSchema: pageSchema, annotations,
  }, async ({ artifactId, frameId: selectedFrame, offset, limit }) => {
    try {
      const artifact = await read(artifactId);
      if (selectedFrame && !artifact.draft.frames.some(frame => frame.id === selectedFrame)) throw Error("UI_FOCUS_FRAME_NOT_FOUND");
      const rows = artifact.draft.candidates.filter(row => !selectedFrame || row.frameId === selectedFrame);
      const items = rows.slice(offset, offset + limit);
      return bounded({ ...summarizeLongformUiFocusArtifactV1(artifact), offset, total: rows.length, items,
        nextOffset: offset + items.length < rows.length ? offset + items.length : null,
        frames: artifact.draft.frames.map(frame => ({ frameId: frame.id, sourceTime: frame.display.decoded.sourceTime,
          relativeTime: frame.display.decoded.relativeTime, imageSha256: frame.ocr.imageSha256 })) });
    } catch (error) { return errorResult(error); }
  });
  server.registerTool("view_longform_ui_focus_frames", {
    description: "查看本連線 OCR 實際處理的原始來源 JPEG 影格，每次最多2張且总影像≤2MiB。先看圖，再確認候選 ID；不把 OCR 字串當作畫面已確認。",
    inputSchema: z.strictObject({ artifactId: id, frameIds: z.array(frameId).min(1).max(2) }).superRefine((value, ctx) => {
      if (new Set(value.frameIds).size !== value.frameIds.length) ctx.addIssue({ code: "custom", message: "Duplicate frame" });
    }), annotations,
  }, async ({ artifactId, frameIds }) => {
    try {
      const artifact = await read(artifactId), frames = await Promise.all(frameIds.map(f => deps.image(runtime.cacheRoot, artifact, f)));
      const totalImageBytes = frames.reduce((n, frame) => n + frame.data.length, 0);
      if (totalImageBytes > 2 * 1024 * 1024) throw Error("UI_FOCUS_IMAGE_RESPONSE_BUDGET: request one frame");
      const metadata = bounded({ artifactId, draftId: artifact.draft.draftId, totalImageBytes, frames: frames.map(({ frame }) =>
        ({ frameId: frame.id, decoded: frame.display.decoded, imageSha256: frame.ocr.imageSha256, textAngle: frame.ocr.result.textAngle })) });
      deps.jobs.markFramesReturned(artifactId, frameIds);
      return { content: [...metadata.content, ...frames.map(({ data }) => ({ type: "image" as const, data: data.toString("base64"), mimeType: "image/jpeg" as const }))] };
    } catch (error) { return errorResult(error); }
  });
  server.registerTool("confirm_longform_ui_focus_targets", {
    description: "查看實際影格後，只以本連線工具產生的候選 ID 確認目標，不接受框位或改寫 OCR。重新檢查目前專案與來源；尚不產生提示或修改專案。"
      + "後續需驗證整個提示期間的目標可見與移動，再準備原生提示。",
    inputSchema: z.strictObject({ artifactId: id, candidateIds: z.array(z.string().regex(/^uif-[a-f0-9]{64}$/)).min(1).max(64) }), annotations,
  }, async ({ artifactId, candidateIds }) => {
    try {
      const artifact = await read(artifactId);
      const frameIds = candidateIds.map(id => { const row = artifact.draft.candidates.find(candidate => candidate.candidateId === id);
        if (!row) throw Error("UI_FOCUS_CANDIDATE_UNAVAILABLE"); return row.frameId; });
      deps.jobs.assertFramesReturned(artifactId, frameIds);
      const result = await deps.confirm(artifact, candidateIds, runtime); deps.jobs.assertArtifactOwned(artifactId);
      const response = bounded(result); confirmations.rememberVerified(artifactId, candidateIds); return response;
    } catch (error) { return errorResult(error); }
  });
  return { runtime, deps, confirmations };
}
