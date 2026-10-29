import { canonicalJson } from "../shared/canonicalJson";
import { findClip } from "../domain/editGraph";
import { dispatchCommandSafely } from "../domain/history";
import type { EditorCommand } from "../domain/commands";
import type { ProjectSession, ProjectTask } from "./projectSession";
import { shotGradeCodeIdentityV1 } from "./shotGradeCodeIdentityV1";
import { getMaterialColorRuntimeIdentity } from "./materialColorSamplingRuntime";
import { evaluateShotGradeLocalV1, verifyShotGradeLocalOriginalsV1, type ShotGradeLocalEvaluationContextV1, type ShotGradeLocalHostV1 } from "./shotGradeLocalEvaluationV1";
import { shotGradeLocalRequestV1Schema, refuseShotGradeLocalV1, ShotGradeLocalRefusalV1, type ParsedShotGradeLocalRequestV1 } from "./shotGradeLocalContractV1";
export type { ShotGradeLocalHostV1 } from "./shotGradeLocalEvaluationV1";
export interface ShotGradeLocalRuntimeV1 { signal?: AbortSignal; isCurrent(): boolean; }
type GradeCommand = Extract<EditorCommand, { type: "set_clip_grade_v2" }>;
type Evaluation = Awaited<ReturnType<typeof evaluateShotGradeLocalV1>>;
export interface PreparedShotGradeLocalV1 {
  schema: "editkin.shot-grade-local-proposal/v1"; state: Evaluation["state"]; mode: ParsedShotGradeLocalRequestV1["mode"];
  projectId: string; expectedRevision: number; clipId: string; referenceClipId: string | null; reason: string;
  command: GradeCommand | null; measurements: Evaluation["measurements"]; numericalEvaluation: Evaluation["numericalEvaluation"];
  sourceBindings: Array<{ clipId: string; assetId: string; sourceSha256: string }>;
  codeIdentitySha256: string; scope: "actual-source-clock-local-post-v2-before-spatial";
  regionAuthority: "caller-declared-not-classified"; humanReview: "required"; appearanceCertified: false;
  finalOutputMeasured: false; actualSixShotPerformanceVerified: false; vaContractAdmission: false; directApplyAllowed: false;
}
// Coverage requirements for the one canonical H16 manifest, not another identity registry.
const required = [
  "src/application/mediaDerivativeHistory.ts", "src/application/projectSession.ts",
  "src/application/shotGradeLocalContractV1.ts", "src/application/shotGradeLocalEvaluationV1.ts", "src/application/shotGradeLocalV1.ts",
  "src/domain/clipGradeSnapshotV1.ts", "src/domain/clipGradeSnapshotV1Schema.ts", "src/domain/clipTimeRemapCommandsV1.ts", "src/domain/clipTimeRemapV1.ts",
  "src/domain/history.ts", "src/domain/mesh3dOverlayValidationV1.ts", "src/domain/timeRemapClockV1.ts", "src/domain/timeRemapFrameCountV1.ts",
  "src/domain/trackedTextBindingV1.ts", "src/domain/vectorTrackingV1.ts", "src/motion/mesh3dOverlayV1.ts",
];
function codeIdentity() {
  const value = shotGradeCodeIdentityV1();
  if (required.some(name => !value.implementations.some(row => row.name === name))) refuseShotGradeLocalV1("RUNTIME_CLOSURE_REQUIRED");
  return value;
}
function targetUnlocked(session: ProjectSession, request: ParsedShotGradeLocalRequestV1) {
  const project = session.getSnapshot().history.present, clip = findClip(project, request.target.clipId), track = project.tracks.find(t => t.id === clip.trackId);
  if (!track || track.locked) refuseShotGradeLocalV1("TARGET_LOCKED");
}
interface Owner {
  session: ProjectSession; task: ProjectTask; project: ReturnType<ProjectSession["getSnapshot"]>["history"]["present"];
  sessionId: number; contentOwner: object; path?: string; before: string; host: ShotGradeLocalHostV1; hostSnapshot: ShotGradeLocalHostV1; hostStamp: string;
  request: ParsedShotGradeLocalRequestV1; runtime: ShotGradeLocalRuntimeV1; code: ReturnType<typeof codeIdentity>;
}
function capture(session: ProjectSession, request: ParsedShotGradeLocalRequestV1, host: ShotGradeLocalHostV1, runtime: ShotGradeLocalRuntimeV1): Owner {
  const snapshot = session.getSnapshot(), project = snapshot.history.present;
  if (project.revision !== request.expectedRevision || typeof runtime.isCurrent !== "function") refuseShotGradeLocalV1("CONTEXT_CHANGED");
  const hostSnapshot = { assetBase: host.assetBase, cacheRoot: host.cacheRoot, ffmpegPath: host.ffmpegPath, ffprobePath: host.ffprobePath };
  targetUnlocked(session, request);
  return { session, project, task: session.beginTask(project), sessionId: snapshot.sessionId, contentOwner: snapshot.contentOwner, path: snapshot.projectPath,
    before: canonicalJson(project), host, hostSnapshot, hostStamp: canonicalJson(hostSnapshot), request, runtime: { ...runtime }, code: codeIdentity() };
}
function current(owner: Owner) {
  owner.runtime.signal?.throwIfAborted();
  const now = owner.session.getSnapshot();
  if (owner.runtime.isCurrent() !== true || !owner.task.isCurrent() || now.sessionId !== owner.sessionId || now.contentOwner !== owner.contentOwner
    || now.projectPath !== owner.path || now.history.present !== owner.project || canonicalJson(now.history.present) !== owner.before
    || canonicalJson({ assetBase: owner.host.assetBase, cacheRoot: owner.host.cacheRoot, ffmpegPath: owner.host.ffmpegPath, ffprobePath: owner.host.ffprobePath }) !== owner.hostStamp) refuseShotGradeLocalV1("CONTEXT_CHANGED");
  targetUnlocked(owner.session, owner.request);
}
function job(owner: Owner, limit: number, additional?: ShotGradeLocalRuntimeV1) {
  const controller = new AbortController(), signals = [owner.runtime.signal, additional?.signal, controller.signal].filter((s): s is AbortSignal => !!s), signal = AbortSignal.any(signals);
  const end = performance.now() + limit, timer = setTimeout(() => controller.abort(new ShotGradeLocalRefusalV1("DEADLINE")), limit);
  const check = () => { signal.throwIfAborted(); current(owner); if (additional && additional.isCurrent() !== true) refuseShotGradeLocalV1("CONTEXT_CHANGED");
    const left = end - performance.now(); if (left <= 0) refuseShotGradeLocalV1("DEADLINE"); return left; };
  const ctx: ShotGradeLocalEvaluationContextV1 = { project: structuredClone(owner.project), request: structuredClone(owner.request), host: { ...owner.hostSnapshot }, signal,
    check, async read<T>(operation: () => Promise<T>) { check(); const value = await operation(); check(); return value; } };
  return { ctx, close: () => clearTimeout(timer) };
}
interface PreparedOwner { owner: Owner; fingerprint: string; evaluation: Evaluation; }
const prepared = new WeakMap<PreparedShotGradeLocalV1, PreparedOwner>();
export async function prepareShotGradeLocalV1(session: ProjectSession, payload: unknown, host: ShotGradeLocalHostV1, runtime: ShotGradeLocalRuntimeV1): Promise<PreparedShotGradeLocalV1> {
  const request = shotGradeLocalRequestV1Schema.parse(payload), owner = capture(session, request, host, runtime), active = job(owner, request.maximumTimeMs);
  try {
    active.ctx.check(); const evaluation = await evaluateShotGradeLocalV1(active.ctx); active.ctx.check();
    if (codeIdentity().identitySha256 !== owner.code.identitySha256) refuseShotGradeLocalV1("RUNTIME_CHANGED");
    const command: GradeCommand | null = evaluation.state === "ready" && evaluation.grade ? { type: "set_clip_grade_v2", clipId: request.target.clipId, grade: structuredClone(evaluation.grade) } : null;
    const packet: PreparedShotGradeLocalV1 = { schema: "editkin.shot-grade-local-proposal/v1", state: evaluation.state, mode: request.mode, projectId: owner.project.id,
      expectedRevision: request.expectedRevision, clipId: request.target.clipId, referenceClipId: request.mode === "shot_match" ? request.reference.clipId : null, reason: evaluation.reason,
      command, measurements: structuredClone(evaluation.measurements), numericalEvaluation: structuredClone(evaluation.numericalEvaluation),
      sourceBindings: evaluation.sources.map(s => ({ clipId: s.clipId, assetId: s.assetId, sourceSha256: s.sha256 })), codeIdentitySha256: owner.code.identitySha256,
      scope: "actual-source-clock-local-post-v2-before-spatial", regionAuthority: "caller-declared-not-classified", humanReview: "required", appearanceCertified: false,
      finalOutputMeasured: false, actualSixShotPerformanceVerified: false, vaContractAdmission: false, directApplyAllowed: false };
    prepared.set(packet, { owner, evaluation, fingerprint: canonicalJson(packet) }); return packet;
  } finally { active.close(); }
}
export function discardShotGradeLocalV1(packet: PreparedShotGradeLocalV1) { return prepared.delete(packet); }
export async function applyPreparedShotGradeLocalV1(session: ProjectSession, packet: PreparedShotGradeLocalV1, runtime?: ShotGradeLocalRuntimeV1) {
  const record = prepared.get(packet); prepared.delete(packet);
  if (!record || record.owner.session !== session || canonicalJson(packet) !== record.fingerprint) refuseShotGradeLocalV1("PROPOSAL_INVALID_OR_USED");
  const { owner, evaluation } = record; current(owner);
  if (packet.state === "not_applicable") refuseShotGradeLocalV1("NOT_APPLICABLE");
  const active = job(owner, owner.request.maximumTimeMs, runtime);
  try {
    if (codeIdentity().identitySha256 !== owner.code.identitySha256) refuseShotGradeLocalV1("RUNTIME_CHANGED");
    await verifyShotGradeLocalOriginalsV1(active.ctx, evaluation.sources);
    const identity = await active.ctx.read(() => getMaterialColorRuntimeIdentity({ ...owner.hostSnapshot, signal: active.ctx.signal, timeoutMs: active.ctx.check() }));
    if (identity.status !== "verified" || identity.identitySha256 !== evaluation.runtimeIdentity.identitySha256 || codeIdentity().identitySha256 !== owner.code.identitySha256) refuseShotGradeLocalV1("RUNTIME_CHANGED");
    active.ctx.check(); if (canonicalJson(packet) !== record.fingerprint) refuseShotGradeLocalV1("PROPOSAL_INVALID_OR_USED");
    if (packet.state === "unchanged") return { status: "unchanged" as const, undoSteps: 0 as const, clipId: packet.clipId };
    if (!packet.command) refuseShotGradeLocalV1("COMMAND_REQUIRED");
    const result = dispatchCommandSafely(session.getSnapshot().history, structuredClone(packet.command));
    if (result.error) refuseShotGradeLocalV1("COMMAND_REFUSED"); active.ctx.check();
    try { session.setHistory(result.state); } catch { refuseShotGradeLocalV1("APPLY_RESULT_UNCERTAIN"); }
    if (session.getSnapshot().history !== result.state) refuseShotGradeLocalV1("APPLY_RESULT_UNCERTAIN");
    return { status: "applied" as const, undoSteps: 1 as const, clipId: packet.clipId };
  } finally { active.close(); }
}
