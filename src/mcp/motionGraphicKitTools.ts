import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { KINETIC_TEXT_STYLES, MOTION_ENERGIES } from "../motion/motionLanguage";
import { EDITKIN_BLUE_WHITE, MOTION_GRAPHIC_KIT_VERSION, prepareMotionGraphicKit, type MotionKitScene } from "../motion/motionGraphicKit";
import { withReferenceMotionPhysicalFonts } from "./referenceMotionPhysicalFonts";
import { ORIGINAL_ELEMENTS, ORIGINAL_ELEMENT_THEMES, defaultOriginalElementConfig, type OriginalElementConfig, type OriginalElementId } from "../creative/originalElements";
import { ORIGINAL_ELEMENT_GRAPHICS_VERSION, originalElementTimeline, prepareOriginalElementGraphics } from "../motion/originalElementGraphics";
import { readProject } from "./storage";
import { errorResult, textResult } from "./toolRuntime";

const at = z.number().finite().min(0).max(600);
const unitX = z.number().finite().min(0).max(1);
const hex = z.string().regex(/^#[0-9a-f]{6}$/i);
const line = (max: number) => z.string().trim().min(1).max(max);

export const motionGraphicKitSceneSchema = z.strictObject({
  startFrame: z.number().int().min(0),
  durationFrames: z.number().int().min(30).max(1800),
  energy: z.enum(MOTION_ENERGIES).optional(),
  fontFamily: z.string().trim().min(1).max(80).optional(),
  palette: z.strictObject({ primary: hex, onPrimary: hex, background: hex, ink: hex, muted: hex, surface: hex, line: hex, grid: hex, tint: hex }).optional(),
  elements: z.array(z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("board"), at, grid: z.boolean().optional() }),
    z.strictObject({ kind: z.literal("kicker"), at, text: line(40), x: unitX, y: unitX, rule: z.boolean().optional() }),
    z.strictObject({ kind: z.literal("headline"), at, text: line(40), x: unitX, y: unitX, width: z.number().finite().min(.1).max(1),
      size: z.number().finite().min(24).max(240).optional(), style: z.enum(KINETIC_TEXT_STYLES).optional(), align: z.enum(["left", "center"]).optional() }),
    z.strictObject({ kind: z.literal("body"), at, text: line(80), x: unitX, y: unitX, width: z.number().finite().min(.1).max(1),
      size: z.number().finite().min(16).max(120).optional(), align: z.enum(["left", "center"]).optional() }),
    z.strictObject({ kind: z.literal("bubble"), at, text: line(24), x: unitX, y: unitX, role: z.enum(["ask", "reply"]), size: z.number().finite().min(16).max(120).optional() }),
    z.strictObject({ kind: z.literal("chip"), at, text: line(24), x: unitX, y: unitX, size: z.number().finite().min(12).max(80).optional() }),
    z.strictObject({ kind: z.literal("card"), at, title: line(24), body: line(60).optional(), x: unitX, y: unitX, width: z.number().finite().min(.12).max(.9) }),
    z.strictObject({ kind: z.literal("ripple"), at, x: unitX, y: unitX, radius: z.number().finite().min(12).max(200).optional() }),
  ])).min(1).max(24),
});

/** Read-only producer; the returned add_motion_graphic commands enter the v4 plan like any other. */
const ORIGINAL_ELEMENT_IDS = ORIGINAL_ELEMENTS.map(element => element.id) as [OriginalElementId, ...OriginalElementId[]];
const ORIGINAL_THEME_IDS = Object.keys(ORIGINAL_ELEMENT_THEMES) as [keyof typeof ORIGINAL_ELEMENT_THEMES, ...Array<keyof typeof ORIGINAL_ELEMENT_THEMES>];

export const originalElementRequestSchema = z.strictObject({
  elementId: z.enum(ORIGINAL_ELEMENT_IDS), startFrame: z.number().int().min(0), durationFrames: z.number().int().min(30).max(600),
  title: line(28).optional(), detail: z.string().max(44).optional(), tag: z.string().max(24).optional(), number: z.string().regex(/^\d{2}$/).optional(),
  theme: z.enum(ORIGINAL_THEME_IDS).optional(), mode: z.enum(["scene", "overlay"]).optional(), energy: z.enum(MOTION_ENERGIES).optional(),
  colors: z.strictObject({ primary: hex, paper: hex, ink: hex, accent: hex, grid: hex }).partial().optional(),
  target: z.strictObject({ x: unitX, y: unitX, w: unitX, h: unitX, sourceId: line(200) }).optional(),
});

/** Shared by prepare_original_element and the module layer: read-only, returns add_motion_graphic commands. */
export async function prepareOriginalElementFile(projectPath: string, element: z.infer<typeof originalElementRequestSchema>) {
  const project = await readProject(projectPath);
  const base = defaultOriginalElementConfig(element.elementId), duration = element.durationFrames / project.fps;
  const config: OriginalElementConfig = { ...base, title: element.title ?? base.title, detail: element.detail ?? base.detail, tag: element.tag ?? base.tag,
    number: element.number ?? base.number, theme: element.theme ?? "editkin", mode: element.mode ?? "scene", colors: element.colors,
    aspect: project.height > project.width ? "portrait" : "landscape", duration,
    target: element.elementId === "focus-bracket" ? (element.target ? { ...element.target, observed: true, visibleFrom: 0, visibleTo: duration } : null) : null };
  const graphics = await withReferenceMotionPhysicalFonts(dependencies => prepareOriginalElementGraphics(project, config,
    { startFrame: element.startFrame, durationFrames: element.durationFrames, energy: element.energy }, dependencies.prepareText));
  return { status: "REVIEW_REQUIRED", schema: ORIGINAL_ELEMENT_GRAPHICS_VERSION, projectRevision: project.revision, elementId: element.elementId,
    timeline: originalElementTimeline(graphics, project.fps),
    commands: graphics.map(graphic => ({ type: "add_motion_graphic" as const, graphic })), readOnly: true,
    next: "bind commands to v4 motionTreatment (title/cards/motion) and designEvidence, then audit/apply; review the rendered artifact" };
}

/** Shared by prepare_motion_graphic_kit and the module layer. */
export async function prepareMotionGraphicKitFile(projectPath: string, scene: z.infer<typeof motionGraphicKitSceneSchema>) {
  const project = await readProject(projectPath);
  const owned: MotionKitScene = { ...scene, id: `kit-${randomUUID().slice(0, 8)}`, palette: scene.palette ?? EDITKIN_BLUE_WHITE };
  const graphics = await withReferenceMotionPhysicalFonts(dependencies => prepareMotionGraphicKit(project, owned, dependencies.prepareText));
  return { status: "REVIEW_REQUIRED", schema: MOTION_GRAPHIC_KIT_VERSION, projectRevision: project.revision, sceneId: owned.id,
    commands: graphics.map(graphic => ({ type: "add_motion_graphic" as const, graphic })), readOnly: true,
    next: "bind commands to v4 motionTreatment (title/cards/motion) and designEvidence, then audit/apply; review the rendered artifact" };
}

export function registerMotionGraphicKitTools(server: McpServer) {
  server.registerTool("prepare_original_element", {
    description: "只讀：Hao 原創元素 Collection 01（八種用途：keyword-sticker 重點字貼／conversation-bubble 對話泡泡／field-note 手記標籤／chapter-ticket 章節票卡／focus-bracket 操作框選（需真實看過的目標框與 sourceId）／reaction-seal 反應貼紙／step-path 步驟連線（detail 用「／」分三項）／recap-strip 重點回顧）。幾何與排版逐行移植自原稿，三套配色 editkin／vermilion／midnight，依專案橫直重排；scene 模式畫紙面背景（概念整幕），overlay 疊在實拍。每個形狀是可編輯 shape 向量、每行字是實體字形文字層，裝飾零件（網格線、票卡打孔、閃光、圓點、框角、連線）各自獨立成層。Motion Language 分段建構、不同時出現：網格逐條畫出並在停留中緩慢漂移→底板擦入（主色前導雙色擦入）或落地→硬陰影從背後滑出→主標逐字逐行→標籤掃入→說明對焦→點綴依序彈出／連線畫向下一步；Studio 細節層另加光澤掃過、衝擊放射線、閃光、漣漪環、打字點、膠帶、尺規刻度、條碼、掃描線、進度軌與封包、勾選，一次性特效（fx-*）在退場前結束，持續層整組一起退場；時長太短時只壓縮節拍、不縮動作，放不下的特效自動省略。回傳 add_motion_graphic commands 與 timeline（buildSeconds 建構時長、holdAfterBuildSeconds 完整停留）；放入同一份 v4 plan 再 audit/apply，本工具不修改專案。",
    inputSchema: z.object({ projectPath: z.string().min(1), element: originalElementRequestSchema }),
  }, async ({ projectPath, element }) => {
    try { return textResult(await prepareOriginalElementFile(projectPath, element)); }
    catch (error) { return errorResult(error); }
  });

  server.registerTool("prepare_motion_graphic_kit", {
    description: "只讀：Editkin 原生 Motion Graphic Kit（Hao 認可的自研 CSS 圖卡語言：藍白網格底板 board、眉題＋畫線 kicker、逐字對焦主標 headline、說明 body、膠囊 chip、先彈出再逐字打字的對話泡泡 bubble(ask/reply)、升起卡片 card、點擊波紋 ripple）。元素依序由後到前、at 為場景內秒數，退場後進先出、底板最後離開。用真實字型量測泡泡／卡片尺寸，回傳可編輯 add_motion_graphic commands；放入同一份 v4 plan 再 audit/apply，本工具不修改專案。board 會蓋住畫面，只用於概念整幕；疊在實拍上請省略 board。",
    inputSchema: z.object({ projectPath: z.string().min(1), scene: motionGraphicKitSceneSchema }),
  }, async ({ projectPath, scene }) => {
    try { return textResult(await prepareMotionGraphicKitFile(projectPath, scene)); }
    catch (error) { return errorResult(error); }
  });
}
