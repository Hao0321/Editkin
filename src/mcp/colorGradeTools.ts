import type { McpServer } from "@modelcontextprotocol/server";
import { isAbsolute, resolve, sep } from "node:path";
import { z } from "zod";
import { colorLutLibraryRoot, exportClipGradeCube, importColorLut, listColorLuts } from "../application/creativeLibrary";
import { FILM_LOOKS_V2 } from "../creative/filmLooksV2";
import { readProject, resolveLutExportPath, resolveWorkspaceMediaPath, workspaceRoot } from "./storage";
import { errorResult, textResult } from "./toolRuntime";

/**
 * Color Grade v2 / LUT tools (W1-4). Registration is one line in server.ts:
 *   registerColorGradeTools(server);
 * Looks themselves are already reachable through the module index (look.color, family
 * film_look_v2) and the set_clip_grade_v2 command; these tools cover the LUT library.
 */
export const importColorLutInputSchema = z.object({
  sourcePath: z.string().trim().min(1).max(1024),
  name: z.string().trim().min(1).max(200),
  license: z.string().trim().min(1).max(200),
  provenance: z.string().trim().min(1).max(200),
  rightsBasis: z.string().trim().min(1).max(200),
  inputSpace: z.enum(["rec709_display", "acescct"]),
}).strict();

export const exportClipGradeLutInputSchema = z.object({
  projectPath: z.string().trim().min(1).max(1024),
  clipId: z.string().trim().min(1).max(160),
  outputPath: z.string().trim().min(1).max(1024),
}).strict();

export interface ColorGradeToolDependencies {
  lutRoot(): string;
  resolveSourcePath(path: string): Promise<string>;
  /** Canonical output check: the export creates parent folders, so a junction must not lead the write outside. */
  resolveOutputPath?(path: string): Promise<string>;
  readProject: typeof readProject;
  workspaceRoot(): string;
}

function productionDependencies(): ColorGradeToolDependencies {
  return { lutRoot: colorLutLibraryRoot, resolveSourcePath: resolveWorkspaceMediaPath, resolveOutputPath: resolveLutExportPath, readProject, workspaceRoot };
}

export function registerColorGradeTools(server: McpServer, dependencies: ColorGradeToolDependencies = productionDependencies()): void {
  server.registerTool("list_color_luts", {
    description: "列出 Color LUT 素材庫（使用者匯入的 .cube）：id、SHA-256、1D／3D、尺寸、輸入工作空間、授權、來源與權利依據。調色節點以 {id, sha256, strength} 引用。",
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => {
    try { return textResult({ root: "color-lut-library", luts: await listColorLuts(dependencies.lutRoot()), filmLooksV2: FILM_LOOKS_V2.map(({ id, name, genre, certification }) => ({ id, name, genre, certification: certification.status })) }); }
    catch (error) { return errorResult(error); }
  });

  server.registerTool("import_color_lut", {
    description: "以嚴格 .cube 驗證（1D／3D、尺寸、列數、有限數值、DOMAIN）匯入工作區內的 LUT，依內容 SHA-256 存進 Color LUT 素材庫，必填授權、來源、權利依據與輸入工作空間（rec709_display 或 acescct）。不接受第三方 LUT 包的匿名匯入；不修改任何專案。回傳可放進 set_clip_grade_v2 節點的 {id, sha256}。",
    inputSchema: importColorLutInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => {
    try {
      const request = importColorLutInputSchema.parse(input);
      const sourcePath = await dependencies.resolveSourcePath(request.sourcePath);
      if (!isAbsolute(sourcePath)) throw new Error("LUT 來源必須解析為工作區內的絕對路徑");
      const entry = await importColorLut(dependencies.lutRoot(), { ...request, sourcePath });
      return textResult({ status: "IMPORTED", entry, nodeReference: { id: entry.id, sha256: entry.sha256, strength: 1 } });
    } catch (error) { return errorResult(error); }
  });

  server.registerTool("export_clip_grade_lut", {
    description: "把片段整套 Color Grade v2（節點、LUT 強度、Film Look）依專案工作空間烘成 65³ .cube 匯出到絕對路徑（不覆寫既有檔）。顆粒、halation、bloom、暗角屬空間效果，無法放進 LUT，會列在 omittedSpatial。",
    inputSchema: exportClipGradeLutInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (input) => {
    try {
      const request = exportClipGradeLutInputSchema.parse(input);
      const root = resolve(dependencies.workspaceRoot()), lexical = resolve(request.outputPath);
      if (!isAbsolute(request.outputPath) || !lexical.startsWith(`${root}${sep}`)) throw new Error("LUT 匯出路徑必須是工作區內的絕對路徑");
      const outputPath = dependencies.resolveOutputPath ? await dependencies.resolveOutputPath(lexical) : lexical;
      const project = await dependencies.readProject(request.projectPath);
      return textResult({ status: "EXPORTED", ...await exportClipGradeCube(project, request.clipId, outputPath, dependencies.lutRoot()) });
    } catch (error) { return errorResult(error); }
  });
}
