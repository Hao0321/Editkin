import { animatedClipState } from "../domain/editGraph";
import type { EditProject, CaptionStyle } from "../domain/types";
import type { BrowserDraftClip } from "../application/browserDraftPlan";
import { combineLookColor, previewEffectFilter, previewTransitionState } from "../creative/corePack";
import { previewPrimaryFilter } from "../color/previewGrade";
import { cssFontFamily, resolveBundledFontFace } from "../typography/fontFaces";

export interface BrowserDraftMedia extends BrowserDraftClip {
  element: HTMLImageElement | HTMLMediaElement;
}

function captionFont(style: CaptionStyle, translation = false) {
  const family = translation ? style.translationFontFamily : style.fontFamily;
  const bold = translation ? style.translationBold : style.bold;
  const italic = translation ? style.translationItalic : style.italic;
  const size = translation ? style.translationFontSize : style.fontSize;
  const face = resolveBundledFontFace(family, bold ? 800 : 400);
  return `${italic ? "italic " : ""}${face?.fontWeight ?? (bold ? 800 : 400)} ${size}px ${cssFontFamily(face?.fontFamily ?? family)}`;
}

export async function loadBrowserDraftFonts(project: EditProject) {
  if (!project.captions.length) return;
  await Promise.all(project.captions.flatMap(caption => [
    document.fonts.load(captionFont(project.captionStyle), caption.text),
    ...(caption.translation ? [document.fonts.load(captionFont(project.captionStyle, true), caption.translation.text)] : []),
  ]));
}

function captionLines(ctx: CanvasRenderingContext2D, text: string, width: number): string[] {
  const lines: string[] = [];
  const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const { segment } of segments.segment(paragraph)) {
      if (line && ctx.measureText(line + segment).width > width) { lines.push(line); line = ""; }
      line += segment;
    }
    lines.push(line);
  }
  return lines;
}

function drawCaption(ctx: CanvasRenderingContext2D, project: EditProject, time: number) {
  const caption = project.captions.find(cue => time >= cue.start && time < cue.start + cue.duration);
  if (!caption) return;
  const style = project.captionStyle;
  ctx.save();
  ctx.font = captionFont(style);
  ctx.letterSpacing = `${style.letterSpacing}px`;
  const primary = captionLines(ctx, caption.text, project.width - 80);
  ctx.font = captionFont(style, true);
  ctx.letterSpacing = "0px";
  const translation = caption.translation ? captionLines(ctx, caption.translation.text, project.width - 80) : [];
  const lineHeight = style.fontSize * 1.25;
  const translationHeight = style.translationFontSize * 1.25;
  const height = primary.length * lineHeight + (translation.length ? 3 + translation.length * translationHeight : 0);
  const top = style.alignment >= 7 ? style.marginV : style.alignment >= 4 ? (project.height - height) / 2 : project.height - style.marginV - height;
  ctx.fillStyle = style.backgroundColor;
  ctx.fillRect(40, top, project.width - 80, height);
  ctx.textAlign = style.alignment % 3 === 1 ? "left" : style.alignment % 3 === 0 ? "right" : "center";
  ctx.textBaseline = "middle";
  const x = ctx.textAlign === "left" ? 40 : ctx.textAlign === "right" ? project.width - 40 : project.width / 2;
  ctx.lineJoin = "round";
  ctx.strokeStyle = style.outlineColor;
  ctx.lineWidth = style.outlineWidth * 2;
  ctx.shadowColor = "#000000aa";
  ctx.shadowBlur = style.shadow * 2;
  ctx.shadowOffsetY = style.shadow;
  const draw = (lines: string[], translated: boolean, y: number, step: number) => {
    ctx.font = captionFont(style, translated);
    ctx.letterSpacing = translated ? "0px" : `${style.letterSpacing}px`;
    ctx.fillStyle = translated ? style.translationColor : style.color;
    for (const line of lines) {
      if (style.outlineWidth > 0) ctx.strokeText(line, x, y + step / 2);
      ctx.fillText(line, x, y + step / 2);
      y += step;
    }
  };
  draw(primary, false, top, lineHeight);
  draw(translation, true, top + primary.length * lineHeight + 3, translationHeight);
  ctx.restore();
}

/** Display-referred, preview-grade composition only; never a native render receipt. */
export function drawBrowserDraftFrame(ctx: CanvasRenderingContext2D, project: EditProject, media: BrowserDraftMedia[], time: number) {
  const { width, height } = ctx.canvas;
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, width, height);
  ctx.save();
  ctx.scale(width / project.width, height / project.height);
  for (const { clip, kind, element } of media) {
    if (kind !== "video" || time < clip.timelineStart || time >= clip.timelineStart + clip.duration) continue;
    if (!(element instanceof HTMLVideoElement) && !(element instanceof HTMLImageElement)) continue;
    const sourceWidth = element instanceof HTMLVideoElement ? element.videoWidth : element.naturalWidth;
    const sourceHeight = element instanceof HTMLVideoElement ? element.videoHeight : element.naturalHeight;
    if (!sourceWidth || !sourceHeight) throw new Error("素材沒有可解碼的畫面；無法匯出草稿。");
    const localTime = time - clip.timelineStart;
    const { transform, color } = animatedClipState(clip, localTime, project.fps);
    const transition = previewTransitionState(clip, localTime);
    const viewport = clip.layout?.viewport ?? { x: 0, y: 0, width: 1, height: 1 };
    const w = viewport.width * project.width, h = viewport.height * project.height;
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, transform.opacity * transition.opacity));
    const blend = clip.layer?.blendMode ?? "normal";
    ctx.globalCompositeOperation = blend === "normal" ? "source-over" : blend === "add" ? "lighter" : blend.replaceAll("_", "-") as GlobalCompositeOperation;
    if ("filter" in ctx) ctx.filter = `${previewPrimaryFilter(combineLookColor(color, clip.creative?.lookPresetId))} brightness(${transition.brightness}) ${previewEffectFilter(clip.creative?.effectPresetIds ?? [])}`;
    ctx.translate((viewport.x + viewport.width / 2) * project.width + transform.x + transition.xPercent / 100 * project.width,
      (viewport.y + viewport.height / 2) * project.height + transform.y);
    ctx.rotate(transform.rotation * Math.PI / 180);
    ctx.scale(transform.scale * transition.scale, transform.scale * transition.scale);
    if (clip.layout) {
      const crop = clip.layout.crop;
      ctx.beginPath(); ctx.rect(-w / 2, -h / 2, w, h); ctx.clip();
      ctx.drawImage(element, crop.x * sourceWidth, crop.y * sourceHeight, crop.width * sourceWidth, crop.height * sourceHeight, -w / 2, -h / 2, w, h);
    } else {
      const fit = Math.min(w / sourceWidth, h / sourceHeight);
      ctx.drawImage(element, -sourceWidth * fit / 2, -sourceHeight * fit / 2, sourceWidth * fit, sourceHeight * fit);
    }
    ctx.restore();
  }
  drawCaption(ctx, project, time);
  ctx.restore();
  ctx.save();
  const size = Math.max(12, width / 65);
  ctx.font = `600 ${size}px sans-serif`;
  const label = "Editkin · DRAFT";
  const labelWidth = ctx.measureText(label).width;
  ctx.fillStyle = "#00000099";
  ctx.fillRect(width - labelWidth - 24, 8, labelWidth + 16, size + 12);
  ctx.fillStyle = "#ffffff";
  ctx.textBaseline = "top";
  ctx.fillText(label, width - labelWidth - 16, 14);
  ctx.restore();
}
