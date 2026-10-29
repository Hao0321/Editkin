import * as z from "zod/v4";
import { EditGraphError } from "./editGraphError";

/**
 * Editable style-template clips (Hao 2026-10-23: 「要都能改字改色改圖」): the optional `TimelineClip.styleJob` field.
 * Additive: a clip without `styleJob` parses, validates, saves and renders exactly as before (the 125 saved projects
 * carry none; see styleTemplates/slots/savedProjectIdentity.test.ts).
 *
 * The field marks an ordinary video clip whose asset is a rendered template clip
 * (`<project media cache>/styletpl-clip/<templateId>/<key>.mov`) and keeps everything needed to edit and re-render it:
 * - `template`: the style template id and revision the clip was compiled from;
 * - `component`: the clip component that consumed the slots (renderer-agnostic: `svg` today, `mesh3d` for the 3D
 *   templates S4/S7), with its own revision;
 * - `slots`: what the person (or VA) chose — text per text slot, palette-role overrides, image slot sources;
 * - `job`: the compiled component job (fully resolved params, frame count, frame rate) the clip was rendered from;
 * - `key`: sha256 over everything that changes output bytes (the slot hash included), so an unchanged slot set is a
 *   cache hit and a changed one is a new file.
 *
 * Zod only (browser-safe). Semantic validation (key, asset binding, image sources) lives in styleJobV1.ts; the slot
 * declarations a value must satisfy live with the templates (styleTemplates/slots/slotCatalog.ts).
 */
export const STYLE_JOB_SCHEMA_V1 = "editkin.style-job/v1" as const;

/** Stable refusal codes. Every message starts with the code. */
export const STYLE_JOB_REFUSAL_CODES_V1 = [
  "STYLE_JOB_FIELD_INVALID",
  "STYLE_JOB_FIELD_REQUIRED",
  "STYLE_JOB_ENGINE_VERSION_STALE",
  "STYLE_JOB_SLOTS_HASH_MISMATCH",
  "STYLE_JOB_FPS_MISMATCH",
  "STYLE_JOB_CACHE_KEY_MISMATCH",
  "STYLE_JOB_ASSET_MISSING",
  "STYLE_JOB_ASSET_NOT_VIDEO",
  "STYLE_JOB_ASSET_BINDING_MISMATCH",
  "STYLE_JOB_ASSET_DIMENSIONS_MISMATCH",
  "STYLE_JOB_ASSET_FRAME_COUNT_MISMATCH",
  "STYLE_JOB_ASSET_ALPHA_MISMATCH",
  "STYLE_JOB_ASSET_CONFLICT",
  "STYLE_JOB_SLOT_ASSET_MISSING",
  "STYLE_JOB_SLOT_ASSET_KIND",
  "STYLE_JOB_SLOT_ASSET_TIME",
  "STYLE_JOB_TRACK_INVALID",
  "STYLE_JOB_LAYER_ROLE_REFUSED",
  "STYLE_JOB_UPDATE_STALE",
  "STYLE_JOB_TEMPLATE_MISMATCH",
  "STYLE_JOB_TEMPLATE_UNKNOWN",
  "STYLE_JOB_COMPONENT_NOT_IMPLEMENTED",
] as const;
export type StyleJobRefusalCodeV1 = typeof STYLE_JOB_REFUSAL_CODES_V1[number];

export class StyleJobRefusalV1 extends EditGraphError {
  readonly code: StyleJobRefusalCodeV1;
  constructor(code: StyleJobRefusalCodeV1, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "StyleJobRefusalV1";
    this.code = code;
  }
}

const invalid = "STYLE_JOB_FIELD_INVALID";
const sha256 = z.string().regex(/^[a-f0-9]{64}$/, invalid);
const assetId = z.string().min(1, invalid).max(160, invalid).refine(value => value.trim() === value && !/[\u0000\r\n]/.test(value), invalid);
const unit = z.number().finite().min(0, invalid).max(1, invalid);

/** Palette roles a template may expose as colour slots (styleTemplates/types.ts STYLE_PALETTE_ROLES, pinned equal by test). */
export const STYLE_JOB_PALETTE_ROLES_V1 = ["bg", "ink", "paper", "accent", "accent2", "highlight", "script"] as const;
/** Slot ids: a letter, then letters/digits (camelCase), at most 32. */
export const STYLE_SLOT_ID_PATTERN_V1 = /^[a-z][a-zA-Z0-9]{0,31}$/;
/** Template ids (styleTemplates/types.ts). */
export const STYLE_TEMPLATE_ID_PATTERN_V1 = /^[SH][0-9]+_[a-z0-9_]+$/;
/** Clip component ids (renderer-agnostic: uiCardScene, mesh3dDeviceScreen, …). */
export const STYLE_COMPONENT_ID_PATTERN_V1 = /^[a-z][a-zA-Z0-9]{2,47}$/;
export const STYLE_COMPONENT_RENDERERS_V1 = ["svg", "mesh3d"] as const;
export type StyleComponentRendererV1 = typeof STYLE_COMPONENT_RENDERERS_V1[number];
export const STYLE_IMAGE_FITS_V1 = ["cover", "contain"] as const;
export type StyleImageFitV1 = typeof STYLE_IMAGE_FITS_V1[number];

const slotId = z.string().regex(STYLE_SLOT_ID_PATTERN_V1, invalid);
/** Stored colours are canonical: #RRGGBB, upper case (so equal choices give equal keys). */
export const styleSlotColorV1Schema = z.string().regex(/^#[0-9A-F]{6}$/, invalid);

/**
 * An image slot value: where the picture comes from (rights and provenance follow that project asset), plus how it
 * sits in its frame. An imported image file is imported as a project asset first (the add/update command can carry it).
 */
export const styleImageSlotValueV1Schema = z.strictObject({
  source: z.discriminatedUnion("kind", [
    /** A project image asset (an imported image file, a screenshot, a still already in the project). */
    z.strictObject({ kind: z.literal("asset"), assetId }),
    /** One frame of a project video asset at a source time (s, from the start of the media). */
    z.strictObject({ kind: z.literal("still"), assetId, time: z.number().finite().min(0, invalid).max(86_400, invalid) }),
  ]),
  /** cover fills the frame (cropped about the focal point); contain shows the whole picture. Default: the slot's. */
  fit: z.enum(STYLE_IMAGE_FITS_V1).optional(),
  /** The point of the picture (0..1, y down) kept in view by cover and punch-ins. Default: the slot's. */
  focal: z.tuple([unit, unit]).optional(),
  /** Optional source crop [x0, y0, x1, y1] (0..1) applied before the fit. */
  crop: z.tuple([unit, unit, unit, unit]).refine(([x0, y0, x1, y1]) => x1 - x0 >= 0.01 && y1 - y0 >= 0.01, invalid).optional(),
});
export type StyleImageSlotValueV1 = z.infer<typeof styleImageSlotValueV1Schema>;

/** What the person (or VA) chose. Shape only; the template's declarations decide which ids and lengths are allowed. */
export const styleSlotValuesV1Schema = z.strictObject({
  text: z.record(slotId, z.string().max(400, invalid)),
  /** Palette-role overrides; a role that is absent follows the template (「恢復模板顏色」 deletes the key). */
  color: z.partialRecord(z.enum(STYLE_JOB_PALETTE_ROLES_V1), styleSlotColorV1Schema),
  image: z.record(slotId, styleImageSlotValueV1Schema),
});
export type StyleSlotValuesV1 = z.infer<typeof styleSlotValuesV1Schema>;

export const styleJobClipV1Schema = z.strictObject({
  schema: z.literal(STYLE_JOB_SCHEMA_V1),
  template: z.strictObject({ id: z.string().regex(STYLE_TEMPLATE_ID_PATTERN_V1, invalid), revision: z.number().int(invalid).min(1, invalid).max(1_000_000, invalid) }),
  component: z.strictObject({
    id: z.string().regex(STYLE_COMPONENT_ID_PATTERN_V1, invalid),
    renderer: z.enum(STYLE_COMPONENT_RENDERERS_V1),
    revision: z.number().int(invalid).min(1, invalid).max(1_000_000, invalid),
  }),
  engineVersion: z.string().regex(/^editkin\.style-template-clip-engine\/\d+\.\d+\.\d+$/, invalid),
  /** alpha: ProRes 4444 straight alpha; opaque: ProRes 422 HQ. */
  output: z.enum(["alpha", "opaque"]),
  slots: styleSlotValuesV1Schema,
  /** sha256 of the canonical JSON of `slots`. */
  slotsSha256: sha256,
  /** The compiled component job: resolved params (renderer specific), frame count and frame rate ("num/den"). */
  job: z.strictObject({
    params: z.record(z.string(), z.unknown()),
    frameCount: z.number().int(invalid).min(1, invalid).max(1_000_000, invalid),
    fps: z.string().regex(/^[1-9][0-9]{0,6}\/[1-9][0-9]{0,4}$/, invalid),
  }),
  key: sha256,
});
export type StyleJobClipV1 = z.infer<typeof styleJobClipV1Schema>;
