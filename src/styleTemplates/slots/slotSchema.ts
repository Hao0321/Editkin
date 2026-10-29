import { z } from "zod";
import { EditGraphError } from "../../domain/editGraphError";
import {
  STYLE_COMPONENT_ID_PATTERN_V1, STYLE_COMPONENT_RENDERERS_V1, STYLE_IMAGE_FITS_V1, STYLE_JOB_PALETTE_ROLES_V1, STYLE_SLOT_ID_PATTERN_V1, STYLE_TEMPLATE_ID_PATTERN_V1,
  styleSlotValuesV1Schema, type StyleSlotValuesV1,
} from "../../domain/styleJobFieldsV1";
import { UI_LOCALES } from "../../shared/uiLocaleContract";

/**
 * Editable slots of a style template (editkin.style-template/v1, additive): what a person or VA may change after a
 * template is applied — text, palette colours, pictures — and which component consumes each slot.
 *
 * Renderer-agnostic by design: a slot is bound to a component by id and to a named target inside it, with the kind of
 * consumer (`as`). An SVG component draws a text slot as glyph outlines (`svg_text`); a mesh3d component (S4/S7, built on
 * Editkin's mesh3d engine) extrudes it (`mesh_text_extruded`) or wraps it on a band (`mesh_text_band`). An image slot is an
 * SVG picture (`svg_image`) or a mesh texture (`mesh_texture`: a device screen, a band). A colour role is an SVG fill, a
 * material colour, a light colour or an emissive colour. Derived colours (text on the accent, glow cores…) follow the roles.
 *
 * Browser-safe (zod only). The values a clip stores (`TimelineClip.styleJob.slots`) are shape-checked by the domain
 * schema; validateStyleSlotValuesV1 checks them against these declarations: unknown slots, over-long or invalid text,
 * missing required text, invalid colours and invalid picture framing are refused with stable codes.
 */

export const STYLE_SLOT_TEXT_ROLES = ["display", "serif", "script", "body"] as const;
export type StyleSlotTextRole = typeof STYLE_SLOT_TEXT_ROLES[number];
export const STYLE_SLOT_TEXT_CONSUMERS = ["svg_text", "mesh_text_extruded", "mesh_text_band", "mesh_text_flat"] as const;
export const STYLE_SLOT_IMAGE_CONSUMERS = ["svg_image", "mesh_texture"] as const;
export const STYLE_SLOT_COLOR_CONSUMERS = ["svg_fill", "material_color", "light_color", "emissive_color"] as const;
export const STYLE_SLOT_IMAGE_PLACEHOLDERS = ["ui_panel", "paper", "none"] as const;
export const STYLE_TEMPLATE_FORMATS = ["portrait", "landscape", "square"] as const;
export type StyleTemplateFormat = typeof STYLE_TEMPLATE_FORMATS[number];

const label = z.string().min(1).max(80);
/** One label per UI language (the interface's five locales). */
export const styleSlotLabelSchema = z.strictObject(Object.fromEntries(UI_LOCALES.map(locale => [locale, label])) as Record<typeof UI_LOCALES[number], typeof label>);
export type StyleSlotLabel = z.infer<typeof styleSlotLabelSchema>;

const slotId = z.string().regex(STYLE_SLOT_ID_PATTERN_V1, "slot ids are camelCase, a letter first, at most 32");
const componentId = z.string().regex(STYLE_COMPONENT_ID_PATTERN_V1, "component ids are camelCase, 3–48");
const target = z.string().regex(/^[a-z][a-zA-Z0-9_.-]{0,63}$/, "binding targets are dotted names");
const binding = <T extends readonly [string, ...string[]]>(consumers: T) => z.strictObject({ component: componentId, target, as: z.enum(consumers) });
const unit = z.number().finite().min(0).max(1);
const ratio = z.number().finite().min(0.1).max(10);

export const styleTextSlotSchema = z.strictObject({
  id: slotId,
  label: styleSlotLabelSchema,
  /** User-perceived characters (grapheme clusters). The component still fits the line to its box. */
  maxLength: z.number().int().min(1).max(120),
  role: z.enum(STYLE_SLOT_TEXT_ROLES),
  /** A required slot must be filled with the creator's own words (M10: VA passes them with evidence; there is no sample fallback). */
  required: z.boolean(),
  bind: z.array(binding(STYLE_SLOT_TEXT_CONSUMERS)).min(1).max(6),
});
export const styleColorSlotSchema = z.strictObject({
  role: z.enum(STYLE_JOB_PALETTE_ROLES_V1),
  label: styleSlotLabelSchema,
  bind: z.array(binding(STYLE_SLOT_COLOR_CONSUMERS)).min(1).max(8),
});
export const styleImageSlotSchema = z.strictObject({
  id: slotId,
  label: styleSlotLabelSchema,
  /** The frame the picture fills (width ÷ height) per output format. */
  aspect: z.strictObject({ portrait: ratio, landscape: ratio, square: ratio.optional() }),
  fit: z.enum(STYLE_IMAGE_FITS_V1),
  focal: z.tuple([unit, unit]),
  /** Drawn when the slot is empty (S1's 「no screenshots → drawn UI panels」). */
  placeholder: z.enum(STYLE_SLOT_IMAGE_PLACEHOLDERS).optional(),
  required: z.boolean(),
  bind: z.array(binding(STYLE_SLOT_IMAGE_CONSUMERS)).min(1).max(4),
});
export type StyleTextSlot = z.infer<typeof styleTextSlotSchema>;
export type StyleColorSlot = z.infer<typeof styleColorSlotSchema>;
export type StyleImageSlot = z.infer<typeof styleImageSlotSchema>;

export const styleSlotsSchema = z.strictObject({
  text: z.array(styleTextSlotSchema).max(16),
  color: z.array(styleColorSlotSchema).max(STYLE_JOB_PALETTE_ROLES_V1.length),
  image: z.array(styleImageSlotSchema).max(6),
}).superRefine((slots, context) => {
  const ids = new Set<string>();
  for (const [kind, list] of [["text", slots.text], ["image", slots.image]] as const) {
    list.forEach((slot, index) => {
      if (ids.has(slot.id)) context.addIssue({ code: "custom", path: [kind, index, "id"], message: `duplicate slot id ${slot.id}` });
      ids.add(slot.id);
    });
  }
  const roles = new Set<string>();
  slots.color.forEach((slot, index) => {
    if (roles.has(slot.role)) context.addIssue({ code: "custom", path: ["color", index, "role"], message: `duplicate colour role ${slot.role}` });
    roles.add(slot.role);
  });
});
export type StyleSlots = z.infer<typeof styleSlotsSchema>;

const componentRef = z.strictObject({ id: componentId, renderer: z.enum(STYLE_COMPONENT_RENDERERS_V1), revision: z.number().int().min(1).max(1_000_000) });
export type StyleClipComponentRef = z.infer<typeof componentRef>;

/** The clip a template becomes on the timeline: its root component (and parts a slot may bind to), output and length. */
export const styleTemplateClipSchema = z.strictObject({
  component: componentRef,
  /** Further components the slots bind to (an S4 device screen and its extruded title, …). */
  parts: z.array(componentRef).max(8).optional(),
  output: z.enum(["alpha", "opaque"]),
  seconds: z.strictObject({ default: z.number().finite().min(0.5).max(120), min: z.number().finite().min(0.5).max(120), max: z.number().finite().min(0.5).max(120) })
    .refine(value => value.min <= value.default && value.default <= value.max, "seconds need min ≤ default ≤ max"),
  formats: z.array(z.enum(STYLE_TEMPLATE_FORMATS)).min(1).max(3),
});
export type StyleTemplateClip = z.infer<typeof styleTemplateClipSchema>;

/** Slot bindings may only name the clip's own components; every image slot declares an aspect for each format. */
export function styleSlotBindingIssues(slots: StyleSlots, clip: StyleTemplateClip): Array<{ path: Array<string | number>; message: string }> {
  const known = new Set([clip.component.id, ...(clip.parts ?? []).map(part => part.id)]);
  const issues: Array<{ path: Array<string | number>; message: string }> = [];
  if (known.size !== 1 + (clip.parts?.length ?? 0)) issues.push({ path: ["clip", "parts"], message: "component ids must be unique" });
  for (const kind of ["text", "color", "image"] as const) {
    (slots[kind] as ReadonlyArray<{ bind: ReadonlyArray<{ component: string }> }>).forEach((slot, index) => slot.bind.forEach((bind, at) => {
      if (!known.has(bind.component)) issues.push({ path: ["slots", kind, index, "bind", at, "component"], message: `${bind.component} is not a component of this template clip` });
    }));
  }
  if (clip.formats.includes("square")) slots.image.forEach((slot, index) => {
    if (slot.aspect.square === undefined) issues.push({ path: ["slots", "image", index, "aspect", "square"], message: "a square clip needs a square aspect" });
  });
  return issues;
}

const hex = z.string().regex(/^#[0-9A-Fa-f]{6}$/, "colours are #RRGGBB").transform(value => value.toUpperCase());
const names = z.strictObject({ zh: z.string().min(1), en: z.string().min(1) });

/**
 * A slot-only template (S4, S5, S7): its art is a clip component built from style frames, not the Phase-A token
 * document. `stub: true` declares slots ahead of the art (it lists in discovery, its slots export to VA, and prepare
 * refuses it); `stub: false` means its components render (slotCatalog checks they are registered). Art status is
 * "pending" until Hao approves the rendered look, then "certified" (auto-pickable); a stub can never be certified.
 */
export const styleTemplateStubSchemaV1 = z.strictObject({
  schema: z.literal("editkin.style-template/v1"),
  id: z.string().regex(STYLE_TEMPLATE_ID_PATTERN_V1),
  revision: z.number().int().min(1),
  stub: z.boolean(),
  names,
  reference: z.string().min(1),
  videoTypes: z.array(z.string().min(1)).min(1),
  /** Measured reference palette (STYLE_TEMPLATE_DESIGN §1.1); roles without a measurement stay unset. */
  palette: z.strictObject(Object.fromEntries(STYLE_JOB_PALETTE_ROLES_V1.map(role => [role, hex.optional()])) as Record<typeof STYLE_JOB_PALETTE_ROLES_V1[number], z.ZodOptional<typeof hex>>),
  /** Where the art will come from. */
  art: z.strictObject({ styleframes: z.string().min(1), engine: z.string().min(1) }),
  slots: styleSlotsSchema,
  clip: styleTemplateClipSchema,
  artStatus: z.enum(["pending", "certified"]),
  notes: z.string().optional(),
}).superRefine((value, context) => {
  for (const issue of styleSlotBindingIssues(value.slots, value.clip)) context.addIssue({ code: "custom", ...issue });
  if (value.stub && value.artStatus !== "pending") context.addIssue({ code: "custom", path: ["artStatus"], message: "a stub (slots ahead of the art) stays pending" });
});
export type StyleTemplateStubV1 = z.output<typeof styleTemplateStubSchemaV1>;
/** The same schema under its accurate name (a slot-only template, stub or built). */
export const styleTemplateSlotOnlySchemaV1 = styleTemplateStubSchemaV1;

// ---------------------------------------------------------------------------
// Values against declarations
// ---------------------------------------------------------------------------

export const STYLE_SLOT_REFUSAL_CODES = [
  "STYLE_SLOT_VALUES_INVALID",
  "STYLE_SLOT_UNKNOWN",
  "STYLE_SLOT_TEXT_TOO_LONG",
  "STYLE_SLOT_TEXT_INVALID",
  "STYLE_SLOT_TEXT_REQUIRED",
  "STYLE_SLOT_COLOR_INVALID",
  "STYLE_SLOT_IMAGE_INVALID",
  "STYLE_SLOT_IMAGE_REQUIRED",
] as const;
export type StyleSlotRefusalCode = typeof STYLE_SLOT_REFUSAL_CODES[number];

export class StyleSlotRefusalV1 extends EditGraphError {
  readonly code: StyleSlotRefusalCode;
  constructor(code: StyleSlotRefusalCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "StyleSlotRefusalV1";
    this.code = code;
  }
}

let segmenter: Intl.Segmenter | undefined | null;
/** User-perceived characters (grapheme clusters; code points where Intl.Segmenter is missing). */
export function styleSlotTextLength(text: string): number {
  if (segmenter === undefined) segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter("und", { granularity: "grapheme" }) : null;
  if (!segmenter) return [...text].length;
  let count = 0;
  for (const _ of segmenter.segment(text)) count += 1;
  return count;
}

/** Characters a single-line slot cannot hold: controls, line and paragraph separators, BOM. */
const INVALID_TEXT = /[\u0000-\u001F\u007F-\u009F\u2028\u2029\uFEFF]/;

export interface StyleSlotDeclarations { readonly slots: StyleSlots }

/**
 * Checks values against a template's declarations and returns them in canonical form (NFC text with surrounding
 * spaces trimmed, empty optional text dropped, upper-case colours, defaults left implicit). `requireRequired` (default
 * true) refuses an empty required text slot.
 */
export function validateStyleSlotValuesV1(template: StyleSlotDeclarations, input: unknown, options: { requireRequired?: boolean } = {}): StyleSlotValuesV1 {
  const raw = input && typeof input === "object" ? input as Partial<Record<"text" | "color" | "image", unknown>> : {};
  const shaped = { text: raw.text ?? {}, color: raw.color ?? {}, image: raw.image ?? {} };
  for (const [kind, value] of Object.entries(shaped)) if (!value || typeof value !== "object" || Array.isArray(value)) throw new StyleSlotRefusalV1("STYLE_SLOT_VALUES_INVALID", kind);
  const text: Record<string, string> = {};
  for (const [id, value] of Object.entries(shaped.text as Record<string, unknown>)) {
    const slot = template.slots.text.find(candidate => candidate.id === id);
    if (!slot) throw new StyleSlotRefusalV1("STYLE_SLOT_UNKNOWN", `text slot ${id}`);
    if (typeof value !== "string") throw new StyleSlotRefusalV1("STYLE_SLOT_TEXT_INVALID", `${id} is not text`);
    const normalized = value.normalize("NFC").trim();
    if (INVALID_TEXT.test(normalized)) throw new StyleSlotRefusalV1("STYLE_SLOT_TEXT_INVALID", `${id} holds one line without control characters`);
    const length = styleSlotTextLength(normalized);
    if (length > slot.maxLength) throw new StyleSlotRefusalV1("STYLE_SLOT_TEXT_TOO_LONG", `${id}: ${length} > ${slot.maxLength}`);
    if (normalized) text[id] = normalized;
  }
  if (options.requireRequired !== false) {
    for (const slot of template.slots.text) if (slot.required && !text[slot.id]) throw new StyleSlotRefusalV1("STYLE_SLOT_TEXT_REQUIRED", slot.id);
  }
  const color: Record<string, string> = {};
  for (const [role, value] of Object.entries(shaped.color as Record<string, unknown>)) {
    if (!template.slots.color.some(slot => slot.role === role)) throw new StyleSlotRefusalV1("STYLE_SLOT_UNKNOWN", `colour role ${role}`);
    if (typeof value !== "string" || !/^#[0-9A-Fa-f]{6}$/.test(value)) throw new StyleSlotRefusalV1("STYLE_SLOT_COLOR_INVALID", `${role}: ${String(value)}`);
    color[role] = value.toUpperCase();
  }
  const image: Record<string, unknown> = {};
  for (const [id, value] of Object.entries(shaped.image as Record<string, unknown>)) {
    if (!template.slots.image.some(candidate => candidate.id === id)) throw new StyleSlotRefusalV1("STYLE_SLOT_UNKNOWN", `image slot ${id}`);
    image[id] = value;
  }
  if (options.requireRequired !== false) {
    for (const slot of template.slots.image) if (slot.required && !image[slot.id]) throw new StyleSlotRefusalV1("STYLE_SLOT_IMAGE_REQUIRED", slot.id);
  }
  const parsed = styleSlotValuesV1Schema.safeParse({ text, color, image });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const kind = String(issue?.path[0] ?? "");
    throw new StyleSlotRefusalV1(kind === "image" ? "STYLE_SLOT_IMAGE_INVALID" : kind === "color" ? "STYLE_SLOT_COLOR_INVALID" : "STYLE_SLOT_VALUES_INVALID",
      issue ? `${issue.path.join(".")}: ${issue.message}` : undefined);
  }
  return parsed.data;
}

/** The label in a UI language (zh-TW when the locale is unknown). */
export function styleSlotLabel(labelValue: StyleSlotLabel, locale: string): string {
  return (labelValue as Record<string, string>)[locale] ?? labelValue["zh-TW"];
}
