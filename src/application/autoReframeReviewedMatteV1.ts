import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { EditProject } from "../domain/types";
import { floorFrameRateSampleIndex, rationalRate, type RationalRate } from "../domain/clipAlphaPlan";
import { canonicalJson } from "../shared/canonicalJson";
import { readBoundedFile } from "../shared/boundedFile";
import { assertRenderActive } from "../render/renderLifetime";
import { analyzeMatteTrackV1, type MatteTrackArtifactsV1, type MatteTrackRuntimeV1 } from "./matteTrackAnalysisV1";
import { beginMatteTrackV1, type MatteTrackMeasurementV1 } from "./matteTrackV1";
import { verifyProductAutoRotoV2 } from "./autoRotoNativeProductV2";
import { verifyRotoMatteTrustV1 } from "./rotoMatteTrustV1";
import { assertRotoV2IdentityUnchanged, assertRotoV2LocalPath, rotoV2Deadline } from "./rotoV2Workspace";
import type { SparseReframeInputV2 } from "./autoReframeSparseV2";
import type { ReframeSubjectV1 } from "./autoReframeV1";

export type ReviewedReframeInputV1 = SparseReframeInputV2 & { expectedSourceSha256: string };
export interface ReframeReviewedMatteV1 { readonly schema: "editkin.reframe-reviewed-matte/v1"; readonly clipId: string; }
export interface ReviewedReframeMatteOptionsV1 { artifacts: MatteTrackArtifactsV1; minimumAlpha: number; referenceFrame: number; }
type State = { project: string; input: string; sourcePath: string; sourceSha256: string; artifacts: MatteTrackArtifactsV1;
  measurement: MatteTrackMeasurementV1; projectRate: RationalRate; sampleRate: RationalRate; total: number; consumed: number;
  status: "ready" | "reading" | "verified" | "closed"; check: () => number };
const owners = new WeakMap<ReframeReviewedMatteV1, State>();
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function state(token: ReframeReviewedMatteV1) {
  const s = owners.get(token); if (!s) throw Error("REFRAME_REVIEWED_MATTE_FOREIGN"); s.check(); return s;
}
function binding(s: State, project: EditProject, input: ReviewedReframeInputV1, sourcePath: string) {
  const selected = resolve(sourcePath), same = process.platform === "win32" ? selected.toLowerCase() === s.sourcePath.toLowerCase() : selected === s.sourcePath;
  if (!same || canonicalJson(project) !== s.project || canonicalJson(input) !== s.input || input.expectedSourceSha256 !== s.sourceSha256)
    throw Error("REFRAME_REVIEWED_MATTE_BINDING_CHANGED");
}
/** Creates a one-use source capability from the existing physical EG3/EG5 verification.
 * The temporary track is only an analysis draft; no add-track command is exposed/applied here. */
export async function prepareReframeReviewedMatteV1(project: EditProject, input: ReviewedReframeInputV1,
  selected: ReviewedReframeMatteOptionsV1, host: { assetBase: string }, runtime: MatteTrackRuntimeV1 = {}) {
  if (input.matteMaskId) throw Error("REFRAME_REVIEWED_MATTE_LEGACY_CONFLICT");
  const capturedProject = canonicalJson(project), capturedInput = canonicalJson(input), options = structuredClone(selected);
  const budget = rotoV2Deadline(runtime.signal, runtime.timeoutMs), check = () => { assertRenderActive(); return budget(); };
  check(); const job = beginMatteTrackV1(project, { clipId: input.clipId, newTrackId: `reframe-analysis-${randomUUID()}`,
    name: "Reviewed matte analysis", minimumAlpha: options.minimumAlpha, referenceFrame: options.referenceFrame, createdAt: new Date().toISOString() }, runtime.signal);
  const verified = await analyzeMatteTrackV1(project, job, options.artifacts, host, runtime); check();
  if (capturedProject !== canonicalJson(project) || capturedInput !== canonicalJson(input) || verified.source.sha256 !== input.expectedSourceSha256)
    throw Error("REFRAME_REVIEWED_MATTE_BINDING_CHANGED");
  const clip = project.tracks.flatMap(t => t.clips).find(c => c.id === input.clipId)!, total = Math.round(clip.duration * project.fps);
  if (!Number.isSafeInteger(total) || total < 1 || Math.abs(total / project.fps - clip.duration) > 1e-8) throw Error("REFRAME_REVIEWED_MATTE_PROJECT_CLOCK");
  const projectRate = rationalRate(project.fps), sampleRate = rationalRate(verified.measurement.fps);
  for (const [rate, value] of [[projectRate, project.fps], [sampleRate, verified.measurement.fps]] as const)
    if (Math.abs(rate.numerator / rate.denominator - value) > value * 1e-9) throw Error("REFRAME_REVIEWED_MATTE_RATE_UNREPRESENTABLE");
  const token = Object.freeze({ schema: "editkin.reframe-reviewed-matte/v1" as const, clipId: input.clipId });
  owners.set(token, { project: capturedProject, input: capturedInput, sourcePath: verified.source.path, sourceSha256: verified.source.sha256,
    artifacts: options.artifacts, measurement: structuredClone(verified.measurement), projectRate, sampleRate, total, consumed: 0, status: "ready", check });
  return token;
}
export function assertReframeReviewedMatteV1(token: ReframeReviewedMatteV1, project: EditProject, input: ReviewedReframeInputV1, sourcePath: string) {
  const s = state(token); if (s.status !== "ready") throw Error("REFRAME_REVIEWED_MATTE_ALREADY_USED"); binding(s, project, input, sourcePath);
}
export function claimReframeReviewedMatteV1(token: ReframeReviewedMatteV1, project: EditProject, input: ReviewedReframeInputV1, sourcePath: string) {
  assertReframeReviewedMatteV1(token, project, input, sourcePath); state(token).status = "reading";
}
/** Floor sample selection uses the same exact rational clock as existing pixel mattes.
 * Empty/low-confidence samples are never replaced by contrast saliency. */
export function reframeReviewedMatteSubjectV1(token: ReframeReviewedMatteV1, frame: number): ReframeSubjectV1 | undefined {
  const s = state(token);
  if (s.status !== "reading" || frame !== s.consumed || frame >= s.total) throw Error("REFRAME_REVIEWED_MATTE_FRAME_ORDER");
  const index = floorFrameRateSampleIndex(frame, s.projectRate, s.sampleRate, s.measurement.frameCount), f = s.measurement.frames[index];
  s.consumed++; return f.bbox ? { rect: { ...f.bbox }, confidence: f.confidence, origin: "matte" } : undefined;
}
export async function verifyReframeReviewedMatteV1(token: ReframeReviewedMatteV1, project: EditProject, input: ReviewedReframeInputV1, sourcePath: string) {
  const s = state(token); binding(s, project, input, sourcePath);
  if (s.status !== "reading" || s.consumed !== s.total) throw Error("REFRAME_REVIEWED_MATTE_INCOMPLETE");
  const { analysis, cutout, trust } = s.artifacts, check = () => { assertRenderActive(); return s.check(); };
  // Reuse the same verifier, rather than a second admission implementation or cached subject claim.
  await verifyProductAutoRotoV2(analysis, check); await assertRotoV2IdentityUnchanged(cutout.clip, check);
  await assertRotoV2LocalPath(cutout.manifestPath);
  const persisted = JSON.parse((await readBoundedFile(cutout.manifestPath, 65536)).toString("utf8"));
  if (JSON.stringify(persisted) !== JSON.stringify(cutout)) throw Error("REFRAME_REVIEWED_MATTE_CUTOUT_CHANGED");
  const confirmed = verifyRotoMatteTrustV1(trust, cutout.matteIdentity);
  if (hash(confirmed) !== s.measurement.subjectConfirmationSha256) throw Error("REFRAME_REVIEWED_MATTE_CONFIRMATION_CHANGED");
  binding(s, project, input, sourcePath); s.check(); s.status = "verified";
}
export function reframeReviewedMatteReceiptV1(token: ReframeReviewedMatteV1) {
  const s = state(token); if (s.status !== "verified") throw Error("REFRAME_REVIEWED_MATTE_NOT_VERIFIED");
  const m = s.measurement;
  return { schema: "editkin.reframe-reviewed-matte-receipt/v1" as const, artifactVerified: true as const, sourceBinding: "explicit_confirmed_v2_matte" as const,
    semanticQuality: "subject_confirmed_placement_only_diagnostic" as const, sourceSha256: m.sourceSha256, alphaSha256: m.alphaSha256,
    analysisSha256: m.analysisSha256, subjectConfirmationSha256: m.subjectConfirmationSha256, alphaBits: m.alphaBits, sampleRate: { ...s.sampleRate },
    sampleCount: m.frameCount, outputFrames: s.consumed, sampling: "exact-rational-floor" as const, saliencyFallbackOnLoss: false as const,
    subjectQualityCertified: false as const, benchmarkAccepted: false as const };
}
/** Only the invocation that claimed this token calls close; a failed concurrent preflight owns nothing. */
export function closeReframeReviewedMatteV1(token: ReframeReviewedMatteV1) { const s = owners.get(token); if (s) s.status = "closed"; }
