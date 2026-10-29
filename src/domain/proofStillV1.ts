/**
 * editkin.proof-still/v1 (roadmap 3.7, design P2): an M107 proof shot is a
 * real screenshot held static, with a crop, solid-fill privacy redactions and
 * an optional target, all in integer source pixels.
 *
 * The original image is never rewritten. Redaction is drawn at render time
 * (FFmpeg drawbox before the canvas fit, Preview overlay rects), and every
 * output route that cannot draw it refuses the project (render/proofStillRouteV1).
 * Nothing here asserts that every piece of personal data was found: each listed
 * region is a confirmed region, not a completeness claim.
 */
import * as z from "zod/v4";
import type { ClipLayout, MediaAsset, NormalizedRect, TimelineClip } from "./visualTypes";

export const PROOF_STILL_V1_SCHEMA = "editkin.proof-still/v1" as const;
export const PROOF_STILL_V1_MAX_REDACTIONS = 32;
export const PROOF_STILL_V1_MIN_RECT_PIXELS = 4;
export const PROOF_STILL_V1_MAX_SOURCE_DIMENSION = 32768;
/** Screenshot containers admitted by long-form intake (longformMaterialIntakeV1). */
export const PROOF_STILL_V1_SOURCE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp"] as const;
/** Normalized canvas units; ~0.002 px at 1920. Absorbs only float formatting, never a moved crop. */
const LAYOUT_TOLERANCE = 1e-6;

export const PROOF_STILL_REFUSAL_CODES_V1 = [
  "PROOF_STILL_SCHEMA_INVALID",
  "PROOF_STILL_RECT_OUT_OF_BOUNDS",
  "PROOF_STILL_RECT_TOO_SMALL",
  "PROOF_STILL_REDACTION_ID_DUPLICATE",
  "PROOF_STILL_TARGET_OUTSIDE_CROP",
  "PROOF_STILL_TARGET_FULLY_REDACTED",
  "PROOF_STILL_ASSET_MISSING",
  "PROOF_STILL_ASSET_NOT_IMAGE",
  "PROOF_STILL_SOURCE_FORMAT_UNSUPPORTED",
  "PROOF_STILL_SOURCE_SHA_MISMATCH",
  "PROOF_STILL_SOURCE_DIMENSIONS_MISMATCH",
  "PROOF_STILL_SOURCE_GEOMETRY_UNSUPPORTED",
  "PROOF_STILL_STATIC_HOLD_KEYFRAMES",
  "PROOF_STILL_STATIC_HOLD_EXPRESSIONS",
  "PROOF_STILL_STATIC_HOLD_TRANSFORM3D",
  "PROOF_STILL_STATIC_HOLD_FLOATING_FRAME",
  "PROOF_STILL_STATIC_HOLD_SPEED",
  "PROOF_STILL_STATIC_HOLD_TIME_REMAP",
  "PROOF_STILL_LAYER_ROLE_REFUSED",
  "PROOF_STILL_NATIVE_EFFECT_REFUSED",
  "PROOF_STILL_ALPHA_PROCESSING_REFUSED",
  "PROOF_STILL_TRACK_MATTE_SOURCE_REFUSED",
  "PROOF_STILL_LAYOUT_REQUIRED",
  "PROOF_STILL_LAYOUT_CROP_MISMATCH",
  "PROOF_STILL_LAYOUT_VIEWPORT_INVALID",
  "PROOF_STILL_CANVAS_INVALID",
] as const;
export type ProofStillRefusalCodeV1 = typeof PROOF_STILL_REFUSAL_CODES_V1[number];

export class ProofStillErrorV1 extends Error {
  constructor(readonly code: ProofStillRefusalCodeV1, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "ProofStillErrorV1";
  }
}

export interface ProofStillRectV1 { x: number; y: number; width: number; height: number }
export interface ProofStillRedactionV1 { id: string; rect: ProofStillRectV1; fill: string }
export interface ProofStillV1 {
  schema: typeof PROOF_STILL_V1_SCHEMA;
  sourceSha256: string;
  sourceWidth: number;
  sourceHeight: number;
  crop: ProofStillRectV1;
  /** Solid fills only in v1 (no blur or pixelate). Order is the drawing order. */
  redactions: ProofStillRedactionV1[];
  target?: { rect: ProofStillRectV1 };
  hold: "static";
  /** Who confirmed the listed regions. Never a claim that all personal data was found. */
  confirmation: { by: "user" | "agent"; note: string };
}

const pixel = z.number().int().min(0).max(PROOF_STILL_V1_MAX_SOURCE_DIMENSION);
const extent = z.number().int().min(1).max(PROOF_STILL_V1_MAX_SOURCE_DIMENSION);
export const proofStillRectV1Schema = z.strictObject({ x: pixel, y: pixel, width: extent, height: extent });
export const proofStillRedactionV1Schema = z.strictObject({ id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/i), rect: proofStillRectV1Schema,
  fill: z.string().regex(/^#[0-9A-Fa-f]{6}$/) });
export const proofStillConfirmationV1Schema = z.strictObject({ by: z.enum(["user", "agent"]),
  note: z.string().min(1).max(500).refine(value => value.trim() === value && !/[\u0000-\u001F\u007F]/.test(value), "Confirmation note must be trimmed plain text") });

/** Editorial evidence ref for the viewed frame of the still's own material receipt (≤160 chars). */
const EVIDENCE_REFERENCE = /^mi:([a-f0-9]{64}):([a-f0-9]{64}):frame:(kf-(?:[1-9]|1[0-2]))$/;
export function proofStillEvidenceReferenceV1(materialId: string, semanticReceiptSha256: string, frameId: string): string {
  const reference = `mi:${materialId}:${semanticReceiptSha256}:frame:${frameId}`;
  if (!EVIDENCE_REFERENCE.test(reference)) throw new ProofStillErrorV1("PROOF_STILL_SCHEMA_INVALID", "evidence reference");
  return reference;
}
export function parseProofStillEvidenceReferenceV1(reference: string): { materialId: string; semanticReceiptSha256: string; frameId: string } | undefined {
  const match = EVIDENCE_REFERENCE.exec(reference);
  return match ? { materialId: match[1], semanticReceiptSha256: match[2], frameId: match[3] } : undefined;
}

/** Prepared proof-still clip ids leave room for the target event suffix inside the 80-character editorial id grammar. */
export const PROOF_STILL_V1_CLIP_ID = /^[a-z0-9][a-z0-9._-]{0,72}$/i;
/**
 * A proof still with a target is annotated by the focus-bracket. The bracket's anchor corner layer and the
 * editorial event it executes share this id, so audit finds the one event that must cite the viewed frame.
 */
export function proofStillTargetEventIdV1(clipId: string): string {
  return `${clipId}.target`;
}

type Issue = { code: ProofStillRefusalCodeV1; path: Array<string | number> };
const right = (rect: ProofStillRectV1) => rect.x + rect.width;
const bottom = (rect: ProofStillRectV1) => rect.y + rect.height;

/** True when the union of `covers` contains every pixel of `rect` (coordinate compression, ≤33 rects). */
function fullyCovered(rect: ProofStillRectV1, covers: readonly ProofStillRectV1[]): boolean {
  const xs = [...new Set([rect.x, right(rect), ...covers.flatMap(c => [c.x, right(c)]).filter(v => v > rect.x && v < right(rect))])].sort((a, b) => a - b);
  const ys = [...new Set([rect.y, bottom(rect), ...covers.flatMap(c => [c.y, bottom(c)]).filter(v => v > rect.y && v < bottom(rect))])].sort((a, b) => a - b);
  for (let i = 0; i + 1 < xs.length; i++) for (let j = 0; j + 1 < ys.length; j++) {
    const cx = (xs[i] + xs[i + 1]) / 2, cy = (ys[j] + ys[j + 1]) / 2;
    if (!covers.some(c => cx > c.x && cx < right(c) && cy > c.y && cy < bottom(c))) return false;
  }
  return true;
}

/** Invariants that need only the proof still itself, in a stable refusal order. */
export function proofStillInvariantIssuesV1(value: Pick<ProofStillV1, "sourceWidth" | "sourceHeight" | "crop" | "redactions" | "target">): Issue[] {
  const issues: Issue[] = [];
  const rects: Array<[ProofStillRectV1, Array<string | number>]> = [[value.crop, ["crop"]],
    ...value.redactions.map((r, index): [ProofStillRectV1, Array<string | number>] => [r.rect, ["redactions", index, "rect"]]),
    ...(value.target ? [[value.target.rect, ["target", "rect"]] as [ProofStillRectV1, Array<string | number>]] : [])];
  for (const [rect, path] of rects) {
    if (right(rect) > value.sourceWidth || bottom(rect) > value.sourceHeight) issues.push({ code: "PROOF_STILL_RECT_OUT_OF_BOUNDS", path });
    if (rect.width < PROOF_STILL_V1_MIN_RECT_PIXELS || rect.height < PROOF_STILL_V1_MIN_RECT_PIXELS) issues.push({ code: "PROOF_STILL_RECT_TOO_SMALL", path });
  }
  const ids = new Set<string>();
  for (const [index, redaction] of value.redactions.entries()) {
    if (ids.has(redaction.id)) issues.push({ code: "PROOF_STILL_REDACTION_ID_DUPLICATE", path: ["redactions", index, "id"] });
    ids.add(redaction.id);
  }
  const target = value.target?.rect;
  if (target) {
    if (target.x < value.crop.x || target.y < value.crop.y || right(target) > right(value.crop) || bottom(target) > bottom(value.crop)) {
      issues.push({ code: "PROOF_STILL_TARGET_OUTSIDE_CROP", path: ["target", "rect"] });
    }
    if (fullyCovered(target, value.redactions.map(r => r.rect))) issues.push({ code: "PROOF_STILL_TARGET_FULLY_REDACTED", path: ["target", "rect"] });
  }
  return issues;
}

export const proofStillV1Schema: z.ZodType<ProofStillV1> = z.strictObject({
  schema: z.literal(PROOF_STILL_V1_SCHEMA),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceWidth: z.number().int().min(PROOF_STILL_V1_MIN_RECT_PIXELS).max(PROOF_STILL_V1_MAX_SOURCE_DIMENSION),
  sourceHeight: z.number().int().min(PROOF_STILL_V1_MIN_RECT_PIXELS).max(PROOF_STILL_V1_MAX_SOURCE_DIMENSION),
  crop: proofStillRectV1Schema,
  redactions: z.array(proofStillRedactionV1Schema).max(PROOF_STILL_V1_MAX_REDACTIONS),
  target: z.strictObject({ rect: proofStillRectV1Schema }).optional(),
  hold: z.literal("static"),
  confirmation: proofStillConfirmationV1Schema,
}).superRefine((value, context) => {
  for (const issue of proofStillInvariantIssuesV1(value)) context.addIssue({ code: "custom", message: issue.code, path: issue.path });
});

/** Parses with stable codes: structural failures are PROOF_STILL_SCHEMA_INVALID, invariants keep their own code. */
export function parseProofStillV1(value: unknown): ProofStillV1 {
  const parsed = proofStillV1Schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const coded = parsed.error.issues.find(issue => issue.code === "custom" && (PROOF_STILL_REFUSAL_CODES_V1 as readonly string[]).includes(issue.message));
  if (coded) throw new ProofStillErrorV1(coded.message as ProofStillRefusalCodeV1, coded.path.join("."));
  const first = parsed.error.issues[0];
  throw new ProofStillErrorV1("PROOF_STILL_SCHEMA_INVALID", first ? `${first.path.join(".") || "proofStill"}: ${first.message}` : undefined);
}

export interface ProofStillCanvasV1 { width: number; height: number }

function assertCanvas(canvas: ProofStillCanvasV1): void {
  if (![canvas.width, canvas.height].every(value => Number.isSafeInteger(value) && value >= 2 && value <= PROOF_STILL_V1_MAX_SOURCE_DIMENSION)) {
    throw new ProofStillErrorV1("PROOF_STILL_CANVAS_INVALID");
  }
}
/** av_rescale's round-half-away-from-zero, exact for these integer ranges. */
const rescale = (a: number, b: number, c: number) => Math.floor((2 * a * b + c) / (2 * c));

/**
 * The compositor's own source fit, in canvas pixels: FFmpeg
 * `scale=W:H:force_original_aspect_ratio=decrease` then `pad=W:H:(ow-iw)/2:(oh-ih)/2`.
 * Preview positions its media and overlay rects from the same numbers.
 */
export function proofStillCanvasFitV1(sourceWidth: number, sourceHeight: number, canvas: ProofStillCanvasV1) {
  assertCanvas(canvas);
  const width = Math.min(rescale(canvas.height, sourceWidth, sourceHeight), canvas.width);
  const height = Math.min(rescale(canvas.width, sourceHeight, sourceWidth), canvas.height);
  return { width, height, x: Math.floor((canvas.width - width) / 2), y: Math.floor((canvas.height - height) / 2) };
}

/** A source-pixel rect in normalized canvas coordinates (same space as ClipLayout). */
export function proofStillCanvasRectV1(proof: Pick<ProofStillV1, "sourceWidth" | "sourceHeight">, rect: ProofStillRectV1, canvas: ProofStillCanvasV1): NormalizedRect {
  const fit = proofStillCanvasFitV1(proof.sourceWidth, proof.sourceHeight, canvas);
  const sx = fit.width / proof.sourceWidth, sy = fit.height / proof.sourceHeight;
  return { x: (fit.x + rect.x * sx) / canvas.width, y: (fit.y + rect.y * sy) / canvas.height,
    width: rect.width * sx / canvas.width, height: rect.height * sy / canvas.height };
}

/** `layout.crop` is derived from `crop`; it is never authored independently. */
export function proofStillDerivedLayoutCropV1(proof: Pick<ProofStillV1, "sourceWidth" | "sourceHeight" | "crop">, canvas: ProofStillCanvasV1): NormalizedRect {
  return proofStillCanvasRectV1(proof, proof.crop, canvas);
}

/** Default placement: the cropped region, aspect kept, as large as the canvas allows and centred. */
export function proofStillDefaultLayoutV1(proof: Pick<ProofStillV1, "sourceWidth" | "sourceHeight" | "crop">, canvas: ProofStillCanvasV1): ClipLayout {
  const crop = proofStillDerivedLayoutCropV1(proof, canvas);
  const pixelWidth = crop.width * canvas.width, pixelHeight = crop.height * canvas.height;
  const scale = Math.min(canvas.width / pixelWidth, canvas.height / pixelHeight);
  const width = pixelWidth * scale / canvas.width, height = pixelHeight * scale / canvas.height;
  return { crop, viewport: { x: (1 - width) / 2, y: (1 - height) / 2, width, height } };
}

/** Output-space position of a source rect for this layout (crop → viewport), normalized to the canvas. */
export function proofStillOutputRectV1(proof: Pick<ProofStillV1, "sourceWidth" | "sourceHeight">, rect: ProofStillRectV1, layout: ClipLayout, canvas: ProofStillCanvasV1): NormalizedRect {
  const inCanvas = proofStillCanvasRectV1(proof, rect, canvas), { crop, viewport } = layout;
  const u = (inCanvas.x - crop.x) / crop.width, v = (inCanvas.y - crop.y) / crop.height;
  return { x: viewport.x + u * viewport.width, y: viewport.y + v * viewport.height,
    width: inCanvas.width / crop.width * viewport.width, height: inCanvas.height / crop.height * viewport.height };
}

function sourceExtension(uri: string): string {
  const path = uri.split(/[?#]/, 1)[0] ?? "";
  const dot = path.lastIndexOf(".");
  return dot < 0 ? "" : path.slice(dot).toLowerCase();
}

export interface ProofStillClipContextV1 {
  asset: MediaAsset | undefined;
  /** The clip's own canvas: the project, or the composition that holds the clip. */
  canvas: ProofStillCanvasV1;
  /** Current full-file SHA-256 when the caller has read the actual bytes. */
  actualSourceSha256?: string;
}

/**
 * Clip-level admission shared by render, Preview, the prepare tool and audit.
 * Returns the parsed proof still; throws ProofStillErrorV1 with a stable code.
 */
export function assertProofStillClipV1(clip: TimelineClip, context: ProofStillClipContextV1): ProofStillV1 {
  const proof = parseProofStillV1(clip.proofStill);
  const asset = context.asset;
  if (!asset || asset.id !== clip.assetId) throw new ProofStillErrorV1("PROOF_STILL_ASSET_MISSING", clip.assetId);
  if (asset.kind !== "image" || asset.compositionId || asset.imageSequence) throw new ProofStillErrorV1("PROOF_STILL_ASSET_NOT_IMAGE", asset.id);
  if (!(PROOF_STILL_V1_SOURCE_EXTENSIONS as readonly string[]).includes(sourceExtension(asset.uri))) throw new ProofStillErrorV1("PROOF_STILL_SOURCE_FORMAT_UNSUPPORTED", asset.id);
  if (asset.width !== proof.sourceWidth || asset.height !== proof.sourceHeight) throw new ProofStillErrorV1("PROOF_STILL_SOURCE_DIMENSIONS_MISMATCH", asset.id);
  if (asset.displayAspectRatio !== undefined && Math.abs(asset.displayAspectRatio / (proof.sourceWidth / proof.sourceHeight) - 1) > 1e-6) {
    throw new ProofStillErrorV1("PROOF_STILL_SOURCE_GEOMETRY_UNSUPPORTED", asset.id);
  }
  if ((asset.derivatives?.sourceSha256 !== undefined && asset.derivatives.sourceSha256.toLowerCase() !== proof.sourceSha256)
    || (context.actualSourceSha256 !== undefined && context.actualSourceSha256 !== proof.sourceSha256)) {
    throw new ProofStillErrorV1("PROOF_STILL_SOURCE_SHA_MISMATCH", asset.id);
  }
  if (clip.keyframes.length) throw new ProofStillErrorV1("PROOF_STILL_STATIC_HOLD_KEYFRAMES", clip.id);
  if (Object.values(clip.expressions ?? {}).some(value => value !== undefined)) throw new ProofStillErrorV1("PROOF_STILL_STATIC_HOLD_EXPRESSIONS", clip.id);
  if (clip.transform3d) throw new ProofStillErrorV1("PROOF_STILL_STATIC_HOLD_TRANSFORM3D", clip.id);
  if (clip.floatingFrame) throw new ProofStillErrorV1("PROOF_STILL_STATIC_HOLD_FLOATING_FRAME", clip.id);
  if (clip.speed !== undefined) throw new ProofStillErrorV1("PROOF_STILL_STATIC_HOLD_SPEED", clip.id);
  if (clip.timeRemap !== undefined) throw new ProofStillErrorV1("PROOF_STILL_STATIC_HOLD_TIME_REMAP", clip.id);
  if ((clip.layer?.role ?? "content") !== "content") throw new ProofStillErrorV1("PROOF_STILL_LAYER_ROLE_REFUSED", clip.id);
  // Materialization renders the raw source before any redaction can be drawn.
  if (clip.creative?.nativeEffectInstances?.some(instance => instance.enabled)) throw new ProofStillErrorV1("PROOF_STILL_NATIVE_EFFECT_REFUSED", clip.id);
  // The render crops in source pixels and resamples once to the viewport; masks and keys are
  // authored on the fitted canvas frame, which this chain never builds.
  if (clip.masks?.some(mask => mask.enabled) || clip.chromaKey?.enabled) throw new ProofStillErrorV1("PROOF_STILL_ALPHA_PROCESSING_REFUSED", clip.id);
  if (!clip.layout) throw new ProofStillErrorV1("PROOF_STILL_LAYOUT_REQUIRED", clip.id);
  const derived = proofStillDerivedLayoutCropV1(proof, context.canvas);
  if ((["x", "y", "width", "height"] as const).some(key => !Number.isFinite(clip.layout!.crop[key]) || Math.abs(clip.layout!.crop[key] - derived[key]) > LAYOUT_TOLERANCE)) {
    throw new ProofStillErrorV1("PROOF_STILL_LAYOUT_CROP_MISMATCH", clip.id);
  }
  const viewport = clip.layout.viewport;
  if (![viewport.x, viewport.y, viewport.width, viewport.height].every(Number.isFinite) || viewport.width <= 0 || viewport.height <= 0) {
    throw new ProofStillErrorV1("PROOF_STILL_LAYOUT_VIEWPORT_INVALID", clip.id);
  }
  return proof;
}

type ProofStillContainerV1 = { width: number; height: number; tracks: ReadonlyArray<{ clips: readonly TimelineClip[] }> };
type ProofStillProjectV1 = ProofStillContainerV1 & { assets: readonly MediaAsset[]; compositions?: readonly ProofStillContainerV1[] };

/** Every proof-still clip with its own canvas, in the root timeline and in compositions. */
export function proofStillClipsV1(project: ProofStillProjectV1): Array<{ clip: TimelineClip; canvas: ProofStillCanvasV1 }> {
  return [project, ...(project.compositions ?? [])].flatMap(owner => owner.tracks.flatMap(track => track.clips)
    .filter(clip => clip.proofStill !== undefined).map(clip => ({ clip, canvas: { width: owner.width, height: owner.height } })));
}

export function projectContainsProofStillV1(project: Pick<ProofStillProjectV1, "tracks"> & { compositions?: ReadonlyArray<Pick<ProofStillContainerV1, "tracks">> }): boolean {
  return [project, ...(project.compositions ?? [])].some(owner => owner.tracks.some(track => track.clips.some(clip => clip.proofStill !== undefined)));
}

/**
 * Project-level admission without file access: every proof still passes the
 * clip checks and none is another clip's track-matte source (that path reads
 * the raw source pixels without a redaction).
 */
export function assertProofStillProjectV1(project: ProofStillProjectV1, actualSourceSha256?: ReadonlyMap<string, string>): void {
  const assets = new Map(project.assets.map(asset => [asset.id, asset]));
  for (const { clip, canvas } of proofStillClipsV1(project)) {
    assertProofStillClipV1(clip, { asset: assets.get(clip.assetId), canvas, actualSourceSha256: actualSourceSha256?.get(clip.id) });
  }
  for (const owner of [project, ...(project.compositions ?? [])]) {
    const clips = owner.tracks.flatMap(track => track.clips);
    const proofIds = new Set(clips.filter(clip => clip.proofStill !== undefined).map(clip => clip.id));
    const source = clips.find(clip => clip.layer?.trackMatte && proofIds.has(clip.layer.trackMatte.sourceClipId));
    if (source) throw new ProofStillErrorV1("PROOF_STILL_TRACK_MATTE_SOURCE_REFUSED", source.layer!.trackMatte!.sourceClipId);
  }
}
