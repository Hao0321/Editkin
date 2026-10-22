// LONG-render orchestration (design C1-C3, C5 WP-A parts). Called by ffmpeg.ts renderProject for LONG renders only:
// facts + refusals before any work, source coverage, the LONG work root (never the OS temp), the exact-path
// journal, owned run/output-staging directories, guard v2 for the whole run, the content render inside the owned
// run directory, `.part` identity QA + commit, and journal cleanup within the release window.
import { createHash, randomUUID } from "node:crypto";
import { rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse, resolve } from "node:path";
import type { EditProject } from "../domain/types";
import { validateProject } from "../domain/editGraph";
import { renderReviewContentJson } from "../shared/renderReviewContent";
import { buildRenderPlan, type RenderPlan } from "./planner";
import type { RenderOptions, RenderResult, VideoEncoder } from "./ffmpegTypes";
import { collectRenderArtifactIdentity } from "./renderArtifactIdentity";
import { assertRenderActive, renderLifetimeAbort, renderLifetimeSignal } from "./renderLifetime";
import { reportRenderStage } from "./renderProgress";
import { probeVolumeSpace } from "./renderDiskSpace";
import { runWithRenderWorkRootV1, selectLongRenderWorkRootV1 } from "./renderWorkspace";
import { collectLongRenderFactsV1, longRenderPlanPathResolverV1 } from "./longRenderClassifierV1";
import { assertLongRenderAdmissibleV1, chooseLongRouteV1, longRenderRouteProvidersV1, measureLongSourceCoverageV1, planLongOutputIdentityV1,
  predictLongRouteV1, predictedLongStagingBytesV1, type LongRouteDecisionV1 } from "./longRenderRouterV1";
import { createLongRenderSpaceGuardV2 } from "./longRenderGuardV2";
import { createOwnedDirectoryV1, openLongRenderJournalV1 } from "./longRenderOwnerJournalV1";
import { longRenderOutputStagingDirectoryV1, longRenderPartPathV1, publishLongRenderOutputV1 } from "./longRenderPublishV1";
import { LongRenderRefusalV1, type LongJournalCleanupReceiptV1, type LongPublishReceiptV1, type LongRenderClassificationV1, type LongRenderPolicyV1,
  type LongRenderReceiptV1, type LongRenderRouteProvidersV1, type LongRenderRunBaseV1, type LongRenderRunContextV1 } from "./longRenderContractsV1";

/** Threaded from renderProject to the route dispatch point inside renderResolvedProject (LONG renders only). */
export interface LongDispatchStateV1 {
  readonly base: LongRenderRunBaseV1;
  readonly providers: Readonly<LongRenderRouteProvidersV1>;
  decision?: LongRouteDecisionV1;
  run?: LongRenderRunContextV1;
}

/** At the actual dispatch point: fixes the route and the up-front output identity plan, before any frame is rendered. */
export function dispatchLongRouteV1(state: LongDispatchStateV1, input: { kind: "scene-linear" | "resident" | "composite"; project: EditProject; plan: RenderPlan;
  encoder: VideoEncoder; alphaDelivery: boolean }): LongRenderRunContextV1 {
  if (state.run) throw new Error("A LONG render reached a second route dispatch point");
  const decision = chooseLongRouteV1({ kind: input.kind, audioClipCount: input.plan.audioClips.length, ramEstimateBytes: state.base.facts.ramEstimateBytes },
    state.base.policy, state.providers);
  const identity = planLongOutputIdentityV1(input.project, input.plan, input.encoder, { alphaDelivery: input.alphaDelivery, sceneLinear: input.kind === "scene-linear" });
  const { predictedRoute: _predicted, ...base } = state.base;
  state.decision = decision;
  state.run = Object.freeze({ ...base, route: decision.route, identity });
  return state.run;
}

function systemVolumePath(): string {
  return process.env.SystemRoot ?? process.env.SYSTEMROOT ?? parse(tmpdir()).root;
}

export async function runLongRenderV1(input: {
  project: EditProject;
  outputPath: string;
  options: RenderOptions;
  classification: LongRenderClassificationV1;
  policy: LongRenderPolicyV1;
  /** The legacy content renderer (prepasses + route dispatch), writing to `partPath`. */
  renderContent: (project: EditProject, partPath: string, dispatch: LongDispatchStateV1) => Promise<RenderResult>;
}): Promise<RenderResult> {
  const { options, policy, classification } = input;
  const stageMs: Record<string, number> = {};
  const timed = async <T>(name: string, operation: () => Promise<T>): Promise<T> => {
    const started = performance.now();
    try { return await operation(); } finally { stageMs[name] = Math.round(performance.now() - started); }
  };
  assertRenderActive();
  reportRenderStage("prepare");
  const admissionStarted = performance.now();
  const snapshot = structuredClone(input.project);
  const projectContentSha256 = createHash("sha256").update(renderReviewContentJson(snapshot)).digest("hex");
  validateProject(snapshot);
  const ffprobePath = options.ffprobePath ?? "ffprobe";
  const probe = options.longRender?.probe ?? probeVolumeSpace;
  const facts = collectLongRenderFactsV1(snapshot, options, policy);
  assertLongRenderAdmissibleV1(facts, policy);
  const providers = longRenderRouteProvidersV1();
  const predicted = predictLongRouteV1(facts, policy, providers);
  const plan = buildRenderPlan(snapshot, longRenderPlanPathResolverV1(options.assetBase));
  stageMs.admission = Math.round(performance.now() - admissionStarted);
  const sourceCoverage = await timed("sourceCoverage", () => measureLongSourceCoverageV1(snapshot, plan, { ffprobePath, assetBase: options.assetBase }));
  const requestedPath = resolve(input.outputPath);
  const selection = await selectLongRenderWorkRootV1({ outputPath: requestedPath, configuredRoot: options.workRoot, probe });
  const runId = randomUUID();
  const journal = await openLongRenderJournalV1({ workRoot: selection.root, runId, registryRoot: options.longRender?.journalRegistryRoot });
  const runDirectory = join(selection.root, `editkin-long-run-${runId}`);
  const outputStagingDirectory = longRenderOutputStagingDirectoryV1(requestedPath, runId);
  const partPath = longRenderPartPathV1(requestedPath, runId);
  let guard: ReturnType<typeof createLongRenderSpaceGuardV2> | undefined;
  let cleanup: LongJournalCleanupReceiptV1 | undefined;
  let dispatch: LongDispatchStateV1 | undefined;
  let result: RenderResult | undefined;
  let publish: LongPublishReceiptV1 | undefined;
  try {
    await createOwnedDirectoryV1(runDirectory, runId);
    await journal.recordCreated(runDirectory, "run-work-dir");
    await createOwnedDirectoryV1(outputStagingDirectory, runId);
    await journal.recordCreated(outputStagingDirectory, "output-staging-dir");
    const abort = renderLifetimeAbort();
    guard = createLongRenderSpaceGuardV2({
      rows: [{ path: outputStagingDirectory, role: "output" }, { path: runDirectory, role: "work" }, { path: systemVolumePath(), role: "system" }],
      policy, stagingRoots: [runDirectory], outputRoots: [outputStagingDirectory], probe,
      onFailure: error => abort?.(error),
      onWarning: message => { console.warn(`[long-render ${runId}] ${message}`); },
      remainingOutputBytes: written => Math.max(0, facts.finalOutputEstimateBytes - written),
    });
    await guard.admit({ outputBytes: facts.finalOutputEstimateBytes, workBytes: predictedLongStagingBytesV1(predicted, facts, policy) });
    guard.start();
    const base: LongRenderRunBaseV1 = {
      schema: "editkin.long-render-run/v1", runId, policy, classification, facts, workRoot: selection.root, runDirectory, outputStagingDirectory,
      partPath, requestedPath, journal, guard, signal: renderLifetimeSignal() ?? new AbortController().signal, predictedRoute: predicted.route,
    };
    dispatch = { base, providers };
    await options.longRender?.onRunStarted?.(base);
    const state = dispatch;
    result = await timed("render", () => runWithRenderWorkRootV1(runDirectory, () => input.renderContent(snapshot, partPath, state)));
    if (!state.run) throw new LongRenderRefusalV1("LONG_RENDER_ROUTE_NOT_AVAILABLE", "the LONG render finished without reaching a LONG route dispatch point");
    if (resolve(result.outputPath) !== partPath) throw new LongRenderRefusalV1("LONG_RENDER_OUTPUT_QA", "the LONG route did not write its owned .part output", { expected: partPath, actual: result.outputPath });
    await journal.recordCreated(partPath, "part");
    await guard.check("pre-publish");
    reportRenderStage("verify");
    const run = state.run;
    publish = await timed("publish", () => publishLongRenderOutputV1({ partPath, requestedPath, identity: run.identity, ffprobePath, journal }));
  } finally {
    await guard?.stop();
    const started = performance.now();
    try { cleanup = await journal.cleanup({ releaseMs: policy.releaseMs }); }
    catch (error) { cleanup = { schema: "editkin.long-render-cleanup/v1", removed: [], leftovers: [{ path: journal.path, reason: error instanceof Error ? error.message : String(error) }], elapsedMs: 0, attempts: 0 }; }
    stageMs.cleanup = Math.round(performance.now() - started);
    if (selection.source === "beside-output") await rmdir(selection.root).catch(() => undefined);
  }
  const run = dispatch!.run!;
  const receipt: LongRenderReceiptV1 = {
    schema: "editkin.long-render/v1", runId, route: run.route, ...(dispatch!.decision?.residentStreamVersion ? { residentStreamVersion: dispatch!.decision.residentStreamVersion } : {}),
    classification, facts, policy, workRoot: { path: selection.root, source: selection.source }, identity: run.identity, sourceCoverage,
    guard: guard!.receipt, publish: publish!, cleanup: cleanup!, stageMs,
  };
  try {
    const artifactIdentity = await timed("artifactIdentity", () => collectRenderArtifactIdentity(requestedPath, projectContentSha256, options.ffprobePath, undefined, { durationSeconds: result!.duration }));
    return { ...result!, outputPath: requestedPath, artifactIdentity, longRender: { ...receipt, stageMs } };
  } catch (error) {
    throw new Error(`影片已產生並保留於 ${requestedPath}，但輸出身分未驗證：${error instanceof Error ? error.message : String(error)}`);
  }
}
