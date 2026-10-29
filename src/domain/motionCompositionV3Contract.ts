import type { MotionDesignV3TemplateId, MotionGraphic } from "./types";

/** One copy field per text line; the template decides what each line means. */
export const MOTION_DESIGN_V3_FIELDS: Record<MotionDesignV3TemplateId, readonly string[]> = {
  title_reveal: ["title", "kicker?"],
  title_impact: ["line", "line?"],
  title_editorial: ["title", "label?"],
  lower_third_bar: ["name", "role?"],
  lower_third_glass: ["name", "role?"],
  chapter_number: ["number", "title", "subtitle?"],
  stat_counter: ["value", "label?"],
  progress_bar: ["label", "percent"],
  compare_split: ["leftLabel", "leftValue", "rightLabel", "rightValue"],
  tag_pill: ["label"],
  location_pin: ["place", "detail?"],
  callout_line: ["label", "detail?"],
  highlight_sweep: ["line", "line?"],
  quote_card: ["quote", "attribution?"],
  steps_list: ["step", "step", "step?", "step?", "step?"],
  cta_subscribe: ["button", "detail?"],
};

export const MOTION_DESIGN_V3_TEMPLATE_IDS = Object.keys(MOTION_DESIGN_V3_FIELDS) as MotionDesignV3TemplateId[];
export const MOTION_V3_MAX_LINE_CHARS = 64;
export const MOTION_V3_MIN_DURATION_SECONDS = 1;
/** Templates that set a person's name. v4 autopilot plans bind names to transcript identity evidence through the
 * paired lower-third presets, so these stay editor-only until v3 has that pairing. */
export const MOTION_DESIGN_V3_IDENTITY_TEMPLATES: ReadonlySet<MotionDesignV3TemplateId> = new Set(["lower_third_bar", "lower_third_glass"]);

export function isMotionDesignV3Template(value: unknown): value is MotionDesignV3TemplateId {
  return typeof value === "string" && Object.hasOwn(MOTION_DESIGN_V3_FIELDS, value);
}

/** The authored copy split into template fields; blank trailing lines are not fields. */
export function motionV3Lines(text: string): string[] {
  const lines = text.replaceAll("\r", "").split("\n").map(line => line.trim());
  while (lines.length > 0 && !lines.at(-1)) lines.pop();
  return lines;
}

export function assertMotionGraphicV3Contract(graphic: MotionGraphic): void {
  if (graphic.schema !== "hao.motion-composition/v3") {
    if (graphic.designV3 !== undefined) throw new Error("只有 v3 可攜帶 designV3");
    return;
  }
  const template = graphic.designV3?.template;
  if (!isMotionDesignV3Template(template)) throw new Error(`未知的 v3 版型：${String(template)}`);
  if (graphic.motionV2 !== undefined || graphic.layoutV2 !== undefined || graphic.visualStyle !== undefined) {
    throw new Error("v3 由版型決定動態與版面，不可攜帶 v2 motion/layout 或 visualStyle");
  }
  if (graphic.trackId !== undefined || graphic.trackingMode !== undefined) throw new Error("v3 版型尚未支援追蹤錨點");
  // Native paint, vector stages and background compositing belong to v2; v3 draws its own ops in front of the video.
  if (graphic.paintV1 !== undefined || graphic.vectorV2 !== undefined) throw new Error("v3 版型不可攜帶 v2 原生繪製或向量舞台參數");
  if (graphic.compositeLayer !== undefined && graphic.compositeLayer !== "foreground") throw new Error("v3 版型只能合成在影片前景");
  if (graphic.duration < MOTION_V3_MIN_DURATION_SECONDS) throw new Error(`v3 版型至少需要 ${MOTION_V3_MIN_DURATION_SECONDS} 秒才能完整進場與退場`);
  const fields = MOTION_DESIGN_V3_FIELDS[template];
  const required = fields.filter(field => !field.endsWith("?")).length;
  const lines = motionV3Lines(graphic.text);
  if (lines.length < required || lines.length > fields.length) {
    throw new Error(`${template} 需要 ${required}–${fields.length} 行文字（${fields.join(" / ")}），目前 ${lines.length} 行`);
  }
  lines.forEach((line, index) => {
    if (!line && !fields[index].endsWith("?")) throw new Error(`${template} 第 ${index + 1} 行（${fields[index]}）不可空白`);
    if ([...line].length > MOTION_V3_MAX_LINE_CHARS) throw new Error(`${template} 第 ${index + 1} 行超過 ${MOTION_V3_MAX_LINE_CHARS} 字`);
  });
}
