import type { CSSProperties, ReactNode } from "react";
import type { CaptionCue, CaptionStyle } from "../domain/types";
import { captionColorParts, captionPreviewText, captionPreviewTranslationText, captionRenderModel, type CaptionFaceLayout } from "../render/captionLayout";
import { cssFontFamily } from "../typography/fontFaces";
import { translateUi as uiText } from "./i18n/interfacePreferences";
import "./captionPreview.css";

type CaptionPaint = "shadow-box" | "box" | "shadow" | "rim" | "fill";

export interface PreviewCaptionProps {
  caption: CaptionCue;
  style: CaptionStyle;
  projectWidth: number;
  projectHeight: number;
}

/**
 * The caption exactly as the export burns it in, drawn the way libass draws it (render/captionLayout): the
 * export's lines and glyphs, the ASS size as its CSS em, libass line boxes and margins, and the drop shadow,
 * soft outline or per-line box as stacked copies of the same text under a sharp fill, so `\blur` becomes a
 * Gaussian of the same σ. Decorative copies are aria-hidden; the top copy is the readable caption.
 */
export function PreviewCaption({ caption, style, projectWidth, projectHeight }: PreviewCaptionProps) {
  const model = captionRenderModel(style);
  // Sizes are canvas pixels; the stage is the query container, so dock/sidebar resizing cannot enlarge text.
  const unit = (pixels: number) => `${pixels / projectWidth * 100}cqw`;
  // The export's lines and glyphs, wrapped where libass wraps: the same text the native preview receives.
  const primaryText = captionPreviewText(caption.text, style, projectWidth);
  const translationText = caption.translation?.text.trim() ? captionPreviewTranslationText(caption.translation.text, style, projectWidth) : undefined;
  const margin = `${model.marginV / projectHeight * 100}%`;
  const vertical: CSSProperties = model.alignment >= 7 ? { top: margin, bottom: "auto", transform: "none" }
    : model.alignment >= 4 ? { top: "50%", bottom: "auto", transform: "translateY(-50%)" }
      : { top: "auto", bottom: margin, transform: "none" };
  const outline = captionColorParts(model.outlineColor);
  const shadow = model.shadow ? captionColorParts(model.shadow.color) : undefined;
  const box = model.box ? captionColorParts(model.box.color) : undefined;
  const blur = model.edgeBlurSigma > 0 ? `blur(${unit(model.edgeBlurSigma)})` : undefined;
  const shift = model.shadow ? `translate(${unit(model.shadow.offset)}, ${unit(model.shadow.offset)})` : undefined;
  const paints: CaptionPaint[] = model.box
    ? [...(shadow ? ["shadow-box" as const] : []), "box", "fill"]
    : [...(shadow ? ["shadow" as const] : []), ...(model.borderWidth > 0 && outline.alpha > 0 ? ["rim" as const] : []), "fill"];

  const layerStyle = (paint: CaptionPaint): CSSProperties | undefined => {
    if (paint === "shadow" || paint === "shadow-box") return { opacity: shadow!.alpha, transform: shift, filter: paint === "shadow" ? blur : undefined };
    if (paint === "rim") return { opacity: outline.alpha, filter: blur };
    if (paint === "box") return { opacity: box!.alpha };
    return undefined;
  };
  // A copy of the glyphs dilated by the border (a centred, round-joined stroke twice as wide, like libass's
  // stroker), in an opaque colour whose alpha the layer carries, so overlapping strokes and fills never darken twice.
  const dilated = (color: string): CSSProperties => ({
    color, WebkitTextStrokeColor: color, WebkitTextStrokeWidth: unit(2 * model.borderWidth), paintOrder: "stroke fill", strokeLinejoin: "round",
  });
  const block = (paint: CaptionPaint, text: string, face: CaptionFaceLayout, italic: boolean, fillColor: string, translation?: CaptionCue["translation"]): ReactNode => {
    const typography: CSSProperties = {
      fontFamily: cssFontFamily(face.family), fontWeight: face.weight, fontSynthesis: "style", fontStyle: italic ? "italic" : "normal",
      fontSize: unit(face.emSize), lineHeight: unit(face.lineHeight), letterSpacing: unit(model.letterSpacing),
    };
    const className = translation ? "preview-caption-translation" : "preview-caption-primary";
    if (paint === "box" || paint === "shadow-box") {
      // libass BorderStyle 3: one box per line, padded on every side; the spread keeps line breaks untouched.
      const color = paint === "box" ? box!.rgb : shadow!.rgb;
      return <span className={className} style={{ ...typography, color: "transparent" }}><span className="preview-caption-box" style={{
        backgroundColor: color, boxShadow: `0 0 0 ${unit(model.box!.padding)} ${color}` }}>{text}</span></span>;
    }
    if (paint === "shadow") return <span className={className} style={{ ...typography, ...dilated(shadow!.rgb) }}>{text}</span>;
    if (paint === "rim") return <span className={className} style={{ ...typography, ...dilated(outline.rgb) }}>{text}</span>;
    const substituted = face.weightSubstituted;
    return <span className={className} lang={translation?.language} data-testid={translation ? "preview-caption-translation" : undefined}
      data-font-weight-substituted={substituted} title={substituted ? uiText("字重 {value0} → {value1}", { value0: String(face.requestedWeight), value1: String(face.weight) }) : undefined}
      style={{ ...typography, color: fillColor }}>{text}</span>;
  };

  return (
    <div className="preview-caption" data-testid="preview-caption" data-caption-metrics={model.primary.metrics} style={{
      left: `${model.sideMargin / projectWidth * 100}%`, right: `${model.sideMargin / projectWidth * 100}%`,
      textAlign: model.alignment % 3 === 1 ? "left" : model.alignment % 3 === 0 ? "right" : "center", textShadow: "none", ...vertical,
    }}>
      {paints.map((paint) => (
        <div key={paint} className={`preview-caption-layer preview-caption-${paint}`} aria-hidden={paint === "fill" ? undefined : true} style={layerStyle(paint)}>
          {block(paint, primaryText, model.primary, style.italic, style.color)}
          {translationText !== undefined && block(paint, translationText, model.translation, style.translationItalic, style.translationColor, caption.translation)}
        </div>
      ))}
    </div>
  );
}
