import type { Dispatch, SetStateAction } from "react";
import { downloadEditGraph, type ProjectDownloadRequest } from "./exportGraph";
import type { HaoDesktopApi } from "../desktop/types";
import type { EditProject } from "../domain/types";
import type { ProjectSession } from "./projectSession";
import type { RenderArtifactIdentity } from "../render/renderArtifactIdentity";
import { describeProblem } from "./plainProblems";
import { failRenderJob, renderJobBusy, runRenderJob, setRenderJobCollapsed } from "../desktop/renderJobStore";

export function createAppRenderActions(input: {
  api?: HaoDesktopApi;
  project: EditProject;
  setStatus: Dispatch<SetStateAction<string>>;
  session?: ProjectSession;
  requestProjectDownload?: (project: EditProject) => ProjectDownloadRequest;
  onArtifactReady?: (project: EditProject, artifact: RenderArtifactIdentity) => Promise<boolean>;
}) {
  const exportGraph = () => {
    try {
      const result = (input.requestProjectDownload ?? downloadEditGraph)(input.session?.getSnapshot().history.present ?? input.project);
      input.setStatus(`已送出專案下載：${result.filename}；請確認瀏覽器下載完成。下載不會標記已儲存。`);
    } catch (error) { input.setStatus(error instanceof Error ? error.message : "專案下載失敗"); }
  };
  // Desktop exports run as one visible job (src/ui/export/ExportPanel.tsx): stage, measured progress and remaining
  // time, a cancel that stops the renderer, and 「打開資料夾」／「播放」 when done. A second click while one runs
  // brings its panel back instead of starting another.
  const renderVideo = async () => {
    if (!input.api) return exportGraph();
    if (renderJobBusy()) { setRenderJobCollapsed(false); return; }
    const api = input.api;
    const task = input.session?.beginTask(input.project);
    if (task && !task.isCurrent()) return;
    const submitted = input.project;
    let jobId: string | undefined;
    try {
      input.setStatus("正在輸出影片…");
      const { id, result } = await runRenderJob({ api, kind: "video", start: (id) => { jobId = id; return api.renderProject(submitted, { jobId: id }); } });
      jobId = id;
      if (task && !task.isCurrent()) {
        if (task.isSessionCurrent()) input.setStatus("前一版影片已輸出；目前專案已修改，該輸出不會套用到新版美感審查。");
        return;
      }
      if (result.canceled) return input.setStatus(result.stoppedByUser ? "已停止輸出影片，專案沒有改變。" : "已取消輸出。");
      const bound = result.artifactIdentity && input.onArtifactReady
        ? await input.onArtifactReady(submitted, result.artifactIdentity) : false;
      if (task && !task.isCurrent()) return;
      input.setStatus(`影片輸出完成：${result.outputPath} · ${result.encoder} · ${bound ? "已綁定本次輸出，請到導演台做美感審查" : "尚未綁定美感審查"} · 尚未取得人工品質認證`);
    } catch (error) {
      if (jobId) failRenderJob(jobId, describeProblem("export", error), () => void renderVideo());
      if (task && !task.isCurrent()) return;
      input.setStatus(error instanceof Error ? error.message : "影片輸出失敗");
    }
  };
  const renderOpenExrSequence = async () => {
    if (!input.api?.renderOpenExrSequence) return input.setStatus("目前執行環境沒有 OpenEXR 序列輸出核心。");
    try {
      input.setStatus("正在以單一 GPU 工作階段輸出場景線性 OpenEXR 影格序列…");
      const result = await input.api.renderOpenExrSequence(input.project);
      if (result.canceled) return input.setStatus("已取消 OpenEXR 序列輸出。");
      input.setStatus(`OpenEXR 序列完成：${result.outputDirectory} · ${result.receipt?.frameCount ?? 0} 格 · RGBA32F`);
    } catch (error) {
      input.setStatus(error instanceof Error ? error.message : "OpenEXR 序列輸出失敗");
    }
  };
  const renderAlphaMaster = async () => {
    const api = input.api;
    if (!api?.renderAlphaMaster) return input.setStatus("目前執行環境沒有 ProRes 4444 Alpha 輸出核心。");
    if (renderJobBusy()) { setRenderJobCollapsed(false); return; }
    let jobId: string | undefined;
    try {
      input.setStatus("正在檢查 FFmpeg ProRes 4444／高位元 Alpha 能力並輸出透明背景主檔…");
      const { id, result } = await runRenderJob({ api, kind: "alpha", start: (id) => { jobId = id; return api.renderAlphaMaster!(input.project, { jobId: id }); } });
      jobId = id;
      if (result.canceled) return input.setStatus(result.stoppedByUser ? "已停止輸出透明背景主檔，專案沒有改變。" : "已取消 ProRes 4444 Alpha 輸出。");
      const receipt = result.alphaDelivery;
      if (!receipt || receipt.status !== "GREEN") throw new Error("ProRes 4444 Alpha 輸出缺少正式 delivery receipt。");
      input.setStatus(`Alpha 主檔完成：${result.outputPath} · ${receipt.probedOutputPixelFormat} · 至少 ${receipt.effectiveMinimumAlphaBits}-bit Alpha`);
    } catch (error) {
      if (jobId) failRenderJob(jobId, describeProblem("export", error), () => void renderAlphaMaster());
      input.setStatus(error instanceof Error ? error.message : "ProRes 4444 Alpha 輸出失敗");
    }
  };
  return { exportGraph, renderVideo, renderOpenExrSequence, renderAlphaMaster };
}
