import type { McpServer } from "@modelcontextprotocol/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { REFERENCE_MOTION_COLOR_POLICY, REFERENCE_MOTION_TEMPLATES, referenceMotionTemplateInputSchema } from "../motion/referenceMotionTemplates";
import { prepareReferenceMotionTemplate } from "../application/referenceMotionTemplates";
import { readProject } from "./storage";
import { errorResult, textResult } from "./toolRuntime";

export function registerReferenceMotionTemplateTools(server: McpServer) {
  server.registerTool("list_reference_motion_templates", {
    description: "只讀低 Token 索引：自研、可替換素材的 Motion 場景；每種有敘事用途、素材槽數、閱讀時間與能力邊界。研究作者影片不作模板素材。", inputSchema: z.strictObject({}),
  }, async () => textResult({ schema: "editkin.reference-motion-template-catalog/v1", templates: REFERENCE_MOTION_TEMPLATES,
    prepareTool: "prepare_reference_motion_template", colorPolicy: REFERENCE_MOTION_COLOR_POLICY, execution: "v4 audit/apply/render required", capabilityBoundary: "Rec.709 editable 2D compound scenes; planar focus wall, no spherical wall or 3D studio" }));
  server.registerTool("prepare_reference_motion_template", {
    description: "只讀：將刪線轉念、層級主標、兩份比較、上下文組裝、同素材接管、平面聚焦牆、逐幕回顧或三幕能力連線編譯成可編輯 Motion v2／影片圖層命令；與桌面共用編譯器。連線是抽象概念圖，點數不是平台人數。需影片、精確片段範圍、核對短文案、用途與證據。拒絕同檔別名、短素材、無閱讀停留、重疊 Motion 及長片預設套整幕。原片音訊與媒體速度不變。回傳 v4 graphics／variants；素材宣告不是驗收，仍須 audit/apply/reopen/render。",
    inputSchema: referenceMotionTemplateInputSchema.extend({ projectPath: z.string().min(1) }),
  }, async ({ projectPath, ...input }) => {
    try { return textResult(prepareReferenceMotionTemplate(await readProject(projectPath), input, prefix => `${prefix}-${randomUUID()}`)); }
    catch (error) { return errorResult(error); }
  });
}
