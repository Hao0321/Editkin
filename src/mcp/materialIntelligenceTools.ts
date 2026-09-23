import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { join, resolve } from "node:path";
import { findAsset, findClip, summarizeProject } from "../domain/editGraph";
import {
  compactMaterialContext,
  materialSemanticsInputSchema,
  prepareMaterialIntelligence,
  readMaterialIntelligence,
  readMaterialKeyframe,
  recordMaterialSemantics,
  type MaterialKeyframe,
} from "../application/materialIntelligence";
import { creativeAssetIdFromUri, resolveCreativeLibraryAsset } from "../application/creativeLibrary";
import { materialColorSummary } from "../application/materialColorContext";
import {
  MATERIAL_KEYFRAME_MAX_IMAGES,
  MATERIAL_KEYFRAME_MAX_RESPONSE_BYTES,
  paginateAgentRows,
} from "../application/agentContextBudget";
import { readProject, resolveWorkspaceMediaPath, workspaceRoot } from "./storage";
import { personalVisualRoot } from "./toolRuntime";
import { materialPreparationJobs } from "../application/materialPreparationJobs";

function textResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

function errorResult(error: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ status: "BLOCK", error: error instanceof Error ? error.message : String(error) }) }],
    isError: true,
  };
}

function creativePackRoot(): string {
  return process.env.EDITKIN_CREATIVE_PACK_ROOT ?? resolve(process.cwd(), ".creative-packs/hao-creator-library");
}

function personalMusicRoot(): string {
  return process.env.EDITKIN_PERSONAL_MUSIC_ROOT ?? resolve(process.cwd(), ".personal-packs/hao-music-library");
}

function runtime() {
  const modelRoot = process.env.EDITKIN_MODEL_ROOT ?? join(workspaceRoot(), ".editkin-models");
  return {
    ffmpegPath: process.env.HAO_FFMPEG_PATH ?? "ffmpeg",
    ffprobePath: process.env.HAO_FFPROBE_PATH,
    modelRoot,
    modelPath: process.env.EDITKIN_WHISPER_MODEL_PATH,
    cacheRoot: process.env.EDITKIN_CACHE_ROOT ?? resolve(modelRoot, "../media-cache"),
  };
}

async function resolveAssetSource(uri: string): Promise<string> {
  const creativeId = creativeAssetIdFromUri(uri);
  if (creativeId) return (await resolveCreativeLibraryAsset(creativePackRoot(), creativeId, personalMusicRoot(), personalVisualRoot())).absolutePath;
  return resolveWorkspaceMediaPath(uri);
}

export function compactMaterialKeyframe(frame: MaterialKeyframe) {
  return { id: frame.id, time: frame.time, sceneIndex: frame.sceneIndex, sha256: frame.sha256, bytes: frame.bytes, mimeType: frame.mimeType,
    ...(frame.display ? { display: { receiptSha256: frame.display.receiptSha256, purpose: frame.display.normalization.purpose,
      transfer: frame.display.normalization.transfer, requestedTime: frame.display.requested.time,
      actualTime: frame.display.decoded.relativeTime, sceneAttributionVerified: frame.display.decoded.sceneAttributionVerified } } : {}) };
}

export function materialKeyframeReadiness(frames: readonly MaterialKeyframe[]) {
  const unverifiedDisplayFrameIds = frames.filter((frame) => !frame.display).map((frame) => frame.id);
  return { status: unverifiedDisplayFrameIds.length ? "PARTIAL" : "GREEN",
    needsReprepare: unverifiedDisplayFrameIds.length > 0, unverifiedDisplayFrameIds };
}

function compactPacket(packet: Awaited<ReturnType<typeof readMaterialIntelligence>>) {
  const cuts = packet.analysis.scene.cuts.slice(0, 40);
  return {
    schema: packet.schema,
    materialId: packet.materialId,
    source: packet.source,
    scene: {
      ...packet.analysis.scene,
      cuts,
      totalCutCount: packet.analysis.scene.cuts.length,
      hasMore: packet.analysis.scene.cuts.length > cuts.length,
    },
    transcript: {
      state: packet.analysis.transcript.state,
      engine: packet.analysis.transcript.engine,
      language: packet.analysis.transcript.language,
      cueCount: packet.analysis.transcript.cueCount,
      reason: packet.analysis.transcript.reason,
      ...(packet.analysis.transcript.segmentation ? { segmentation: {
        windowCount: packet.analysis.transcript.segmentation.windows.length,
        boundaryCuesRequireReview: packet.analysis.transcript.segmentation.boundaryCuesRequireReview,
      } } : {}),
    },
    color: materialColorSummary(packet.analysis.color, 0, packet.source.duration),
    keyframeAnalysis: packet.analysis.keyframes,
    keyframes: packet.keyframes.map(compactMaterialKeyframe),
  };
}

function preparedResult(result: { packet: Awaited<ReturnType<typeof readMaterialIntelligence>>; cacheHit: boolean }) {
  const { analysis } = result.packet;
  return { status: analysis.transcript.state === "blocked" || analysis.scene.state === "blocked" || analysis.color?.status === "unmeasured"
    || analysis.keyframes?.state === "blocked" || analysis.keyframes?.state === "partial" ? "PARTIAL" : "GREEN", cacheHit: result.cacheHit, packet: compactPacket(result.packet) };
}

export const EDITKIN_MCP_INSTRUCTIONS = [
  "Editkin is a local STDIO editing tool controlled by the user's MCP-compatible agent; never request an Editkin API key or AI provider token.",
  "For automatic editing: call get_autopilot_contract, start_ai_editing_session, then prepare_ai_material for every relevant clip. Long sources return a RUNNING job immediately: poll get_material_preparation_job until it returns GREEN/PARTIAL with a sealed packet; RUNNING is NOT a completed prepare receipt. Poll at most once every 10 seconds. Use cancel_material_preparation_job to cancel; resume by repeating the fresh prepare request with resumeJobId. Do not start duplicate jobs or proceed to semantics while preparation is incomplete. Then view_material_keyframes in batches of at most 4 within the response byte limit, and get_material_context for bounded transcript windows.",
  "Material colour observations cover only the cited normalized representative samples. Missing/unknown colour interpretation is unmeasured, not Rec709. A neutral candidate is not a trusted white point; brightness, endpoint occupancy or a creative LUT does not prove automatic exposure/WB correction or human-approved aesthetics.",
  "For precise event inspection, prepare_ai_material accepts optional keyframeTimes: 1..12 strictly increasing source-clip-relative seconds, each >=0 and <clip.duration, within maxKeyframes. Do not add sourceStart or use timeline time. Select times from observed evidence; different selections create different sealed material packets and reuse valid speech/scene caches. View every returned image before recording semantics. Sparse overview samples do not prove an unseen launch, collision or outcome. This does not alter the project or mark frames human-reviewed.",
  "After recording material semantics, propose_auto_color_exposure can evaluate a declared editorial luminance target (not a measured correct exposure). Bind its exact command and autoColor decision ID/index in the same v4 plan. It evaluates representative static primary exposure only, before looks/graphics; target_unreachable requires review and does not certify colour, shot matching or white balance.",
  "propose_reference_white_balance needs explicit caller-declared neutral ROIs in the first and last measured upright source frames. It measures source FLOAT before tone/look; maxGainStops is log2 gain, not artistic temperature/tint. Only applicable=true may bind its absolute whiteBalanceRed/Green/Blue command with mode=reference_white_balance in autoColor. Gray-looking pixels, walls, clothing or semantic labels alone do not verify a white point. This is not automatic white-point discovery, skin protection or full-film matching. Do not combine independent exposure/WB decisions on one clip in one plan; re-evaluate after a committed primary change.",
  "Record evidence-backed observations with record_material_semantics before producing the video-autopilot plan. Call resolve_autopilot_inference_route, audit_autopilot_plan, then apply_autopilot_plan. Never bypass BLOCK or review_required.",
  "Before any mask, Auto Roto or green/blue Screen Keyer command, call inspect_roto_keyer_capabilities, view the cited keyframes, record_roto_keyer_evidence, then build_autopilot_roto_keyer_decision or prepare_autopilot_auto_roto. Never infer a screen key from color alone, never use research/external routes, and never omit the exact rotoKeyer decision from the v4 plan.",
  "For subject tracking in an automatic edit, call prepare_autopilot_motion_track after inspecting the real target in source frames. Bind its add_motion_track command to a narrative beat and the tracking_masks decision in the same v4 plan. The direct track_subject_and_attach_label tool is for manual edits and must not bypass audit/apply.",
  "For an automatic template, list_creative_presets(kind=template) and call prepare_autopilot_template_package with the exact visual clip IDs. It only compiles the chosen Look and long-form white-on-translucent-black subtitle style. Author actual titles/cards with registered Motion v2 presets after reading the design brief; effects, transitions and recuts need material evidence and the same audited v4 plan.",
  "Before authoring editorial graphics, call list_creative_presets with kind=motion, expand only the selected motionPresetId, and bind that presetId to the matching add_motion_graphic seed in the v4 plan. For custom v2 visual styling, use the returned motionPresetVariant descriptor: declare its basePresetSha256, reason and allowed overrides in editorial.graphics[].presetVariant; resolved commands must match exactly. Never disguise custom styling as an unchanged stock preset or apply before audit.",
  "For an evidence-verified on-screen person, use one matched lower_third_*_name plus lower_third_*_unit preset pair and the lower_third_name/lower_third_affiliation editorial kinds, both with purpose=identity and the exact same editorial frame range. Each evidenceRefs item must be mi:<materialId>:<semanticReceiptSha256>:cue:<index>, must resolve to a material receipt carried by the v4 plan, and the immutable transcript cue must contain the visible claim. The name BAR starts at range.startFrame; the unit BAR starts at most 0.08 seconds later and both end at range.endFrame. Never invent a person's name, title or organisation, and never place a lower third over dense subtitles.",
  "Before selecting montage, camera-language, retiming or bullet-time behavior, call list_creative_presets with kind=cinematic; satisfy every listed requirement and use the declared fallback or honestLabel when a capability gate is unavailable.",
  "For a beat montage draft, call compile_beat_montage and bind its caller-asserted beat/salience/storyOrder to v4 material receipts or human review. Compilation does not verify that evidence or grant ACCEPTED. Place its command into the same v4 plan; never pass it to apply_edit_commands, and always continue through audit_autopilot_plan and apply_autopilot_plan.",
  "Original media is read-only. Use structured EditGraph tools, semantic creative asset IDs, atomic updates and render_project. If no structured Editkin tool exists, Computer Use may only control Editkin's own UI as a bounded fallback; never invoke or hand off to an external editor.",
].join("\n");

export function registerMaterialIntelligenceTools(server: McpServer): void {
  server.registerTool("start_ai_editing_session", {
    description: "開始低 Token 自動剪輯工作階段；分頁回傳專案摘要、片段索引與固定工作流，不暴露本機絕對路徑，也不需要 Editkin API key。",
    inputSchema: z.object({
      projectPath: z.string(),
      clipOffset: z.number().int().nonnegative().default(0),
      clipLimit: z.number().int().min(1).max(100).default(40),
    }),
  }, async ({ projectPath, clipOffset, clipLimit }) => {
    try {
      const project = await readProject(projectPath);
      const assets = new Map(project.assets.map((asset) => [asset.id, asset]));
      const clips = project.tracks.flatMap((track) => track.clips.map((clip) => {
        const asset = assets.get(clip.assetId);
        return { clipId: clip.id, assetId: clip.assetId, assetName: asset?.name, kind: asset?.kind, trackId: track.id, timelineStart: clip.timelineStart, sourceStart: clip.sourceStart, duration: clip.duration };
      }));
      const clipPage = paginateAgentRows(clips, clipOffset, clipLimit);
      return textResult({
        status: "GREEN",
        aiConnection: { transport: "local_stdio_mcp", apiKeyRequiredByEditkin: false, billing: "current_host_session" },
        summary: summarizeProject(project),
        clips: clipPage.page,
        clipPage: {
          totalClips: clipPage.total,
          offset: clipPage.offset,
          limit: clipPage.limit,
          nextOffset: clipPage.nextOffset,
        },
        workflow: ["prepare_ai_material", "view_material_keyframes", "get_material_context", "record_material_semantics", "inspect_roto_keyer_capabilities", "record_roto_keyer_evidence", "build_autopilot_roto_keyer_decision|prepare_autopilot_auto_roto", "resolve_autopilot_inference_route", "audit_autopilot_plan", "apply_autopilot_plan", "render_project"],
      });
    } catch (error) { return errorResult(error); }
  });

  server.registerTool("prepare_ai_material", {
    description: "建立本機素材理解包。可選 keyframeTimes 精看事件：最多 12 個嚴格遞增的片段來源相對秒數，0 <= t < clip.duration，不加 sourceStart、不用時間軸秒數，且不得超過 maxKeyframes。抽幀選擇綁定 cache／semantic receipt，原片與專案不變。auto 對超過 60 秒素材回 RUNNING/jobId；以 get_material_preparation_job 取完成 packet。resumeJobId 只重用已驗證分段，不跳過看片流程。",
    inputSchema: z.object({
      projectPath: z.string(), clipId: z.string(), language: z.string().default("auto"),
      includeTranscript: z.boolean().default(true), maxKeyframes: z.number().int().min(1).max(12).default(8),
      keyframeTimes: z.array(z.number().finite().nonnegative()).min(1).max(12).optional(),
      execution: z.enum(["auto", "background", "sync"]).default("auto"), resumeJobId: z.string().uuid().optional(),
    }).refine(input => input.keyframeTimes === undefined || (input.keyframeTimes.length <= input.maxKeyframes
      && input.keyframeTimes.every((time, index, all) => index === 0 || time > all[index - 1])), "keyframeTimes 必須嚴格遞增且不超過 maxKeyframes"),
  }, async ({ projectPath, clipId, language, includeTranscript, maxKeyframes, keyframeTimes, execution, resumeJobId }) => {
    try {
      const project = await readProject(projectPath);
      const clip = findClip(project, clipId);
      const asset = findAsset(project, clip.assetId);
      const sourcePath = await resolveAssetSource(asset.uri);
      const request = {
        assetId: asset.id, clipId, sourcePath, sourceStart: clip.sourceStart, duration: clip.duration,
        fps: project.fps, kind: asset.kind, sourceSha256: asset.derivatives?.sourceSha256,
        language, includeTranscript, maxKeyframes, ...(keyframeTimes !== undefined ? { keyframeTimes } : {}), color: asset.color, colorManagement: project.colorManagement,
      };
      const current = runtime();
      if (execution === "background" || resumeJobId || (execution === "auto" && clip.duration > 60)) {
        const started = await materialPreparationJobs(current.cacheRoot).start(request, current, resumeJobId);
        return textResult({ status: started.job.state, ...started, nextTool: "get_material_preparation_job", pollAfterMs: 10000 });
      }
      return textResult(preparedResult(await prepareMaterialIntelligence(request, current)));
    } catch (error) { return errorResult(error); }
  });

  server.registerTool("get_material_preparation_job", {
    description: "查詢素材準備的分段進度；完成後重新驗證 sealed material packet 並回傳與 prepare_ai_material 相同的 GREEN/PARTIAL receipt。RUNNING、CANCELLING、FAILED 等不是完成證據。",
    inputSchema: z.object({ jobId: z.string().uuid() }),
  }, async ({ jobId }) => {
    try {
      const current = runtime(), job = await materialPreparationJobs(current.cacheRoot).status(jobId);
      if (job.state !== "COMPLETED" || !job.result) return textResult({ status: job.state, job, pollAfterMs: 10000 });
      const packet = await readMaterialIntelligence(current.cacheRoot, job.result.materialId);
      if (packet.cache?.packetSha256 !== job.result.packetSha256) throw Error("素材工作結果與封存 packet 不一致");
      return textResult({ ...preparedResult({ packet, cacheHit: job.result.cacheHit }), job });
    } catch (error) { return errorResult(error); }
  });

  server.registerTool("cancel_material_preparation_job", {
    description: "取消此連線持有的素材準備；CANCELLING 代表仍在收尾，等到 CANCELLED 才已停止。原片不變，完成的辨識分段保留供明確續跑。",
    inputSchema: z.object({ jobId: z.string().uuid() }),
  }, async ({ jobId }) => {
    try { const job = await materialPreparationJobs(runtime().cacheRoot).cancel(jobId); return textResult({ status: job.state, job }); }
    catch (error) { return errorResult(error); }
  });

  server.registerTool("get_material_context", {
    description: "依時間窗與 cue cursor 分頁讀取逐字稿、分鏡與關鍵幀索引；回應受 1100 estimated-token 硬上限約束，不會把整支影片塞進 context。",
    inputSchema: z.object({
      materialId: z.string().regex(/^[a-f0-9]{64}$/),
      start: z.number().nonnegative().default(0),
      end: z.number().positive(),
      maxCues: z.number().int().min(1).max(200).default(80),
      afterCueIndex: z.number().int().min(-1).default(-1),
      maxTokens: z.number().int().min(200).max(1_100).default(600),
      maxCuts: z.number().int().min(1).max(100).default(20),
    }),
  }, async ({ materialId, start, end, maxCues, afterCueIndex, maxTokens, maxCuts }) => {
    try {
      return textResult({
        status: "GREEN",
        context: compactMaterialContext(
          await readMaterialIntelligence(runtime().cacheRoot, materialId),
          start,
          end,
          maxCues,
          { afterCueIndex, maxTokens, maxCuts },
        ),
      });
    }
    catch (error) { return errorResult(error); }
  });

  server.registerTool("view_material_keyframes", {
    description: "把已驗證 SHA-256 的素材關鍵幀直接作為 MCP image content 交給目前 AI session 觀看；一次最多 4 張，不回傳檔案路徑。舊快取缺少顯示正規化收據時明示 PARTIAL/needsReprepare，不視為已驗證 neutral-sRGB。",
    inputSchema: z.object({ materialId: z.string().regex(/^[a-f0-9]{64}$/), frameIds: z.array(z.string().regex(/^kf-\d+$/)).min(1).max(MATERIAL_KEYFRAME_MAX_IMAGES) }),
  }, async ({ materialId, frameIds }) => {
    try {
      const frames = await Promise.all(frameIds.map((frameId) => readMaterialKeyframe(runtime().cacheRoot, materialId, frameId)));
      const totalImageBytes = frames.reduce((sum, frame) => sum + frame.data.length, 0);
      if (totalImageBytes > MATERIAL_KEYFRAME_MAX_RESPONSE_BYTES) {
        throw new Error(`關鍵幀回應超過 ${MATERIAL_KEYFRAME_MAX_RESPONSE_BYTES} bytes，請減少 frameIds 後重試`);
      }
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ ...materialKeyframeReadiness(frames.map(({ frame }) => frame)), materialId, totalImageBytes, frames: frames.map(({ frame }) => compactMaterialKeyframe(frame)) }) },
          ...frames.map(({ data }) => ({ type: "image" as const, data: data.toString("base64"), mimeType: "image/jpeg" as const })),
        ],
      };
    } catch (error) { return errorResult(error); }
  });

  server.registerTool("record_material_semantics", {
    description: "保存目前 session 對素材的證據式語意判讀。每段都必須引用關鍵幀或逐字稿 cue，receipt 綁定來源 SHA-256，過期素材會 fail closed。",
    inputSchema: materialSemanticsInputSchema,
  }, async (input) => {
    try {
      const receipt = await recordMaterialSemantics(runtime().cacheRoot, input);
      return textResult({ status: "GREEN", receipt: { schema: receipt.schema, materialId: receipt.materialId, sourceSha256: receipt.sourceSha256, semanticReceiptSha256: receipt.semanticReceiptSha256, segmentCount: receipt.segments.length, createdAt: receipt.createdAt } });
    } catch (error) { return errorResult(error); }
  });
}
