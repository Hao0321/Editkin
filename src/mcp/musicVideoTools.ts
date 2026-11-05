import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { compileMusicVideoDraft } from "../application/musicVideoDraftCompiler";
import { compileIllustratedMusicVideo } from "../application/illustratedMusicVideoCompiler";
import type { EditProject } from "../domain/types";
import { readProject } from "./storage";
import { errorResult, textResult } from "./toolRuntime";

const id = z.string().trim().min(1).max(128);
const time = z.number().finite().nonnegative().max(86_400);
const evidenceRef = z.string().trim().min(1).max(160);

export const prepareMusicVideoDraftInputSchema = z.strictObject({
  projectPath: z.string().trim().min(1).max(1_024),
  styleId: z.enum(["afterglow", "paper_air"]),
  musicClipId: id,
  targetTrackId: id.default("video-main"),
  beatTimes: z.array(time).min(2).max(33),
  candidates: z.array(z.strictObject({
    shotId: id, assetId: id, sourceStart: time, sourceEnd: time,
    salience: z.number().finite().min(0).max(1),
    storyOrder: z.number().int().min(-1_000_000).max(1_000_000),
    focusTime: time.optional(),
  })).min(1).max(256),
  lyricCues: z.array(z.strictObject({ id, text: z.string().trim().min(1).max(96), start: time, end: time, evidenceRef })).max(64).optional(),
  cameraSafeShotIds: z.array(id).max(32).optional(),
  transitionCues: z.array(z.strictObject({
    boundaryIndex: z.number().int().min(1).max(31), fromShotId: id, toShotId: id,
    style: z.enum(["soft", "axis_left", "axis_right"]),
    evidenceRefs: z.tuple([evidenceRef, evidenceRef]),
  })).max(12).optional(),
  clipIds: z.array(id).min(1).max(32).optional(),
});

export type PrepareMusicVideoDraftInput = z.infer<typeof prepareMusicVideoDraftInputSchema>;

export const prepareIllustratedMusicVideoInputSchema = z.strictObject({
  projectPath: z.string().trim().min(1).max(1_024),
  musicClipId: id,
  backgroundTrackId: id.default("video-main"),
  characterTrackId: id.default("mv-character"),
  silhouetteTrackId: id.default("mv-silhouette"),
  foregroundTrackId: id.default("mv-foreground"),
  sections: z.array(z.strictObject({
    id, start: time, end: time,
    role: z.enum(["intro", "verse", "chorus", "break", "outro"]),
    framing: z.enum(["wide", "close"]),
    backgroundAssetId: id, characterAssetId: id, musicEvidenceRef: evidenceRef,
    silhouetteRevealFrames: z.number().int().min(0).max(24).optional(),
    backgroundEffect: z.enum(["none", "night_depth", "dawn_bloom"]).optional(),
    beatAccentFrames: z.array(z.number().int().min(0).max(900)).max(8).optional(),
    beatAccentEvidenceRefs: z.array(evidenceRef).max(8).optional(),
    entryTransition: z.enum(["cut", "soft_fade", "character_slide_left", "character_slide_right", "accent_flash"]).optional(),
    transitionEvidenceRefs: z.tuple([evidenceRef, evidenceRef]).optional(),
    foregroundAccent: z.strictObject({ assetId: id, startFrame: z.number().int().min(0).max(900),
      durationFrames: z.number().int().min(12).max(60), evidenceRef }).optional(),
    characterFrame: z.strictObject({ x: z.number().finite().min(-4_096).max(4_096),
      scale: z.number().finite().min(.5).max(2), evidenceRef }).optional(),
  })).min(1).max(12),
  wordCues: z.array(z.strictObject({
    id, text: z.string().trim().min(1).max(64), start: time, end: time,
    kind: z.enum(["title", "lyric"]), placement: z.enum(["left", "right", "top"]), tone: z.enum(["light", "ink"]).optional(),
    treatment: z.enum(["cascade", "impact", "ripple"]).optional(), evidenceRef,
  })).max(24).optional(),
});

export type PrepareIllustratedMusicVideoInput = z.infer<typeof prepareIllustratedMusicVideoInputSchema>;

export async function prepareIllustratedMusicVideoReadOnly(
  input: PrepareIllustratedMusicVideoInput,
  dependencies: { readProject(projectPath: string): Promise<EditProject> } = { readProject },
) {
  const parsed = prepareIllustratedMusicVideoInputSchema.parse(input);
  const project = await dependencies.readProject(parsed.projectPath);
  return compileIllustratedMusicVideo(project, parsed);
}

export async function prepareMusicVideoDraftReadOnly(
  input: PrepareMusicVideoDraftInput,
  dependencies: { readProject(projectPath: string): Promise<EditProject> } = { readProject },
) {
  const parsed = prepareMusicVideoDraftInputSchema.parse(input);
  const project = await dependencies.readProject(parsed.projectPath);
  return compileMusicVideoDraft(project, parsed);
}

export function registerMusicVideoTools(server: McpServer): void {
  server.registerTool("prepare_illustrated_music_video_draft", {
    description: "唯讀：把有權利的原創／授權插畫背景與透明角色圖層、連續歌曲及核對過的樂段編成可編輯動畫 MV。每個樂段建立分層 2D 鏡頭推移、角色進場、剪影、節拍動態與切鏡／短閃轉場；有證據的 characterFrame 可微調寬畫幅角色構圖，空間字可選逐字、衝擊或中心漣漪節奏，歌詞須先核對。缺角色插畫、透明度、同畫幅完整畫布或歌曲即拒絕，絕不以實拍影片歌詞卡冒充。輸出 flat commands 需先綁 v4 plan，audit 後 atomic apply/render 與美術審片。",
    inputSchema: prepareIllustratedMusicVideoInputSchema,
  }, async (input) => {
    try { return textResult(await prepareIllustratedMusicVideoReadOnly(input)); }
    catch (error) { return errorResult(error); }
  });
  server.registerTool("prepare_music_video_draft", {
    description: "唯讀：僅供明確指定實拍素材蒙太奇時使用。把歌曲聲軌、影片鏡頭、樂句切點與可選歌詞編成可編輯草稿；它不是插畫動畫 MV，不得用它代替 prepare_illustrated_music_video_draft。所有命令仍需 v4 audit/apply/render 與審片。",
    inputSchema: prepareMusicVideoDraftInputSchema,
  }, async (input) => {
    try { return textResult(await prepareMusicVideoDraftReadOnly(input)); }
    catch (error) { return errorResult(error); }
  });
}
