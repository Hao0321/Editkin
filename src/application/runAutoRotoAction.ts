import type { AutoRotoDesktopResult, HaoDesktopApi } from "../desktop/types";
import type { EditorCommand } from "../domain/commands";
import type { EditProject } from "../domain/types";
import { acceptProjectTask } from "./projectTask";
import type { ProjectSession } from "./projectSession";

interface AutoRotoActionOptions<RuntimeStatus> {
  projectSession: ProjectSession;
  project: EditProject;
  clipId?: string;
  maskId: string;
  playhead: number;
  analyze: HaoDesktopApi["analyzeAutoRoto"];
  busy: { current: boolean };
  onBusy: (busy: boolean) => void;
  onPlaying: (playing: boolean) => void;
  onStatus: (message: string) => void;
  validateResult: (result: AutoRotoDesktopResult) => RuntimeStatus;
  onRuntimeStatus: (status: RuntimeStatus) => void;
  onCommand: (command: EditorCommand, message: string) => void;
}

/** Analysis owns one immutable editor-content generation, not merely a clip ID. */
export async function runAutoRotoAction<RuntimeStatus>({
  projectSession, project, clipId, maskId, playhead, analyze, busy,
  onBusy, onPlaying, onStatus, validateResult, onRuntimeStatus, onCommand,
}: AutoRotoActionOptions<RuntimeStatus>): Promise<"applied" | "stale" | "busy" | "invalid" | "unavailable" | "failed"> {
  if (busy.current) return "busy";
  const task = projectSession.beginTask(project);
  if (!acceptProjectTask(task, onStatus, "Auto Roto 分析")) return "stale";
  const clip = project.tracks.flatMap((track) => track.clips).find((item) => item.id === clipId);
  const asset = clip ? project.assets.find((item) => item.id === clip.assetId) : undefined;
  if (!clip || !asset || asset.kind !== "video") { onStatus("Auto Roto 需要先選一段影片。"); return "invalid"; }
  const mask = clip.masks?.find((item) => item.id === maskId);
  if (!mask || mask.kind !== "subject") { onStatus("Auto Roto 只能套用在主體遮罩。"); return "invalid"; }
  if (!analyze) { onStatus("目前 runtime 尚未提供原生 Auto Roto；請使用 Tauri 桌面版。"); return "unavailable"; }
  const track = mask.trackId ? project.motionTracks.find((item) => item.id === mask.trackId) : undefined;
  const xs = mask.path.map((point) => point.x); const ys = mask.path.map((point) => point.y);
  const initialRect = track?.initialRect ?? { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
  // React state does not close same-tick double-clicks; this ref lock does.
  busy.current = true;
  try {
    onPlaying(false); onBusy(true); onStatus("正在由本機影像引擎產生逐像素 matte；不會上傳素材…");
    const result = await analyze({
      sourcePath: asset.uri, sourceStart: clip.sourceStart, duration: clip.duration, fps: project.fps,
      sourceWidth: asset.width ?? project.width, sourceHeight: asset.height ?? project.height,
      initialTime: Math.max(0, Math.min(clip.duration, playhead - clip.timelineStart)), initialRect: structuredClone(initialRect),
      sourceSha256: asset.derivatives?.sourceSha256, temporalStability: mask.refine.chatterReduction * 0.65,
      feather: mask.feather, edgeShift: Math.max(-.25, Math.min(.25, mask.expansion + mask.refine.edgeShift)), contrast: 0.5 + mask.refine.contrast * 2.4,
      corrections: structuredClone(mask.rotoCorrections),
    });
    if (!acceptProjectTask(task, onStatus, "Auto Roto 分析")) return "stale";
    // Keep the existing runtime receipt validator as the acceptance boundary.
    const runtimeStatus = validateResult(result);
    onRuntimeStatus(runtimeStatus);
    const outcome = "已由 Editkin 自研本機引擎產生 diagnostic matte；請人工檢查髮絲、透明材質、動態模糊與遮擋重現。";
    onCommand({ type: "update_clip_mask", clipId: clip.id, maskId, patch: {
      matteSequence: { schema: result.schema, engine: result.engine, width: result.width, height: result.height, analysisFps: result.analysisFps, frameCount: result.frames.length, sequenceUri: result.sequencePath, sequenceSha256: result.sequenceSha256, sequenceBytes: result.sequenceBytes, manifestUri: result.manifestPath, framePreviewUris: result.frames.map((frame) => frame.previewUrl ?? frame.alphaPath), frameArtifactUris: result.frames.map((frame) => frame.alphaPath), meanBoundaryChatter: result.meanBoundaryChatter, correctionStrokesApplied: result.correctionStrokesApplied, correctedFrames: result.correctedFrames, regionMemoryRouting: result.regionMemoryRouting, alphaRefinement: result.alphaRefinement, routeReceipt: result.routeReceipt, frozen: true, qualityState: result.qualityState },
      frozenRange: { fromFrame: 0, toFrame: Math.ceil(clip.duration * project.fps) },
    } }, `Auto Roto 已產生 ${result.frames.length} 格逐像素 matte，套用 ${result.correctionStrokesApplied} 筆人工保留／移除修正；${outcome}`);
    return "applied";
  } catch (error) {
    if (!acceptProjectTask(task, onStatus, "Auto Roto 分析")) return "stale";
    onStatus(error instanceof Error ? error.message : typeof error === "string" && error.trim() ? error : "Auto Roto 分析失敗");
    return "failed";
  } finally { busy.current = false; onBusy(false); }
}
