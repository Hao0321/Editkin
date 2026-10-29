import { canonicalJson } from "../shared/canonicalJson";
import { motionLibraryFontDigests } from "../motionLibrary/svg/glyphs";
import { motionLibraryClipSecondsV1, motionLibraryFrameRateV1, sha256HexV1 } from "./motionLibraryV1";
import { StyleJobRefusalV1, styleJobClipV1Schema, type StyleJobClipV1, type StyleSlotValuesV1 } from "./styleJobFieldsV1";
import type { MediaAsset, TimelineClip } from "./visualTypes";

/**
 * Semantic validation of `TimelineClip.styleJob` (styleJobFieldsV1.ts). Browser-safe and synchronous: validateProject
 * runs it for every clip that carries the field, exactly as it runs the Motion Library check.
 *
 * - the slot hash and the cache key re-compute from the stored slots and compiled job (whenever the field was rendered
 *   by the current clip engine; an older engine's field stays a truthful description of its file: "stale_engine");
 * - the job's frame rate is the owning container's;
 * - the asset is the rendered cache clip `<…>/styletpl-clip/<templateId>/<key>.mov` with the container's size, the job's
 *   frame count and the output's alpha mode;
 * - every image slot names a project asset of the right kind (an image, or a video for a still at a time inside it).
 *
 * The template catalogue is not consulted here: a saved project must keep opening after a template revision. Slot ids,
 * lengths and colours are checked against the current declarations when a command creates or updates the field.
 */

/** Bump when the clip renderer (frame generation, image derivatives, compositing or encoding) changes output bytes. */
export const STYLE_TEMPLATE_CLIP_ENGINE_VERSION_V1 = "editkin.style-template-clip-engine/1.0.0" as const;
export const STYLE_TEMPLATE_CLIP_CACHE_SCHEMA_V1 = "editkin.style-template-clip-cache/v1" as const;
export const STYLE_TEMPLATE_CLIP_ENCODE_PROFILE_V1 = "prores_ks/4444-yuva444p10le|422hq-yuv422p10le/bt709-tv/unpremultiplied/still-underlay/v1" as const;
/** Cache folder (under the project media cache) of rendered template clips. */
export const STYLE_TEMPLATE_CLIP_CACHE_DIRECTORY_V1 = "styletpl-clip" as const;
const EPSILON = 1e-6;

export type StyleJobFieldStatusV1 = "current" | "stale_engine";

export function styleSlotsSha256V1(slots: StyleSlotValuesV1): string {
  return sha256HexV1(canonicalJson(slots));
}

export interface StyleJobCacheKeyInputV1 {
  readonly template: StyleJobClipV1["template"];
  readonly component: StyleJobClipV1["component"];
  readonly output: StyleJobClipV1["output"];
  readonly slotsSha256: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly frameCount: number;
  readonly fps: string;
  readonly width: number;
  readonly height: number;
}

/** sha256 over everything that changes output bytes: engine, encode profile, template, component, slots, params, clock, size, fonts. */
export function styleJobCacheKeyV1(input: StyleJobCacheKeyInputV1): string {
  return sha256HexV1(canonicalJson({
    schema: STYLE_TEMPLATE_CLIP_CACHE_SCHEMA_V1, engineVersion: STYLE_TEMPLATE_CLIP_ENGINE_VERSION_V1, encodeProfile: STYLE_TEMPLATE_CLIP_ENCODE_PROFILE_V1,
    template: input.template, component: input.component, output: input.output, slotsSha256: input.slotsSha256, params: input.params,
    frameCount: input.frameCount, fps: input.fps, width: input.width, height: input.height, fonts: motionLibraryFontDigests(),
  }));
}

export function styleJobAssetFileNameV1(key: string): string {
  return `${key}.mov`;
}

export function parseStyleJobFieldV1(value: unknown): StyleJobClipV1 {
  if (value === undefined) throw new StyleJobRefusalV1("STYLE_JOB_FIELD_REQUIRED");
  const parsed = styleJobClipV1Schema.safeParse(value);
  if (!parsed.success) throw new StyleJobRefusalV1("STYLE_JOB_FIELD_INVALID", parsed.error.issues[0]?.path.join(".") || "styleJob");
  return parsed.data;
}

export function styleJobFieldStatusV1(field: { readonly engineVersion: string }): StyleJobFieldStatusV1 {
  return field.engineVersion === STYLE_TEMPLATE_CLIP_ENGINE_VERSION_V1 ? "current" : "stale_engine";
}

export interface StyleJobContainerV1 {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly assets: readonly MediaAsset[];
}

/** The asset must be the rendered cache clip `<…>/styletpl-clip/<templateId>/<key>.mov` with the expected geometry. */
export function assertStyleJobAssetV1(container: StyleJobContainerV1, field: StyleJobClipV1, assetId: string): MediaAsset {
  const asset = container.assets.find(candidate => candidate.id === assetId);
  if (!asset) throw new StyleJobRefusalV1("STYLE_JOB_ASSET_MISSING", assetId);
  if (asset.kind !== "video" || asset.compositionId !== undefined || asset.imageSequence !== undefined || asset.clipRetime !== undefined) {
    throw new StyleJobRefusalV1("STYLE_JOB_ASSET_NOT_VIDEO", asset.id);
  }
  const parts = asset.uri.split(/[\\/]+/);
  if (parts.at(-1) !== styleJobAssetFileNameV1(field.key) || parts.at(-2) !== field.template.id || parts.at(-3) !== STYLE_TEMPLATE_CLIP_CACHE_DIRECTORY_V1) {
    throw new StyleJobRefusalV1("STYLE_JOB_ASSET_BINDING_MISMATCH", `${asset.id} is not ${STYLE_TEMPLATE_CLIP_CACHE_DIRECTORY_V1}/${field.template.id}/${styleJobAssetFileNameV1(field.key)}`);
  }
  if (asset.width !== container.width || asset.height !== container.height) {
    throw new StyleJobRefusalV1("STYLE_JOB_ASSET_DIMENSIONS_MISMATCH", `${asset.id} is ${asset.width}x${asset.height}, expected ${container.width}x${container.height}`);
  }
  const rate = motionLibraryFrameRateV1(container.fps);
  if (!Number.isFinite(asset.duration) || Math.abs(asset.duration - motionLibraryClipSecondsV1(field.job.frameCount, rate)) > EPSILON) {
    throw new StyleJobRefusalV1("STYLE_JOB_ASSET_FRAME_COUNT_MISMATCH", `${asset.id} lasts ${asset.duration}s, expected ${field.job.frameCount} frames at ${rate.text}`);
  }
  const alphaMode = field.output === "alpha" ? "straight" : "opaque";
  if (asset.alphaMode !== alphaMode) throw new StyleJobRefusalV1("STYLE_JOB_ASSET_ALPHA_MISMATCH", `${asset.id} alphaMode ${String(asset.alphaMode)}, expected ${alphaMode}`);
  return asset;
}

/** Every image slot names a project image (or a project video and a time inside it). */
export function assertStyleJobSlotAssetsV1(assets: readonly MediaAsset[], slots: StyleSlotValuesV1): void {
  for (const [slot, value] of Object.entries(slots.image)) {
    const asset = assets.find(candidate => candidate.id === value.source.assetId);
    if (!asset) throw new StyleJobRefusalV1("STYLE_JOB_SLOT_ASSET_MISSING", `${slot}: ${value.source.assetId}`);
    if (asset.compositionId !== undefined || asset.imageSequence !== undefined) throw new StyleJobRefusalV1("STYLE_JOB_SLOT_ASSET_KIND", `${slot}: ${asset.id}`);
    if (value.source.kind === "asset" && asset.kind !== "image") throw new StyleJobRefusalV1("STYLE_JOB_SLOT_ASSET_KIND", `${slot}: ${asset.id} is ${asset.kind}, not an image`);
    if (value.source.kind === "still") {
      if (asset.kind !== "video") throw new StyleJobRefusalV1("STYLE_JOB_SLOT_ASSET_KIND", `${slot}: a still needs a video, ${asset.id} is ${asset.kind}`);
      if (!(value.source.time < asset.duration)) throw new StyleJobRefusalV1("STYLE_JOB_SLOT_ASSET_TIME", `${slot}: ${value.source.time}s is outside ${asset.id} (${asset.duration}s)`);
    }
  }
}

/** Validates a clip's `styleJob` field against its owning project or composition. Returns the field status. */
export function assertStyleJobClipV1(container: StyleJobContainerV1, trackKind: string, clip: TimelineClip): StyleJobFieldStatusV1 {
  const field = parseStyleJobFieldV1(clip.styleJob);
  if (trackKind !== "video") throw new StyleJobRefusalV1("STYLE_JOB_TRACK_INVALID", `${clip.id} is on a ${trackKind} track`);
  if ((clip.layer?.role ?? "content") !== "content") throw new StyleJobRefusalV1("STYLE_JOB_LAYER_ROLE_REFUSED", clip.id);
  if (styleSlotsSha256V1(field.slots) !== field.slotsSha256) throw new StyleJobRefusalV1("STYLE_JOB_SLOTS_HASH_MISMATCH", clip.id);
  const rate = motionLibraryFrameRateV1(container.fps);
  if (field.job.fps !== rate.text) throw new StyleJobRefusalV1("STYLE_JOB_FPS_MISMATCH", `${clip.id} was rendered at ${field.job.fps}, the timeline runs at ${rate.text}`);
  // Asset geometry first: after a canvas change the honest answer is "the render no longer fits", not "the key moved".
  assertStyleJobAssetV1(container, field, clip.assetId);
  assertStyleJobSlotAssetsV1(container.assets, field.slots);
  if (styleJobFieldStatusV1(field) === "stale_engine") return "stale_engine";
  const key = styleJobCacheKeyV1({ template: field.template, component: field.component, output: field.output, slotsSha256: field.slotsSha256,
    params: field.job.params, frameCount: field.job.frameCount, fps: field.job.fps, width: container.width, height: container.height });
  if (key !== field.key) throw new StyleJobRefusalV1("STYLE_JOB_CACHE_KEY_MISMATCH", `${clip.id}: ${field.template.id} r${field.template.revision}`);
  return "current";
}
