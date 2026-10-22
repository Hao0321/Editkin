import type { McpServer } from "@modelcontextprotocol/server";
import { resolve } from "node:path";
import * as z from "zod/v4";
import { longformUiFocusHoldFileRequestV1Schema } from "../domain/longformUiFocusHoldFileV1";
import { ownLongformUiFocusHoldJobsV1, type LongformUiFocusHoldJobDepsV1 } from "../application/longformUiFocusHoldJobsV1";
import { longformUiFocusHoldAlgorithmSha256V1, prepareLongformUiFocusHoldV1 } from "../application/longformUiFocusHoldRuntimeV1";
import { colorFileSha, getMaterialColorRuntimeIdentity } from "../application/materialColorSamplingRuntime";
import type { registerLongformUiFocusToolsV1 } from "./longformUiFocusToolsV1";
import { errorResult, textResult } from "./toolRuntime";
export const LONGFORM_UI_FOCUS_HOLD_TOOLS_V1 = ["start_longform_ui_focus_hold", "get_longform_ui_focus_hold_job", "cancel_longform_ui_focus_hold_job", "read_longform_ui_focus_hold_frames"] as const;
export const LONGFORM_UI_FOCUS_HOLD_RESPONSE_BYTES_V1 = 256 * 1024;
const nativeSha256 = "02d6d8dd383ecf29c406cc0ea62b390b47355bb77cfaa46334876a013bbf1fb7";
const jobSchema = z.strictObject({ jobId: z.string().regex(/^uh-[a-f0-9]{24}$/) });
function bounded(value: unknown) {
  if (Buffer.byteLength(JSON.stringify(value)) > LONGFORM_UI_FOCUS_HOLD_RESPONSE_BYTES_V1) throw Error("UI_FOCUS_HOLD_RESPONSE_BUDGET");
  return textResult(value);
}
export function registerLongformUiFocusHoldToolsV1(server: McpServer, session: ReturnType<typeof registerLongformUiFocusToolsV1>, injected?: LongformUiFocusHoldJobDepsV1) {
  const { runtime, deps: source, confirmations } = session, nativeCorePath = resolve(import.meta.dirname, "../../native/bin/win32-x64/hao-core.exe");
  const read = async (artifactId: string, signal?: AbortSignal) => {
    source.jobs.assertArtifactOwned(artifactId); const artifact = await source.read(artifactId, { ...runtime, signal });
    source.jobs.assertArtifactOwned(artifactId); return artifact;
  };
  const jobs = ownLongformUiFocusHoldJobsV1(injected ?? {
    assertOwned: id => source.jobs.assertArtifactOwned(id), assertViewed: (id, frames) => source.jobs.assertFramesReturned(id, frames), confirmations, read,
    prepare: async (artifact, request, signal) => prepareLongformUiFocusHoldV1(artifact.sourcePath, artifact.draft,
      { draftId: artifact.draft.draftId, candidateId: request.candidateId, duration: request.duration },
      { ...runtime, signal, nativeCorePath, expectedNativeCoreSha256: nativeSha256 }),
    validateCurrent: async (artifactId, result, signal) => {
      const artifact = await read(artifactId, signal);
      if (artifact.draft.draftId !== result.draftId || artifact.draft.source.sha256 !== result.sourceSha256) throw Error("UI_FOCUS_HOLD_CURRENT_SOURCE_BINDING");
      if (result.provider.nativeCoreSha256 !== nativeSha256 || await colorFileSha(nativeCorePath) !== nativeSha256) throw Error("UI_FOCUS_HOLD_NATIVE_IDENTITY");
      if (await longformUiFocusHoldAlgorithmSha256V1() !== result.provider.implementationSha256) throw Error("UI_FOCUS_HOLD_ALGORITHM_CHANGED");
      const identity = await getMaterialColorRuntimeIdentity(runtime); signal?.throwIfAborted();
      if (identity.status !== "verified" || identity.identitySha256 !== result.provider.decodeRuntimeIdentitySha256) throw Error("UI_FOCUS_HOLD_DECODE_RUNTIME_CHANGED");
    },
  });
  const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  server.registerTool("start_longform_ui_focus_hold", {
    description: "以本連線已產生、已查看且已確認的 OCR 候選 ID，背景檢查0.8–4秒內每一個實際影格的文字定位。框位、來源和時鐘由工具取得；不接受手填座標。"
      + "遇到文字消失、重複圖樣或切頁會阻止整段提示，不自動重新鎖定。每連線最多一個工作；約每10秒查詢。不修改專案，仍待準備原生焦點框。",
    inputSchema: longformUiFocusHoldFileRequestV1Schema, annotations,
  }, async input => { try { return bounded(jobs.start(input)); } catch (error) { return errorResult(error); } });
  server.registerTool("get_longform_ui_focus_hold_job", {
    description: "查詢逐格定位工作。COMPLETED表示分析已完成；另看結果的TRACKING_EVIDENCE_READY/BLOCKED。完成結果重查目前專案與素材，尚非成片或美術驗收。",
    inputSchema: jobSchema, annotations,
  }, async ({ jobId }) => { try { return bounded(await jobs.get(jobId)); } catch (error) { return errorResult(error); } });
  server.registerTool("cancel_longform_ui_focus_hold_job", {
    description: "取消本連線逐格定位工作。所有實際分析程序關閉、暫存清理後才到CANCELLED；連線結束同樣取消並等待關閉。",
    inputSchema: jobSchema, annotations: { ...annotations, readOnlyHint: false },
  }, async ({ jobId }) => { try { return bounded(jobs.cancel(jobId)); } catch (error) { return errorResult(error); } });
  server.registerTool("read_longform_ui_focus_hold_frames", {
    description: "分頁讀每格的實際PTS、時間、文字四角與像素定位證據；保留原生追蹤失敗診斷。先重查來源、專案和分析程式。"
      + "每頁最多64格；文字圖樣連續性不代表按鈕邊緣、可點擊性或語意識別已證明，不會修改專案。",
    inputSchema: jobSchema.extend({ offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(64).default(32) }), annotations,
  }, async ({ jobId, offset, limit }) => { try { return bounded(await jobs.read(jobId, offset, limit)); } catch (error) { return errorResult(error); } });
  return jobs;
}
