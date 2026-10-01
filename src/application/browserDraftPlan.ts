import { projectDuration, validateProject } from "../domain/editGraph";
import { DEFAULT_COLOR, type EditProject, type MediaAsset, type TimelineClip, type TrackKind } from "../domain/types";
import { combineLookColor } from "../creative/corePack";

export const BROWSER_DRAFT_MAX_SECONDS = 300;
export const BROWSER_DRAFT_MAX_CLIPS = 32;
export const BROWSER_DRAFT_MAX_BYTES = 128 * 1024 * 1024;
export const BROWSER_DRAFT_MAX_SOURCE_BYTES = 128 * 1024 * 1024;
export const BROWSER_DRAFT_MAX_SOURCE_PIXELS = 4096 * 4096;

export const BROWSER_DRAFT_CODECS = [
  { mimeType: "video/mp4;codecs=avc1.42E01E,mp4a.40.2", extension: "mp4", label: "H.264 / AAC" },
  { mimeType: "video/webm;codecs=vp9,opus", extension: "webm", label: "VP9 / Opus" },
  { mimeType: "video/webm;codecs=vp8,opus", extension: "webm", label: "VP8 / Opus" },
] as const;

export interface BrowserDraftClip {
  clip: TimelineClip;
  asset: MediaAsset;
  source: string;
  kind: TrackKind;
}

export function browserDraftPlan(project: EditProject, runtimeUrls: Record<string, string>) {
  validateProject(project);
  const duration = projectDuration(project);
  if (duration <= 0) throw new Error("時間軸沒有可匯出的內容。");
  if (duration > BROWSER_DRAFT_MAX_SECONDS) throw new Error("網頁草稿最多輸出 5 分鐘；較長的影片請使用桌面版。");
  const unsupported = (feature: string): never => { throw new Error(`網頁草稿無法輸出${feature}；請使用桌面版，專案與剪輯仍保留。`); };
  if (project.colorManagement?.mode === "aces2") unsupported(" ACES 色彩管理");
  if (project.scene25d?.enabled || project.particleSimulation?.enabled) unsupported(" 2.5D／粒子場景");
  if (project.motionGraphics.length) unsupported("動態圖文");
  const clips: BrowserDraftClip[] = [];
  let needsFilter = false;
  for (const track of project.tracks) {
    if (track.muted || track.kind === "caption") continue;
    for (const clip of track.clips) {
      if (clip.layer?.enabled === false) continue;
      const asset = project.assets.find(item => item.id === clip.assetId)!;
      if (asset.compositionId) unsupported("巢狀合成");
      if (asset.imageSequence) unsupported(" OpenEXR 序列");
      if (asset.alphaMode && asset.alphaMode !== "auto" && asset.alphaMode !== "straight") unsupported("指定的來源 Alpha 解讀");
      if (asset.color && !["auto", "rec709", "srgb"].includes(asset.color.interpretation)) unsupported(" HDR／Log／線性色彩素材");
      if (asset.color?.transfer && !["bt709", "iec61966-2-1", "srgb", "unknown"].includes(asset.color.transfer.toLowerCase())) unsupported(" HDR／Log／線性色彩素材");
      if (clip.floatingFrame || clip.transform3d) unsupported("透視／3D 變形");
      if (clip.layer?.parentClipId || clip.layer?.trackMatte || (clip.layer?.role && clip.layer.role !== "content")) unsupported("父子／Matte／控制或調整圖層");
      if (clip.masks?.some(mask => mask.enabled) || clip.chromaKey?.enabled) unsupported("遮罩／去背");
      if (clip.creative?.nativeEffectInstances?.some(effect => effect.enabled)) unsupported("原生／GPU 外掛效果");
      const colors = [clip.color, ...clip.keyframes.map(frame => ({ ...clip.color, ...frame.color }))];
      for (const color of colors) {
        const look = combineLookColor(color, clip.creative?.lookPresetId);
        if ([look.whiteBalanceRed, look.whiteBalanceGreen, look.whiteBalanceBlue].some(value => value !== undefined && value !== 0)) unsupported("線性白平衡");
        if (Object.entries(DEFAULT_COLOR).some(([key, value]) => look[key as keyof typeof look] !== value)) needsFilter = true;
      }
      needsFilter ||= Boolean(clip.creative?.effectPresetIds.length || clip.creative?.transitionIn || clip.creative?.transitionOut);
      const source = runtimeUrls[asset.id];
      if (!source?.startsWith("blob:")) throw new Error(`請重新匯入「${asset.name}」後再匯出草稿；網頁匯出只讀取本頁匯入的素材。`);
      clips.push({ clip, asset, source, kind: track.kind });
    }
  }
  if (clips.length > BROWSER_DRAFT_MAX_CLIPS) throw new Error("網頁草稿最多輸出 32 個啟用的片段；較複雜的影片請使用桌面版。");
  const scale = Math.min(1, 1280 / Math.max(project.width, project.height));
  const width = Math.max(2, Math.floor(project.width * scale / 2) * 2);
  const height = Math.max(2, Math.floor(project.height * scale / 2) * 2);
  return { clips, duration, width, height, fps: Math.min(30, project.fps), needsFilter };
}
