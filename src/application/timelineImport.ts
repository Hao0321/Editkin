import { applyCommand, type EditorCommand } from "../domain/commands";
import { projectDuration } from "../domain/editGraph";
import type { EditProject, MediaAsset } from "../domain/types";
import { canvasResolutionForAsset, isStarterDemo } from "./sourceOrientation";
import { planTimelineAssetInsert } from "./timelinePlacement";
import { timelineAssetDuration } from "../ui/timelineAssetDrop";

export interface TimelineImportIntent {
  trackId: string;
  trackKind: "video" | "audio";
  timelineStart: number;
}

/** Plan against the live graph after probing; preserve the captured drop intent. */
export function planImportedMediaTimeline(
  project: EditProject,
  assets: MediaAsset[],
  intent: TimelineImportIntent | undefined,
  createId: (prefix: string) => string,
) {
  if (!assets.length) throw new Error("沒有可匯入的素材。");
  const placement = intent ? { ...intent } : undefined;
  if (placement && (!Number.isFinite(placement.timelineStart) || placement.timelineStart < 0)) throw new Error("匯入落點必須是有效影格。");
  const firstVisual = assets.find(asset => asset.kind !== "audio");
  const replaceStarter = !placement && Boolean(firstVisual && isStarterDemo(project));
  const canvas = !placement && firstVisual ? canvasResolutionForAsset(firstVisual) : undefined;
  const changeCanvas = Boolean(canvas && (replaceStarter || !project.assets.some(asset => asset.kind !== "audio")));
  let cursor = placement ? Math.round(placement.timelineStart * project.fps) / project.fps
    : replaceStarter ? 0 : Math.ceil(projectDuration(project) * project.fps - 1e-7) / project.fps;
  const start = cursor;
  const commands: EditorCommand[] = [];
  let draft = project;
  const append = (command: EditorCommand) => { draft = applyCommand(draft, command); commands.push(command); };
  if (replaceStarter) {
    append({ type: "delete_clip", clipId: "clip-demo" });
    append({ type: "delete_asset", assetId: "asset-demo" });
  }
  if (changeCanvas && canvas) append({ type: "set_project_resolution", width: canvas.width, height: canvas.height });
  let lastClipId = "", newLayers = 0;
  for (const asset of assets) {
    const kind = asset.kind === "audio" ? "audio" : "video";
    if (placement && kind !== placement.trackKind) throw new Error("素材與指定軌道種類不同，請放到相容軌道。");
    let target = draft.tracks.find(track => placement ? track.id === placement.trackId : track.kind === kind && !track.locked);
    if (!target && !placement) {
      const id = createId(`${kind}-track`);
      append({ type: "add_track", track: { id, name: kind === "audio" ? "新增聲音軌" : "新增畫面軌", kind, locked: false, muted: false, clips: [] } });
      target = draft.tracks.find(track => track.id === id);
    }
    if (!target || target.locked || target.kind !== kind) throw new Error("指定軌道已刪除、鎖定或不相容；素材未加入。");
    const duration = timelineAssetDuration(asset, draft.fps);
    if (duration <= 0) throw new Error("素材不足一個專案影格，無法加入時間軸。");
    append({ type: "import_asset", asset });
    const clipId = createId("clip");
    const planned = planTimelineAssetInsert(draft, asset.id, target.id, cursor, clipId, createId);
    append(planned.command);
    if (planned.newLayer) newLayers++;
    cursor += duration;
    lastClipId = clipId;
  }
  return { command: { type: "batch", commands } as EditorCommand, lastClipId, timelineStart: start, newLayers, orientationMessage: changeCanvas && canvas ? `，已設成 ${canvas.label}（${canvas.width}×${canvas.height}）` : "" };
}
