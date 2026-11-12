import type { EditorCommand } from "../domain/commands";
import type { EditProject, MediaAsset } from "../domain/types";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";
import { canvasResolutionForAsset, isStarterDemo } from "./sourceOrientation";

export interface ImportedMediaPlacement {
  commands: EditorCommand[];
  lastClipId: string;
  orientationMessage: string;
  replacedStarter: boolean;
}

/** Place each media kind at the end of its own track, so a new voiceover and
 * a new picture both start at zero rather than following one another. */
export function planImportedMediaPlacement(
  project: EditProject,
  assets: MediaAsset[],
  nextClipId: () => string,
): ImportedMediaPlacement {
  if (!assets.length) throw new Error("沒有可匯入的素材");
  const replacedStarter = isStarterDemo(project);
  const firstVisual = assets.find((asset) => asset.kind !== "audio");
  const canvas = firstVisual ? canvasResolutionForAsset(firstVisual) : undefined;
  const setCanvas = Boolean(canvas && (replacedStarter || !project.assets.some((asset) => asset.kind !== "audio")));
  const commands: EditorCommand[] = [];
  if (replacedStarter) commands.push(
    { type: "delete_clip", clipId: "clip-demo" },
    { type: "delete_asset", assetId: "asset-demo" },
  );
  if (canvas && setCanvas) commands.push({ type: "set_project_resolution", width: canvas.width, height: canvas.height });
  const nextStart = new Map<string, number>();
  let lastClipId = "";
  for (const asset of assets) {
    const track = project.tracks.find((item) => item.kind === (asset.kind === "audio" ? "audio" : "video"));
    if (!track) throw new Error("找不到適合這份素材的軌道");
    const cursor = nextStart.get(track.id) ?? (replacedStarter ? 0 : Math.max(0, ...track.clips.map((clip) => clip.timelineStart + clip.duration)));
    const clipId = nextClipId();
    commands.push(
      { type: "import_asset", asset },
      { type: "add_clip", clip: {
        id: clipId, assetId: asset.id, trackId: track.id,
        timelineStart: cursor, sourceStart: 0, duration: asset.duration, volume: 1,
        transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [],
      } },
    );
    nextStart.set(track.id, cursor + asset.duration);
    lastClipId = clipId;
  }
  return {
    commands, lastClipId, replacedStarter,
    orientationMessage: setCanvas && canvas
      ? `，已依第一支畫面素材設成 ${canvas.label}（${canvas.width}×${canvas.height}）` : "",
  };
}
