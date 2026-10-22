import * as z from "zod/v4";
import { applyCommand } from "../domain/commands";
import type { EditorCommand } from "../domain/commandTypes";
import type { EditProject } from "../domain/types";
import { canonicalJson } from "../shared/canonicalJson";
import { assertAutoReframeVideoV1, assertPortraitReframeSizeV1, createAutoReframePortraitProjectV1, type ReframeNewProjectIdentityV1 } from "./autoReframePortraitProjectV1";
import type { prepareAutoReframeSparseSourceV2 } from "./autoReframeSparseSourceV2";

export type ReframePreparedV1 = Awaited<ReturnType<typeof prepareAutoReframeSparseSourceV2>>;
const id = z.string().min(1).max(160).refine(s => s.trim() === s), digest = z.string().regex(/^[a-f0-9]{64}$/);
const subject = z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("saliency") }),
  z.strictObject({ kind: z.literal("confirmed-matte-v2"), confirmationSha256: digest })]);
const newIdentity = z.strictObject({ id, name: z.string().trim().min(1).max(160), createdAt: z.string().max(64).refine(s => Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s) });
export const autoReframeRequestSchemaV1 = z.strictObject({ schema: z.literal("editkin.auto-reframe-request/v1"), operationId: id,
  sourceProjectId: id, sourceRevision: z.number().int().nonnegative(), sourceProjectSha256: digest, targetProjectSha256: digest,
  clipId: id, outputWidth: z.number().int().positive().max(16384), outputHeight: z.number().int().positive().max(16384), expectedSourceSha256: digest,
  subject, mode: z.enum(["current_portrait", "new_portrait_project"]), newProject: newIdentity.optional() }).superRefine((r, c) => {
  if ((r.mode === "new_portrait_project") !== !!r.newProject || r.outputWidth * 16 !== r.outputHeight * 9)
    c.addIssue({ code: "custom", message: "AUTO_REFRAME_REQUEST_MODE_OR_SIZE" });
});
export type AutoReframeRequestV1 = z.infer<typeof autoReframeRequestSchemaV1>;
export type AutoReframeSubjectV1 = AutoReframeRequestV1["subject"];
export type AutoReframeModeV1 = AutoReframeRequestV1["mode"];
export interface AutoReframeReplyV1 { schema: "editkin.auto-reframe-reply/v1"; request: AutoReframeRequestV1; prepared: ReframePreparedV1; }
export interface AutoReframeProgressV1 { stage: "verify" | "matte" | "source" | "finalize"; completed: number; total: number; }
export interface AutoReframeBeginOptionsV1 { operationId: string; mode: AutoReframeModeV1; outputWidth: number; outputHeight: number;
  subject: AutoReframeSubjectV1; newProject?: ReframeNewProjectIdentityV1; }
export interface AutoReframeJobV1 { readonly schema: "editkin.auto-reframe-job/v1"; readonly operationId: string; }
type JobState = { sourceJson: string; source: EditProject; target: EditProject; request: AutoReframeRequestV1; summary?: ReturnType<typeof createAutoReframePortraitProjectV1>["summary"]; signal?: AbortSignal; admitted?: boolean };
const jobs = new WeakMap<AutoReframeJobV1, JobState>();
export interface AutoReframePlanV1 { readonly schema: "editkin.auto-reframe-plan/v1"; readonly operationId: string; readonly mode: AutoReframeModeV1;
  readonly preview: { sourceWidth: number; sourceHeight: number; cropWidth: number; cropHeight: number;
    points: { time: number; x: number; y: number; jump: boolean }[]; central60Ratio: number | null; validSubjects: number; unknownFrames: number; frames: number;
    summary?: ReturnType<typeof createAutoReframePortraitProjectV1>["summary"] }; }
const plans = new WeakMap<AutoReframePlanV1, { job: AutoReframeJobV1; command: EditorCommand; status: "ready" | "applying" | "closed" }>();
export async function autoReframeProjectDigestV1(project: EditProject): Promise<string> {
  if (!globalThis.crypto?.subtle) throw Error("AUTO_REFRAME_DIGEST_UNAVAILABLE");
  const data = new TextEncoder().encode(canonicalJson(project)), hash = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return Array.from(hash, n => n.toString(16).padStart(2, "0")).join("");
}
/** Shared deterministic graph construction; Node performs the real source/target digest checks. */
export function autoReframeTargetV1(source: EditProject, request: Pick<AutoReframeRequestV1, "clipId" | "mode" | "newProject" | "outputWidth" | "outputHeight">) {
  assertPortraitReframeSizeV1(request.outputWidth, request.outputHeight); assertAutoReframeVideoV1(source, request.clipId);
  if (request.mode === "current_portrait") {
    if (source.width !== request.outputWidth || source.height !== request.outputHeight || request.newProject) throw Error("AUTO_REFRAME_CURRENT_PORTRAIT_REQUIRED");
    return { project: source, summary: undefined };
  }
  if (!request.newProject) throw Error("AUTO_REFRAME_NEW_IDENTITY_INVALID");
  return createAutoReframePortraitProjectV1(source, request.clipId, request.outputWidth, request.outputHeight, request.newProject);
}
function current(project: EditProject, job: AutoReframeJobV1) {
  const state = jobs.get(job); if (!state) throw Error("AUTO_REFRAME_JOB_FOREIGN"); state.signal?.throwIfAborted();
  if (canonicalJson(project) !== state.sourceJson) throw Error("AUTO_REFRAME_JOB_STALE"); return state;
}
export async function beginAutoReframeEditV1(project: EditProject, clipId: string, options: AutoReframeBeginOptionsV1, signal?: AbortSignal): Promise<AutoReframeJobV1> {
  signal?.throwIfAborted(); const sourceJson = canonicalJson(project), source = structuredClone(project), selected = assertAutoReframeVideoV1(source, clipId);
  const args = structuredClone(options), target = autoReframeTargetV1(source, { ...args, clipId });
  const [sourceProjectSha256, targetProjectSha256] = await Promise.all([autoReframeProjectDigestV1(source), autoReframeProjectDigestV1(target.project)]);
  signal?.throwIfAborted(); if (canonicalJson(project) !== sourceJson) throw Error("AUTO_REFRAME_JOB_STALE");
  const request = autoReframeRequestSchemaV1.parse({ schema: "editkin.auto-reframe-request/v1", ...args, clipId, sourceProjectId: source.id,
    sourceRevision: source.revision, sourceProjectSha256, targetProjectSha256, expectedSourceSha256: selected.asset.derivatives!.sourceSha256 });
  const job = Object.freeze({ schema: "editkin.auto-reframe-job/v1" as const, operationId: request.operationId });
  jobs.set(job, { sourceJson, source, target: target.project, request, summary: target.summary, signal }); return job;
}
export function autoReframeJobRequestV1(project: EditProject, job: AutoReframeJobV1) { return structuredClone(current(project, job).request); }
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const natural = (n: unknown): n is number => finite(n) && Number.isSafeInteger(n) && n >= 0;
const close = (a: number, b: number, e = 1e-8) => Math.abs(a - b) <= e;
/** Validate bounded backend data and only existing target-camera edits. No caller-supplied
 * JSON plan can mutate volume, sources, masks, grade, other clips or a different project. */
export function admitAutoReframePlanV1(project: EditProject, job: AutoReframeJobV1, reply: AutoReframeReplyV1): AutoReframePlanV1 {
  const state = current(project, job), request = state.request, target = state.target;
  if (!reply || reply.schema !== "editkin.auto-reframe-reply/v1" || canonicalJson(autoReframeRequestSchemaV1.parse(reply.request)) !== canonicalJson(request)) throw Error("AUTO_REFRAME_REPLY_BINDING_CHANGED");
  const r = reply.prepared;
  if (!r || !Array.isArray(r.commands) || r.commands.length < 1 || r.commands.length > 4096
    || !Array.isArray(r.frames) || r.frames.length > 8 || !Array.isArray(r.observations) || r.observations.length > 8) throw Error("AUTO_REFRAME_REPLY_BUDGET");
  const { clip, asset } = assertAutoReframeVideoV1(target, request.clipId), count = Math.round(clip.duration * target.fps), s = r.source;
  if (r.schema !== "editkin.auto-reframe-preparation/v2" || r.state !== "DRAFT_CANDIDATE" || r.projectSha256 !== request.targetProjectSha256
    || r.sourceSha256 !== request.expectedSourceSha256 || r.mutationPerformed !== false || r.subjectQualityCertified !== false || r.visualCertification !== "ART_PENDING_CLAUDE"
    || !s || s.assetId !== asset.id || s.clipId !== clip.id || s.uri !== asset.uri || s.sourceStart !== clip.sourceStart || s.duration !== clip.duration
    || ![s.width, s.height].every(v => Number.isSafeInteger(v) && v > 0 && v <= 16384)) throw Error("AUTO_REFRAME_REPLY_SOURCE_CHANGED");
  const ratio = s.width / s.height, outputRatio = target.width / target.height, scale = Math.max(ratio / outputRatio, outputRatio / ratio);
  const cropW = Math.min(1, outputRatio / ratio), cropH = Math.min(1, ratio / outputRatio), renderW = target.width / cropW, renderH = target.height / cropH;
  if (!r.crop || !close(r.crop.width, cropW) || !close(r.crop.height, cropH)
    || asset.displayAspectRatio !== undefined && !close(asset.displayAspectRatio, ratio, 1e-7)) throw Error("AUTO_REFRAME_REPLY_GEOMETRY");
  const c = r.compression, camera = r.camera, m = r.metrics;
  if (!c || c.method !== "online_feasible_slope_corridor/v1" || !finite(c.maximumPositionErrorPixels) || c.maximumPositionErrorPixels < .01 || c.maximumPositionErrorPixels > .25
    || c.maximumCommands !== 4096 || c.storedWholeObservationRows !== 0 || !natural(c.outputKeyframes) || c.outputKeyframes !== r.commands.length
    || !natural(c.maximumDiagnosticRows) || c.maximumDiagnosticRows > 8 || !natural(c.acceptedConstraints) || c.acceptedConstraints > count
    || !natural(c.sceneStarts) || c.sceneStarts < 1 || c.sceneStarts > count
    || !camera || !finite(camera.maximumPanSpeed) || camera.maximumPanSpeed <= 0 || camera.maximumPanSpeed > 2 || camera.sceneCutReset !== true
    || !finite(camera.deadZone) || camera.deadZone < 0 || camera.deadZone > .3 || !finite(camera.springFrequency) || camera.springFrequency < 1 || camera.springFrequency > 30
    || !m || m.observations !== count || ![m.validSubjects, m.unknownFrames, m.central60Frames, m.guaranteedCompressedCentral60Frames].every(natural)
    || m.validSubjects + m.unknownFrames !== count || m.central60Frames > m.validSubjects || m.guaranteedCompressedCentral60Frames > m.central60Frames
    || m.actualCompressedHumanCoverageCertified !== false) throw Error("AUTO_REFRAME_REPLY_METRICS");
  for (const [n, value] of [[m.central60Frames, m.measuredCentral60Ratio], [m.guaranteedCompressedCentral60Frames, m.guaranteedCompressedCentral60Ratio]] as const)
    if (m.validSubjects ? !finite(value) || !close(value, n / m.validSubjects, 1e-12) : value !== null) throw Error("AUTO_REFRAME_REPLY_METRICS");
  if (r.analysis?.modelsDownloaded !== 0 || r.analysis.rawMoviePixelFiles !== 0) throw Error("AUTO_REFRAME_REPLY_SOURCE_CHANGED");
  const tail = Math.min(8, count);
  if (!/^[a-f0-9]{64}$/.test(r.observationSha256) || r.frames.length !== tail || r.observations.length !== tail || c.maximumDiagnosticRows !== tail) throw Error("AUTO_REFRAME_REPLY_DIAGNOSTICS");
  for (let i = 0; i < tail; i++) {
    const o = r.observations[i], f = r.frames[i], frame = count - tail + i, b = o?.subject?.rect;
    if (!o || !f || o.frame !== frame || f.frame !== frame || !finite(o.time) || !close(o.time, frame / target.fps)
      || typeof o.sceneCut !== "boolean" || o.sceneCut !== f.sceneCut || !/^[a-f0-9]{64}$/.test(o.pixelSha256)
      || !finite(f.centerX) || !finite(f.centerY) || f.centerX < cropW / 2 - 1e-9 || f.centerX > 1 - cropW / 2 + 1e-9 || f.centerY < cropH / 2 - 1e-9 || f.centerY > 1 - cropH / 2 + 1e-9
      || o.subject && (!b || ![b.x, b.y, b.width, b.height].every(finite) || b.x < 0 || b.y < 0 || b.width <= 0 || b.height <= 0 || b.x + b.width > 1 + 1e-9 || b.y + b.height > 1 + 1e-9
        || !finite(o.subject.confidence) || o.subject.confidence < 0 || o.subject.confidence > 1 || !["matte", "saliency"].includes(o.subject.origin))) throw Error("AUTO_REFRAME_REPLY_DIAGNOSTICS");
  }
  const matte = r.analysis.matte;
  if (request.subject.kind === "confirmed-matte-v2") {
    if (!matte || !("subjectConfirmationSha256" in matte) || matte.subjectConfirmationSha256 !== request.subject.confirmationSha256
      || matte.sourceBinding !== "explicit_confirmed_v2_matte" || matte.saliencyFallbackOnLoss !== false) throw Error("AUTO_REFRAME_REPLY_MATTE_CHANGED");
  } else if (matte !== null) throw Error("AUTO_REFRAME_REPLY_MATTE_CHANGED");
  const points: AutoReframePlanV1["preview"]["points"] = []; let prior: Extract<EditorCommand, { type: "add_keyframe" }>["keyframe"] | undefined;
  for (const command of r.commands) {
    if (!command || command.type !== "add_keyframe" || command.clipId !== clip.id
      || canonicalJson(Object.keys(command).sort()) !== canonicalJson(["clipId", "keyframe", "type"])) throw Error("AUTO_REFRAME_REPLY_COMMAND");
    const k = command.keyframe;
    if (!k || canonicalJson(Object.keys(k).sort()) !== canonicalJson(["color", "easing", "id", "time", "transform"])) throw Error("AUTO_REFRAME_REPLY_COMMAND");
    const frame = Math.round(k.time * target.fps), t = k.transform;
    if (!finite(k.time) || frame < 0 || frame >= count || !close(k.time * target.fps, frame, 1e-6) || prior && k.time <= prior.time
      || k.id !== `reframe-v2-${clip.id}-${frame}` || !["linear", "hold"].includes(k.easing)
      || canonicalJson(k.color) !== canonicalJson(clip.color) || !t || ![t.x, t.y, t.scale].every(finite)
      || !close(t.scale, scale) || Math.abs(t.x) > (.5 - cropW / 2) * renderW + 1e-7 || Math.abs(t.y) > (.5 - cropH / 2) * renderH + 1e-7
      || canonicalJson({ ...t, x: clip.transform.x, y: clip.transform.y, scale: clip.transform.scale }) !== canonicalJson(clip.transform)) throw Error("AUTO_REFRAME_REPLY_COMMAND");
    if (prior && prior.easing !== "hold") {
      const dt = k.time - prior.time;
      if (Math.abs(t.x - prior.transform.x) > camera.maximumPanSpeed * renderW * dt + 1e-7
        || Math.abs(t.y - prior.transform.y) > camera.maximumPanSpeed * renderH * dt + 1e-7) throw Error("AUTO_REFRAME_REPLY_PAN");
    }
    points.push({ time: k.time, x: .5 - t.x / renderW, y: .5 - t.y / renderH, jump: prior?.easing === "hold" }); prior = k;
  }
  if (points[0].time !== 0 || !close(points.at(-1)!.time, (count - 1) / target.fps)) throw Error("AUTO_REFRAME_REPLY_ENDPOINTS");
  const command: EditorCommand = { type: "batch", commands: structuredClone(r.commands) }; applyCommand(target, command);
  const plan: AutoReframePlanV1 = Object.freeze({ schema: "editkin.auto-reframe-plan/v1" as const, operationId: request.operationId, mode: request.mode,
    preview: { sourceWidth: s.width, sourceHeight: s.height, cropWidth: cropW, cropHeight: cropH, points, central60Ratio: m.measuredCentral60Ratio,
      validSubjects: m.validSubjects, unknownFrames: m.unknownFrames, frames: count, ...(state.summary ? { summary: structuredClone(state.summary) } : {}) } });
  if (state.admitted) throw Error("AUTO_REFRAME_JOB_ALREADY_ADMITTED");
  state.admitted = true; plans.set(plan, { job, command, status: "ready" }); return plan;
}
export type AutoReframeApplicationV1 = { kind: "command"; command: EditorCommand; expectedRevision: number }
  | { kind: "new_project"; baseProject: EditProject; command: EditorCommand; expectedSourceId: string; expectedSourceRevision: number };
export function takeAutoReframeApplicationV1(project: EditProject, plan: AutoReframePlanV1): AutoReframeApplicationV1 {
  const p = plans.get(plan); if (!p || p.status !== "ready") throw Error("AUTO_REFRAME_PLAN_USED_OR_FOREIGN");
  const state = current(project, p.job); p.status = "applying";
  return state.request.mode === "current_portrait" ? { kind: "command", command: structuredClone(p.command), expectedRevision: state.source.revision }
    : { kind: "new_project", baseProject: structuredClone(state.target), command: structuredClone(p.command), expectedSourceId: state.source.id, expectedSourceRevision: state.source.revision };
}
export function settleAutoReframeApplicationV1(plan: AutoReframePlanV1, cancelledBeforeCommit = false) {
  const p = plans.get(plan); if (!p || p.status !== "applying") throw Error("AUTO_REFRAME_PLAN_NOT_APPLYING"); p.status = cancelledBeforeCommit ? "ready" : "closed";
}
