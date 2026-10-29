import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { createHash } from "node:crypto";
import { canonicalJson } from "../shared/canonicalJson";
import { applyCommand } from "../domain/commands";
import { findAsset, findClip } from "../domain/editGraph";
import type { EditProject } from "../domain/types";
import type { EditorCommand } from "../domain/commandTypes";
import { clipSpeedSchemaV1, clipTimeRemapSchemaV1, clipTimeRemapExpectedV1, clipTimeRemapClockV1, clipTimeRemapAudioPlanV1, hasAuthoredClipTimeRemapV1 } from "../domain/clipTimeRemapV1";
import { textResult, errorResult } from "./toolRuntime";
const base = { projectPath: z.string().trim().min(1).max(1024), clipId: z.string().trim().min(1).max(160) };
export const clipSpeedPrepareSchemaV1 = z.strictObject({ ...base, speed: clipSpeedSchemaV1.nullable() });
export const clipCurvePrepareSchemaV1 = z.strictObject({ ...base, timeRemap: clipTimeRemapSchemaV1.nullable() });
export interface ClipTimeRemapToolDependenciesV1 { readProject(path: string): Promise<EditProject> }
async function dependenciesDefault(): Promise<ClipTimeRemapToolDependenciesV1> { const { readProject } = await import("./storage"); return { readProject }; }
export async function prepareClipTimeRemapV1(kind: "speed" | "curve", value: unknown, signal?: AbortSignal, supplied?: ClipTimeRemapToolDependenciesV1) {
  const parsed = kind === "speed" ? clipSpeedPrepareSchemaV1.parse(value) : kind === "curve" ? clipCurvePrepareSchemaV1.parse(value) : (() => { throw Error("CLIP_TIME_REMAP_PREPARE_KIND_INVALID"); })();
  signal?.throwIfAborted(); const dependencies = supplied ?? await dependenciesDefault(), project = await dependencies.readProject(parsed.projectPath); signal?.throwIfAborted();
  const clip = findClip(project, parsed.clipId), expected = clipTimeRemapExpectedV1(clip);
  const command: EditorCommand = "speed" in parsed ? { type: "set_clip_speed", clipId: parsed.clipId, expected, speed: parsed.speed }
    : { type: "set_clip_time_remap", clipId: parsed.clipId, expected, timeRemap: parsed.timeRemap };
  const candidate = applyCommand(project, command), target = findClip(candidate, parsed.clipId), clock = clipTimeRemapClockV1(candidate, target, findAsset(candidate, target.assetId));
  signal?.throwIfAborted();
  return { status: "DRAFT_SOURCE_CLOCK_COMMAND" as const, mutationPerformed: false, command,
    projectBinding: { id: project.id, revision: project.revision, sha256: createHash("sha256").update(canonicalJson(project)).digest("hex") },
    clock: clock ? { schema: clock.schema, outputRate: clock.outputRate, totalOutputFrames: clock.totalOutputFrames, timelineDurationSeconds: clock.timelineDurationSeconds,
      sourceStartSeconds: clock.sourceStartSeconds, sourceEndSeconds: clock.sourceEndSeconds, consumedSourceSeconds: clock.consumedSourceSeconds, direction: clock.direction, interpolation: clock.interpolation, segments: clock.segments.length } : null,
    audioPlan: clipTimeRemapAudioPlanV1(target), timelineDurationChanged: false, sourceAssetChanged: false, mediaStagingBytes: 0,
    sharedFrameConsumerRequired: hasAuthoredClipTimeRemapV1(target), previewExportConsumerReady: false, sourceMediaTimingVerified: false,
    directApplyAllowed: false, certificationPerformed: false, installedActivationPerformed: false };
}
export function registerClipTimeRemapToolsV1(server: McpServer) {
  server.registerTool("prepare_clip_speed", { description: "唯讀準備set_clip_speed草案：保留時間軸長度，speed為絕對base rate，0定格，null移除；不產生整段衍生物。驗expected來源/完整settings與可用source span，恒速音訊規劃atempo保音高。新sharedframe/preview/export consumer尚未接入，不能宣稱可渲染或直接apply；舊B4 clip_retime不改。",
    inputSchema: clipSpeedPrepareSchemaV1, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
    async (input, extra) => { try { return textResult(await prepareClipTimeRemapV1("speed", input, extra.mcpReq.signal)); } catch (error) { return errorResult(error); } });
  server.registerTool("prepare_clip_time_remap", { description: "唯讀準備set_clip_time_remap草案：normalized Bezier speed multiplier乘base speed，forward/reverse、frame blending、mute或follow音訊政策。積分驗source handles、descriptor有界；保留timeline長度，null移除curve。尚須shared decoded-frame/audio consumer與preview/export一致性驗證，不直接apply/不給ready、不新模型或VA變更。",
    inputSchema: clipCurvePrepareSchemaV1, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
    async (input, extra) => { try { return textResult(await prepareClipTimeRemapV1("curve", input, extra.mcpReq.signal)); } catch (error) { return errorResult(error); } });
}
