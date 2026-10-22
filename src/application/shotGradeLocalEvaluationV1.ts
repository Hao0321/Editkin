import { mkdir, realpath, stat, statfs } from "node:fs/promises";
import { isAbsolute, parse } from "node:path";
import { findAsset, findClip } from "../domain/editGraph";
import { assertColorGradeV2 } from "../domain/colorGradeV2Schema";
import type { EditProject } from "../domain/types";
import type { ColorGradeV2 } from "../domain/visualTypes";
import { resolveMediaPath } from "../render/mediaProcess";
import { canonicalJson } from "../shared/canonicalJson";
import { sampleMaterialColor } from "./materialColorSampling";
import { colorFileSha, getMaterialColorRuntimeIdentity } from "./materialColorSamplingRuntime";
import { readShotGradeWorkingSurfaceV1, type ShotGradeWorkingSourceV1 } from "./shotGradeFramesV1";
import { readShotGradeRenderedSurfaceV1 } from "./shotGradeRenderedFramesV1";
import { proposeShotGradeCandidateV1 } from "../color/shotGradeCandidateV1";
import { proposeShotGradeAutoBalanceV1 } from "../color/shotGradeAutoBalanceV1";
import { analyzeShotGradeStatisticsV1, measureShotGradeMatchV1, measureShotGradeSafetyV1 } from "../color/shotGradeStatisticsV1";
import { cieDeltaE2000V1, linearRec709ToCieLabD65V1 } from "../color/cieDeltaE2000V1";
import { refuseShotGradeLocalV1, type ParsedShotGradeLocalRequestV1, type ShotGradeLocalSourceV1 } from "./shotGradeLocalContractV1";

export interface ShotGradeLocalHostV1 { assetBase: string; cacheRoot: string; ffmpegPath: string; ffprobePath: string; }
export interface ShotGradeLocalEvaluationContextV1 {
  project: EditProject; request: ParsedShotGradeLocalRequestV1; host: ShotGradeLocalHostV1; signal: AbortSignal;
  check(): number; read<T>(operation: () => Promise<T>): Promise<T>;
}
type Version = { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint };
export interface ShotGradeLocalOriginalV1 { clipId: string; assetId: string; uri: string; path: string; sha256: string; version: Version; }
const version = (value: Version): Version => ({ dev: value.dev, ino: value.ino, size: value.size, mtimeNs: value.mtimeNs, ctimeNs: value.ctimeNs });
const sameVersion = (a: Version, b: Version) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

async function original(ctx: ShotGradeLocalEvaluationContextV1, clipId: string): Promise<ShotGradeLocalOriginalV1> {
  const clip = findClip(ctx.project, clipId), asset = findAsset(ctx.project, clip.assetId);
  if (asset.kind !== "video" || asset.compositionId || asset.imageSequence || asset.clipRetime) refuseShotGradeLocalV1("ORIGINAL_VIDEO_REQUIRED");
  const path = await ctx.read(() => realpath(resolveMediaPath(asset.uri, ctx.host.assetBase))), info = await ctx.read(() => stat(path, { bigint: true }));
  if (!info.isFile()) refuseShotGradeLocalV1("ORIGINAL_FILE_REQUIRED");
  const sha256 = await ctx.read(() => colorFileSha(path));
  return { clipId, assetId: asset.id, uri: asset.uri, path, sha256, version: version(info) };
}
export async function verifyShotGradeLocalOriginalsV1(ctx: ShotGradeLocalEvaluationContextV1, sources: readonly ShotGradeLocalOriginalV1[]) {
  for (const source of sources) {
    const clip = findClip(ctx.project, source.clipId), asset = findAsset(ctx.project, source.assetId);
    if (clip.assetId !== source.assetId || asset.uri !== source.uri) refuseShotGradeLocalV1("ORIGINAL_CHANGED");
    const path = await ctx.read(() => realpath(resolveMediaPath(asset.uri, ctx.host.assetBase))), before = await ctx.read(() => stat(path, { bigint: true }));
    if (path !== source.path || !before.isFile() || !sameVersion(before, source.version)) refuseShotGradeLocalV1("ORIGINAL_CHANGED");
    if (await ctx.read(() => colorFileSha(path)) !== source.sha256) refuseShotGradeLocalV1("ORIGINAL_CHANGED");
    const after = await ctx.read(() => stat(path, { bigint: true }));
    if (!sameVersion(after, source.version) || await ctx.read(() => realpath(resolveMediaPath(asset.uri, ctx.host.assetBase))) !== source.path) refuseShotGradeLocalV1("ORIGINAL_CHANGED");
  }
}
async function measuredSource(ctx: ShotGradeLocalEvaluationContextV1, request: ShotGradeLocalSourceV1, identity: Awaited<ReturnType<typeof getMaterialColorRuntimeIdentity>>) {
  const source = await original(ctx, request.clipId), clip = findClip(ctx.project, request.clipId), asset = findAsset(ctx.project, source.assetId);
  if (request.samples.some(s => s.time >= clip.duration)) refuseShotGradeLocalV1("SAMPLE_OUTSIDE_CLIP");
  const measured = await ctx.read(() => sampleMaterialColor({ sourcePath: source.path, sourceSha256: source.sha256, sourceStart: clip.sourceStart, duration: clip.duration,
    kind: "video", color: asset.color, colorManagement: ctx.project.colorManagement,
    samples: request.samples.map(s => ({ ...s, sceneIndex: 0 })), sceneCount: 1 }, { ...ctx.host, signal: ctx.signal, timeoutMs: ctx.check() }, identity));
  if (measured.status !== "measured") refuseShotGradeLocalV1("SOURCE_MEASUREMENT_UNAVAILABLE");
  const binding: ShotGradeWorkingSourceV1 = { clipId: clip.id, assetId: asset.id, sourceSha256: source.sha256, sourceStart: clip.sourceStart, duration: clip.duration, color: asset.color };
  return { source, clip, measured, binding };
}
type Measured = Awaited<ReturnType<typeof measuredSource>>;
async function working(ctx: ShotGradeLocalEvaluationContextV1, item: Measured) {
  const values = [];
  for (let i = 0; i < item.measured.mapping.length; i++) values.push(await ctx.read(() => readShotGradeWorkingSurfaceV1(item.measured, item.binding, ctx.project, i, item.source.path, { ...ctx.host, signal: ctx.signal }, ctx.check(), ctx.request.highBitDepth)));
  if (values.some(v => !v.allPixelsOpaque)) refuseShotGradeLocalV1("ALPHA_COHORT_ADAPTER_REQUIRED");
  return values;
}
async function rendered(ctx: ShotGradeLocalEvaluationContextV1, item: Measured, grade?: ColorGradeV2 | null) {
  const values = [];
  for (let i = 0; i < item.measured.mapping.length; i++) values.push(await ctx.read(() => readShotGradeRenderedSurfaceV1(item.measured, item.binding, ctx.project, i, item.source.path, { ...ctx.host, signal: ctx.signal }, ctx.check(), grade, ctx.request.highBitDepth)));
  if (values.some(v => !v.allPixelsOpaque)) refuseShotGradeLocalV1("ALPHA_COHORT_ADAPTER_REQUIRED");
  return values;
}
function searchGrade(ctx: ShotGradeLocalEvaluationContextV1) {
  const grade = assertColorGradeV2(findClip(ctx.project, ctx.request.target.clipId).gradeV2 ?? { schema: "editkin.color-grade/v2" });
  if (ctx.request.destination.kind === "append") return grade;
  const nodes = grade.nodes ?? [];
  if (nodes.at(-1)?.id !== ctx.request.destination.nodeId) refuseShotGradeLocalV1("REPLACE_TERMINAL_NODE_REQUIRED");
  return { ...grade, nodes: nodes.slice(0, -1) };
}
function labelledCandidate(ctx: ShotGradeLocalEvaluationContextV1, grade: ColorGradeV2) {
  const result = structuredClone(grade), node = result.nodes?.at(-1);
  if (!node) refuseShotGradeLocalV1("CANDIDATE_NODE_REQUIRED");
  node.label = ctx.request.destination.label;
  if (ctx.request.destination.kind === "replace") node.id = ctx.request.destination.nodeId;
  return result;
}
function neutrality(before: ReturnType<typeof analyzeShotGradeStatisticsV1>, after: ReturnType<typeof analyzeShotGradeStatisticsV1>) {
  const linear = before.regions.neutral.meanLinearRec709, first = before.regions.neutral.meanCieLabD65, next = after.regions.neutral.meanCieLabD65;
  if (!linear || !first || !next) return null;
  const y = .2126 * linear[0] + .7152 * linear[1] + .0722 * linear[2], targetLab = linearRec709ToCieLabD65V1([y, y, y]);
  const beforeCie00 = cieDeltaE2000V1(first, targetLab), afterCie00 = cieDeltaE2000V1(next, targetLab);
  return { beforeCie00, afterCie00, maximumCie00: 3 as const, baselineLinearY: y, targetLab,
    measuredBoundSatisfied: afterCie00 <= 3 && afterCie00 <= beforeCie00 + 1e-12 };
}
export async function evaluateShotGradeLocalV1(ctx: ShotGradeLocalEvaluationContextV1) {
  if (![ctx.host.assetBase, ctx.host.cacheRoot, ctx.host.ffmpegPath, ctx.host.ffprobePath].every(isAbsolute)
    || parse(ctx.host.assetBase).root.toLowerCase() !== parse(ctx.host.cacheRoot).root.toLowerCase()) refuseShotGradeLocalV1("HOST_PATHS");
  await ctx.read(() => mkdir(ctx.host.cacheRoot, { recursive: true }));
  const space = await ctx.read(() => statfs(ctx.host.cacheRoot));
  if (!Number.isSafeInteger(space.bavail * space.bsize) || space.bavail * space.bsize < 64 * 1024 ** 2) refuseShotGradeLocalV1("CACHE_SPACE");
  const identity = await ctx.read(() => getMaterialColorRuntimeIdentity({ ...ctx.host, signal: ctx.signal, timeoutMs: ctx.check() }));
  if (identity.status !== "verified") refuseShotGradeLocalV1("RUNTIME_UNVERIFIED");
  const base = searchGrade(ctx), target = await measuredSource(ctx, ctx.request.target, identity), pre = await working(ctx, target), before = await rendered(ctx, target);
  const beforeStats = analyzeShotGradeStatisticsV1(before.map(v => v.frame), ctx.request.target.regions);
  const reference = ctx.request.mode === "shot_match" ? await measuredSource(ctx, ctx.request.reference, identity) : undefined;
  const referenceSurfaces = reference ? await rendered(ctx, reference) : [];
  const evaluation = ctx.request.mode === "shot_match" ? proposeShotGradeCandidateV1({ frames: pre.map(v => v.frame), regions: ctx.request.target.regions,
    referenceFrames: referenceSurfaces.map(v => v.frame), referenceRegions: ctx.request.reference.regions, gradeV2: base, signal: ctx.signal, maximumTimeMs: Math.min(2000, ctx.check()) })
    : proposeShotGradeAutoBalanceV1({ frames: pre.map(v => v.frame), regions: ctx.request.target.regions, gradeV2: base, signal: ctx.signal, maximumTimeMs: Math.min(2000, ctx.check()) });
  ctx.check(); const candidate = evaluation.status === "candidate" && evaluation.gradeV2 ? labelledCandidate(ctx, evaluation.gradeV2) : null;
  const after = candidate ? await rendered(ctx, target, candidate) : before, afterStats = analyzeShotGradeStatisticsV1(after.map(v => v.frame), ctx.request.target.regions);
  const safety = measureShotGradeSafetyV1(beforeStats, afterStats), match = ctx.request.mode === "shot_match" ? measureShotGradeMatchV1(beforeStats, afterStats,
    analyzeShotGradeStatisticsV1(referenceSurfaces.map(v => v.frame), ctx.request.reference.regions)) : null, neutral = ctx.request.mode === "auto_balance" ? neutrality(beforeStats, afterStats) : null;
  const applicable = evaluation.search.allSuppliedPixelsVerified && (evaluation.status === "candidate" || evaluation.status === "unchanged") && safety.measuredBoundsSatisfied
    && (ctx.request.mode === "shot_match" ? match?.matchesSpecifiedNeutralAndSkinBounds === true : neutral?.measuredBoundSatisfied === true);
  const changed = candidate !== null && canonicalJson(candidate) !== canonicalJson(target.clip.gradeV2 ?? null), sources = [target.source, ...(reference ? [reference.source] : [])];
  await verifyShotGradeLocalOriginalsV1(ctx, sources);
  const ending = await ctx.read(() => getMaterialColorRuntimeIdentity({ ...ctx.host, signal: ctx.signal, timeoutMs: ctx.check() }));
  if (ending.identitySha256 !== identity.identitySha256) refuseShotGradeLocalV1("RUNTIME_CHANGED");
  return { state: applicable ? changed ? "ready" as const : "unchanged" as const : "not_applicable" as const,
    reason: applicable ? "actual-local-post-v2-bounds-satisfied" : evaluation.reason, grade: applicable && changed ? candidate : null,
    sources, runtimeIdentity: identity, numericalEvaluation: evaluation, measurements: { before: beforeStats, after: afterStats, safety, match, neutrality: neutral },
    surfaces: { targetPre: pre.map(v => v.surface), targetBefore: before.map(v => v.surface), targetAfter: after.map(v => v.surface), reference: referenceSurfaces.map(v => v.surface) } };
}
