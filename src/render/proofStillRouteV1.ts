/**
 * Proof-still output routes (design P3). Only the FFmpeg composite draws the
 * source-pixel redaction (drawbox before the canvas fit) and the Preview draws
 * matching overlay rects. Every other output route that reads the source
 * pixels refuses a project that contains a proof still, instead of leaking.
 * A project without any proof still never reaches a branch in this module.
 * Browser-safe on purpose (the desktop preview hook imports it): no node: modules.
 */
import { assertProofStillClipV1, assertProofStillProjectV1, projectContainsProofStillV1, ProofStillErrorV1 } from "../domain/proofStillV1";
import type { EditProject, MediaAsset, TimelineClip } from "../domain/types";
import type { MediaProbe } from "./ffmpegContracts";

export const PROOF_STILL_ROUTE_REFUSED_V1 = "PROOF_STILL_ROUTE_REFUSED" as const;
/** Alternative output routes that cannot draw the redaction. */
export const PROOF_STILL_GUARDED_ROUTES_V1 = [
  "packet-copy-v1", "muxed-packet-copy-v1", "gop-source-copy-v2", "gop-source-copy-v3", "source-preserving-v1",
  "time-remap-source-v1", "mesh3d", "offscreen-png-preview", "openexr-sequence", "resident-scene-linear-video",
  "native-effect-materialization",
] as const;
export type ProofStillGuardedRouteV1 = typeof PROOF_STILL_GUARDED_ROUTES_V1[number];

export class ProofStillRouteErrorV1 extends Error {
  readonly code = PROOF_STILL_ROUTE_REFUSED_V1;
  constructor(readonly route: ProofStillGuardedRouteV1) {
    super(`${PROOF_STILL_ROUTE_REFUSED_V1}: ${route} cannot draw source-pixel proof-still redaction; render through the FFmpeg composite route`);
    this.name = "ProofStillRouteErrorV1";
  }
}

/** One call at the entry of each alternative route. Projects without proof stills pass untouched. */
export function assertProofStillRouteV1(project: Pick<EditProject, "tracks"> & { compositions?: EditProject["compositions"] }, route: ProofStillGuardedRouteV1): void {
  if (projectContainsProofStillV1(project)) throw new ProofStillRouteErrorV1(route);
}

const RGBA_DRAW_FORMATS = new Set(["rgba", "gbrap16le"]);

/**
 * FFmpeg source-chain prefix for one compositor input. Empty without a proof
 * still, so ordinary graphs stay byte-identical. With one, the actual probe
 * must be the admitted upright square-pixel raster. The still is then cropped
 * in exact integer SOURCE pixels, every redaction is drawn as a solid opaque fill
 * (in crop coordinates), and the result is resampled ONCE with Lanczos straight
 * to the viewport size. The compositor then skips its canvas fit, pad and
 * layout crop/scale for this clip, so small UI text is resampled only once.
 */
export function proofStillSourceFiltersV1(input: { clip: TimelineClip; asset: MediaAsset; probe: MediaProbe },
  canvas: { width: number; height: number }, rgbaFormat: string): string[] {
  if (input.clip.proofStill === undefined) return [];
  const proof = assertProofStillClipV1(input.clip, { asset: input.asset, canvas });
  const probe = input.probe;
  if (probe.width !== proof.sourceWidth || probe.height !== proof.sourceHeight) throw new ProofStillErrorV1("PROOF_STILL_SOURCE_DIMENSIONS_MISMATCH", input.clip.id);
  if ((probe.displayRotationDegrees ?? 0) % 360 !== 0 || (probe.sampleAspectRatio !== undefined && probe.sampleAspectRatio !== 1)) {
    throw new ProofStillErrorV1("PROOF_STILL_SOURCE_GEOMETRY_UNSUPPORTED", input.clip.id);
  }
  if (!RGBA_DRAW_FORMATS.has(rgbaFormat)) throw new ProofStillErrorV1("PROOF_STILL_SOURCE_GEOMETRY_UNSUPPORTED", `draw format ${rgbaFormat}`);
  // JPEG (yuvj) is full-range BT.601 by JFIF; lossy WebP is BT.601 studio range unless tagged full.
  const pixelFormat = probe.pixelFormat ?? "", yuv = pixelFormat.startsWith("yuv");
  const decode = yuv ? [`scale=in_range=${pixelFormat.startsWith("yuvj") || probe.colorRange === "pc" ? "full" : "limited"}:in_color_matrix=${probe.colorMatrix === "bt709" ? "bt709" : "bt601"}`] : [];
  const { crop } = proof, viewport = input.clip.layout!.viewport;
  const redactions = proof.redactions.flatMap(({ rect, fill }) => {
    const x0 = Math.max(rect.x, crop.x), y0 = Math.max(rect.y, crop.y);
    const x1 = Math.min(rect.x + rect.width, crop.x + crop.width), y1 = Math.min(rect.y + rect.height, crop.y + crop.height);
    return x1 > x0 && y1 > y0 ? [`drawbox=x=${x0 - crop.x}:y=${y0 - crop.y}:w=${x1 - x0}:h=${y1 - y0}:color=0x${fill.slice(1).toUpperCase()}:t=fill:replace=1`] : [];
  });
  return [...decode, `format=${rgbaFormat}`, `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`, ...redactions,
    // Same viewport raster as the ordinary layout path, so the overlay placement is unchanged.
    `scale=${Math.max(2, Math.round(canvas.width * viewport.width))}:${Math.max(2, Math.round(canvas.height * viewport.height))}:flags=lanczos`];
}

/**
 * Composite entry check: every proof still is admitted against its own canvas,
 * none feeds a track matte, and each rendered source file currently hashes to
 * the proof's sourceSha256 (`hashFile` is the caller's Node file hash).
 * Returns immediately, without touching any file, when there is no proof still.
 */
export async function verifyProofStillCompositeSourcesV1(project: EditProject,
  segments: ReadonlyArray<{ clip: TimelineClip; assetPath: string }>, hashFile: (path: string) => Promise<string>): Promise<void> {
  if (!projectContainsProofStillV1(project)) return;
  const actual = new Map<string, string>();
  for (const segment of segments) if (segment.clip.proofStill !== undefined) actual.set(segment.clip.id, await hashFile(segment.assetPath));
  assertProofStillProjectV1(project, actual);
}
