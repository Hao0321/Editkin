import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, relative, isAbsolute } from "node:path";
import { applyCommand, type EditorCommand } from "../domain/commands";
import { validateProject } from "../domain/editGraph";
import type { CaptionCue, EditProject } from "../domain/types";
import { shortsCaptionStyle } from "../creative/shortsCaptionStyle";
import { canonicalJson } from "../shared/canonicalJson";
import { sha256Canonical } from "./autopilotInvocationIdentity";
import type { MaterialIntelligencePacket } from "./materialIntelligence";
import { TemplateShortBlockError, assertGlyphs, assertBriefNumbers } from "./templateShortBrief";
import { TEMPLATE_SHORT_GENRES, selectTemplateShortFamily, toTemplateInput } from "./templateShortCatalog";
import type { TemplateShortDeps } from "./templateShortRun";
import { templateShortRenderTimeoutMs } from "./templateShortRun";
import type { TemplateShortPacket } from "./templateShortPlan";
import { analyzeCompiledTemplate, type TemplateShortQaPacket } from "./templateShortQa";
import { resolveTemplateShortSourceRights } from "./templateShortWorkspace";
import { MULTI_SOURCE_SHORT_VERSION, MULTI_SOURCE_SHORT_ROOT, MULTI_SOURCE_SHORT_ART,
  multiSourceShortStartSchema, multiSourceShortMakeSchema, parseMultiSourceShort, planOrderedShortWindows,
  multiShortDiskNeed, orderedShortCaptionCues, type MultiSourceShortMake } from "./multiSourceShortRecipeV2";

type Packet = TemplateShortPacket & TemplateShortQaPacket;
type SharedDeps = Pick<TemplateShortDeps, "root" | "now" | "randomHex" | "readDefaults" | "resolveSource" | "probe" |
  "createProject" | "prepareBootstrap" | "applyBootstrap" | "readProject" | "fileSha256" | "speechModelReady" |
  "prepareMaterial" | "readMaterial" | "readKeyframe" | "recordSemantics" | "freeBytes" | "lock" | "readback">;
export interface MultiSourceShortDeps extends SharedDeps {
  compile(project: EditProject, input: Parameters<TemplateShortDeps["compileTemplate"]>[1], identity: string): Promise<Packet>;
  prepareCaptions(project: EditProject, captions: readonly CaptionCue[], style: ReturnType<typeof shortsCaptionStyle>): Promise<CaptionCue[]>;
  render(project: EditProject, outputPath: string, options: { workRoot: string; timeoutMs: number }): Promise<unknown>;
  analyzeRendered(input: { candidate: string; candidateSha256: string; project: EditProject; packet: Packet;
    durationFrames: number; sheetsDir: string; qaPath: string; requireAudio: boolean }): Promise<{
      technical: { pass: boolean; checks: readonly unknown[] }; flags: readonly unknown[]; sheets?: readonly string[];
    }>;
  signal?: AbortSignal;
}
interface Source {
  index: number; path: string; assetId: string; clipId: string; sourceStartFrame: number; durationFrames: number;
  timelineStartFrame: number; sha256: string; hasAudio: boolean; materialId?: string;
  frames: Array<{ id: string; sha256: string }>; transcript: "ready" | "not_applicable" | "blocked";
}
interface State {
  schema: typeof MULTI_SOURCE_SHORT_VERSION; runId: string; genre: NonNullable<ReturnType<typeof multiSourceShortStartSchema.parse>["genre"]>;
  projectId: string; projectRevision: number; projectSha256: string; defaultsSha256: string; durationFrames: number;
  sources: Source[]; music?: Source; served: string[]; framePage: number;
  status: "AWAITING_BRIEF" | "RUNNING" | "REVIEW_REQUIRED" | "NEEDS_FIX" | "INTERRUPTED" | "FAILED_PROJECT_PRESERVED";
  createdAt: string; result?: Record<string, unknown>;
}
const active = new Map<string, Promise<Record<string, unknown>>>();
const key = (s: number, kf: string) => `s${s}:${kf}`;
function paths(deps: Pick<MultiSourceShortDeps, "root">, runId: string) {
  if (!/^ms-[a-f0-9]{24}$/.test(runId)) throw new Error("多段短片識別碼不合法。");
  const directory = `${MULTI_SOURCE_SHORT_ROOT}/${runId}`;
  return { directory, absolute: resolve(deps.root, directory), project: `${directory}/short.editkin.json`,
    output: resolve(deps.root, directory, "short.mp4"), state: resolve(deps.root, directory, "run.json") };
}
async function persist(deps: MultiSourceShortDeps, state: State, initial = false) {
  const target = paths(deps, state.runId).state, json = `${JSON.stringify(state, null, 2)}\n`;
  if (initial) await writeFile(target, json, { flag: "wx" });
  else { const temporary = `${target}.${deps.randomHex(8)}.tmp`; await writeFile(temporary, json, { flag: "wx" }); await rename(temporary, target); }
}
async function readState(deps: MultiSourceShortDeps, runId: string): Promise<State> {
  const content = await readFile(paths(deps, runId).state);
  if (content.byteLength > 64 * 1024) throw new Error("多段短片紀錄超過上限。");
  const state = JSON.parse(content.toString("utf8")) as State;
  if (state.schema !== MULTI_SOURCE_SHORT_VERSION || state.runId !== runId || !Array.isArray(state.sources)
    || state.sources.length < 2 || state.sources.length > 8) throw new Error("多段短片紀錄不合法。");
  return state;
}
async function assertDisk(deps: MultiSourceShortDeps, state: Pick<State, "runId" | "durationFrames">) {
  const need = multiShortDiskNeed(state.durationFrames), directory = paths(deps, state.runId).absolute;
  if (await deps.freeBytes(directory) < need.combinedBytes) throw new TemplateShortBlockError("BLOCK_DISK",
    `輸出磁碟需要約 ${(need.combinedBytes / 1024 ** 3).toFixed(1)} GB，請先釋放輸出磁碟空間。`);
  return need;
}
function check(deps: MultiSourceShortDeps) { deps.signal?.throwIfAborted(); }

/** Prepared images are actually served under 1 MB; no caller can make before viewing every source page. */
async function serve(deps: MultiSourceShortDeps, state: State, page: number) {
  if (state.status !== "AWAITING_BRIEF" || page !== state.framePage + 1) throw new Error("關鍵畫面頁數不正確，或短片已開始製作。");
  const images: Array<{ id: string; sourceIndex: number; kf: string; data: Buffer; mimeType: "image/jpeg" }> = [];
  let bytes = 0;
  serving: for (const source of state.sources) for (const frame of source.frames) {
    const id = key(source.index, frame.id);
    if (state.served.includes(id)) continue;
    const current = await deps.readKeyframe(source.materialId!, frame.id); check(deps);
    if (current.frame.sha256 !== frame.sha256 || createHash("sha256").update(current.data).digest("hex") !== frame.sha256) throw new Error("關鍵畫面在準備後已改變，請重新開始。");
    if (bytes + current.data.length > 1_000_000) {
      if (!images.length) throw new Error("單張關鍵畫面超過 1 MB，請縮短素材範圍。");
      break serving;
    }
    bytes += current.data.length; images.push({ id, sourceIndex: source.index, kf: frame.id, data: current.data, mimeType: "image/jpeg" });
  }
  state.served.push(...images.map(image => image.id)); state.framePage = page; await persist(deps, state);
  const pending = state.sources.flatMap(source => source.frames.map(frame => key(source.index, frame.id))).filter(id => !state.served.includes(id));
  return { text: { schema: MULTI_SOURCE_SHORT_VERSION, runId: state.runId, status: state.status, durationSeconds: state.durationFrames / 30,
    sources: state.sources.map(source => ({ index: source.index, path: source.path, in: source.sourceStartFrame / 30,
      seconds: source.durationFrames / 30, timelineStart: source.timelineStartFrame / 30, transcript: source.transcript })),
    images: images.map(({ data: _data, ...image }) => image), imageBytes: bytes, pending,
    next: pending.length ? { tool: "start_multi_source_short", framePage: page + 1 } : { tool: "make_multi_source_short" },
    ...MULTI_SOURCE_SHORT_ART }, images };
}

export async function startMultiSourceShort(raw: unknown, deps: MultiSourceShortDeps) {
  const request = parseMultiSourceShort(multiSourceShortStartSchema, raw); check(deps);
  if (request.runId) {
    const release = await deps.lock(paths(deps, request.runId).state);
    try { return await serve(deps, await readState(deps, request.runId), request.framePage!); } finally { await release(); }
  }
  const defaults = await deps.readDefaults();
  const resolved = [];
  for (const source of request.sources!) {
    const path = await deps.resolveSource(source.path), probe = await deps.probe(path.absolute);
    const rights = resolveTemplateShortSourceRights(defaults.defaults, path.relative);
    resolved.push({ ...path, probe, rights }); check(deps);
  }
  const order = planOrderedShortWindows(request.sources!, resolved.map(source => source.probe));
  let music: { absolute: string; relative: string; sourceStartFrame: number; rights: typeof resolved[number]["rights"] } | undefined;
  if (request.music) {
    const path = await deps.resolveSource(request.music.path), probe = await deps.probe(path.absolute);
    const rights = resolveTemplateShortSourceRights(defaults.defaults, path.relative);
    if (rights.scope.replaceAll("\\", "/").toLowerCase() !== path.relative.replaceAll("\\", "/").toLowerCase()) {
      throw new TemplateShortBlockError("BLOCK_START", "配樂需要這支音訊檔專用的權利宣告，不能沿用影片資料夾的宣告。");
    }
    const sourceStartFrame = Math.round((request.music.in ?? 0) * 30), end = sourceStartFrame + order.durationFrames;
    if (!probe.hasAudio || probe.hasVideo || end > Math.floor(probe.duration * 30 + 1e-7)
      || (request.music.out !== undefined && end > Math.floor(request.music.out * 30 + 1e-7))) {
      throw new TemplateShortBlockError("BLOCK_START", "配樂必須是已授權、足夠覆蓋整支短片的純音訊。");
    }
    music = { ...path, rights, sourceStartFrame };
  }
  const runId = `ms-${deps.randomHex(12)}`, owned = paths(deps, runId);
  await assertDisk(deps, { runId, durationFrames: order.durationFrames });
  await mkdir(resolve(deps.root, MULTI_SOURCE_SHORT_ROOT), { recursive: true }); await mkdir(owned.absolute);
  const created = await deps.createProject(owned.project, "多段素材 Short", 1080, 1920, 30, TEMPLATE_SHORT_GENRES[request.genre!].profile);
  const sources: Source[] = [], commands: EditorCommand[] = [];
  for (const window of order.windows) {
    const source = resolved[window.index], assetId = `multi-source-${window.index}`, clipId = `multi-clip-${window.index}`;
    const prepared = await deps.prepareBootstrap({ projectPath: owned.project, sourcePath: source.relative, assetId, clipId,
      trackId: "video-main", timelineStartFrame: window.timelineStartFrame, sourceStartFrame: window.sourceStartFrame,
      durationFrames: window.durationFrames, sourceColorInterpretation: "auto", rights: source.rights.declaration });
    commands.push(...prepared.commands);
    sources.push({ ...window, path: source.relative, assetId, clipId, sha256: prepared.binding.source.sha256,
      hasAudio: source.probe.hasAudio, frames: [], transcript: "blocked" }); check(deps);
  }
  let musicState: Source | undefined;
  if (music) {
    const prepared = await deps.prepareBootstrap({ projectPath: owned.project, sourcePath: music.relative, assetId: "multi-music",
      clipId: "multi-music", trackId: "audio-main", timelineStartFrame: 0, sourceStartFrame: music.sourceStartFrame,
      durationFrames: order.durationFrames, rights: music.rights.declaration });
    commands.push(...prepared.commands, { type: "set_clip_volume", clipId: "multi-music", volume: 10 ** (-18 / 20) },
      { type: "set_clip_audio_envelope", clipId: "multi-music", envelope: { schema: "editkin.clip-audio-envelope/v1",
        fades: { in: .4, out: .4, duration: order.durationFrames / 30, offset: 0 } } });
    musicState = { index: -1, path: music.relative, assetId: "multi-music", clipId: "multi-music", sha256: prepared.binding.source.sha256,
      sourceStartFrame: music.sourceStartFrame, durationFrames: order.durationFrames, timelineStartFrame: 0,
      hasAudio: true, frames: [], transcript: "not_applicable" };
  }
  // All sources are imported into the new editable project with one validated atomic bootstrap.
  const dry = applyCommand(created, { type: "batch", commands }); validateProject(dry);
  const bootstrapped = await deps.applyBootstrap(owned.project, commands, created.revision);
  const state: State = { schema: MULTI_SOURCE_SHORT_VERSION, runId, genre: request.genre!, projectId: bootstrapped.id,
    projectRevision: bootstrapped.revision, projectSha256: sha256Canonical(bootstrapped), defaultsSha256: defaults.sha256,
    durationFrames: order.durationFrames, sources, ...(musicState ? { music: musicState } : {}), served: [], framePage: 0,
    status: "AWAITING_BRIEF", createdAt: deps.now().toISOString() };
  await persist(deps, state, true);
  try {
    const modelReady = await deps.speechModelReady();
    for (const source of state.sources) {
      const path = await deps.resolveSource(source.path), asset = bootstrapped.assets.find(asset => asset.id === source.assetId)!;
      const { packet } = await deps.prepareMaterial({ assetId: source.assetId, clipId: source.clipId, sourcePath: path.absolute,
        sourceStart: source.sourceStartFrame / 30, duration: source.durationFrames / 30, fps: 30, kind: "video",
        sourceSha256: source.sha256, includeTranscript: source.hasAudio && modelReady, language: "auto", maxKeyframes: 1,
        color: asset.color, colorManagement: bootstrapped.colorManagement }); check(deps);
      if (packet.source.sourceSha256 !== source.sha256 || packet.keyframes.length !== 1) throw new Error("來源雜湊或關鍵畫面準備不完整。");
      source.materialId = packet.materialId; source.frames = packet.keyframes.map(frame => ({ id: frame.id, sha256: frame.sha256 }));
      source.transcript = packet.analysis.transcript.state;
    }
    return await serve(deps, state, 1);
  } catch (error) {
    state.status = "FAILED_PROJECT_PRESERVED";
    const reason = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
    state.result = { schema: MULTI_SOURCE_SHORT_VERSION, runId, status: state.status, delivered: false,
      projectPath: owned.project, applied: true, stage: "preparation", reason, ...MULTI_SOURCE_SHORT_ART };
    await persist(deps, state);
    throw new TemplateShortBlockError("BLOCK_START", `${reason}（已保留專案 ${owned.project}；runId ${runId}）`);
  }
}

async function assertSources(state: State, deps: MultiSourceShortDeps) {
  if ((await deps.readDefaults()).sha256 !== state.defaultsSha256) throw new Error("素材權利設定已改變，請重新開始。");
  for (const source of [...state.sources, ...(state.music ? [state.music] : [])]) {
    const path = await deps.resolveSource(source.path);
    const inside = relative(resolve(deps.root), path.absolute);
    if (isAbsolute(inside) || inside.startsWith("..") || await deps.fileSha256(path.absolute) !== source.sha256) throw new Error("素材來源在準備後已改變，請重新開始。");
  }
  check(deps);
}

async function execute(request: MultiSourceShortMake, state: State, deps: MultiSourceShortDeps, mode: "mcp" | "in_app") {
  const owned = paths(deps, state.runId), release = await deps.lock(owned.state);
  let applied = false, admitted = false;
  try {
    state = await readState(deps, state.runId);
    if (state.status !== "AWAITING_BRIEF") throw new Error("這支短片已開始或已完成；修改內容請建立新的一支。");
    admitted = true;
    const allFrames = state.sources.flatMap(source => source.frames.map(frame => key(source.index, frame.id)));
    const seen = request.seen.map(row => key(row.s, row.kf));
    if (new Set(seen).size !== seen.length || canonicalJson([...seen].sort()) !== canonicalJson([...allFrames].sort())
      || allFrames.some(id => !state.served.includes(id))) throw new TemplateShortBlockError("BLOCK_UNVIEWED_FRAME", "每段已提供的關鍵畫面都要看過並各寫一項描述。");
    assertGlyphs(request.copy);
    const selection = selectTemplateShortFamily({ copy: request.copy }, state.genre);
    if (!selection.certification && !request.allowUncertified) throw new TemplateShortBlockError("BLOCK_TEMPLATE", "這個題材尚未認證；請明確選擇檢視未認證版本，完成後需人工看成片。");
    await assertSources(state, deps); await assertDisk(deps, state);
    const project = await deps.readProject(owned.project);
    if (project.id !== state.projectId || project.revision !== state.projectRevision || sha256Canonical(project) !== state.projectSha256) throw new Error("短片專案在準備後已改變，請重新開始。");
    const materials: MaterialIntelligencePacket[] = [];
    const refs: string[] = [];
    for (const source of state.sources) {
      const packet = await deps.readMaterial(source.materialId!);
      if (packet.source.sourceSha256 !== source.sha256 || packet.source.assetId !== source.assetId || packet.source.clipId !== source.clipId
        || packet.source.sourceStart !== source.sourceStartFrame / 30 || packet.source.duration !== source.durationFrames / 30) throw new Error("素材分析紀錄與片段不一致。");
      materials.push(packet);
      const rows = request.seen.filter(row => row.s === source.index);
      const semantics = await deps.recordSemantics({ materialId: packet.materialId, sourceSha256: source.sha256, overallTopic: request.copy.payoff,
        contentType: state.genre, language: "auto", people: [], locations: [], segments: rows.map(row => ({ start: 0,
          end: source.durationFrames / 30, summary: row.note, subjects: [], actions: [], objects: [], importance: .7,
          evidenceFrameIds: [row.kf], transcriptCueIndexes: [] })) });
      refs.push(`material:${packet.materialId}:semantic:${semantics.semanticReceiptSha256}`);
    }
    const numbers = assertBriefNumbers(request.copy, { copyAuthor: mode === "in_app" ? "creator" : "agent",
      transcript: materials.flatMap(packet => packet.analysis.transcript.cues.map(cue => cue.text)), facts: [], seen: request.seen.map(row => row.note) });
    const first = state.sources[0];
    const input = toTemplateInput(selection.family, request.copy, { clipId: first.clipId, durationFrames: first.durationFrames,
      designSystem: selection.designSystem, shortId: state.runId, semanticRef: refs[0] });
    const packet = await deps.compile(project, input, state.runId);
    if (packet.sourceGeneration.projectSha256 !== state.projectSha256) throw new Error("模板不是為當前專案準備的。");
    const analytic = analyzeCompiledTemplate(packet, packet.beats ?? [], project);
    if (analytic.blocks.length) throw new TemplateShortBlockError("BLOCK_TEMPLATE_QA", analytic.blocks.map(block => block.detail).join("；").slice(0, 500));
    const style = shortsCaptionStyle(project, project.editorialProfile);
    let captions = orderedShortCaptionCues(state.sources.map((source, index) => ({ timelineStart: source.timelineStartFrame / 30,
      duration: source.durationFrames / 30, cues: materials[index].analysis.transcript.cues })), 30);
    if (request.captions === "copy") {
      const words = [request.copy.hook, request.copy.proof, request.copy.payoff].filter((word): word is string => Boolean(word));
      const framesPer = Math.floor(state.durationFrames / words.length);
      captions = words.map((text, index) => ({ id: `multi-copy-${index}`, text, start: index * framesPer / 30,
        duration: ((index === words.length - 1 ? state.durationFrames : (index + 1) * framesPer) - index * framesPer) / 30 }));
    }
    captions = await deps.prepareCaptions(project, captions, style); check(deps);
    const commands: EditorCommand[] = [{ type: "set_caption_style", patch: style }, ...captions.map(caption => ({ type: "add_caption" as const, caption })), ...packet.commands];
    const planned = applyCommand(project, { type: "batch", commands }); validateProject(planned);
    // Independent deterministic recompile, exact byte check, then recheck actual source files and project immediately before commit.
    const verification = await deps.compile(project, input, state.runId);
    if (canonicalJson(verification.commands) !== canonicalJson(packet.commands) || canonicalJson(verification.instance) !== canonicalJson(packet.instance)) throw new Error("模板獨立重新編譯不一致，專案未套用。");
    await assertSources(state, deps);
    if (sha256Canonical(await deps.readProject(owned.project)) !== state.projectSha256) throw new Error("專案在準備期間改變，未套用。");
    const audit = { schema: "editkin.multi-source-short-audit/v2", originalV4Plan: false, expectedRevision: project.revision,
      sourceSha256: state.sources.map(source => source.sha256), ...(state.music ? { musicSha256: state.music.sha256 } : {}),
      commandsSha256: sha256Canonical(commands), templateRecompiledExactly: true, durationFrames: state.durationFrames, analytic,
      copyNumbersRequireReview: numbers.reviewRequired, ...MULTI_SOURCE_SHORT_ART };
    await writeFile(resolve(owned.absolute, "plan.json"), `${JSON.stringify({ audit, commands }, null, 2)}\n`, { flag: "wx" });
    state.status = "RUNNING"; await persist(deps, state);
    const committed = await deps.applyBootstrap(owned.project, commands, project.revision); applied = true;
    if ((await deps.readback(owned.project, packet.instance.id)).instanceStatus !== "CURRENT") throw new Error("模板套用後未保持 CURRENT，已保留可編輯專案。");
    const render = await deps.render(committed, owned.output, { workRoot: resolve(owned.absolute, ".editkin-render-work"),
      timeoutMs: templateShortRenderTimeoutMs(state.durationFrames, 30) }); check(deps);
    await writeFile(resolve(owned.absolute, "render.json"), `${JSON.stringify(render, null, 2)}\n`, { flag: "wx" });
    const candidateSha256 = await deps.fileSha256(owned.output);
    const qa = await deps.analyzeRendered({ candidate: owned.output, candidateSha256, project: committed, packet,
      durationFrames: state.durationFrames, sheetsDir: resolve(owned.absolute, "sheets"), qaPath: resolve(owned.absolute, "QA.json"),
      requireAudio: Boolean(state.music) || state.sources.some(source => source.hasAudio) });
    if (!qa.technical.pass) throw new Error("成片技術檢查未通過，已保留專案與檢查紀錄。");
    await assertSources(state, deps);
    const flags = [...analytic.flags, ...qa.flags];
    if (!captions.length) flags.push({ id: "captions_unmeasured", detail: "目前沒有可用逐字稿字幕，請看成片後補字幕；未啟用或下載新語音模型。" });
    if (!state.music) flags.push({ id: "music_not_selected", detail: "尚未選擇已授權配樂，保留素材原聲。" });
    state.status = flags.length ? "NEEDS_FIX" : "REVIEW_REQUIRED";
    const result = { schema: MULTI_SOURCE_SHORT_VERSION, runId: state.runId, status: state.status, delivered: true,
      projectPath: owned.project, outputPath: owned.output, outputSha256: candidateSha256, seconds: state.durationFrames / 30,
      sourceCount: state.sources.length, captionCount: captions.length, music: Boolean(state.music), instanceStatus: "CURRENT",
      sourceOrder: state.sources.map(source => source.path), flags: flags.slice(0, 24), checks: qa.technical.checks,
      sheets: (qa.sheets ?? []).map(name => {
        if (!/^sheet_[0-9]{2}\.jpg$/.test(name)) throw new Error("接觸表檔名不合法，已保留成片與專案。");
        return `${owned.directory}/sheets/${name}`;
      }), renderReceiptPath: `${owned.directory}/render.json`, auditPath: `${owned.directory}/plan.json`, ...MULTI_SOURCE_SHORT_ART };
    if (Buffer.byteLength(JSON.stringify(result), "utf8") > 20 * 1024) throw new Error("結果摘要超過上限，已保留成片與專案。");
    state.result = result; await persist(deps, state); return result;
  } catch (error) {
    if (!admitted) throw error;
    state.status = "FAILED_PROJECT_PRESERVED";
    state.result = { schema: MULTI_SOURCE_SHORT_VERSION, runId: state.runId, status: state.status, delivered: false,
      projectPath: owned.project, applied, reason: (error instanceof Error ? error.message : String(error)).slice(0, 1000), ...MULTI_SOURCE_SHORT_ART };
    await persist(deps, state); throw error;
  } finally { await release(); }
}

export async function makeMultiSourceShort(raw: unknown, deps: MultiSourceShortDeps, options: { mode: "mcp" | "in_app"; wait?: boolean } = { mode: "mcp" }): Promise<Record<string, unknown>> {
  const request = parseMultiSourceShort(multiSourceShortMakeSchema, raw);
  if (active.has(request.runId)) throw new Error("這支短片正在製作，請查詢進度。");
  const state = await readState(deps, request.runId);
  if (options.wait) return execute(request, state, deps, options.mode);
  const job = execute(request, state, deps, options.mode); active.set(request.runId, job);
  void job.catch(() => undefined).finally(() => active.delete(request.runId));
  return { schema: MULTI_SOURCE_SHORT_VERSION, runId: request.runId, status: "RUNNING", next: "get_multi_source_short", pollAfterMs: 10_000 };
}
export async function getMultiSourceShort(runId: string, deps: MultiSourceShortDeps): Promise<Record<string, unknown>> {
  const state = await readState(deps, runId);
  if (state.status === "RUNNING" && !active.has(runId)) return { schema: MULTI_SOURCE_SHORT_VERSION, runId, status: "INTERRUPTED",
    projectPath: paths(deps, runId).project, note: "工作階段中斷，專案已保留；用同一份素材與文案建立新的一支。" };
  return state.result ?? { schema: MULTI_SOURCE_SHORT_VERSION, runId, status: state.status, ...MULTI_SOURCE_SHORT_ART };
}
