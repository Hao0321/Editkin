import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { measureFinalOutputScopesV1, finalOutputArtifactIdentityV1Schema, finalOutputScopesOptionsV1Schema } from "../render/finalOutputScopesV1";
import { readFinalPixelScopePageV1, FINAL_PIXEL_SCOPE_LIMITS } from "../color/finalPixelScopesV1";
import { resolveWorkspaceMediaPath } from "./storage";
import { errorResult, textResult } from "./toolRuntime";

export const finalOutputScopePageV1Schema = z.object({
  scope: z.enum(["waveform", "parade", "histogram", "vectorscope"]),
  plane: z.enum(["luma", "red", "green", "blue", "chroma"]),
  offset: z.number().int().nonnegative().max(FINAL_PIXEL_SCOPE_LIMITS.countCells).default(0),
  limit: z.number().int().min(1).max(FINAL_PIXEL_SCOPE_LIMITS.pageValues).default(128),
}).strict().refine(value => value.scope === "waveform" ? value.plane === "luma"
  : value.scope === "vectorscope" ? value.plane === "chroma"
  : value.scope === "parade" ? ["red", "green", "blue"].includes(value.plane)
  : ["luma", "red", "green", "blue"].includes(value.plane), "Scope plane does not exist");
export const measureFinalOutputScopesInputV1Schema = z.object({
  outputPath: z.string().min(1).max(4096), artifact: finalOutputArtifactIdentityV1Schema,
  timelineFrame: z.number().int().nonnegative().max(20_735_999),
  options: finalOutputScopesOptionsV1Schema.optional(), page: finalOutputScopePageV1Schema,
}).strict().refine(value => value.timelineFrame < value.artifact.durationFrames, "Selected output frame outside artifact");
export interface FinalOutputScopeToolDependencies {
  resolveOutputPath: typeof resolveWorkspaceMediaPath;
  measure: typeof measureFinalOutputScopesV1;
  runtime(): { ffmpegPath: string; ffprobePath?: string; timeoutMs: number; signal?: AbortSignal };
}
const productionDependencies: FinalOutputScopeToolDependencies = {
  resolveOutputPath: resolveWorkspaceMediaPath, measure: measureFinalOutputScopesV1,
  runtime: () => ({ ffmpegPath: process.env.HAO_FFMPEG_PATH ?? "ffmpeg", ffprobePath: process.env.HAO_FFPROBE_PATH, timeoutMs: 30000 }),
};
export function registerFinalOutputScopeToolsV1(server: McpServer, dependencies: FinalOutputScopeToolDependencies = productionDependencies): void {
  server.registerTool("measure_final_output_color_scopes", {
    description: "Read-only actual encoded-output frame scopes: BT709 SDR luma waveform, RGB parade/histograms and CbCr vectorscope with an I-axis guide. Supply the expected render artifact identity and output frame; output bytes, decoded PTS/raster/colour metadata and decoder hashes are checked. Returns one bounded density/count page plus all scope metadata. HLG sources are measured after an actual SDR render; HDR-encoded outputs must first be transformed to SDR. This measures the supplied artifact, not current unsaved timeline state or artistic quality.",
    inputSchema: measureFinalOutputScopesInputV1Schema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input, context) => {
    try {
      const request = measureFinalOutputScopesInputV1Schema.parse(input), outputPath = await dependencies.resolveOutputPath(request.outputPath);
      const { page, ...measurementRequest } = request;
      const measured = await dependencies.measure({ ...measurementRequest, outputPath }, { ...dependencies.runtime(), signal: context.mcpReq.signal });
      const payload = { status: "MEASURED", receipt: measured.receipt, scopes: measured.measurement, page: readFinalPixelScopePageV1(measured.measurement, page) };
      if (Buffer.byteLength(JSON.stringify(payload)) > 16384) throw Error("Final scope response byte budget exceeded");
      return textResult(payload);
    } catch (error) { return errorResult(error); }
  });
}
