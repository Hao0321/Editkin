import { Console } from "node:console";
import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import * as z from "zod/v4";
import { canonicalJson } from "../shared/canonicalJson";
import { materialColorCodeIdentity } from "../application/materialColorCodeIdentity";
import { assertVideoAutopilotKitInstalled } from "../application/autopilotInvocationIdentity";
import { TEMPLATE_SHORT_BRIEF_MAX_BYTES, TEMPLATE_SHORT_BRIEF_SCHEMA, TEMPLATE_SHORT_GENRE_IDS, TEMPLATE_SHORT_START_SCHEMA,
  TemplateShortBlockError, type TemplateShortCopy } from "../application/templateShortBrief";
import { TEMPLATE_SHORT_ROOT, makeTemplateShort, startTemplateShort, type TemplateShortDeps, type TemplateShortResult,
  type TemplateShortStartResponse } from "../application/templateShortRun";
import { TEMPLATE_SHORT_DEFAULTS_PATH, TEMPLATE_SHORT_DEFAULTS_SCHEMA, readTemplateShortDefaults, templateShortDefaultsSchema } from "../application/templateShortWorkspace";

/**
 * In-app template Shorts (M1 wave 4.2; Hao 2026-10-09: the in-app one-click is an official path). The desktop starts one
 * owned child per job with the closed environment it builds (src-tauri/src/template_short.rs): one request on stdin,
 * one JSON envelope on stdout, progress in a small file the desktop polls (its no-progress watchdog also watches the
 * run folder). The run is the same orchestrator the MCP tools call (templateShortRun), in "in_app" mode.
 *
 * Host: preparing material reads the material-colour code identity (materialColorCodeIdentity), and only the MCP bundle
 * carries it (mcp.mjs + mcp.mjs.material-color-identity.json, staged as a pair for release). The desktop therefore starts
 * `node mcp.mjs --editkin-one-shot`. service/cli.ts routes the same commands here; in a bundle without that identity the
 * run refuses before anything is created.
 *
 * Honesty: the creator typed every word (M10: their own numbers are creator_declared). Nobody described the served
 * keyframes, so each seen line says exactly that and the semantics read 「創作者描述：未描述，畫面只用於時間定位（非 AI 判讀）」.
 */
export const EDITKIN_ONE_SHOT_FLAG = "--editkin-one-shot";
export const TEMPLATE_SHORT_SERVICE_COMMANDS = ["template_short_run", "template_short_write_defaults"] as const;
export type TemplateShortServiceCommand = typeof TEMPLATE_SHORT_SERVICE_COMMANDS[number];
export const TEMPLATE_SHORT_IN_APP_SCHEMA = "editkin.template-short-in-app/v1" as const;
export const TEMPLATE_SHORT_PROGRESS_SCHEMA = "editkin.template-short-progress/v1" as const;
export const TEMPLATE_SHORT_DEFAULTS_WRITE_SCHEMA = "editkin.template-short-defaults-write/v1" as const;
/** The seen line of every served keyframe in-app: the frames only place the semantics in time. */
export const TEMPLATE_SHORT_IN_APP_SEEN_NOTE = "未描述，畫面只用於時間定位（非 AI 判讀）";
/** Statuses that deliver output.mp4 (templateShortRun keeps the same set). */
const DELIVERED_STATUSES = new Set(["NEEDS_FIX", "REVIEW_REQUIRED", "SPOT_CHECK_DUE", "READY"]);
const MAX_FRAME_PAGES = 16;
const MAX_REQUEST_BYTES = 64 * 1024;

export const isTemplateShortServiceCommand = (value: unknown): value is TemplateShortServiceCommand =>
  typeof value === "string" && (TEMPLATE_SHORT_SERVICE_COMMANDS as readonly string[]).includes(value);

/** The desktop's run request. Copy lengths are bounded here and checked exactly by the brief schema (BLOCK_BRIEF). */
export const templateShortInAppRunSchema = z.strictObject({
  sourcePath: z.string().trim().min(1).max(1_024),
  genre: z.enum(TEMPLATE_SHORT_GENRE_IDS),
  copy: z.strictObject({
    payoff: z.string().max(64),
    hook: z.string().max(64).optional(),
    points: z.array(z.string().max(64)).max(4).optional(),
  }),
  progressPath: z.string().min(1).max(4_096).refine(path => isAbsolute(path), "progressPath 必須是絕對路徑"),
});
export type TemplateShortInAppRun = z.output<typeof templateShortInAppRunSchema>;

export interface TemplateShortInAppResult {
  schema: typeof TEMPLATE_SHORT_IN_APP_SCHEMA;
  /** The orchestrator's status (READY … NEEDS_FIX, RENDER_FAILED_PROJECT_APPLIED, BLOCK_*). */
  status: string;
  /** output.mp4 exists and may be shown and saved (Hao 2026-10-09: an art flag still delivers). */
  delivered: boolean;
  shortId?: string;
  runDir?: string;
  projectPath?: string;
  outputPath?: string;
  outputSha256?: string;
  /** Which part of the clip was used: the first `seconds`, cut at 15 s when the clip is longer (`clamped`). */
  window?: { start: number; end: number; seconds: number; clamped: boolean };
  /** Art flags to show as 「第 N 秒」. */
  flags: Array<{ check: string; seconds: number[] }>;
  block?: { code: string; detail: string; field?: string };
  detail?: string;
}

// ---- Progress ----------------------------------------------------------------------------------------------------------
export type TemplateShortStep = 0 | 1 | 2 | 3;
export interface TemplateShortProgress { step: TemplateShortStep; fraction: number; shortId?: string; runDir?: string }
export type TemplateShortProgressSink = (progress: TemplateShortProgress) => void;

async function writeJsonAtomic(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx");
  try { await handle.writeFile(JSON.stringify(value), "utf8"); }
  finally { await handle.close(); }
  try { await rename(temporary, path); }
  catch (error) { await rm(temporary, { force: true }); throw error; }
}

/** Forward-only progress, written atomically for the desktop to poll. A failed write never fails the run. */
export function createTemplateShortProgressFile(path: string, now: () => Date = () => new Date()) {
  let current: TemplateShortProgress = { step: 0, fraction: 0 };
  let writing: Promise<void> = Promise.resolve();
  const sink: TemplateShortProgressSink = next => {
    const fraction = Number.isFinite(next.fraction) ? Math.min(1, Math.max(0, next.fraction)) : 0;
    const forward = next.step > current.step || (next.step === current.step && fraction >= current.fraction);
    current = { ...current, ...(forward ? { step: next.step, fraction } : {}), ...(next.shortId ? { shortId: next.shortId } : {}),
      ...(next.runDir ? { runDir: next.runDir } : {}) };
    const snapshot = { schema: TEMPLATE_SHORT_PROGRESS_SCHEMA, ...current, updatedAt: now().toISOString() };
    writing = writing.then(() => writeJsonAtomic(path, snapshot)).catch(() => undefined);
  };
  return { sink, flush: () => writing, current: () => ({ ...current }) };
}

/** Reports the four plain steps (看你的影片 → 加上標題和動畫 → 做成影片 → 最後檢查一次) from the boundaries the run already
 * crosses. Values flow through untouched: the audit receipt still reaches apply by identity. */
export function trackTemplateShortDeps(deps: TemplateShortDeps, report: (step: TemplateShortStep, fraction: number) => void): TemplateShortDeps {
  return {
    ...deps,
    prepareBootstrap: input => { report(0, 0.15); return deps.prepareBootstrap(input); },
    prepareMaterial: request => { report(0, 0.35); return deps.prepareMaterial(request); },
    recordSemantics: input => { report(1, 0.05); return deps.recordSemantics(input); },
    compileTemplate: (projectPath, input) => { report(1, 0.25); return deps.compileTemplate(projectPath, input); },
    compileDesign: (request, policy) => { report(1, 0.5); return deps.compileDesign(request, policy); },
    prepareBatch: async (batchPath, options) => {
      report(1, 0.7);
      const prepared = await deps.prepareBatch(batchPath, options), runtime = prepared.runtime;
      return { ...prepared, runtime: { ...runtime,
        audit: (item, plan) => { report(1, 0.8); return runtime.audit(item, plan); },
        apply: (item, plan, audit) => { report(1, 0.9); return runtime.apply(item, plan, audit); },
        render: (item, candidate) => { report(2, 0.05); return runtime.render(item, candidate); },
        verifyRender: (item, candidate) => { report(3, 0.25); return runtime.verifyRender(item, candidate); },
      } };
    },
  };
}

// ---- The run ---------------------------------------------------------------------------------------------------------
/** The run folder startTemplateShort creates for a shortId (templateShortRun's runDirOf; the in-app test checks they agree). */
export const templateShortRunDir = (shortId: string) => `${TEMPLATE_SHORT_ROOT}/${shortId.slice(3)}`;
const keyframeNumber = (id: string) => Number(/^kf-(\d+)$/.exec(id)?.[1] ?? Number.MAX_SAFE_INTEGER);
const briefBytes = (value: unknown) => new TextEncoder().encode(canonicalJson(value)).byteLength;

/** The brief for creator-typed copy: 原本以為 → 其實是 (strike_reframe), or 2–4 points (context_stack). The topic restates
 * the creator's words and is left to the engine's default when it would push the brief over 1 KB. */
export function inAppTemplateShortBrief(shortId: string, frames: readonly string[], copy: TemplateShortInAppRun["copy"]) {
  const payoff = copy.payoff.trim(), hook = copy.hook?.trim();
  const shaped: TemplateShortCopy = hook ? { hook, payoff }
    : { payoff, points: (copy.points ?? []).map(point => point.trim()).filter(Boolean).map(label => ({ label })) };
  const seen = [...new Set(frames)].sort((a, b) => keyframeNumber(a) - keyframeNumber(b)).map(kf => ({ kf, note: TEMPLATE_SHORT_IN_APP_SEEN_NOTE }));
  const brief = { schema: TEMPLATE_SHORT_BRIEF_SCHEMA, shortId, seen, copy: shaped };
  const topic = hook ? `${hook}→${payoff}` : payoff;
  const withTopic = { ...brief, topic };
  return topic && topic.length <= 120 && briefBytes(withTopic) <= TEMPLATE_SHORT_BRIEF_MAX_BYTES ? withTopic : brief;
}

function windowOf(value: unknown): TemplateShortInAppResult["window"] {
  const window = value as { in?: unknown; out?: unknown; seconds?: unknown; note?: unknown } | undefined;
  if (!window || typeof window.in !== "number" || typeof window.out !== "number" || typeof window.seconds !== "number") return undefined;
  return { start: window.in, end: window.out, seconds: window.seconds, clamped: typeof window.note === "string" };
}
const pendingOf = (text: Record<string, unknown>) => (Array.isArray(text.framesPending) ? text.framesPending : []).map(String);
type Base = Pick<TemplateShortInAppResult, "shortId" | "runDir" | "window">;

export function blockedTemplateShortResult(error: TemplateShortBlockError, base: Base = {}): TemplateShortInAppResult {
  return { schema: TEMPLATE_SHORT_IN_APP_SCHEMA, status: error.code, delivered: false, ...base, flags: [],
    block: { code: error.code, detail: error.detail, ...(error.field ? { field: error.field } : {}) } };
}

/** The ≤20 KB orchestrator result reduced to what the in-app screens show. */
export function compactTemplateShortResult(result: TemplateShortResult, base: Base = {}): TemplateShortInAppResult {
  const status = String(result.status), output = result.output as { path?: unknown; sha256?: unknown } | undefined;
  const delivered = DELIVERED_STATUSES.has(status) && typeof output?.path === "string";
  const checks = (result.qa as { checks?: unknown } | undefined)?.checks;
  const flags = (Array.isArray(checks) ? checks : []).flatMap(check => {
    const row = check as { id?: unknown; pass?: unknown; severity?: unknown; seconds?: unknown } | null;
    if (!row || row.pass !== false || row.severity !== "FLAG") return [];
    const seconds = (Array.isArray(row.seconds) ? row.seconds : []).filter((second): second is number => typeof second === "number" && Number.isFinite(second) && second >= 0);
    return [{ check: String(row.id), seconds }];
  });
  const block = result.block as { code?: unknown; detail?: unknown; field?: unknown } | undefined;
  return {
    schema: TEMPLATE_SHORT_IN_APP_SCHEMA, status, delivered, ...base,
    ...(typeof result.projectPath === "string" ? { projectPath: result.projectPath } : {}),
    ...(delivered ? { outputPath: output!.path as string, ...(typeof output!.sha256 === "string" ? { outputSha256: output!.sha256 } : {}) } : {}),
    flags,
    ...(block && typeof block.code === "string" ? { block: { code: block.code, detail: String(block.detail ?? ""), ...(typeof block.field === "string" ? { field: block.field } : {}) } } : {}),
    ...(typeof result.detail === "string" ? { detail: result.detail.slice(0, 600) } : {}),
  };
}

export interface TemplateShortInAppEngine { start: typeof startTemplateShort; make: typeof makeTemplateShort }
/** start (bootstrap, keyframes) → every frame page served → make with the creator's copy, all in this process. */
export async function runTemplateShortInApp(raw: unknown, deps: TemplateShortDeps, progress: TemplateShortProgressSink,
  engine: TemplateShortInAppEngine = { start: startTemplateShort, make: makeTemplateShort }): Promise<TemplateShortInAppResult> {
  const request = templateShortInAppRunSchema.parse(raw);
  const report = (step: TemplateShortStep, fraction: number) => progress({ step, fraction });
  const tracked = trackTemplateShortDeps(deps, report), options = { mode: "in_app", provider: "other" } as const;
  report(0, 0);
  let page: TemplateShortStartResponse;
  try { page = await engine.start({ schema: TEMPLATE_SHORT_START_SCHEMA, source: { path: request.sourcePath }, genre: request.genre }, tracked, options); }
  catch (error) { if (error instanceof TemplateShortBlockError) return blockedTemplateShortResult(error); throw error; }
  const shortId = String(page.text.shortId), base: Base = { shortId, runDir: templateShortRunDir(shortId), window: windowOf(page.text.window) };
  progress({ step: 0, fraction: 0.6, shortId, runDir: base.runDir });
  const served = page.images.map(image => image.id);
  try {
    for (let next = 2; pendingOf(page.text).length; next++) {
      if (next > MAX_FRAME_PAGES) throw new TemplateShortBlockError("BLOCK_START", "關鍵畫面的頁數超出上限");
      page = await engine.start({ schema: TEMPLATE_SHORT_START_SCHEMA, shortId, framePage: next }, tracked, options);
      served.push(...page.images.map(image => image.id));
    }
    report(0, 0.9);
    const result = await engine.make(inAppTemplateShortBrief(shortId, served, request.copy), tracked, { ...options, wait: true });
    report(3, 1);
    return compactTemplateShortResult(result, base);
  } catch (error) {
    if (error instanceof TemplateShortBlockError) return blockedTemplateShortResult(error, base);
    throw error;
  }
}

// ---- The one-time defaults file (Hao decision §13-1; written only after the creator's explicit click) -----------------
export const templateShortDefaultsWriteSchema = z.strictObject({
  /** Set only by the 「是，這是我自己拍的素材」 click; nothing else may write the file. */
  confirmedByCreatorClick: z.literal(true),
  scope: z.string().trim().min(1).max(512),
  scopeKind: z.enum(["folder", "file"]),
  brandMark: z.string().trim().max(32).optional(),
});

/** Creates `.autopilot/template-short-defaults.json` once: validated by the same schema that reads it, created exclusively
 * (an existing file is never replaced), then read back. */
export async function writeTemplateShortDefaultsInApp(raw: unknown, root: string, now: () => Date = () => new Date()) {
  const request = templateShortDefaultsWriteSchema.parse(raw);
  const what = request.scopeKind === "folder" ? `「${request.scope}」資料夾裡的影片` : `影片「${request.scope}」`;
  const defaults = templateShortDefaultsSchema.parse({
    schema: TEMPLATE_SHORT_DEFAULTS_SCHEMA,
    rights: [{ scope: request.scope, declaration: {
      provenance: `創作者在 Editkin 按下「是，這是我自己拍的素材」，確認${what}是自己拍的`,
      rightsBasis: "創作者確認是自己拍攝的素材",
      distributionScope: "創作者自己的作品",
      license: "creator-owned",
    } }],
    excludedSources: [],
    ...(request.brandMark ? { brandMark: request.brandMark } : {}),
    confirmedBy: "creator",
    confirmedAt: now().toISOString(),
  });
  const canonicalRoot = await realpath(root), directory = resolve(canonicalRoot, ".autopilot");
  const entry = await lstat(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink() || relative(canonicalRoot, await realpath(directory)).toLowerCase() !== ".autopilot") {
    throw new Error(".autopilot 必須是工作資料夾裡的真實資料夾（不可是連結）");
  }
  const target = resolve(directory, "template-short-defaults.json"), temporary = resolve(directory, `.template-short-defaults.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx");
  try {
    try { await handle.writeFile(`${JSON.stringify(defaults, null, 2)}\n`, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    // A hard link never replaces an existing file: whoever wrote first wins and nothing is overwritten.
    try { await link(temporary, target); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return { schema: TEMPLATE_SHORT_DEFAULTS_WRITE_SCHEMA, written: false, exists: true, path: TEMPLATE_SHORT_DEFAULTS_PATH };
      throw error;
    }
  } finally { await rm(temporary, { force: true }); }
  const { sha256 } = await readTemplateShortDefaults(canonicalRoot);
  return { schema: TEMPLATE_SHORT_DEFAULTS_WRITE_SCHEMA, written: true, exists: true, path: TEMPLATE_SHORT_DEFAULTS_PATH, sha256 };
}

// ---- One-shot dispatch -------------------------------------------------------------------------------------------------
let consoleRedirected = false;
/** stdout carries exactly one JSON envelope; diagnostics go to stderr. */
export function redirectConsoleToStderr() {
  if (consoleRedirected) return;
  consoleRedirected = true;
  const diagnostics = new Console({ stdout: process.stderr, stderr: process.stderr });
  console.log = diagnostics.log.bind(diagnostics);
  console.info = diagnostics.info.bind(diagnostics);
  console.debug = diagnostics.debug.bind(diagnostics);
}

export async function dispatchTemplateShortServiceCommand(command: TemplateShortServiceCommand, payload: unknown,
  environment: NodeJS.ProcessEnv = process.env): Promise<unknown> {
  const root = environment.EDITKIN_WORKSPACE;
  if (!root || !isAbsolute(root)) throw new Error("模板短片子程序缺少 EDITKIN_WORKSPACE（工作資料夾的絕對路徑）");
  if (command === "template_short_write_defaults") return writeTemplateShortDefaultsInApp(payload, root);
  const request = templateShortInAppRunSchema.parse(payload);
  // Preparing material needs the material-colour code identity; a host without it refuses here, before anything is created.
  try { materialColorCodeIdentity(); }
  catch (error) {
    throw new Error(`模板短片要在帶素材色彩身份的 Editkin 程式（mcp.mjs ${EDITKIN_ONE_SHOT_FLAG}）裡執行；這個程式沒有（${error instanceof Error ? error.message : String(error)}），沒有建立任何檔案`);
  }
  // The Short is planned and checked by the Video Autopilot Kit: without it, say what to install before anything is created.
  await assertVideoAutopilotKitInstalled(environment.EDITKIN_VIDEO_AUTOPILOT_SKILL?.trim() || undefined);
  const { productionTemplateShortDeps } = await import("../mcp/templateShortTools");
  const progress = createTemplateShortProgressFile(request.progressPath);
  try { return await runTemplateShortInApp(request, productionTemplateShortDeps(environment), progress.sink); }
  finally { await progress.flush(); }
}

async function readBounded(input: NodeJS.ReadableStream, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input) {
    const bytes = Buffer.from(chunk as Buffer);
    size += bytes.length;
    if (size > limit) throw new Error(`單次請求超過 ${limit} bytes`);
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** `node mcp.mjs --editkin-one-shot`: one request in, one envelope out, then exit so lingering handles cannot hold the job. */
export async function runTemplateShortOneShotProcess(options: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream;
  environment?: NodeJS.ProcessEnv; exit?: (code: number) => void; redirectConsole?: boolean } = {}): Promise<void> {
  if (options.redirectConsole !== false) redirectConsoleToStderr();
  let envelope: Record<string, unknown>, code = 0;
  try {
    const request = JSON.parse(await readBounded(options.input ?? process.stdin, MAX_REQUEST_BYTES)) as { command?: unknown; payload?: unknown } | null;
    if (!request || !isTemplateShortServiceCommand(request.command)) throw new Error(`單次子程序不接受 ${String(request?.command)}`);
    envelope = { ok: true, result: await dispatchTemplateShortServiceCommand(request.command, request.payload ?? {}, options.environment) };
  } catch (error) {
    envelope = { ok: false, error: error instanceof Error ? error.message : String(error) };
    code = 1;
  }
  const output = options.output ?? process.stdout;
  await new Promise<void>(done => { output.write(JSON.stringify(envelope), () => done()); });
  (options.exit ?? (value => process.exit(value)))(code);
}
