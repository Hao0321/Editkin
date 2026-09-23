import { StrictMode, act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createProjectSession } from "../../src/application/projectSession";
import { runAutoRotoAction } from "../../src/application/runAutoRotoAction";
import { useAutomaticCaptions } from "../../src/desktop/useAutomaticCaptions";
import { useSemanticAutoEdit } from "../../src/desktop/useSemanticAutoEdit";
import { useCreativeLibrary } from "../../src/desktop/useCreativeLibrary";
import { useBatchAutoEdit } from "../../src/desktop/useBatchAutoEdit";
import type { AutomaticCaptionDesktopResult, AutoRotoDesktopResult, BatchAutoEditSession, HaoDesktopApi, OpenProjectResult, PickedMedia, PrepareMediaResult, SceneDetectionDesktopResult } from "../../src/desktop/types";
import { createDemoProject } from "../../src/domain/demo";
import { createClipMask } from "../../src/domain/masks";
import { dispatchCommand } from "../../src/domain/history";
import type { EditorCommand } from "../../src/domain/commands";
import { PRODUCT_AUTO_ROTO_ENGINE, PRODUCT_AUTO_ROTO_ROUTE_POLICY, PRODUCT_AUTO_ROTO_ROUTE_RECEIPT_SHA256, PRODUCT_AUTO_ROTO_ROUTE_SCHEMA } from "../../src/domain/autoRotoProductReceipt";
import { autoRotoRuntimeStatusFromReceipt } from "../../src/ui/autoRotoRuntimeStatus";
import type { NativeEditingPolicy } from "../../src/application/nativeAutopilotPolicy";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const TIME = "2026-08-31T00:00:00.000Z";
const PATH = "C:/fixture-memory/same.editkin.json";
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
type Deferred<T> = ReturnType<typeof deferred<T>>;
function initialProject() {
  const project = createDemoProject();
  project.updatedAt = TIME;
  project.captions = [{ id: "caption-existing", text: "Original text", start: 0, duration: 2 }];
  project.tracks[0].clips[0].masks = [createClipMask("subject-mask", "subject")];
  return project;
}
function transcript(): AutomaticCaptionDesktopResult {
  return { cues: [{ start: 0, end: 2, text: "First new caption" }, { start: 3, end: 5, text: "Second new caption" }, { start: 7, end: 10, text: "Final useful point" }], engine: "fixture-whisper", modelId: "fixture", modelSha256: "a".repeat(64), language: "en", analyzedSeconds: 12, elapsedMs: 1, modelDownloaded: false, cacheHit: false, acceleration: "cpu" };
}
function scenes(): SceneDetectionDesktopResult { return { cuts: [{ time: 5, frame: 150, score: .5 }], engine: "ffmpeg-scdet-8", threshold: 8, minSceneDuration: 1, analyzedSeconds: 12, elapsedMs: 1, cacheHit: false }; }
function picked(): PickedMedia { return { asset: { id: "fixture-import", uri: "C:/fixture-memory/import.mp4", name: "Fixture imported video", kind: "video", duration: 3, width: 320, height: 180 }, previewUrl: "fixture-only://original-preview" }; }
function prepared(): PrepareMediaResult { return { assetId: "fixture-import", derivatives: { sourceSha256: "f".repeat(64), proxyUri: "C:/fixture-memory/proxy.mp4", generatedAt: TIME }, runtimeUrls: { "fixture-import": "fixture-only://proxy-preview" }, cacheHit: false }; }
const batchSession: BatchAutoEditSession = { schemaVersion: 1, id: "fixture-batch", editorialProfile: "auto", outputRoot: "C:/fixture-memory/batch", createdAt: TIME, updatedAt: TIME, jobs: [{ id: "job-1", sourcePath: "C:/fixture-memory/source.mp4", sourceName: "Completed fixture", status: "completed", warnings: [] }] };
function opened(): OpenProjectResult { const project = initialProject(); project.name = "Opened batch result"; project.captions[0].text = "Batch caption"; return { canceled: false, path: PATH, project, runtimeUrls: {} }; }

function rotoResult(): AutoRotoDesktopResult {
  const root = `C:/fixture-memory/auto-roto-product/${"d".repeat(64)}`;
  return {
    schema: "editkin.auto-roto-matte/v1", engine: PRODUCT_AUTO_ROTO_ENGINE, width: 16, height: 16, analysisFps: 1, initialFrame: 0,
    sequencePath: `${root}/matte-sequence.alpha8`, sequenceSha256: "a".repeat(64), sequenceBytes: 256,
    meanBoundaryChatter: 0, correctionStrokesApplied: 0, correctedFrames: [], frozen: true, manifestPath: `${root}/matte-manifest.json`,
    frames: [{ frame: 0, time: 0, alphaPath: `${root}/frame-000000.png`, confidence: 1, foregroundRatio: .5, boundaryChatter: 0, previewSha256: "b".repeat(64), alphaFrameSha256: "c".repeat(64) }],
    regionMemoryRouting: { schema: "editkin.region-memory-routing/v1", requested: "fixed_baseline", executed: "fixed_baseline", candidateAttempted: false, deterministicFallback: false },
    alphaRefinement: { schema: "editkin.optical-alpha-refinement-aggregate/v1", engine: "editkin-self-authored-optical-alpha-refiner/v1", appliedFrames: 1, radius: 2, backgroundThreshold: .1, foregroundThreshold: .9, coarseWeight: .4, temporalStability: .5, temporalGate: .15, changedPixels: 0, fractionalPixels: 256, solvedPixels: 256, meanSolveConfidence: 1 },
    analyzedSeconds: 1, elapsedMs: 1, cacheHit: false, qualityState: "diagnostic",
    routeReceipt: {
      schema: PRODUCT_AUTO_ROTO_ROUTE_SCHEMA, policyVersion: PRODUCT_AUTO_ROTO_ROUTE_POLICY, mode: "product", requestedEngine: PRODUCT_AUTO_ROTO_ENGINE, selectedEngine: PRODUCT_AUTO_ROTO_ENGINE, status: "selected", reasonCode: "selected-self-authored-product-artifact",
      boundary: { serviceArtifactKind: "product", externalResearchRuntime: "disabled", externalModelWeights: false, modelInjection: "forbidden" },
      provenance: { origin: "editkin-self-authored", implementation: "native-compiled", modelAndAlgorithmRights: "editkin-owned" }, execution: { regionMemoryPolicy: "fixed_baseline" }, quality: { state: "diagnostic", claim: "unmeasured", humanReviewRequired: true },
      candidates: [{ engine: PRODUCT_AUTO_ROTO_ENGINE, configured: true, origin: "editkin-self-authored", rightsClass: "editkin-owned", qualityTier: "self-authored-unmeasured", decision: "selected", reasonCode: "compiled-into-product-artifact" }], receiptSha256: PRODUCT_AUTO_ROTO_ROUTE_RECEIPT_SHA256,
    },
  };
}

function desktopMock() {
  const captions: Deferred<AutomaticCaptionDesktopResult>[] = [], scene: Deferred<SceneDetectionDesktopResult>[] = [];
  const imports: Deferred<PickedMedia[]>[] = [], prepare: Deferred<PrepareMediaResult>[] = [], open: Deferred<OpenProjectResult>[] = [], roto: Deferred<AutoRotoDesktopResult>[] = [];
  const calls: string[] = [];
  const queue = <T,>(name: string, list: Deferred<T>[]) => { calls.push(name); const gate = deferred<T>(); list.push(gate); return gate.promise; };
  const partial: Partial<HaoDesktopApi> = {
    isDesktop: true,
    automaticCaptionMedia: () => queue("automaticCaptionMedia", captions), detectScenes: () => queue("detectScenes", scene),
    importMediaPaths: () => queue("importMediaPaths", imports), prepareMedia: () => queue("prepareMedia", prepare),
    openBatchProject: () => queue("openBatchProject", open), analyzeAutoRoto: () => queue("analyzeAutoRoto", roto),
    getBatchSession: async () => { calls.push("getBatchSession"); return { session: batchSession }; },
    listCreativeLibrary: async () => ({ id: "fixture-library", name: "Empty fixture library", version: "1.0.0", attribution: "fixture", assets: [], assetCount: 0, assetBytes: 0, musicAssetCount: 0, sfxAssetCount: 0, restrictedAssetCount: 0 }),
    listInstalledPlugins: async () => ({ schema: "editkin.plugin-registry/v1", plugins: [], diagnostics: [] }),
    getWorkflowProfile: async () => ({ configured: true, profile: { schema: "hao.editkin.workflow-profile/v1", id: "fixture", revision: 1, enabledSkills: [], priority: [], grants: [], pluginGrants: [], conflictPolicy: "fail_closed" } }),
    analyzeMotionTrack: async () => { calls.push("fixture-tracking-fallback"); throw new Error("Fixture provides no tracking result; production fallback remains active"); },
  };
  const api = new Proxy(partial, { get(target, key) { if (!(key in target)) throw new Error(`Unexpected fixture API access: ${String(key)}`); return Reflect.get(target, key); } }) as HaoDesktopApi;
  return { api, captions, scene, imports, prepare, open, roto, calls };
}
async function flush(operation: () => unknown = () => undefined) { await act(async () => { operation(); await Promise.resolve(); }); }
async function finish(work: Promise<unknown>, operation: () => unknown) { await act(async () => { operation(); await work; }); }

function createHarness() {
  const desktop = desktopMock(), session = createProjectSession(initialProject(), PATH);
  const statuses: string[] = [], runtimeUrls: Record<string, string> = {}, runtimeStates: unknown[] = [];
  const applied: EditorCommand[] = [], preparedItems: PrepareMediaResult[] = [], confirmations: string[] = [];
  const onStatus = (message: string) => { statuses.push(message); };
  const command = (value: EditorCommand, message = "fixture edit") => { session.setHistory((history) => dispatchCommand(history, value)); applied.push(value); onStatus(message); };
  const onPicked = (items: PickedMedia[]) => { for (const item of items) { command({ type: "import_asset", asset: item.asset }); runtimeUrls[item.asset.id] = item.previewUrl; } };
  const onPrepared = (items: PrepareMediaResult[]) => { for (const item of items) { preparedItems.push(item); command({ type: "set_asset_derivatives", assetId: item.assetId, derivatives: item.derivatives }); Object.assign(runtimeUrls, item.runtimeUrls); } };
  const onOpenProject = (value: OpenProjectResult) => { if (value.project) session.replaceProject(value.project, value.path); };
  let hooks!: { captions: ReturnType<typeof useAutomaticCaptions>; semantic: ReturnType<typeof useSemanticAutoEdit>; library: ReturnType<typeof useCreativeLibrary>; batch: ReturnType<typeof useBatchAutoEdit> };
  let root: Root | undefined, confirm = () => true;
  const originalConfirm = window.confirm;
  window.confirm = (message?: string) => { confirmations.push(String(message)); return confirm(); };
  const busy = { current: false };
  function Harness() {
    const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
    const project = snapshot.history.present, selectedClip = project.tracks[0].clips[0];
    const captions = useAutomaticCaptions({ api: desktop.api, project, projectSession: session, selectedClip, onCommand: command, onStatus });
    const semantic = useSemanticAutoEdit({ api: desktop.api, project, projectSession: session, selectedClip, onCommand: command, onStatus, onRuntimeUrls: (urls) => Object.assign(runtimeUrls, urls) });
    const library = useCreativeLibrary({ api: desktop.api, projectSession: session, onPicked, onPrepared, onStatus, onCommands: (commands, message) => command({ type: "batch", commands }, message) });
    const batch = useBatchAutoEdit({ api: desktop.api, projectSession: session, onOpenProject, onStatus });
    hooks = { captions, semantic, library, batch };
    return <output data-testid="async-active-hook-state">{JSON.stringify({ sessionId: snapshot.sessionId, name: project.name, captions: project.captions.map((caption) => caption.text), assets: project.assets.map((asset) => asset.id), dirty: snapshot.dirty, captionsBusy: captions.busy, semanticBusy: semantic.busy, batchReady: Boolean(batch.session) })}</output>;
  }
  return {
    desktop, session, statuses, runtimeUrls, runtimeStates, applied, preparedItems, confirmations,
    hooks: () => hooks, confirmWith: (next: () => boolean) => { confirm = next; },
    history: () => JSON.stringify(session.getSnapshot().history),
    editCaption: (text: string) => flush(() => command({ type: "update_caption", captionId: "caption-existing", patch: { text } })),
    replaceSameId: (name: string) => flush(() => { const next = initialProject(); next.name = name; next.captions[0].text = "New session text"; session.replaceProject(next, PATH); }),
    runRoto: () => runAutoRotoAction({ projectSession: session, project: session.getSnapshot().history.present, clipId: "clip-demo", maskId: "subject-mask", playhead: 0, analyze: desktop.api.analyzeAutoRoto, busy, onBusy: () => {}, onPlaying: () => {}, onStatus, validateResult: autoRotoRuntimeStatusFromReceipt, onRuntimeStatus: (status) => runtimeStates.push(status), onCommand: command }),
    mount: async () => { root = createRoot(document.getElementById("active-host")!); await flush(() => root!.render(<StrictMode><Harness /></StrictMode>)); },
    dispose: async () => { try { if (root) await flush(() => root!.unmount()); } finally { window.confirm = originalConfirm; } },
  };
}
type Harness = ReturnType<typeof createHarness>;
type Check = { label: string; passed: boolean };
type Expect = (value: unknown, label: string) => void;
type Case = { id: string; run: (h: Harness, check: Expect) => Promise<void> };

const cases: Case[] = [
  { id: "captions-positive-and-duplicate", run: async (h, check) => {
    let work!: Promise<void>, duplicate!: Promise<void>;
    await flush(() => { work = h.hooks().captions.run(); duplicate = h.hooks().captions.run(); });
    await duplicate; check(h.desktop.captions.length === 1, "same-tick duplicate produces one transcript request");
    await finish(work, () => h.desktop.captions[0].resolve(transcript()));
    const snapshot = h.session.getSnapshot();
    check(snapshot.history.present.captions.some((cue) => cue.text === "First new caption"), "real history receives generated captions");
    check(!snapshot.history.present.captions.some((cue) => cue.text === "Original text") && snapshot.history.past.length === 1, "replacement is one undoable batch");
  } },
  { id: "captions-preserve-later-manual-text", run: async (h, check) => {
    let work!: Promise<void>; await flush(() => { work = h.hooks().captions.run(); });
    await h.editCaption("I typed this while transcribing"); const before = h.history();
    await finish(work, () => h.desktop.captions[0].resolve(transcript()));
    check(h.history() === before, "entire current history is unchanged by stale transcript");
    check(h.session.getSnapshot().history.present.captions[0].text === "I typed this while transcribing", "later manual text survives");
    check(h.statuses.at(-1)?.includes("未套用舊結果"), "same-session stale result explains retry");
  } },
  { id: "semantic-positive-real-command-batch", run: async (h, check) => {
    let work!: Promise<void>; await flush(() => { work = h.hooks().semantic.run(); });
    await finish(work, () => { h.desktop.captions[0].resolve(transcript()); h.desktop.scene[0].resolve(scenes()); });
    const snapshot = h.session.getSnapshot();
    check(snapshot.history.past.length === 1, "native planning commits one actual undoable batch");
    check(snapshot.history.present.captions.length > 0 && !snapshot.history.present.captions.some((cue) => cue.text === "Original text"), "semantic output contains its planned editable captions");
    check(h.statuses.some((status) => status.includes("本機規則式粗剪完成") && status.includes("尚未完成 AI 畫面判讀")), "positive path reports rough-cut boundary, not full semantic completion");
  } },
  { id: "semantic-explicit-longform-captured-before-await", run: async (h, check) => {
    const policy: { -readonly [K in keyof NativeEditingPolicy]: NativeEditingPolicy[K] } = { format: "longform", ownership: "automatic" };
    let work!: Promise<void>;
    await flush(() => { work = h.hooks().semantic.run(policy); });
    policy.format = "shorts"; policy.ownership = "manual";
    await finish(work, () => { h.desktop.captions[0].resolve(transcript()); h.desktop.scene[0].resolve(scenes()); });
    const p = h.session.getSnapshot().history.present;
    check(p.captionStyle.color === "#FFFFFF" && p.captionStyle.backgroundColor === "#000000", "captured explicit longform remains white-on-black despite caller mutation");
    check(p.tracks.flatMap(t => t.clips).every(c => !c.creative?.transitionIn && !c.creative?.transitionOut), "actual reducer receives no automatic transitions");
    check(h.statuses.at(-1)?.includes("長片白字黑底"), "status agrees with captured route");
  } },
  { id: "semantic-manual-preserves-caption-style", run: async (h, check) => {
    const before = JSON.stringify(h.session.getSnapshot().history.present.captionStyle);
    let work!: Promise<void>; await flush(() => { work = h.hooks().semantic.run({ format: "longform", ownership: "manual" }); });
    await finish(work, () => { h.desktop.captions[0].resolve(transcript()); h.desktop.scene[0].resolve(scenes()); });
    check(JSON.stringify(h.session.getSnapshot().history.present.captionStyle) === before, "explicit preserve does not overwrite customized caption style");
    check(h.applied.length === 1, "preserve style still executes one actual edit batch");
  } },
  { id: "semantic-invalid-policy-no-analysis", run: async (h, check) => {
    await finish(h.hooks().semantic.run({ format: "wide", ownership: "automatic" } as unknown as NativeEditingPolicy), () => {});
    check(h.desktop.captions.length === 0 && h.applied.length === 0, "invalid inferred format cannot begin analysis or edit");
    check(h.statuses.at(-1)?.includes("重新選擇"), "invalid route is visible");
  } },
  { id: "semantic-policy-content-edit-rejects-old-result", run: async (h, check) => {
    let work!: Promise<void>; await flush(() => { work = h.hooks().semantic.run({ format: "longform", ownership: "automatic" }); });
    await h.editCaption("Keep my edit during rough cut"); const before = h.history();
    await finish(work, () => { h.desktop.captions[0].resolve(transcript()); h.desktop.scene[0].resolve(scenes()); });
    check(h.history() === before && h.applied.length === 1, "pending explicit policy cannot replace a later manual command");
  } },
  { id: "semantic-policy-save-ack-is-not-content-change", run: async (h, check) => {
    let work!: Promise<void>; await flush(() => { work = h.hooks().semantic.run({ format: "longform", ownership: "automatic" }); });
    await flush(() => { const request = h.session.beginSave()!; h.session.completeSave(request, { path: PATH, project: { ...structuredClone(request.project), revision: 1 } }); h.session.finishSave(request); });
    await finish(work, () => { h.desktop.captions[0].resolve(transcript()); h.desktop.scene[0].resolve(scenes()); });
    const p = h.session.getSnapshot().history.present;
    check(p.revision === 1 && p.captionStyle.color === "#FFFFFF" && p.captionStyle.backgroundColor === "#000000", "save acknowledgement keeps the accepted revision and explicit policy output");
    check(h.session.getSnapshot().dirty && h.applied.length === 1, "rough cut remains dirty and undoable after save acknowledgement");
  } },
  { id: "semantic-same-id-session-switch", run: async (h, check) => {
    let work!: Promise<void>; await flush(() => { work = h.hooks().semantic.run(); });
    await h.replaceSameId("New same-id session"); const before = h.history(), statusCount = h.statuses.length;
    await finish(work, () => { h.desktop.captions[0].resolve(transcript()); h.desktop.scene[0].resolve(scenes()); });
    check(h.history() === before && h.session.getSnapshot().history.present.captions[0].text === "New session text", "same-ID new history and text survive old analysis");
    check(h.statuses.length === statusCount && h.applied.length === 0, "no old command/status leaks into replacement session");
  } },
  { id: "creative-import-positive", run: async (h, check) => {
    let work!: Promise<void>; await flush(() => { work = h.hooks().library.importDesktopPaths(["C:/fixture-memory/import.mp4"]); });
    await flush(() => h.desktop.imports[0].resolve([picked()]));
    check(h.session.getSnapshot().history.present.assets.some((asset) => asset.id === "fixture-import"), "picked media is committed before background preparation");
    await finish(work, () => h.desktop.prepare[0].resolve(prepared()));
    check(h.session.getSnapshot().history.present.assets.find((asset) => asset.id === "fixture-import")?.derivatives?.sourceSha256 === "f".repeat(64), "prepared derivative enters real asset history");
    check(h.runtimeUrls["fixture-import"] === "fixture-only://proxy-preview", "accepted source receives proxy URL");
  } },
  { id: "creative-proxy-preserves-caption-edit", run: async (h, check) => {
    let work!: Promise<void>; await flush(() => { work = h.hooks().library.importDesktopPaths(["C:/fixture-memory/import.mp4"]); });
    await flush(() => h.desktop.imports[0].resolve([picked()]));
    await h.editCaption("Caption edited during proxy");
    await finish(work, () => h.desktop.prepare[0].resolve(prepared()));
    check(h.session.getSnapshot().history.present.captions[0].text === "Caption edited during proxy", "additive proxy commit preserves newer caption text");
    check(h.preparedItems.length === 1 && h.session.getSnapshot().history.present.assets.some((asset) => asset.id === "fixture-import" && asset.derivatives), "same-session preparation is still accepted");
  } },
  { id: "creative-proxy-session-switch", run: async (h, check) => {
    let work!: Promise<void>; await flush(() => { work = h.hooks().library.importDesktopPaths(["C:/fixture-memory/import.mp4"]); });
    await flush(() => h.desktop.imports[0].resolve([picked()]));
    await h.replaceSameId("New during proxy"); const before = h.history(), statusCount = h.statuses.length;
    await finish(work, () => h.desktop.prepare[0].resolve(prepared()));
    check(h.history() === before && h.session.getSnapshot().history.present.captions[0].text === "New session text", "late proxy leaves entire replacement history unchanged");
    check(h.preparedItems.length === 0 && h.runtimeUrls["fixture-import"] !== "fixture-only://proxy-preview", "old derivative and proxy callbacks are dropped");
    check(h.statuses.length === statusCount, "late import completion cannot publish into new session");
  } },
  { id: "batch-positive-open-and-duplicate", run: async (h, check) => {
    check(Boolean(h.hooks().batch.session), "StrictMode mount restored completed batch session");
    let work!: Promise<void>, duplicate!: Promise<void>;
    await flush(() => { work = h.hooks().batch.openProject("job-1"); duplicate = h.hooks().batch.openProject("job-1"); });
    await duplicate; check(h.desktop.open.length === 1, "same-tick duplicate opens exactly one batch project");
    await finish(work, () => h.desktop.open[0].resolve(opened()));
    check(h.session.getSnapshot().history.present.name === "Opened batch result" && h.session.getSnapshot().history.present.captions[0].text === "Batch caption", "approved batch replaces real session and caption history");
  } },
  { id: "batch-initial-decline-preserves-history", run: async (h, check) => {
    await h.editCaption("Unsaved before batch open"); h.confirmWith(() => false); const before = h.history();
    await act(async () => { await h.hooks().batch.openProject("job-1"); });
    check(h.confirmations.length === 1 && h.desktop.open.length === 0, "decline occurs before desktop open call");
    check(h.history() === before && h.session.getSnapshot().history.present.captions[0].text === "Unsaved before batch open", "declined batch preserves complete dirty history");
  } },
  { id: "batch-new-edit-second-decline", run: async (h, check) => {
    let work!: Promise<void>; await flush(() => { work = h.hooks().batch.openProject("job-1"); });
    await h.editCaption("Typed while batch opens"); h.confirmWith(() => false); const before = h.history();
    await finish(work, () => h.desktop.open[0].resolve(opened()));
    check(h.confirmations.length === 1 && h.confirmations[0].includes("又有新的未儲存修改"), "new edits require fresh confirmation after delayed open");
    check(h.history() === before && h.session.getSnapshot().history.present.captions[0].text === "Typed while batch opens", "second decline preserves newest text and history");
  } },
  { id: "roto-positive-survives-save-ack", run: async (h, check) => {
    let work!: ReturnType<Harness["runRoto"]>; await flush(() => { work = h.runRoto(); });
    await flush(() => { const request = h.session.beginSave()!; h.session.completeSave(request, { path: PATH, project: { ...structuredClone(request.project), revision: 1 } }); h.session.finishSave(request); });
    await finish(work, () => h.desktop.roto[0].resolve(rotoResult()));
    const current = h.session.getSnapshot().history.present;
    check(current.revision === 1 && current.tracks[0].clips[0].masks?.[0].matteSequence?.frozen, "current matte enters real history despite save-only metadata change");
    check(current.captions[0].text === "Original text" && h.runtimeStates.length === 1, "unrelated caption survives and receipt is promoted once");
  } },
  { id: "roto-mask-edit-rejects-old-freeze", run: async (h, check) => {
    let work!: ReturnType<Harness["runRoto"]>; await flush(() => { work = h.runRoto(); });
    await flush(() => h.session.setHistory((history) => dispatchCommand(history, { type: "update_clip_mask", clipId: "clip-demo", maskId: "subject-mask", patch: { feather: .15 } })));
    await h.editCaption("Caption during roto"); const before = h.history();
    await finish(work, () => h.desktop.roto[0].resolve(rotoResult()));
    check(h.history() === before && h.session.getSnapshot().history.present.captions[0].text === "Caption during roto", "old matte cannot modify newer mask or text history");
    check(!h.session.getSnapshot().history.present.tracks[0].clips[0].masks?.[0].matteSequence && h.runtimeStates.length === 0, "stale result neither freezes matte nor promotes runtime");
  } },
];

async function run() {
  const summary = document.getElementById("summary")!, report = document.getElementById("result")!, list = document.getElementById("checks")!;
  const startedAt = new Date().toISOString();
  const results: Array<{ id: string; status: "PASS" | "FAIL"; checks: Check[]; durationMs: number; error?: string; apiCalls: string[]; statuses: string[]; historySummary: { name: string; past: number; future: number; journal: string[]; captions: string[]; clips: Array<{ id: string; masks: string[] }> } }> = [];
  for (const test of cases) {
    const row = document.createElement("li"); row.textContent = `RUNNING · ${test.id}`; list.appendChild(row);
    summary.textContent = `RUNNING ${results.length + 1}/${cases.length} — ${test.id}`;
    const checks: Check[] = [], h = createHarness(), start = performance.now(); let error: string | undefined;
    const check: Expect = (value, label) => { checks.push({ label, passed: Boolean(value) }); if (!value) throw new Error(label); };
    try { await h.mount(); await test.run(h, check); }
    catch (failure) { error = failure instanceof Error ? failure.stack ?? failure.message : String(failure); }
    finally { try { await h.dispose(); } catch (failure) { error = `${error ?? ""}\nCleanup failure: ${String(failure)}`.trim(); } }
    const history = h.session.getSnapshot().history;
    const result = {
      id: test.id, status: error ? "FAIL" as const : "PASS" as const, checks,
      durationMs: Math.round(performance.now() - start), ...(error ? { error } : {}), apiCalls: h.desktop.calls,
      statuses: [...h.statuses],
      historySummary: { name: history.present.name, past: history.past.length, future: history.future.length,
        journal: history.journal.map((item) => item.command.type), captions: history.present.captions.map((cue) => cue.text),
        clips: history.present.tracks.flatMap((track) => track.clips.map((clip) => ({ id: clip.id, masks: clip.masks?.map((mask) => mask.id) ?? [] }))),
      },
    };
    results.push(result); row.textContent = `${result.status} · ${test.id} (${checks.filter((item) => item.passed).length}/${checks.length})`; row.className = result.status.toLowerCase();
    report.textContent = JSON.stringify({ status: "RUNNING", expectedCases: cases.length, cases: results }, null, 2);
  }
  const passedCases = results.filter((result) => result.status === "PASS").length, status = passedCases === cases.length ? "PASS" : "FAIL";
  const final = { schema: "editkin.async-edit-react-browser-fixture/v1", status, startedAt, finishedAt: new Date().toISOString(), expectedCases: cases.length, passedCases, assertions: results.reduce((total, result) => total + result.checks.length, 0), reactMode: "React 19 development StrictMode; production hooks/store/action + real domain reducer", evidenceBoundary: { mockDesktopApi: true, mockConfirm: true, syntheticAnalysisMetadata: true, callbacksEmulateCommitBindings: true, rootAppUi: false, nativeIpc: false, actualFilesystem: false, packagedExe: false, editorialOrAlphaQuality: false, userDataTouched: false }, cases: results };
  report.textContent = JSON.stringify(final, null, 2); summary.dataset.status = status; summary.textContent = `${status} — ${passedCases}/${cases.length} cases · ${final.assertions} assertions · real history preservation`;
  document.title = `${status} — Editkin async edit React regression`;
}
void run().catch((error) => { const summary = document.getElementById("summary")!; summary.dataset.status = "FAIL"; summary.textContent = `FAIL — runner: ${String(error)}`; document.getElementById("result")!.textContent = JSON.stringify({ status: "FAIL", runnerError: String(error) }, null, 2); });
