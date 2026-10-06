import type { CaptionStyle, EditProject, MotionGraphic } from "../domain/types";
import { bundledFontAssMetrics } from "../typography/fontEmMetrics";
import { motionGraphicV2FrameReceipt, motionGraphicV2LayoutReceipt } from "../motion/compositionV2";
import { motionPanelPaths } from "../motion/panelGeometry";
import { assColor, assFace, assFontName, assMotionFrameTime, assOverrideColor, assText, assTime, roundAss } from "./assText";
import { motionGraphicV3Events } from "./motionV3Ass";

export { assMotionFrameTime } from "./assText";

function graphicOverrides(graphic: MotionGraphic, x: number, y: number, animate = true, bundledFaces = true): string {
  const startX = Math.round(x);
  const startY = Math.round(y);
  const face = assFace(graphic.fontFamily ?? "Noto Sans TC", graphic.fontWeight ?? 700, bundledFaces);
  const font = `\\fn${assFontName(face.fontFamily)}`;
  const weight = `\\b${face.fontWeight}`;
  const spacing = `\\fsp${Math.round(graphic.letterSpacing ?? 0)}`;
  const border = Math.round(graphic.outlineWidth ?? (graphic.kind === "card" ? 14 : 7));
  const shadow = Math.round(graphic.shadowDepth ?? 2);
  const base = `\\an7${font}${weight}${spacing}\\fs${Math.round(graphic.fontSize)}${assOverrideColor(graphic.textColor, 1, 1)}${assOverrideColor(graphic.backgroundColor, 3, 1)}${assOverrideColor(graphic.accentColor, 4, 1)}\\bord${border}\\shad${shadow}`;
  if (!animate) return `{${base}\\pos(${startX},${startY})}`;
  if (graphic.animation === "slide_up") return `{${base}\\move(${startX},${startY + 36},${startX},${startY},0,360)\\fad(160,140)}`;
  if (graphic.animation === "pop") return `{${base}\\pos(${startX},${startY})\\fscx70\\fscy70\\t(0,260,\\fscx100\\fscy100)\\fad(90,140)}`;
  if (graphic.animation === "spring_soft") return `{${base}\\pos(${startX},${startY})\\fscx72\\fscy72\\t(0,210,\\fscx108\\fscy108)\\t(210,390,\\fscx100\\fscy100)\\fad(80,140)}`;
  return `{${base}\\pos(${startX},${startY})\\fad(180,140)}`;
}

function motionGraphicEvents(project: EditProject, bundledFaces: boolean): string[] {
  return project.motionGraphics.flatMap((graphic, index) => {
    if (graphic.schema === "hao.motion-composition/v3") return motionGraphicV3Events(project, graphic, bundledFaces, index);
    if (graphic.schema === "hao.motion-composition/v2") return motionGraphicV2Events(project, graphic, bundledFaces);
    const text = assText(graphic.text);
    if (!graphic.trackId) {
      const overrides = graphicOverrides(graphic, graphic.x * project.width, graphic.y * project.height, true, bundledFaces);
      return [`Dialogue: 1,${assTime(graphic.timelineStart)},${assTime(graphic.timelineStart + graphic.duration)},Motion,,0,0,0,,${overrides}${text}`];
    }
    const track = project.motionTracks.find((item) => item.id === graphic.trackId);
    const clip = track && project.tracks.flatMap((item) => item.clips).find((item) => item.id === track.clipId);
    if (!track || !clip) return [];
    return track.points.flatMap((point, index) => {
      if (point.status === "lost") return [];
      const start = Math.max(graphic.timelineStart, clip.timelineStart + point.time);
      const nextTime = track.points[index + 1]?.time ?? point.time + 1 / track.analysisFps;
      const end = Math.min(graphic.timelineStart + graphic.duration, clip.timelineStart + nextTime);
      if (end <= start) return [];
      const safeMargin = 40;
      const unclampedX = (point.rect.x + point.rect.width + graphic.offsetX) * project.width;
      const unclampedY = (point.rect.y + graphic.offsetY) * project.height;
      const maxX = Math.max(safeMargin, project.width - graphic.width * project.width - safeMargin);
      const maxY = Math.max(safeMargin, project.height - graphic.fontSize * 2 - safeMargin);
      const x = Math.min(maxX, Math.max(safeMargin, unclampedX));
      const y = Math.min(maxY, Math.max(safeMargin, unclampedY));
      return [`Dialogue: 1,${assTime(start)},${assTime(end)},Motion,,0,0,0,,${graphicOverrides(graphic, x, y, false, bundledFaces)}${text}`];
    });
  });
}

function motionGraphicV2Events(project: EditProject, graphic: MotionGraphic, bundledFaces: boolean): string[] {
  if (!bundledFaces) throw new Error("v2 動態文字輸出需要已驗證的內建字型，不能改用未驗證替代字型");
  const layout = motionGraphicV2LayoutReceipt(project, graphic);
  const startFrame = Math.round(graphic.timelineStart * project.fps);
  const durationFrames = Math.max(1, Math.round(graphic.duration * project.fps));
  assMotionFrameTime(startFrame, project.fps);
  const events = [`; MotionCompositionV2Receipt: ${graphic.id},${layout.receiptId},${durationFrames}`];
  const face = assFace(graphic.fontFamily ?? "Noto Sans TC", graphic.fontWeight ?? 700, bundledFaces);
  const font = `\\fn${assFontName(face.fontFamily)}`;
  const weight = `\\b${face.fontWeight}`;
  const spacing = `\\fsp${Math.round(graphic.letterSpacing ?? 0)}`;
  const panel = motionPanelPaths(layout.box.width, layout.box.height, graphic.cornerRadius ?? 10, graphic.outlineWidth ?? 2);
  const shadow = Math.round(graphic.shadowDepth ?? 2);
  const metrics = bundledFontAssMetrics(graphic.fontFamily ?? "Noto Sans TC", graphic.fontWeight ?? 700, layout.fontSize, layout.lineHeight);
  const segmentById = new Map(layout.segments.map((segment) => [segment.id, segment]));
  for (let localFrame = 0; localFrame < durationFrames; localFrame += 1) {
    const timelineFrame = startFrame + localFrame;
    const frame = motionGraphicV2FrameReceipt(project, graphic, timelineFrame, layout);
    const start = assMotionFrameTime(timelineFrame, project.fps);
    const end = assMotionFrameTime(timelineFrame + 1, project.fps);
    if (frame.backgroundOpacity > .001) {
      const box = layout.box;
      const drawing = `{\\an7\\pos(${roundAss(box.x)},${roundAss(box.y)})\\p1\\bord0\\shad0${assOverrideColor(graphic.backgroundColor, 1, frame.backgroundOpacity)}}${panel.fillAss}{\\p0}`;
      events.push(`Dialogue: 1,${start},${end},Motion,,0,0,0,,${drawing}`);
      if (panel.borderAss) {
        // CSS border-box strokes occupy the inside edge, not glyph contours.
        events.push(`Dialogue: 1,${start},${end},Motion,,0,0,0,,{\\an7\\pos(${roundAss(box.x)},${roundAss(box.y)})\\p1\\bord0\\shad0${assOverrideColor(graphic.accentColor, 1, frame.backgroundOpacity)}}${panel.borderAss}{\\p0}`);
      }
    }
    for (const state of frame.segments) {
      if (state.opacity <= .001) continue;
      const segment = segmentById.get(state.segmentId)!;
      const x = segment.x + state.translateXPixels;
      const y = segment.y + state.translateYPixels + metrics.topOffset * state.scale;
      const scale = Math.max(1, Math.round(state.scale * 100));
      const overrides = `{\\an7\\q2${font}${weight}${spacing}\\fs${roundAss(metrics.fontSize)}\\fscx${scale}\\fscy${scale}${assOverrideColor(graphic.textColor, 1, state.opacity)}${assOverrideColor(graphic.accentColor, 3, state.opacity)}${assOverrideColor(graphic.accentColor, 4, state.opacity)}\\bord0\\shad${shadow}\\pos(${roundAss(x)},${roundAss(y)})}`;
      events.push(`Dialogue: 2,${start},${end},Motion,,0,0,0,,${overrides}${assText(segment.text)}`);
    }
  }
  return events;
}

export function writeAssContent(project: EditProject, style: CaptionStyle, options: { bundledFaces?: boolean } = {}): string {
  const bundledFaces = options.bundledFaces !== false;
  const primary = assFace(style.fontFamily, style.bold ? 800 : 400, bundledFaces);
  const secondary = assFace(style.translationFontFamily, style.translationBold ? 800 : 400, bundledFaces);
  const events = project.captions.map((caption) => {
    const translation = caption.translation?.text.trim()
      ? `\\N{\\fn${assFontName(secondary.fontFamily)}\\fs${Math.round(style.translationFontSize)}${assOverrideColor(style.translationColor, 1, 1)}\\b${secondary.fontWeight}\\i${style.translationItalic ? 1 : 0}}${assText(caption.translation.text)}`
      : "";
    return `Dialogue: 0,${assTime(caption.start)},${assTime(caption.start + caption.duration)},Default,,0,0,0,,{\\fn${assFontName(primary.fontFamily)}\\b${primary.fontWeight}}${assText(caption.text)}${translation}`;
  }).concat(motionGraphicEvents(project, bundledFaces));
  const backgroundVisible = /^#[0-9a-f]{6}$/i.test(style.backgroundColor)
    || (/^#[0-9a-f]{8}$/i.test(style.backgroundColor) && style.backgroundColor.slice(7, 9).toUpperCase() !== "00");
  return [
    "[Script Info]", "ScriptType: v4.00+", `PlayResX: ${project.width}`, `PlayResY: ${project.height}`,
    // These colors are authored as RGB, not legacy video-matched ASS colors.
    // FFmpeg otherwise assumes BT.601 limited: RGB white becomes 235 and
    // black becomes 16; Rec.709 inputs also receive the wrong chroma matrix.
    // None means use the actual compositing input's matrix AND range.
    "YCbCr Matrix: None",
    "WrapStyle: 0", "ScaledBorderAndShadow: yes", "", "[V4+ Styles]",
    "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
    // libass BorderStyle 3 paints the box with OutlineColour. BackColour is
    // the shadow channel, so an opaque outline would make a translucent panel
    // appear solid black even when backgroundColor carries alpha.
    `Style: Default,${assFontName(primary.fontFamily)},${style.fontSize},${assColor(style.color)},${assColor(style.color)},${assColor(backgroundVisible ? style.backgroundColor : style.outlineColor)},${assColor(style.backgroundColor)},0,${style.italic ? -1 : 0},0,0,100,100,${style.letterSpacing},0,${backgroundVisible ? 3 : 1},${style.outlineWidth},${style.shadow},${style.alignment},40,40,${style.marginV},1`,
    // Motion events supply their own panel/outline colors. Subtitle opaque-box
    // styling must never turn an accent outline into a filled glyph rectangle.
    `Style: Motion,${assFontName(primary.fontFamily)},${style.fontSize},${assColor(style.color)},${assColor(style.color)},${assColor(style.outlineColor)},${assColor(style.backgroundColor)},0,${style.italic ? -1 : 0},0,0,100,100,${style.letterSpacing},0,1,${style.outlineWidth},${style.shadow},${style.alignment},40,40,${style.marginV},1`,
    "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text", ...events, "",
  ].join("\n");
}

function escapeFilterPath(path: string): string {
  // The filtergraph parser runs before the option-value parser; preserve the
  // latter's escapes through the former. These are FFmpeg escapes, not shell escapes.
  const option = path.replaceAll("\\", "/").replace(/[\\':\s]/g, "\\$&");
  return option.replace(/[\\'\[\],;\s]/g, "\\$&");
}

export function buildAssFilter(assPath: string, fontRoot?: string): string {
  const fonts = fontRoot ? `:fontsdir=${escapeFilterPath(fontRoot)}` : "";
  return `subtitles=filename=${escapeFilterPath(assPath)}${fonts}:wrap_unicode=1`;
}
