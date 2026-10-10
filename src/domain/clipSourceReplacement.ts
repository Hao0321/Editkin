import { EditGraphError } from "./editGraphError";
import { validateClipForTrack, validateMediaAsset } from "./projectValidation";
import type { EditProject, MediaAsset } from "./types";

export interface ClipSourceReplacementRequest {
  clipId: string;
  expectedAssetId: string;
  assetId: string;
  /** Seconds on the project's frame grid; never silently clamped or rounded. */
  sourceStart: number;
}

const FRAME_EPSILON = 1e-6;
const SOURCE_TIME_EPSILON = 1e-6;
const validId = (value: string) => typeof value === "string" && value.length > 0 && value.length <= 160
  && value === value.trim() && !/[\u0000\r\n]/.test(value);
const ordinaryVideo = (asset: MediaAsset | undefined): asset is MediaAsset => Boolean(asset
  && asset.kind === "video" && !asset.compositionId && !asset.imageSequence
  && !/^editkin-composition:/i.test(asset.uri));
function exactFrame(time: number, fps: number): number | undefined {
  const value = time * fps, frame = Math.round(value);
  return Number.isFinite(time) && time >= 0 && Number.isSafeInteger(frame)
    && Math.abs(value - frame) <= FRAME_EPSILON ? frame : undefined;
}

/** Read-only UI/domain admission for an already imported source selection.
 * Import ingress owns real bytes, probe, colour and rights; this is neither a
 * filesystem grant nor evidence that editable metadata was actually measured.
 * Media-dependent analysis and managed recipes require their own recompiler. */
export function getClipSourceReplacementError(project: EditProject, command: ClipSourceReplacementRequest): string | undefined {
  if (![command.clipId, command.expectedAssetId, command.assetId].every(validId)) return "更換影片的片段或素材識別無效。";
  const track = project.tracks.find(candidate => candidate.clips.some(clip => clip.id === command.clipId));
  const clip = track?.clips.find(candidate => candidate.id === command.clipId);
  if (!clip || !track) return "原片段已不存在，請重新選取要更換的影片。";
  if (clip.assetId !== command.expectedAssetId) return "原片段的素材已變更，請重新選取後再更換。";
  if (clip.assetId === command.assetId) return "請選擇另一份已匯入的影片；目前素材沒有更換。";
  if (track.kind !== "video" || track.locked) return "只能更換未鎖定畫面軌上的影片片段。";
  const previousAsset = project.assets.find(asset => asset.id === clip.assetId);
  const asset = project.assets.find(candidate => candidate.id === command.assetId);
  if (!ordinaryVideo(previousAsset) || !ordinaryVideo(asset)) return "更換來源只接受已匯入的單檔影片，不接受音訊、圖片、預合成或影格序列。";
  if (!Number.isFinite(project.fps) || project.fps <= 0 || project.fps > 240) return "目前專案的影格率無效，無法更換影片。";
  if (!Number.isSafeInteger(asset.width) || !Number.isSafeInteger(asset.height) || asset.width! <= 0 || asset.height! <= 0) {
    return "新影片缺少有效的展示尺寸，請先完成素材匯入與探測。";
  }
  try { validateMediaAsset(project, asset); }
  catch (error) { return error instanceof Error ? error.message : "新影片的素材資料無效。"; }
  if (!Number.isFinite(asset.duration) || asset.duration <= 0) return "新影片缺少有效的探測時長。";
  const sourceFrame = exactFrame(command.sourceStart, project.fps);
  const timelineFrame = exactFrame(clip.timelineStart, project.fps);
  const durationFrames = exactFrame(clip.duration, project.fps);
  if (sourceFrame === undefined) return "新影片入點必須是非負且對齊專案影格的時間。";
  if (timelineFrame === undefined || durationFrames === undefined || durationFrames < 1
    || !Number.isSafeInteger(sourceFrame + durationFrames) || !Number.isSafeInteger(timelineFrame + durationFrames)) {
    return "原片段的起點或長度未對齊有效專案影格，請先修正時間範圍。";
  }
  if (command.sourceStart + clip.duration > asset.duration + SOURCE_TIME_EPSILON) {
    return "新影片從指定入點起長度不足；原片段長度與後續時間軸不會自動縮短。";
  }
  if ((project.referenceMotionInstances ?? []).some(instance => instance.input.clipId === clip.id
    || instance.roles.some(role => role.id === clip.id || role.parentId === clip.id))
    || project.templateApplication?.generatedClips?.some(candidate => candidate.clipId === clip.id)
    || project.templateApplication?.applied.clips.some(candidate => candidate.clipId === clip.id)) {
    return "此片段由模板管理；請透過模板重新編譯或明確解除模板連結，再更換來源。";
  }
  if (project.motionTracks.some(motion => motion.clipId === clip.id)
    || clip.masks?.some(mask => mask.trackId !== undefined || mask.matteSequence !== undefined || mask.frozenRange !== undefined
      || Boolean(mask.rotoCorrections?.length) || mask.keyframes.some(keyframe => keyframe.status !== "manual"))) {
    return "此片段含原影片的追蹤或已烘焙遮罩；請先明確移除分析綁定，再更換並重新分析。";
  }
  if (project.scene3d?.segments.some(segment => segment.objects.some(object => object.material.clipId === clip.id))) {
    return "此片段已綁定 3D 影片材質；請透過場景來源重新綁定，不能直接更換材質來源。";
  }
  // Scene25d camera/pose and independent MotionScene2D graphics do not pin an
  // asset independently. Preserve them; normal whole-project validation still
  // checks the new source against actual floating-frame/scene constraints.
  try { validateClipForTrack(project, track, { ...clip, assetId: asset.id, sourceStart: command.sourceStart }); }
  catch (error) { return error instanceof Error ? error.message : "新影片不符合此片段現有的效果與版面條件。"; }
  return undefined;
}

export function assertClipSourceReplacement(project: EditProject, command: ClipSourceReplacementRequest): void {
  const error = getClipSourceReplacementError(project, command);
  if (error) throw new EditGraphError(error);
}
