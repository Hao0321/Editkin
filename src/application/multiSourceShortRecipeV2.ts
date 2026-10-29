import * as z from "zod/v4";
import type { CaptionCue, CaptionStyle, EditProject } from "../domain/types";
import type { MediaProbe } from "../render/ffmpegContracts";
import { TEMPLATE_SHORT_GENRE_IDS, TemplateShortBlockError, templateShortCopySchema } from "./templateShortBrief";
import { layoutMeasuredTextV2 } from "../typography/measuredTextLayoutV2";
import { resolveBundledFontFace } from "../typography/fontFaces";
import type { MotionTextAuthoringDeps } from "./motionTextAuthoringV3";

export const MULTI_SOURCE_SHORT_VERSION = "editkin.multi-source-short/v2" as const;
export const MULTI_SOURCE_SHORT_ROOT = "videos/_AUTOPILOT/editkin-multi-short";
export const MULTI_SOURCE_SHORT_ART = { artStatus: "ART_PENDING_CLAUDE", defaultEnabled: false, vaDefaultEnabled: false } as const;
const source = z.strictObject({ path: z.string().trim().min(1).max(512), in: z.number().finite().nonnegative().optional(),
  out: z.number().finite().positive().optional() });
const runId = z.string().regex(/^ms-[a-f0-9]{24}$/);
export const multiSourceShortStartSchema = z.strictObject({ schema: z.literal(MULTI_SOURCE_SHORT_VERSION),
  sources: z.array(source).min(2).max(8).optional(), genre: z.enum(TEMPLATE_SHORT_GENRE_IDS).optional(),
  music: source.optional(), runId: runId.optional(), framePage: z.number().int().min(2).max(8).optional(),
}).superRefine((value, ctx) => {
  if (value.runId) {
    if (!value.framePage || value.sources || value.genre || value.music) ctx.addIssue({ code: "custom", message: "續看畫面只接受 runId 和 framePage。" });
  } else if (!value.sources || !value.genre || value.framePage) ctx.addIssue({ code: "custom", message: "請指定 2–8 段素材與影片題材。" });
});
export const multiSourceShortMakeSchema = z.strictObject({ schema: z.literal(MULTI_SOURCE_SHORT_VERSION), runId,
  seen: z.array(z.strictObject({ s: z.number().int().min(0).max(7), kf: z.string().regex(/^kf-[1-9]\d{0,2}$/),
    note: z.string().trim().min(1).max(48) })).min(2).max(8), copy: templateShortCopySchema,
  captions: z.enum(["transcript", "copy"]).default("transcript"),
  /** Other themes are never selected automatically; this is an explicit opt-in to an uncertified composition. */
  allowUncertified: z.literal(true).optional(),
});
export type MultiSourceShortStart = z.output<typeof multiSourceShortStartSchema>;
export type MultiSourceShortMake = z.output<typeof multiSourceShortMakeSchema>;
export function parseMultiSourceShort<T>(schema: z.ZodType<T>, input: unknown): T {
  const bytes = new TextEncoder().encode(JSON.stringify(input)).byteLength;
  if (bytes > 1024) throw new TemplateShortBlockError("BLOCK_BRIEF", "輸入超過 1 KB，請用工作資料夾內的短相對路徑並縮短描述。");
  return schema.parse(input);
}

export interface OrderedShortWindow {
  index: number;
  sourceStartFrame: number;
  durationFrames: number;
  timelineStartFrame: number;
}
/** Array order is recording order. No reordering, silent overlap removal or source-speed alteration. */
export function planOrderedShortWindows(sources: readonly z.output<typeof source>[], probes: readonly MediaProbe[], fps = 30): {
  windows: OrderedShortWindow[]; durationFrames: number;
} {
  if (sources.length < 2 || sources.length > 8 || probes.length !== sources.length || !Number.isInteger(fps) || fps <= 0 || fps > 120) {
    throw new TemplateShortBlockError("BLOCK_START", "素材數量或影格率不合法。");
  }
  let durationFrames = 0;
  const windows = sources.map((input, index) => {
    const probe = probes[index], start = input.in ?? 0;
    if (!probe.hasVideo || !Number.isFinite(probe.duration) || probe.duration <= 0) throw new TemplateShortBlockError("BLOCK_START", `第 ${index + 1} 段必須是可讀取的影片。`);
    const end = input.out ?? Math.min(probe.duration, start + 10);
    if (![start, end].every(Number.isFinite) || start < 0 || end <= start || end > probe.duration + 1e-7) {
      throw new TemplateShortBlockError("BLOCK_START", `第 ${index + 1} 段的入出點超過素材範圍。`);
    }
    const sourceStartFrame = Math.round(start * fps), endFrame = Math.floor(end * fps + 1e-7), frames = endFrame - sourceStartFrame;
    if (frames < fps * 5 || frames > fps * 15 || endFrame > Math.floor(probe.duration * fps + 1e-7)) {
      throw new TemplateShortBlockError("BLOCK_START", `第 ${index + 1} 段請選 5–15 秒，讓開場與各段內容有完整閱讀時間。`);
    }
    const window = { index, sourceStartFrame, durationFrames: frames, timelineStartFrame: durationFrames };
    durationFrames += frames; return window;
  });
  if (durationFrames < fps * 20 || durationFrames > fps * 40) throw new TemplateShortBlockError("BLOCK_START", "各段合計請選 20–40 秒；請調整入出點或素材數量。");
  return { windows, durationFrames };
}

/** Both allocations use the renderer's real output drive; one combined free-space requirement. */
export function multiShortDiskNeed(durationFrames: number, fps = 30) {
  const seconds = durationFrames / fps;
  if (!Number.isInteger(durationFrames) || !Number.isFinite(fps) || fps <= 0 || seconds < 20 || seconds > 40) throw new Error("多段短片磁碟估算範圍不合法。");
  const temporaryBytes = 1024 ** 3 + durationFrames * 2 * 1024 ** 2;
  const outputBytes = Math.ceil(seconds * 100e6 / 8) * 3 + 256 * 1024 ** 2;
  return { temporaryBytes, outputBytes, combinedBytes: temporaryBytes + outputBytes, workspace: "beside-output" as const };
}

export interface ShortCaptionSource { timelineStart: number; duration: number; cues: readonly { start: number; end: number; text: string }[] }
/** Recognizer cue times are relative to the analyzed source window, never to the original source's in-point. */
export function orderedShortCaptionCues(sources: readonly ShortCaptionSource[], fps: number): CaptionCue[] {
  const result: CaptionCue[] = [];
  for (const [s, source] of sources.entries()) for (const [c, cue] of source.cues.entries()) {
    if (![cue.start, cue.end].every(Number.isFinite) || !cue.text.trim() || cue.end <= cue.start) continue;
    const start = Math.round((source.timelineStart + Math.max(0, cue.start)) * fps) / fps;
    const end = Math.min(Math.floor((source.timelineStart + source.duration) * fps + 1e-7) / fps,
      Math.round((source.timelineStart + Math.min(source.duration, cue.end)) * fps) / fps);
    if (end > start) result.push({ id: `multi-caption-${s}-${c}`, text: cue.text.trim(), start, duration: end - start });
  }
  return result;
}

/** Store measured boundaries in ordinary editable captions. Every new text path can reuse the same v2 rules. */
export async function prepareShortCaptionTextV2(project: Pick<EditProject, "width" | "height">, captions: readonly CaptionCue[],
  style: CaptionStyle, deps: MotionTextAuthoringDeps): Promise<CaptionCue[]> {
  const face = resolveBundledFontFace(style.fontFamily, style.bold ? 700 : 400);
  if (!face) throw new TemplateShortBlockError("BLOCK_COPY_GLYPH", "字幕字型缺少可驗證的實體字型檔。");
  const result: CaptionCue[] = [];
  for (const cue of captions) {
    deps.signal?.throwIfAborted();
    const run = await deps.prepareText(face.faceId, cue.text.replaceAll("\r", ""));
    // ASS Fontsize is sized to ascender-descender; the glyph provider uses em pixels.
    const size = Math.ceil(style.fontSize * run.unitsPerEm / (run.ascender - run.descender));
    const layout = layoutMeasuredTextV2(run, { slotWidth: Math.min(project.width * .72, 780 * project.width / 1080),
      fontSize: size, minFontSize: size, maxLines: 2, padding: () => 0, signal: deps.signal });
    result.push({ ...cue, text: layout.text });
  }
  return result;
}
