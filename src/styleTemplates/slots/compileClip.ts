import { EditGraphError } from "../../domain/editGraphError";
import { motionLibraryClipSecondsV1, motionLibraryFrameCountV1, motionLibraryFrameRateV1 } from "../../domain/motionLibraryV1";
import { STYLE_JOB_SCHEMA_V1, type StyleImageSlotValueV1, type StyleJobClipV1, type StyleSlotValuesV1 } from "../../domain/styleJobFieldsV1";
import { STYLE_TEMPLATE_CLIP_ENGINE_VERSION_V1, styleJobCacheKeyV1, styleSlotsSha256V1 } from "../../domain/styleJobV1";
import { MotionLibraryGlyphError } from "../../motionLibrary/svg/glyphs";
import { styleClipComponentV1, type StyleClipComponentV1 } from "./components";
import { findStyleSlotTemplateV1, type StyleSlotTemplateV1 } from "./slotCatalog";
import { validateStyleSlotValuesV1, type StyleImageSlot, type StyleTemplateFormat } from "./slotSchema";
import type { SlotImageParams } from "./svgImage";

/**
 * Template + slot values + frame → the compiled component job of an editable template clip (browser-safe, pure).
 * The result carries the complete `styleJob` field; the renderer (renderTemplateClip.ts) turns it into the cache clip,
 * and add/update_style_template_clip bind it. Pictures enter as normalized derivatives (sha256 + size + mime), so the
 * key changes exactly when a slot changes: text, a colour, a picture, its fit or its focal point.
 */

export const STYLE_TEMPLATE_CLIP_REFUSAL_CODES = [
  "STYLE_TEMPLATE_UNKNOWN",
  "STYLE_TEMPLATE_NOT_IMPLEMENTED",
  "STYLE_TEMPLATE_FORMAT_UNSUPPORTED",
  "STYLE_TEMPLATE_DURATION_INVALID",
  "STYLE_TEMPLATE_IMAGE_MISSING",
  "STYLE_TEMPLATE_IMAGE_UNREADABLE",
  "STYLE_TEMPLATE_GLYPH_UNSUPPORTED",
] as const;
export type StyleTemplateClipRefusalCode = typeof STYLE_TEMPLATE_CLIP_REFUSAL_CODES[number];

export class StyleTemplateClipRefusalV1 extends EditGraphError {
  readonly code: StyleTemplateClipRefusalCode;
  constructor(code: StyleTemplateClipRefusalCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "StyleTemplateClipRefusalV1";
    this.code = code;
  }
}

export function styleTemplateFormatOf(width: number, height: number): StyleTemplateFormat {
  return height > width ? "portrait" : width > height ? "landscape" : "square";
}

/** The template, implemented and offered in this frame format. */
export function resolveSlotTemplateForClipV1(templateId: string, frame: { readonly width: number; readonly height: number }): { template: StyleSlotTemplateV1; component: StyleClipComponentV1 } {
  const template = findStyleSlotTemplateV1(templateId);
  if (!template) throw new StyleTemplateClipRefusalV1("STYLE_TEMPLATE_UNKNOWN", templateId);
  const component = styleClipComponentV1(template.clip.component.id);
  if (!template.implemented || !component || component.renderer !== template.clip.component.renderer || component.revision !== template.clip.component.revision) {
    throw new StyleTemplateClipRefusalV1("STYLE_TEMPLATE_NOT_IMPLEMENTED", `${template.id} needs ${template.clip.component.id} (${template.clip.component.renderer})${template.stub ? "; its art is still being made" : ""}`);
  }
  const format = styleTemplateFormatOf(frame.width, frame.height);
  if (!template.clip.formats.includes(format)) throw new StyleTemplateClipRefusalV1("STYLE_TEMPLATE_FORMAT_UNSUPPORTED", `${template.id} offers ${template.clip.formats.join(", ")}, not ${format}`);
  return { template, component };
}

/** The resolved framing of a picture slot value (slot defaults where the value is silent). */
export function slotImageFraming(slot: StyleImageSlot, value: StyleImageSlotValueV1): { fit: SlotImageParams["fit"]; focal: readonly [number, number] } {
  return { fit: value.fit ?? slot.fit, focal: value.focal ?? slot.focal };
}

export interface CompiledStyleTemplateClipV1 {
  readonly template: StyleSlotTemplateV1;
  readonly component: StyleClipComponentV1;
  readonly field: StyleJobClipV1;
  readonly durationSeconds: number;
}

// A 1×1 PNG: lets the glyph preflight draw a frame before the real picture exists.
const PREFLIGHT_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

export function compileStyleTemplateClipV1(input: {
  readonly templateId: string;
  readonly slots: unknown;
  readonly frame: { readonly width: number; readonly height: number; readonly fps: number };
  /** Default: the template clip's default length. */
  readonly durationSeconds?: number;
  /** Normalized derivative (sha256, size, mime) per filled image slot; fit and focal are resolved here. */
  readonly images: Readonly<Record<string, Pick<SlotImageParams, "sha256" | "width" | "height" | "mime">>>;
}): CompiledStyleTemplateClipV1 {
  const { template, component } = resolveSlotTemplateForClipV1(input.templateId, input.frame);
  const slots: StyleSlotValuesV1 = validateStyleSlotValuesV1(template, input.slots);
  const seconds = input.durationSeconds ?? template.clip.seconds.default;
  if (!Number.isFinite(seconds) || seconds < template.clip.seconds.min - 1e-9 || seconds > template.clip.seconds.max + 1e-9) {
    throw new StyleTemplateClipRefusalV1("STYLE_TEMPLATE_DURATION_INVALID", `${seconds}s is outside ${template.clip.seconds.min}–${template.clip.seconds.max}s`);
  }
  const rate = motionLibraryFrameRateV1(input.frame.fps);
  const frameCount = motionLibraryFrameCountV1(seconds, rate);
  const durationSeconds = motionLibraryClipSecondsV1(frameCount, rate);
  const images: Record<string, SlotImageParams> = {};
  for (const [slotId, value] of Object.entries(slots.image)) {
    const derivative = input.images[slotId];
    if (!derivative) throw new StyleTemplateClipRefusalV1("STYLE_TEMPLATE_IMAGE_MISSING", slotId);
    const declaration = template.slots.image.find(slot => slot.id === slotId)!;
    images[slotId] = { sha256: derivative.sha256, width: derivative.width, height: derivative.height, mime: derivative.mime, ...slotImageFraming(declaration, value) };
  }
  for (const slotId of Object.keys(input.images)) if (!slots.image[slotId]) throw new StyleTemplateClipRefusalV1("STYLE_TEMPLATE_IMAGE_MISSING", `${slotId} has a picture but no slot value`);
  let params: Record<string, unknown>;
  // Glyph preflight (every frame draws the same strings): a character the face cannot draw is refused before any render.
  // Composited components lay out every string they draw, in 2D and in 3D (the engine's extruded and banded text use the
  // same bundled faces); some already measure their type while building params.
  try {
    params = JSON.parse(JSON.stringify(component.build({ template, slots, frame: input.frame, durationSeconds, images }))) as Record<string, unknown>;
    if (component.composite) component.composite.preflight(params);
    else if (component.svgFrame) {
      const preflight = Object.fromEntries(Object.keys(images).map(slotId => [slotId, PREFLIGHT_PNG]));
      component.svgFrame(params, Math.min(durationSeconds * 0.6, durationSeconds - 1e-3), { images: preflight });
    }
  } catch (error) {
    if (error instanceof MotionLibraryGlyphError) throw new StyleTemplateClipRefusalV1("STYLE_TEMPLATE_GLYPH_UNSUPPORTED", error.message);
    throw error;
  }
  const slotsSha256 = styleSlotsSha256V1(slots);
  const head = {
    template: { id: template.id, revision: template.revision },
    component: { id: component.id, renderer: component.renderer, revision: component.revision },
    output: template.clip.output,
  } as const;
  const key = styleJobCacheKeyV1({ ...head, slotsSha256, params, frameCount, fps: rate.text, width: input.frame.width, height: input.frame.height });
  const field: StyleJobClipV1 = {
    schema: STYLE_JOB_SCHEMA_V1, ...head, engineVersion: STYLE_TEMPLATE_CLIP_ENGINE_VERSION_V1, slots, slotsSha256,
    job: { params, frameCount, fps: rate.text }, key,
  };
  return { template, component, field, durationSeconds };
}
