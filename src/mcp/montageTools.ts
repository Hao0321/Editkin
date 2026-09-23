import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  compileBeatAlignedMontage,
  type BeatMontageShotEvidence,
} from "../application/beatMontageCompiler";
import type { EditProject } from "../domain/types";
import { errorResult, textResult } from "./toolRuntime";
import { readProject } from "./storage";

const boundedIdSchema = z.string().trim().min(1).max(128);
const boundedTimeSchema = z.number().finite().nonnegative().max(86_400);

export const compileBeatMontageInputSchema = z.strictObject({
  projectPath: z.string().trim().min(1).max(1_024),
  targetTrackId: boundedIdSchema.default("video-main"),
  beatTimes: z.array(boundedTimeSchema).min(2).max(65),
  candidates: z.array(z.strictObject({
    shotId: boundedIdSchema,
    assetId: boundedIdSchema,
    sourceStart: boundedTimeSchema,
    sourceEnd: boundedTimeSchema,
    salience: z.number().finite().min(0).max(1),
    storyOrder: z.number().int().min(-1_000_000).max(1_000_000),
    focusTime: boundedTimeSchema.optional(),
    volume: z.number().finite().min(0).max(4).optional(),
  })).min(1).max(512),
  clipIds: z.array(boundedIdSchema).min(1).max(64).optional(),
});

export type CompileBeatMontageInput = z.infer<typeof compileBeatMontageInputSchema>;

export interface CompileBeatMontageDependencies {
  readProject(projectPath: string): Promise<EditProject>;
}

export async function compileBeatMontageReadOnly(
  input: CompileBeatMontageInput,
  dependencies: CompileBeatMontageDependencies = { readProject },
) {
  // Parse again at the application boundary so direct imports cannot bypass the MCP schema.
  const parsed = compileBeatMontageInputSchema.parse(input);
  const project = await dependencies.readProject(parsed.projectPath);
  const compiled = compileBeatAlignedMontage(project, {
    targetTrackId: parsed.targetTrackId,
    beatTimes: parsed.beatTimes,
    candidates: parsed.candidates as BeatMontageShotEvidence[],
    clipIds: parsed.clipIds,
  });
  return {
    status: "DRAFT_COMMAND_CANDIDATE" as const,
    mutationPerformed: false as const,
    evidenceAuthority: "caller_asserted_unverified" as const,
    projectId: compiled.projectId,
    projectRevision: compiled.projectRevision,
    engine: compiled.engine,
    targetTrackId: compiled.targetTrackId,
    beatTimes: compiled.beatTimes,
    selections: compiled.selections,
    command: compiled.command,
    guarantees: compiled.guarantees,
    executionBoundary: "compile_only_v4_plan_audit_atomic_apply_required" as const,
    directApplyAllowed: false as const,
  };
}

export function registerMontageTools(server: McpServer): void {
  server.registerTool("compile_beat_montage", {
    description: "唯讀把 caller 宣告但尚未驗真的 beat grid、salience 與 storyOrder 編譯成選鏡／重排／裁切 EditGraph draft command；不修改專案、不授予 ACCEPTED。上述證據仍須綁定 v4 material receipts 或人工檢查；將 command 放進同一份 Video Autopilot v4 plan，經 audit_autopilot_plan 後才可由 apply_autopilot_plan 原子提交。此工具不宣稱 beat detection、pairwise transition、time remap 或 J/L cut。",
    inputSchema: compileBeatMontageInputSchema,
  }, async (input) => {
    try { return textResult(await compileBeatMontageReadOnly(input)); }
    catch (error) { return errorResult(error); }
  });
}
