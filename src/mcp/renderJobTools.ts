import type { McpServer } from "@modelcontextprotocol/server";
import { lstat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import * as z from "zod/v4";
import { capJobPayload, JobError, JobRegistry, JOB_ERROR_CODE_PATTERN, JOB_ID_PATTERN, type JobFailure, type JobTracker, type JobView } from "../application/jobRegistry";
import { addProgressSample, estimateRemainingMs, EXPORT_STEPS, exportStepIndex, parseRenderProgress, type ProgressSample } from "../application/renderProgressModel";
import type { EditProject } from "../domain/types";
import type { MediaProbe } from "../render/ffmpegContracts";
import { probeMedia } from "../render/mediaProcess";
import { RenderDiskSpaceError } from "../render/renderDiskSpace";
import { withRenderEncoderNotes, type RenderEncoderNote } from "../render/renderEncoderNotes";
import { withRenderProgress, type RenderProgressSnapshot } from "../render/renderProgress";
import { bindProjectMediaForRender } from "./renderMediaBinding";
import { readProject, resolveRenderPath, workspaceRoot, WorkspaceBoundaryError } from "./storage";

/**
 * MCP side of the W2-4 job registry: `render_project {async:true}` and the Agent API v5 `job` tool (status / cancel /
 * list). The render itself is today's `renderAutopilotProject` (injected by renderTools.ts), so the async route renders
 * exactly what the synchronous call renders, through the same long-render runner, `.part` publish, watchdog and
 * cancellation. Every response stays under MCP_JOB_RESPONSE_MAX_BYTES.
 */
export const MCP_JOB_RESPONSE_MAX_BYTES = 2_048;
export const RENDER_JOB_KIND = "render";

type RenderCall = (projectPath: string, outputPath: string, preferGpu: boolean, verifiedProject: EditProject, signal: AbortSignal)
  => Promise<{ content: Array<{ type: "text"; text: string }> }>;

export interface RenderJobRequest { projectPath: string; outputPath: string; preferGpu: boolean; overwrite?: boolean }

/** Jobs live next to the other MCP job state (the autopilot batch owner root): the app cache, or the workspace's cache. */
export function mcpJobRoot(environment: NodeJS.ProcessEnv = process.env): string {
  return resolve(environment.EDITKIN_CACHE_ROOT ?? join(workspaceRoot(), ".editkin-cache"), "jobs-v1");
}

const registries = new Map<string, JobRegistry>();
export function mcpJobRegistry(): JobRegistry {
  const root = mcpJobRoot();
  let registry = registries.get(root);
  if (!registry) { registry = new JobRegistry(root, { concurrency: { [RENDER_JOB_KIND]: 1 } }); registries.set(root, registry); }
  return registry;
}

/** W2-5: material preparation and autopilot batch mirror their jobs here, so `job` lists and stops every kind. */
export const mcpJobTracker: JobTracker = { attach: attachment => mcpJobRegistry().attach({ scope: workspaceRoot(), ...attachment }) };

/** Tests only: stop (optionally cancel) every registry and forget it, as a restarted server would. */
export async function resetMcpJobRegistriesForTest(input: { cancel?: boolean } = {}): Promise<void> {
  const all = [...registries.values()];
  registries.clear();
  await Promise.all(all.map(registry => registry.close(input)));
}

function bounded(payload: Record<string, unknown>, isError = false) {
  let text = JSON.stringify(payload);
  if (Buffer.byteLength(text, "utf8") > MCP_JOB_RESPONSE_MAX_BYTES) text = JSON.stringify(capJobPayload(payload, MCP_JOB_RESPONSE_MAX_BYTES));
  return { content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) };
}

/** An error's own stable code (JobError, OUTSIDE_MEDIA_NOT_GRANTED…) when it has one; Node errno codes (ENOENT…) are not. */
function ownCode(error: unknown): string | undefined {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && JOB_ERROR_CODE_PATTERN.test(code) && !/^E[A-Z]+$/.test(code) ? code : undefined;
}

export function jobBlockResult(error: unknown) {
  const code = ownCode(error) ?? (error instanceof WorkspaceBoundaryError ? "WORKSPACE_BOUNDARY" : "BLOCK");
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 600);
  return bounded({ status: "BLOCK", code, error: message }, true);
}

const workspacePath = (absolute: string) => relative(workspaceRoot(), absolute).replaceAll("\\", "/");
const samePath = (left: string, right: string) => process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits;

async function existingOutput(path: string): Promise<"file" | "other" | undefined> {
  try { return (await lstat(path)).isFile() ? "file" : "other"; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** The synchronous route's opt-in guard: `overwrite:false` refuses an existing file instead of replacing it. */
export async function assertRenderOutputAbsent(outputPath: string): Promise<void> {
  const output = await resolveRenderPath(outputPath);
  if (await existingOutput(output)) throw new JobError("OUTPUT_EXISTS", `輸出檔已存在：${workspacePath(output)}。要取代請傳 overwrite:true，或換一個 outputPath。`);
}

/** True when the synchronous route is about to replace a file (reported in its response; it never refuses). */
export async function renderOutputExists(outputPath: string): Promise<boolean> {
  try { return Boolean(await existingOutput(await resolveRenderPath(outputPath))); }
  catch { return false; }
}

/** The synchronous route keeps replacing an existing file (VA v4 re-renders `_out/current.mp4`), but says so. */
export function withOutputReplacedNote<T>(result: T): T {
  const content = (result as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content;
  const first = content?.[0];
  if (!content || first?.type !== "text" || typeof first.text !== "string") return result;
  try {
    const payload = JSON.parse(first.text) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return result;
    return { ...result, content: [{ ...first, text: JSON.stringify({ ...payload, outputReplaced: true }) }, ...content.slice(1)] } as T;
  } catch { return result; }
}

interface RenderedPayload {
  outputPath: string;
  duration: number;
  encoder?: string;
  planner?: string;
  artifactIdentity?: { outputSha256: string; bytes: number; fps: number; durationFrames: number };
  longRender?: unknown;
}

/** NVENC/VideoToolbox → x264/x265 only; ProRes, FFV1 and a CPU-only platform are not fallbacks. */
export function renderEncoderFallback(preferGpu: boolean, encoder: string | undefined, notes: readonly RenderEncoderNote[], platform: NodeJS.Platform = process.platform) {
  if (!preferGpu || (encoder !== "libx264" && encoder !== "libx265")) return undefined;
  const family = platform === "win32" ? "nvenc" : platform === "darwin" ? "videotoolbox" : undefined;
  if (!family) return undefined;
  const note = notes[0];
  return {
    preferred: note?.encoder ?? `${encoder === "libx265" ? "hevc" : "h264"}_${family}`,
    used: encoder,
    reason: note?.code ?? "software_route",
    ...(note?.detail ? { detail: note.detail } : {}),
  };
}

/** The finished render in about 1 KB: where, how long, what the file really is, and anything to look at. */
export function compactRenderResult(input: { rendered: RenderedPayload; probe?: MediaProbe; notes: readonly RenderEncoderNote[]; preferGpu: boolean;
  replaced: boolean; renderMs: number; platform?: NodeJS.Platform }) {
  const { rendered, probe, notes } = input;
  const identity = rendered.artifactIdentity;
  const fallback = renderEncoderFallback(input.preferGpu, rendered.encoder, notes, input.platform);
  const probeFps = probe?.frameRate ? probe.frameRate.numerator / probe.frameRate.denominator : undefined;
  const warnings: string[] = [];
  if (fallback) warnings.push("encoder_fallback");
  if (!identity) warnings.push("identity_unverified");
  if (!probe) warnings.push("probe_unavailable");
  else {
    if (!probe.hasVideo) warnings.push("no_video_stream");
    if (!probe.hasAudio) warnings.push("no_audio_stream");
    if (Number.isFinite(probe.duration) && Math.abs(probe.duration - rendered.duration) > 0.1) warnings.push("duration_differs_from_render");
  }
  if (input.replaced) warnings.push("output_replaced");
  return {
    status: "GREEN",
    outputPath: rendered.outputPath,
    ...(identity ? { bytes: identity.bytes, sha256: identity.outputSha256 } : {}),
    duration: round(rendered.duration, 3),
    probe: probe ? {
      video: probe.codecName ?? null,
      width: probe.width ?? null,
      height: probe.height ?? null,
      fps: identity ? round(identity.fps, 3) : probeFps !== undefined ? round(probeFps, 3) : null,
      frames: identity?.durationFrames ?? null,
      audio: probe.audioCodecName ?? null,
      pixelFormat: probe.pixelFormat ?? null,
    } : null,
    encoder: rendered.encoder ?? null,
    ...(fallback ? { encoderFallback: fallback } : {}),
    route: rendered.longRender ? "long" : "short",
    ...(rendered.planner ? { planner: rendered.planner.length > 120 ? `${rendered.planner.slice(0, 117)}…` : rendered.planner } : {}),
    warnings,
    qualityCertified: false,
    renderSeconds: round(input.renderMs / 1000, 1),
  };
}

export function classifyRenderJobError(error: unknown): JobFailure {
  const message = (error instanceof Error ? error.message : String(error)) || "影片輸出失敗";
  const code = ownCode(error)
    ?? (error instanceof WorkspaceBoundaryError ? "WORKSPACE_BOUNDARY"
      : error instanceof RenderDiskSpaceError || /ENOSPC/.test(message) ? "DISK_SPACE"
        : message.startsWith("影片輸出停滯") ? "RENDER_STALLED"
          : message.startsWith("影片輸出總時間逾時") ? "RENDER_DEADLINE"
            : message.startsWith("輸出 QA 失敗") ? "OUTPUT_QA_FAILED"
              : "RENDER_FAILED");
  return { code, message: message.slice(0, 400) };
}

/**
 * Checks what can be checked at once (workspace paths, the project parses, the overwrite rule, one job per output
 * file), then queues the render and returns its job without waiting for it. The project is read now: the job renders
 * the project as it was when the job was accepted.
 */
export async function startRenderJob(request: RenderJobRequest, render: RenderCall): Promise<JobView> {
  const output = await resolveRenderPath(request.outputPath);
  const outputLabel = workspacePath(output);
  const project = await readProject(request.projectPath);
  // Refuse ungranted or missing outside media now; the render binds the canonical paths again when it starts.
  await bindProjectMediaForRender(project);
  const existing = await existingOutput(output);
  if (existing === "other") throw new JobError("OUTPUT_NOT_FILE", `輸出路徑已被資料夾或其他項目占用：${outputLabel}`);
  if (existing && request.overwrite !== true) {
    throw new JobError("OUTPUT_EXISTS", `輸出檔已存在：${outputLabel}。要取代請傳 overwrite:true，或換一個 outputPath。`);
  }
  const registry = mcpJobRegistry();
  const busy = (await registry.list({ kind: RENDER_JOB_KIND, limit: 64 }))
    .find(job => (job.state === "queued" || job.state === "running" || job.state === "cancelling") && job.label?.outputPath && samePath(job.label.outputPath, outputLabel));
  if (busy) throw new JobError("OUTPUT_BUSY", `另一個輸出工作（${busy.jobId}）正在寫同一個檔案：${outputLabel}`);

  return registry.submit({
    kind: RENDER_JOB_KIND,
    scope: workspaceRoot(),
    label: { projectPath: request.projectPath, outputPath: outputLabel },
    classifyError: classifyRenderJobError,
    run: async ({ signal, progress }) => {
      // Checked again when the job starts: a file may have appeared while it waited in the queue.
      const replaced = Boolean(await existingOutput(output));
      if (replaced && request.overwrite !== true) throw new JobError("OUTPUT_EXISTS", `輸出檔已存在：${outputLabel}。要取代請傳 overwrite:true。`);
      let samples: ProgressSample[] = [];
      const sink = (snapshot: RenderProgressSnapshot) => {
        const view = parseRenderProgress(snapshot);
        if (!view) return;
        samples = addProgressSample(samples, view, Date.now());
        const remainingMs = estimateRemainingMs(samples);
        const step = exportStepIndex(view.stage);
        progress({
          stage: view.stage,
          ...(view.fraction !== undefined ? { fraction: round(view.fraction, 3) } : {}),
          ...(remainingMs !== undefined ? { etaSeconds: Math.ceil(remainingMs / 1000) } : {}),
          ...(step >= 0 ? { step: step + 1, steps: EXPORT_STEPS.length } : {}),
          ...(view.part !== undefined && view.parts !== undefined ? { part: view.part, parts: view.parts } : {}),
        });
      };
      const startedAt = Date.now();
      const { value: response, notes } = await withRenderProgress(sink, () =>
        withRenderEncoderNotes(() => render(request.projectPath, request.outputPath, request.preferGpu, project, signal)));
      const rendered = JSON.parse(response.content[0].text) as RenderedPayload;
      const probe = await probeMedia(rendered.outputPath, process.env.HAO_FFPROBE_PATH ?? "ffprobe").catch(() => undefined);
      return compactRenderResult({ rendered, probe, notes, preferGpu: request.preferGpu, replaced, renderMs: Date.now() - startedAt });
    },
  });
}

/** The immediate answer of `render_project {async:true}`. */
export async function startRenderJobResult(request: RenderJobRequest, render: RenderCall) {
  try {
    const job = await startRenderJob(request, render);
    return bounded({ status: "ACCEPTED", jobId: job.jobId, kind: job.kind, state: job.state, outputPath: job.label?.outputPath ?? request.outputPath,
      pollAfterMs: job.pollAfterMs ?? 5_000, next: "job {op:\"status\", jobId}" });
  } catch (error) { return jobBlockResult(error); }
}

const jobInputSchema = z.strictObject({
  op: z.enum(["status", "cancel", "list"]),
  jobId: z.string().regex(JOB_ID_PATTERN).optional(),
  limit: z.number().int().min(1).max(10).optional(),
});

/** Agent API v5 slot `job` (mcpProfiles V5_TOOL_SLOTS): advertised in the compat and v5 profiles once registered. */
export function registerJobTool(server: McpServer): void {
  server.registerTool("job", {
    description: "長時間工作：render（render_project async）、material_prep、batch。status：state、progress{stage,fraction,etaSeconds}、result或error{code}；cancel停止；list最近工作。依pollAfterMs輪詢，≤2KB，重啟後可查。",
    inputSchema: jobInputSchema,
  }, async ({ op, jobId, limit }) => {
    try {
      const registry = mcpJobRegistry();
      if (op === "list") {
        const jobs = await registry.list({ scope: workspaceRoot(), limit: limit ?? 10 });
        return bounded({ jobs: jobs.map(job => ({ jobId: job.jobId, kind: job.kind, state: job.state, ...(job.ownerJobId ? { ownerJobId: job.ownerJobId } : {}),
          ...(job.label?.outputPath ? { outputPath: job.label.outputPath } : {}),
          ...(job.progress ? { stage: job.progress.stage } : {}), ...(job.error ? { errorCode: job.error.code } : {}), createdAt: job.createdAt,
          ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}) })) });
      }
      if (!jobId) throw new JobError("JOB_ID_REQUIRED", `op=${op} 需要 jobId`);
      const job = op === "cancel" ? await registry.cancel(jobId) : await registry.status(jobId);
      return bounded({ ...job });
    } catch (error) { return jobBlockResult(error); }
  });
}
