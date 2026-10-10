import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { resolve } from "node:path";
import { exportVideo } from "../application/exportVideo";
import { materializeCreativeAssets } from "../application/creativeLibrary";
import { summarizeProject } from "../domain/editGraph";
import { creativePackRoot, errorResult, personalMusicRoot, personalVisualRoot, textResult } from "./toolRuntime";
import { readProject, resolveProjectPath, resolveRenderPath, workspaceRoot, readAuthenticatedOriginalMotionReceipt } from "./storage";
import { createOriginalMotionRenderBindingVerifier } from "../application/originalMotionRenderBinding";
import { assertAutopilotPlanSourceCurrent, createAutopilotProjectAuditIdentity, readLiveAutopilotIdentity, sha256Canonical } from "../application/autopilotInvocationIdentity";
import { canonicalOriginalMotionSourceSetSchema } from "../application/originalMotionSourceSets";
import { verifyOriginalMotionFiles } from "./originalMotionWorkflow";
import { readCreatorReviewPolicy, assertProjectReviewPolicy, assertCreatorReviewPolicyCurrent } from "./creatorReviewPolicy";
import { readSelectedNativeVideoRuntime, assertSelectedNativeVideoRuntimeCurrent, type SelectedNativeVideoRuntimeIdentity } from "../application/selectedNativeVideoRuntime";

export function registerRenderTools(server: McpServer): void {
  server.registerTool("render_original_motion_project", {
    description: "Canonical v4 authored animation render: reads the owned authenticated committed receipt, actual saved project, authored files and current invocation/policy. New protected-user commits survive restart; legacy process seals require their original issuer. Caller receipt JSON and stale source hashes are refused. Output still requires whole-film decode, audio/art and performance QA.",
    inputSchema: z.strictObject({ projectPath: z.string().min(1), outputPath: z.string().min(1), preferGpu: z.boolean().default(true), planSha256: z.string().regex(/^[a-f0-9]{64}$/), originalSourceEvidenceSha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  }, async (input, context) => {
    try { return await renderOriginalMotionProject(input, context.mcpReq.signal); } catch (error) { return errorResult(error); }
  });
  server.registerTool("render_project", {
    description: "以 Rust 排程與 FFmpeg/GPU 輸出 MP4；輸出路徑限制在 EDITKIN_WORKSPACE。",
    inputSchema: z.object({
      projectPath: z.string(),
      outputPath: z.string().describe("相對 workspace 的 .mp4 路徑"),
      preferGpu: z.boolean().default(true),
    }),
  }, async ({ projectPath, outputPath, preferGpu }, context) => {
    try { return await renderAutopilotProject(projectPath, outputPath, preferGpu, undefined, context.mcpReq.signal); }
    catch (error) { return errorResult(error); }
  });
}

export async function renderAutopilotProject(projectPath: string, outputPath: string, preferGpu: boolean, verifiedProject?: Awaited<ReturnType<typeof readProject>>, signal?: AbortSignal, rendererBinding?: { identity: SelectedNativeVideoRuntimeIdentity | undefined }) {
  signal?.throwIfAborted();
  const renderer = rendererBinding ? await assertSelectedNativeVideoRuntimeCurrent(rendererBinding.identity) : await readSelectedNativeVideoRuntime();
  const storedProject = verifiedProject ?? await readProject(projectPath);
  const project = await materializeCreativeAssets(storedProject, creativePackRoot(), personalMusicRoot(), personalVisualRoot());
  const output = await resolveRenderPath(outputPath);
  const result = await exportVideo({
    project,
    outputPath: output,
    options: {
      assetBase: workspaceRoot(),
      autoRotoCacheRoot: process.env.EDITKIN_CACHE_ROOT ?? resolve(process.env.EDITKIN_MODEL_ROOT ?? resolve(workspaceRoot(), ".editkin-models"), "../media-cache"),
      ffmpegPath: process.env.HAO_FFMPEG_PATH,
      ffprobePath: process.env.HAO_FFPROBE_PATH,
      nativeCorePath: process.env.HAO_NATIVE_CORE_PATH ?? resolve(import.meta.dirname, "../../native/bin/win32-x64/hao-core.exe"),
      gpuCompositorPath: renderer?.executablePath,
      selectedNativeVideoRuntime: renderer?.identity,
      colorRoot: process.env.EDITKIN_COLOR_ROOT ?? resolve(import.meta.dirname, "../../public/color/aces2"),
      fontRoot: process.env.EDITKIN_FONT_ROOT ?? resolve(import.meta.dirname, "../../public/fonts"),
      preferGpu,
      signal,
    },
  });
  await assertSelectedNativeVideoRuntimeCurrent(renderer?.identity);
  signal?.throwIfAborted();
  return textResult({ status: "GREEN", ...result, ...(renderer ? { selectedNativeVideoRuntime: renderer.identity } : {}), summary: summarizeProject(project) });
}

export async function renderOriginalMotionProject(input: { projectPath: string; outputPath: string; preferGpu: boolean; planSha256: string; originalSourceEvidenceSha256: string }, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const storedProject = await readProject(input.projectPath);
  const path = await resolveProjectPath(input.projectPath);
  const identity = createAutopilotProjectAuditIdentity(path, storedProject);
  let receipt: Record<string, unknown> | undefined;
  const verifier = createOriginalMotionRenderBindingVerifier({ readAuthenticatedCommittedReceipt: async (projectIdentity, planSha256) => {
    receipt = await readAuthenticatedOriginalMotionReceipt(input.projectPath, projectIdentity, planSha256);
    return receipt;
  } });
  const binding = await verifier.verify({ project: storedProject, projectIdentity: identity, planSha256: input.planSha256, originalSourceEvidenceSha256: input.originalSourceEvidenceSha256 });
  const evidence = canonicalOriginalMotionSourceSetSchema.parse(receipt!.originalMotionEvidence);
  if (sha256Canonical(evidence) !== input.originalSourceEvidenceSha256) throw new Error("Original render source manifest SHA differs from committed execution");
  const invocation = await readLiveAutopilotIdentity();
  assertAutopilotPlanSourceCurrent(receipt!.source as Parameters<typeof assertAutopilotPlanSourceCurrent>[0], invocation);
  const policy = await readCreatorReviewPolicy();
  assertProjectReviewPolicy(storedProject, policy);
  await verifyOriginalMotionFiles(evidence, storedProject, signal);
  signal?.throwIfAborted();
  const result = await renderAutopilotProject(input.projectPath, input.outputPath, input.preferGpu, storedProject, signal,
    { identity: invocation.schema === "editkin.video-autopilot.live-identity/v2" ? invocation.renderer : undefined });
  await assertCreatorReviewPolicyCurrent(policy);
  if (sha256Canonical(await readProject(input.projectPath)) !== identity.contentSha256) throw new Error("Original project changed during render; preserve output as failed candidate");
  await verifyOriginalMotionFiles(evidence, storedProject, signal);
  assertAutopilotPlanSourceCurrent(receipt!.source as Parameters<typeof assertAutopilotPlanSourceCurrent>[0], await readLiveAutopilotIdentity());
  signal?.throwIfAborted();
  const render = JSON.parse(result.content[0].text);
  return textResult({ ...render, originalBinding: binding, qualityState: "review_required", qualityCertified: false });
}
