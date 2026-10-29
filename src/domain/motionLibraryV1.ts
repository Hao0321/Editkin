import { canonicalJson } from "../motionLibrary/params";
import { motionLibraryFontDigests } from "../motionLibrary/svg/glyphs";
import {
  MOTION_LIBRARY_ENGINE_VERSION,
  backgroundMotionParamsSchema,
  textMotionParamsSchema,
  transitionMotionParamsSchema,
  type MotionLibraryKind,
  type MotionLibraryParams,
} from "../motionLibrary/types";
import {
  MotionLibraryRefusalV1,
  motionLibraryClipV1Schema,
  timelineTransitionMotionLibraryV1Schema,
  type MotionLibraryClipV1,
  type TimelineTransitionMotionLibraryV1,
} from "./motionLibraryFieldsV1";
import type { TimelineTransition } from "./timelineTransitionV1";
import type { MediaAsset, TimelineClip } from "./visualTypes";

/**
 * Semantic validation of the Motion Library Phase 3 fields (PHASE3_INTEGRATION_DESIGN §1, PHASE3_CORE_BRIEF decision 4).
 * Browser-safe and synchronous: validateProject runs it for every clip and transition that carries the field.
 *
 * Checks, each with a stable refusal code (motionLibraryFieldsV1.ts):
 * - the item id names a registered item of the field's kind (T01–T80 text, X01–X40 transitions, B01–B40 backgrounds);
 * - the stored params re-validate against the catalog's params schema for that kind and are already fully resolved;
 * - the cache key re-computes (renderItem.ts motionLibraryCacheKey) from the stored item revision, params, the owning
 *   container's size and fps and the current fonts, whenever the field was rendered by the current engine;
 * - the referenced assets are the rendered cache clips for exactly that key, with matching size, frame count and alpha.
 *
 * A field rendered by an older engine version is still a truthful description of its cached clip, so it stays valid
 * (status "stale_engine": the cache key cannot be recomputed with this build's encode profile). Commands refuse to
 * create or update a field with anything but the current engine. The catalog itself (item implementations) is not
 * imported here: the domain stays light and the item id ranges are pinned to catalog.ts by test.
 */

/** Mirrors render/renderItem.ts (Node-only); pinned equal by test. */
export const MOTION_LIBRARY_CACHE_SCHEMA_V1 = "editkin.motion-library-cache/v2" as const;
export const MOTION_LIBRARY_ENCODE_PROFILE_V1 = "prores_ks/4444-yuva444p10le|422hq-yuv422p10le|h264-high-25M/bt709-tv/unpremultiplied/v1" as const;

const ITEM_PATTERNS: Readonly<Record<MotionLibraryKind, RegExp>> = {
  text: /^T(0[1-9]|[1-7][0-9]|80)$/,
  transition: /^X(0[1-9]|[1-3][0-9]|40)$/,
  background: /^B(0[1-9]|[1-3][0-9]|40)$/,
};
const EPSILON = 1e-6;

export function motionLibraryItemKindV1(itemId: string): MotionLibraryKind | undefined {
  return (Object.keys(ITEM_PATTERNS) as MotionLibraryKind[]).find(kind => ITEM_PATTERNS[kind].test(itemId));
}

// ---------------------------------------------------------------------------
// Frame clock (mirrors motionLibrary/frames.ts without importing it: frames.ts pulls the domain graph back in)
// ---------------------------------------------------------------------------

export interface MotionLibraryRateV1 { readonly numerator: number; readonly denominator: number; readonly text: string }

function gcd(left: number, right: number): number {
  let a = Math.abs(left), b = Math.abs(right);
  while (b) [a, b] = [b, a % b];
  return a || 1;
}

/** Same continued-fraction rule as clipAlphaPlan.rationalRate(value, 1001), which motionFrameRate uses. */
export function motionLibraryFrameRateV1(fps: number): MotionLibraryRateV1 {
  if (!Number.isFinite(fps) || fps <= 0) throw new MotionLibraryRefusalV1("MOTION_LIBRARY_FIELD_INVALID", "fps must be a positive number");
  let remainder = fps, previousNumerator = 0, numerator = 1, previousDenominator = 1, denominator = 0;
  for (;;) {
    const integer = Math.floor(remainder);
    const nextNumerator = integer * numerator + previousNumerator, nextDenominator = integer * denominator + previousDenominator;
    if (!Number.isSafeInteger(nextNumerator) || nextDenominator > 1001) break;
    previousNumerator = numerator; numerator = nextNumerator;
    previousDenominator = denominator; denominator = nextDenominator;
    const fraction = remainder - integer;
    if (fraction <= Number.EPSILON) break;
    remainder = 1 / fraction;
  }
  const divisor = gcd(numerator, denominator);
  const rate = { numerator: numerator / divisor, denominator: denominator / divisor };
  const value = rate.numerator / rate.denominator;
  if (!(value >= 1 && value <= 240)) throw new MotionLibraryRefusalV1("MOTION_LIBRARY_FIELD_INVALID", "fps must be within 1..240");
  return Object.freeze({ ...rate, text: `${rate.numerator}/${rate.denominator}` });
}

/** round(d · fps) frames, at least one (motionFrameCount). */
export function motionLibraryFrameCountV1(durationSeconds: number, rate: MotionLibraryRateV1): number {
  if (!(durationSeconds > 0) || !Number.isFinite(durationSeconds)) throw new MotionLibraryRefusalV1("MOTION_LIBRARY_PARAMS_INVALID", "durationSeconds must be positive");
  return Math.max(1, Math.round((durationSeconds * rate.numerator) / rate.denominator));
}

/** The rendered clip's duration in seconds (renderItem manifest durationSeconds). */
export function motionLibraryClipSecondsV1(frameCount: number, rate: MotionLibraryRateV1): number {
  return (frameCount * rate.denominator) / rate.numerator;
}

// ---------------------------------------------------------------------------
// SHA-256 (synchronous and browser-safe; validateProject cannot await WebCrypto)
// ---------------------------------------------------------------------------

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** SHA-256 of the UTF-8 bytes of `text`, lowercase hex (equal to node:crypto's digest; pinned by test). */
export function sha256HexV1(text: string): string {
  const input = new TextEncoder().encode(text);
  const blocks = Math.ceil((input.length + 9) / 64), bytes = new Uint8Array(blocks * 64);
  bytes.set(input); bytes[input.length] = 0x80;
  const view = new DataView(bytes.buffer), bits = input.length * 8;
  view.setUint32(bytes.length - 8, Math.floor(bits / 0x100000000)); view.setUint32(bytes.length - 4, bits >>> 0);
  const hash = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotate = (value: number, count: number) => (value >>> count) | (value << (32 - count));
  for (let block = 0; block < blocks; block += 1) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(block * 64 + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotate(w[i - 15], 7) ^ rotate(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotate(w[i - 2], 17) ^ rotate(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let i = 0; i < 64; i += 1) {
      const t1 = (h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    hash[0] += a; hash[1] += b; hash[2] += c; hash[3] += d; hash[4] += e; hash[5] += f; hash[6] += g; hash[7] += h;
  }
  return [...hash].map(word => word.toString(16).padStart(8, "0")).join("");
}

// ---------------------------------------------------------------------------
// Params and cache key
// ---------------------------------------------------------------------------

/** The stored params must parse with the catalog schema of `kind` and already be in resolved, canonical form. */
export function revalidateMotionLibraryParamsV1(kind: MotionLibraryKind, params: unknown): MotionLibraryParams {
  const schema = kind === "text" ? textMotionParamsSchema : kind === "transition" ? transitionMotionParamsSchema : backgroundMotionParamsSchema;
  const parsed = schema.safeParse(params);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new MotionLibraryRefusalV1("MOTION_LIBRARY_PARAMS_INVALID", issue ? `${issue.path.join(".") || "params"}: ${issue.message}` : undefined);
  }
  let same = false;
  try { same = canonicalJson(parsed.data) === canonicalJson(params); } catch { same = false; }
  if (!same) throw new MotionLibraryRefusalV1("MOTION_LIBRARY_PARAMS_INVALID", "params are not in resolved canonical form");
  return parsed.data as MotionLibraryParams;
}

export interface MotionLibraryCacheKeyInputV1 {
  readonly itemId: string;
  readonly itemRevision: number;
  readonly kind: MotionLibraryKind;
  readonly params: MotionLibraryParams;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
}

/** The key renderMotionLibraryItem uses for these inputs (no H.264 preview), with the current engine and fonts. */
export function motionLibraryCacheKeyV1(input: MotionLibraryCacheKeyInputV1): string {
  return sha256HexV1(canonicalJson({
    schema: MOTION_LIBRARY_CACHE_SCHEMA_V1, engineVersion: MOTION_LIBRARY_ENGINE_VERSION, encodeProfile: MOTION_LIBRARY_ENCODE_PROFILE_V1,
    itemId: input.itemId, itemRevision: input.itemRevision, kind: input.kind, params: input.params,
    width: input.width, height: input.height, fps: motionLibraryFrameRateV1(input.fps).text, preview: false,
    fonts: motionLibraryFontDigests(),
  }));
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

export type MotionLibraryAssetRoleV1 = "clip" | "matte" | "overlay";
const SUFFIX: Readonly<Record<MotionLibraryAssetRoleV1, string>> = { clip: ".mov", matte: ".matte.mov", overlay: ".overlay.mov" };

/** The cache file name renderMotionLibraryItem publishes for a role (renderItem.ts fileNames). */
export function motionLibraryAssetFileNameV1(cacheKey: string, role: MotionLibraryAssetRoleV1): string {
  return `${cacheKey}${SUFFIX[role]}`;
}

export interface MotionLibraryAssetExpectationV1 {
  readonly itemId: string;
  readonly cacheKey: string;
  readonly role: MotionLibraryAssetRoleV1;
  readonly alphaMode: "straight" | "opaque";
  readonly width: number;
  readonly height: number;
  readonly frameCount: number;
  readonly rate: MotionLibraryRateV1;
}

/** The asset must be the rendered cache clip `<…>/motionlib/<itemId>/<cacheKey><suffix>` with the expected geometry. */
export function assertMotionLibraryAssetV1(asset: MediaAsset | undefined, expected: MotionLibraryAssetExpectationV1, assetId: string): MediaAsset {
  if (!asset) throw new MotionLibraryRefusalV1("MOTION_LIBRARY_ASSET_MISSING", `${expected.role} asset ${assetId}`);
  if (asset.kind !== "video" || asset.compositionId !== undefined || asset.imageSequence !== undefined || asset.clipRetime !== undefined) {
    throw new MotionLibraryRefusalV1("MOTION_LIBRARY_ASSET_NOT_VIDEO", asset.id);
  }
  const parts = asset.uri.split(/[\\/]+/);
  if (parts.at(-1) !== motionLibraryAssetFileNameV1(expected.cacheKey, expected.role) || parts.at(-2) !== expected.itemId || parts.at(-3) !== "motionlib") {
    throw new MotionLibraryRefusalV1("MOTION_LIBRARY_ASSET_BINDING_MISMATCH", `${asset.id} is not motionlib/${expected.itemId}/${motionLibraryAssetFileNameV1(expected.cacheKey, expected.role)}`);
  }
  if (asset.width !== expected.width || asset.height !== expected.height) {
    throw new MotionLibraryRefusalV1("MOTION_LIBRARY_ASSET_DIMENSIONS_MISMATCH", `${asset.id} is ${asset.width}x${asset.height}, expected ${expected.width}x${expected.height}`);
  }
  if (!Number.isFinite(asset.duration) || Math.abs(asset.duration - motionLibraryClipSecondsV1(expected.frameCount, expected.rate)) > EPSILON) {
    throw new MotionLibraryRefusalV1("MOTION_LIBRARY_ASSET_FRAME_COUNT_MISMATCH", `${asset.id} lasts ${asset.duration}s, expected ${expected.frameCount} frames at ${expected.rate.text}`);
  }
  if (asset.alphaMode !== expected.alphaMode) throw new MotionLibraryRefusalV1("MOTION_LIBRARY_ASSET_ALPHA_MISMATCH", `${asset.id} alphaMode ${String(asset.alphaMode)}, expected ${expected.alphaMode}`);
  const color = asset.color;
  if (color && (!["auto", "rec709"].includes(color.interpretation)
    || [color.primaries, color.transfer, color.matrix].some(value => value !== undefined && value !== "bt709")
    || (color.range !== undefined && color.range !== "tv"))) {
    throw new MotionLibraryRefusalV1("MOTION_LIBRARY_ASSET_COLOR_MISMATCH", asset.id);
  }
  return asset;
}

// ---------------------------------------------------------------------------
// Field validation
// ---------------------------------------------------------------------------

export interface MotionLibraryContainerV1 {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly assets: readonly MediaAsset[];
}

export type MotionLibraryFieldStatusV1 = "current" | "stale_engine";

function parseClipField(value: unknown): MotionLibraryClipV1 {
  const parsed = motionLibraryClipV1Schema.safeParse(value);
  if (!parsed.success) throw new MotionLibraryRefusalV1("MOTION_LIBRARY_FIELD_INVALID", parsed.error.issues[0]?.path.join(".") || "motionLibrary");
  return parsed.data;
}

function parseTransitionField(value: unknown): TimelineTransitionMotionLibraryV1 {
  const parsed = timelineTransitionMotionLibraryV1Schema.safeParse(value);
  if (!parsed.success) throw new MotionLibraryRefusalV1("MOTION_LIBRARY_FIELD_INVALID", parsed.error.issues[0]?.path.join(".") || "motionLibrary");
  return parsed.data;
}

function assertItemKind(itemId: string, kind: MotionLibraryKind): void {
  const actual = motionLibraryItemKindV1(itemId);
  if (!actual) throw new MotionLibraryRefusalV1("MOTION_LIBRARY_ITEM_UNKNOWN", itemId);
  if (actual !== kind) throw new MotionLibraryRefusalV1("MOTION_LIBRARY_KIND_MISMATCH", `${itemId} is a ${actual} item, not ${kind}`);
}

function assertCacheKey(input: MotionLibraryCacheKeyInputV1, engineVersion: string, cacheKey: string): MotionLibraryFieldStatusV1 {
  if (engineVersion !== MOTION_LIBRARY_ENGINE_VERSION) return "stale_engine";
  if (motionLibraryCacheKeyV1(input) !== cacheKey) {
    throw new MotionLibraryRefusalV1("MOTION_LIBRARY_CACHE_KEY_MISMATCH", `${input.itemId} r${input.itemRevision} at ${input.width}x${input.height}`);
  }
  return "current";
}

/** Validates a clip's `motionLibrary` field against its owning project or composition. Returns the field status. */
export function assertMotionLibraryClipV1(container: MotionLibraryContainerV1, trackKind: string, clip: TimelineClip): MotionLibraryFieldStatusV1 {
  const field = parseClipField(clip.motionLibrary);
  assertItemKind(field.itemId, field.kind);
  const params = revalidateMotionLibraryParamsV1(field.kind, field.params);
  if (trackKind !== "video") throw new MotionLibraryRefusalV1("MOTION_LIBRARY_TRACK_INVALID", `${clip.id} is on a ${trackKind} track`);
  if ((clip.layer?.role ?? "content") !== "content") throw new MotionLibraryRefusalV1("MOTION_LIBRARY_LAYER_ROLE_REFUSED", clip.id);
  const rate = motionLibraryFrameRateV1(container.fps);
  // Asset geometry first: after a canvas change the honest answer is "the render no longer fits", not "the key moved".
  assertMotionLibraryAssetV1(container.assets.find(asset => asset.id === clip.assetId), { itemId: field.itemId, cacheKey: field.cacheKey, role: "clip",
    alphaMode: field.kind === "text" ? "straight" : "opaque", width: container.width, height: container.height,
    frameCount: motionLibraryFrameCountV1((params as { durationSeconds: number }).durationSeconds, rate), rate }, clip.assetId);
  return assertCacheKey({ itemId: field.itemId, itemRevision: field.itemRevision, kind: field.kind, params,
    width: container.width, height: container.height, fps: container.fps }, field.engineVersion, field.cacheKey);
}

/** Validates a matte transition's `motionLibrary` field: window length, params, cache key, matte and overlay assets. */
export function assertMotionLibraryTransitionV1(container: MotionLibraryContainerV1, transition: TimelineTransition): MotionLibraryFieldStatusV1 {
  const field = parseTransitionField(transition.motionLibrary);
  assertItemKind(field.itemId, "transition");
  const params = revalidateMotionLibraryParamsV1("transition", field.params);
  const rate = motionLibraryFrameRateV1(container.fps), windowFrames = transition.beforeFrames + transition.afterFrames;
  const frameCount = motionLibraryFrameCountV1((params as { durationSeconds: number }).durationSeconds, rate);
  if (frameCount !== windowFrames) {
    throw new MotionLibraryRefusalV1("MOTION_LIBRARY_TRANSITION_DURATION_MISMATCH", `${transition.id}: matte has ${frameCount} frames, window has ${windowFrames}`);
  }
  const expected = { itemId: field.itemId, cacheKey: field.cacheKey, alphaMode: "straight" as const, width: container.width, height: container.height, frameCount, rate };
  assertMotionLibraryAssetV1(container.assets.find(asset => asset.id === field.matteAssetId), { ...expected, role: "matte" }, field.matteAssetId);
  if (field.overlayAssetId !== undefined) {
    assertMotionLibraryAssetV1(container.assets.find(asset => asset.id === field.overlayAssetId), { ...expected, role: "overlay" }, field.overlayAssetId);
  }
  return assertCacheKey({ itemId: field.itemId, itemRevision: field.itemRevision, kind: "transition", params,
    width: container.width, height: container.height, fps: container.fps }, field.engineVersion, field.cacheKey);
}

/** Every matte transition of one container (validateProject calls it after the transition handles compile). */
export function assertMotionLibraryTransitionsV1(container: MotionLibraryContainerV1 & { readonly timelineTransitions?: readonly TimelineTransition[] }): void {
  for (const transition of container.timelineTransitions ?? []) {
    if (transition.kernel === "matte" || transition.motionLibrary !== undefined) {
      if (transition.kernel !== "matte" || transition.motionLibrary === undefined) {
        throw new MotionLibraryRefusalV1("MOTION_LIBRARY_FIELD_INVALID", `${transition.id}: a matte kernel needs exactly one motionLibrary field`);
      }
      assertMotionLibraryTransitionV1(container, transition);
    }
  }
}

/** Status of a saved field without throwing for staleness (UI and prepare use it to offer a re-render). */
export function motionLibraryFieldStatusV1(field: { readonly engineVersion: string }): MotionLibraryFieldStatusV1 {
  return field.engineVersion === MOTION_LIBRARY_ENGINE_VERSION ? "current" : "stale_engine";
}
