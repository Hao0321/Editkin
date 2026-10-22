import type { ReferenceMotionTemplateId } from "../motion/referenceMotionTemplates";
import type { MotionTreatmentFamily } from "./motionTreatment";
import { TemplateShortBlockError, type TemplateShortCopy } from "./templateShortBrief";

/** One-tool Short (M1 design §5.3): the words a template's beats carry into the v4 plan. The template declares its beats
 * where it draws them (DesignContext.beat); this table holds what is not geometry: each beat's energy and its summary,
 * application and focus sentences, the skill roles of the family and its familyReasons.use. Written once by Claude when
 * a family is certified. Every sentence restates the creator's copy and what the template visibly does; it adds no
 * fact about the footage (M10). */
export interface TemplateBeatTexts {
  /** editorial.narrative.beats[].summary */
  summary: string;
  /** designEvidence.decisions[].application */
  application: string;
  /** editorial.narrative.beats[].primaryFocus = the design request beat subject */
  primaryFocus: string;
}
export interface TemplateBeatTableEntry {
  energy: number;
  texts(copy: TemplateShortCopy): TemplateBeatTexts;
}
export interface TemplateFamilyBeatTable {
  /** resolve_editkin_skill_workflow semanticRoles for this family's Shorts. */
  skillRoles: readonly string[];
  /** Keyed by the beat ids the template declares. */
  beats: Readonly<Record<string, TemplateBeatTableEntry>>;
  /** familyReasons.use; only families the compiled commands actually use are read. */
  useReasons: Readonly<Partial<Record<MotionTreatmentFamily, string>>>;
}

/** The schema bounds these sentences must fit (editorialBeatSchema, designEvidenceSchema). */
export const TEMPLATE_BEAT_TEXT_BOUNDS = {
  summary: { min: 12, max: 240 }, application: { min: 12, max: 480 }, primaryFocus: { min: 1, max: 120 }, useReason: { min: 1, max: 320 },
} as const;

const quoted = (text: string) => `「${text}」`;
const MEDIA_WINDOW_REASONS = {
  tracking_masks: "實拍放進主題影像窗的固定形狀柔邊遮罩，不是追蹤",
  transitions_camera: "同一連續鏡頭在主題影像窗裡的版面裁切與落定關鍵影格；不是轉場或數位運鏡",
} as const;

export const REFERENCE_MOTION_BEAT_TABLES = {
  strike_reframe: {
    skillRoles: ["hook", "reveal"],
    beats: {
      hook: { energy: 0.8, texts: copy => ({
        summary: `第一格讀到${copy.place ? `地點${quoted(copy.place)}與` : ""}原句${quoted(copy.hook!)}，接著原句被刪線劃掉`,
        application: `${copy.place ? `地點${quoted(copy.place)}與` : ""}原句${quoted(copy.hook!)}在第一格就完整可讀；刪線劃過原句的字跡後原句退場，把版面讓給答案。`,
        primaryFocus: `被刪去的原句${quoted(copy.hook!)}`,
      }) },
      answer: { energy: 0.5, texts: copy => ({
        summary: `答案${quoted(copy.payoff)}進場${copy.accent ? `並標出${quoted(copy.accent)}` : ""}，與下方主題影像窗裡的實拍一起讀${copy.proof ? `；補充${quoted(copy.proof)}` : ""}`,
        application: `答案${quoted(copy.payoff)}在原句下方進場${copy.accent ? `，以強調色標出${quoted(copy.accent)}` : ""}；實拍放在答案下方的主題影像窗`
          + `${copy.proof ? `；原句退場後，補充${quoted(copy.proof)}接替原句的位置` : ""}${copy.tag ? `；標籤${quoted(copy.tag)}貼在答案下方` : ""}。`,
        primaryFocus: `答案${quoted(copy.payoff)}與實拍畫面`,
      }) },
    },
    useReasons: {
      title: "所有文字（原句、答案與選填的地點、補充、標籤）都以實體字形排版",
      cards: "主題頁面、裝飾圖形、影像框與刪線都是主題向量圖卡",
      motion: "Motion Language 進退場：原句被刪線劃過後退場、答案進場、補充接替原句的位置",
      ...MEDIA_WINDOW_REASONS,
    },
  },
  context_stack: {
    skillRoles: ["process", "payoff"],
    beats: {
      promise: { energy: 0.8, texts: copy => ({
        summary: `第一格讀到${copy.place ? `地點${quoted(copy.place)}與` : ""}標題${quoted(copy.payoff)}，實拍放在主題影像窗裡`,
        application: `${copy.place ? `地點${quoted(copy.place)}與` : ""}標題${quoted(copy.payoff)}${copy.accent ? `（標出${quoted(copy.accent)}）` : ""}在第一格就完整可讀；實拍放在重點列下方的主題影像窗。`,
        primaryFocus: `標題${quoted(copy.payoff)}與實拍畫面`,
      }) },
      steps: { energy: 0.5, texts: copy => {
        const labels = (copy.points ?? []).map(point => point.label);
        return {
          summary: `重點依序出現：${labels.map(quoted).join("→")}`,
          application: `重點一次一項捲進同一列，前一項整組捲出、下一項接上，進度條跟著填滿；最後停在${quoted(labels.at(-1) ?? copy.payoff)}。`,
          primaryFocus: `依序出現的重點：${labels.join("、")}`,
        };
      } },
    },
    useReasons: {
      title: "所有文字（標題、重點與選填的地點、說明）都以實體字形排版",
      cards: "主題頁面、裝飾圖形、進度條與影像框都是主題向量圖卡",
      motion: "Motion Language 進退場：重點一次一項捲入、進度條跟著填滿",
      ...MEDIA_WINDOW_REASONS,
    },
  },
} as const satisfies Partial<Record<ReferenceMotionTemplateId, TemplateFamilyBeatTable>>;

export function templateFamilyBeatTable(family: ReferenceMotionTemplateId): TemplateFamilyBeatTable | undefined {
  return (REFERENCE_MOTION_BEAT_TABLES as Partial<Record<ReferenceMotionTemplateId, TemplateFamilyBeatTable>>)[family];
}

/** The texts of the beats a template emitted, filled from the creator's copy. A beat without a table entry, or a sentence
 * outside its schema bound, is BLOCK_TEMPLATE_BEATS: the template and its table must be certified together. */
export function templateBeatTexts(family: ReferenceMotionTemplateId, copy: TemplateShortCopy, beats: ReadonlyArray<{ id: string }>) {
  const table = templateFamilyBeatTable(family);
  if (!table) throw new TemplateShortBlockError("BLOCK_TEMPLATE_BEATS", `${family} has no beat table yet`);
  return beats.map(beat => {
    const entry = table.beats[beat.id];
    if (!entry) throw new TemplateShortBlockError("BLOCK_TEMPLATE_BEATS", `beat ${beat.id} of ${family} has no beat-table entry`);
    const texts = entry.texts(copy);
    for (const key of ["summary", "application", "primaryFocus"] as const) {
      const length = texts[key].length, bound = TEMPLATE_BEAT_TEXT_BOUNDS[key];
      if (length < bound.min || length > bound.max || texts[key].trim() !== texts[key]) {
        throw new TemplateShortBlockError("BLOCK_TEMPLATE_BEATS", `beat ${beat.id} ${key} is ${length} characters; the bound is ${bound.min}–${bound.max}`);
      }
    }
    return { id: beat.id, energy: entry.energy, ...texts };
  });
}
