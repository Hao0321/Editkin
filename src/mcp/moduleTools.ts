import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { describeEditkinModule, listEditkinModules, prepareEditkinModule } from "../modules/moduleRegistry";
import { MODULE_FORMATS, MODULE_KINDS, MODULE_STATUSES } from "../modules/moduleTypes";
import { describeEditkinTemplate, listEditkinTemplates, prepareEditkinTemplate } from "../modules/templateRegistry";
import { errorResult, textResult } from "./toolRuntime";

/** Unified module and template discovery/preparation; every dedicated prepare_* tool keeps working unchanged. */
export function registerModuleTools(server: McpServer, environment: NodeJS.ProcessEnv = process.env) {
  server.registerTool("list_editkin_modules", {
    description: "只讀：Editkin 所有模組的統一索引（Motion 圖文預設、原創元素、Motion Kit、片段運鏡、浮空框與章節場景、自研場景模板、調色／特效／轉場／字幕樣式、MV、節拍蒙太奇、短長片模板，以及需專用工具或僅規劃的模組）。可依 kind／role（語意用途，如 emphasis、question、process、recap）／format（landscape／portrait／square）／status／關鍵字篩選，分頁回傳；帶 moduleId 回該模組完整 manifest 與輸入 JSON Schema。available 模組用 prepare_editkin_module 編譯，其餘照 invoke 指示的專用工具。",
    inputSchema: z.object({
      moduleId: z.string().min(1).max(80).optional(),
      kind: z.enum(MODULE_KINDS).optional(), status: z.enum(MODULE_STATUSES).optional(), format: z.enum(MODULE_FORMATS).optional(),
      role: z.string().min(1).max(60).optional(), query: z.string().max(80).optional(),
      limit: z.number().int().min(1).max(50).default(20), cursor: z.number().int().min(0).default(0),
    }),
  }, async ({ moduleId, ...query }) => {
    try { return textResult(moduleId ? describeEditkinModule(moduleId) : listEditkinModules(query)); }
    catch (error) { return errorResult(error); }
  });

  server.registerTool("prepare_editkin_module", {
    description: "只讀：用模組 id（＋variantId）編譯任何 available 模組，回傳統一的 editkin.module-invocation/v1：commands、commandsSha256、carriers（planDeclaration、editorialGraphics、timeline、suggestions…）與 module／registry 雜湊。與對應的專用 prepare 工具走同一個 compiler、輸出一致。不修改專案；把 commands 與 carriers 放入同一份 v4 plan，再 audit_autopilot_plan → apply_autopilot_plan。",
    inputSchema: z.object({
      projectPath: z.string().min(1), moduleId: z.string().min(1).max(80), variantId: z.string().min(1).max(160).optional(),
      inputs: z.record(z.string(), z.unknown()).default({}),
    }),
  }, async (request, context) => {
    try { return textResult(await prepareEditkinModule(request, { environment, signal: context.mcpReq.signal })); }
    catch (error) { return errorResult(error); }
  });

  server.registerTool("list_editkin_templates", {
    description: "只讀：Editkin 組合模板（editkin.template/v1）索引：Shorts 教學／高能鉤子／旅遊美食 Vlog、教學長片（Hao 70 分基準故事形狀）、插畫 MV。每個模板列出 base 視覺包與 slot（開場、步驟、框選、強調、回顧…）可用的模組與 variant；帶 templateId 回完整定義、各 slot 模組需求與 fill 格式。",
    inputSchema: z.object({ templateId: z.string().min(1).max(80).optional(), format: z.enum(MODULE_FORMATS).optional() }),
  }, async ({ templateId, format }) => {
    try { return textResult(templateId ? describeEditkinTemplate(templateId) : listEditkinTemplates({ format })); }
    catch (error) { return errorResult(error); }
  });

  server.registerTool("prepare_editkin_template", {
    description: "只讀：把組合模板的 fills（每個 fill＝slotId＋可選 moduleId／variantId＋beatId＋模組 inputs，時間與文字都來自素材證據）一次經模組層編譯成同一份有序 commands；在記憶體副本上驗證全部命令可依序套用、合併 planDeclaration（索引已位移）與 editorialGraphics、回報十個 motionTreatment 家族的命令索引與節拍，並檢查 slot 數量、節奏預算與 v4 每份 plan 100 個命令上限（超過時回傳分組）。預設 include=summary 只回摘要；確認後 include=full（建議經 mcp-batch 存檔，再用 video-autopilot editkin_modules.py merge 位移索引併入 plan）。不修改專案；放入 v4 plan 後 audit_autopilot_plan → apply_autopilot_plan。",
    inputSchema: z.object({
      projectPath: z.string().min(1), templateId: z.string().min(1).max(80), expectedRevision: z.number().int().nonnegative().optional(),
      base: z.object({ clipIds: z.array(z.string().min(1)).min(1).max(64), beatId: z.string().min(1).max(80).optional() }).nullable().optional(),
      fills: z.array(z.object({
        slotId: z.string().min(1).max(40), moduleId: z.string().min(1).max(80).optional(), variantId: z.string().min(1).max(160).optional(),
        beatId: z.string().min(1).max(80).optional(), inputs: z.record(z.string(), z.unknown()).default({}),
      })).max(48).default([]),
      include: z.enum(["summary", "full"]).default("summary"), reserveCommands: z.number().int().min(0).max(99).default(10),
    }),
  }, async (request, context) => {
    try { return textResult(await prepareEditkinTemplate(request, { environment, signal: context.mcpReq.signal })); }
    catch (error) { return errorResult(error); }
  });
}
