import * as z from "zod/v4";
import { EditGraphError } from "./editGraphError";

/**
 * Motion Library Phase 3 project fields (PHASE3_INTEGRATION_DESIGN §1). Additive: a clip or timeline transition
 * without `motionLibrary` parses, validates, saves and renders exactly as before.
 *
 * - A clip field marks an ordinary video clip whose asset is a rendered motion library cache clip
 *   (`<project media cache>/motionlib/<itemId>/<cacheKey>.mov`): ProRes 4444 with straight alpha for text,
 *   ProRes 422 HQ (opaque) for backgrounds.
 * - A transition field is required exactly when the transition kernel is "matte"; it names the rendered matte clip
 *   (`<cacheKey>.matte.mov`, matte in alpha) and the optional colour overlay (`<cacheKey>.overlay.mov`).
 *
 * `itemRevision` refines the design shape: the clip cache key includes the item's art revision, so a saved field
 * must record it or every later art revision would make its cache key impossible to recompute.
 *
 * This file imports zod only, so the shared schema and transition model can use it without loading the catalog.
 * Semantic validation (catalog schema, cache key, asset binding) lives in motionLibraryV1.ts.
 */
export const MOTION_LIBRARY_CLIP_SCHEMA_V1 = "editkin.motion-library-clip/v1" as const;

/** Stable refusal codes. Every message starts with the code, so a caller can branch without parsing prose. */
export const MOTION_LIBRARY_REFUSAL_CODES_V1 = [
  "MOTION_LIBRARY_FIELD_INVALID",
  "MOTION_LIBRARY_ITEM_UNKNOWN",
  "MOTION_LIBRARY_KIND_MISMATCH",
  "MOTION_LIBRARY_PARAMS_INVALID",
  "MOTION_LIBRARY_ENGINE_VERSION_STALE",
  "MOTION_LIBRARY_CACHE_KEY_MISMATCH",
  "MOTION_LIBRARY_ASSET_MISSING",
  "MOTION_LIBRARY_ASSET_NOT_VIDEO",
  "MOTION_LIBRARY_ASSET_BINDING_MISMATCH",
  "MOTION_LIBRARY_ASSET_DIMENSIONS_MISMATCH",
  "MOTION_LIBRARY_ASSET_FRAME_COUNT_MISMATCH",
  "MOTION_LIBRARY_ASSET_ALPHA_MISMATCH",
  "MOTION_LIBRARY_ASSET_COLOR_MISMATCH",
  "MOTION_LIBRARY_ASSET_CONFLICT",
  "MOTION_LIBRARY_TRACK_INVALID",
  "MOTION_LIBRARY_LAYER_ROLE_REFUSED",
  "MOTION_LIBRARY_CLIP_FIELD_REQUIRED",
  "MOTION_LIBRARY_UPDATE_STALE",
  "MOTION_LIBRARY_TRANSITION_DURATION_MISMATCH",
] as const;
export type MotionLibraryRefusalCodeV1 = typeof MOTION_LIBRARY_REFUSAL_CODES_V1[number];

export class MotionLibraryRefusalV1 extends EditGraphError {
  readonly code: MotionLibraryRefusalCodeV1;
  constructor(code: MotionLibraryRefusalCodeV1, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "MotionLibraryRefusalV1";
    this.code = code;
  }
}

const invalid = "MOTION_LIBRARY_FIELD_INVALID";
const itemId = z.string().regex(/^[TXB](?:0[1-9]|[1-7][0-9]|80)$/, invalid);
const cacheKey = z.string().regex(/^[a-f0-9]{64}$/, invalid);
const assetId = z.string().min(1, invalid).max(160, invalid).refine(value => value.trim() === value && !/[\u0000\r\n]/.test(value), invalid);
const common = {
  itemId,
  itemRevision: z.number().int(invalid).min(1, invalid).max(1_000_000, invalid),
  /** The fully resolved params (resolveMotionLibraryParams output); re-validated against the catalog schema. */
  params: z.record(z.string(), z.unknown()),
  engineVersion: z.string().regex(/^editkin\.motion-library-engine\/\d+\.\d+\.\d+$/, invalid),
  cacheKey,
};

export const motionLibraryClipV1Schema = z.strictObject({
  schema: z.literal(MOTION_LIBRARY_CLIP_SCHEMA_V1),
  kind: z.enum(["text", "background"]),
  ...common,
});
export type MotionLibraryClipV1 = z.infer<typeof motionLibraryClipV1Schema>;

export const timelineTransitionMotionLibraryV1Schema = z.strictObject({
  ...common,
  matteAssetId: assetId,
  overlayAssetId: assetId.optional(),
}).refine(value => value.overlayAssetId !== value.matteAssetId, invalid);
export type TimelineTransitionMotionLibraryV1 = z.infer<typeof timelineTransitionMotionLibraryV1Schema>;
