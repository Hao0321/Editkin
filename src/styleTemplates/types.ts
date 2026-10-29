import { z } from "zod";
import { MOTION_FONT_ROLES } from "../motionLibrary/svg/glyphs";
import { styleSlotBindingIssues, styleSlotsSchema, styleTemplateClipSchema } from "./slots/slotSchema";

/**
 * Editkin style templates v1 (STYLE_TEMPLATE_DESIGN.md §2–§3): the template and
 * style-plan schemas. Browser-safe (zod only, no node: imports).
 *
 * - A template (`editkin.style-template/v1`) is data: palette roles, font roles,
 *   component settings and editorial rules. Components are code (components/).
 * - A style plan (`editkin.style-plan/v1`) says WHAT happens WHEN: it references
 *   existing timed words (never invented, M10) and lists beats.
 */

export const STYLE_TEMPLATE_SCHEMA_V1 = "editkin.style-template/v1" as const;
export const STYLE_PLAN_SCHEMA_V1 = "editkin.style-plan/v1" as const;
/** Bump when any generator, layout or compiler change alters output bytes (part of every render-job key). */
export const STYLE_ENGINE_VERSION = "editkin.style-templates-engine/0.1.0" as const;

export const STYLE_PALETTE_ROLES = ["bg", "ink", "paper", "accent", "accent2", "highlight", "script"] as const;
export type StylePaletteRole = typeof STYLE_PALETTE_ROLES[number];
export type StylePalette = Readonly<Record<StylePaletteRole, string>>;

export const STYLE_FONT_ROLES = ["display", "serif", "script", "body", "mono"] as const;
export type StyleFontRole = typeof STYLE_FONT_ROLES[number];

export const CAPTION_TREATMENTS = ["accentColor", "highlightBox", "glow", "gradient", "script", "size"] as const;
export type CaptionTreatment = typeof CAPTION_TREATMENTS[number];
export const CAPTION_ENTRIES = ["blurIn", "pop", "slide", "typeOn"] as const;
export type CaptionEntry = typeof CAPTION_ENTRIES[number];
export const PLACEMENT_PREFERENCES = ["auto", "left", "right", "top", "bottom", "center_low"] as const;
export type PlacementPreference = typeof PLACEMENT_PREFERENCES[number];
export const SECTION_STYLES = ["bleed", "punchCard"] as const;
export type SectionStyle = typeof SECTION_STYLES[number];
export const TRANSITION_IDS = ["lightLeak", "punchIn"] as const;
export type StyleTransitionId = typeof TRANSITION_IDS[number];
export const SFX_CUES = ["pop", "whoosh", "click", "riser", "hit", "ding"] as const;
export type SfxCue = typeof SFX_CUES[number];
export const STYLE_ASPECTS = ["9:16", "16:9", "1:1"] as const;
export type StyleAspect = typeof STYLE_ASPECTS[number];
export const READABILITY_STEPS = ["scrim", "box", "boxAll", "plate", "lighterKeyword", "whiteKeyword", "inkText"] as const;
export type ReadabilityStep = typeof READABILITY_STEPS[number];

const hex = z.string().regex(/^#[0-9A-Fa-f]{6}$/, "colours are #RRGGBB").transform(value => value.toUpperCase());
const fraction = (min: number, max: number) => z.number().finite().min(min).max(max);
const seconds = z.number().finite().min(0).max(86_400);

export const stylePaletteSchema = z.strictObject({
  bg: hex, ink: hex, paper: hex, accent: hex, accent2: hex, highlight: hex, script: hex,
});
export const stylePaletteOverrideSchema = stylePaletteSchema.partial();

export const styleFontSchema = z.strictObject({
  /** A motion library glyph role (svg/glyphs.ts): only Editkin's bundled render faces. */
  font: z.enum(MOTION_FONT_ROLES),
  weight: z.number().int().min(100).max(900).optional(),
});
export type StyleFont = z.infer<typeof styleFontSchema>;

const paletteRole = z.enum(STYLE_PALETTE_ROLES);

export const captionComponentSchema = z.strictObject({
  /** Small connector words ("lead" before the keyword, "tail" after it). */
  leadFont: z.enum(STYLE_FONT_ROLES),
  keywordFont: z.enum(STYLE_FONT_ROLES),
  /** Lead glyph size as a share of the frame's short side (ART_DIRECTION: secondary ≥ 4.5%). */
  leadSize: fraction(0.045, 0.08),
  /** Keyword size ÷ lead size: the 3–4× hierarchy of the references. */
  keywordScale: fraction(3, 4),
  leadColor: paletteRole,
  leadTracking: fraction(-0.06, 0.1),
  keywordTracking: fraction(-0.08, 0.02),
  /** Baseline-to-baseline gap between stacked lines, in lead em. */
  lineGap: fraction(0.1, 1),
  /** Lead lines wrap at this many lead em (CJK: about one character per em). */
  leadMaxEm: fraction(5, 16),
  treatments: z.array(z.enum(CAPTION_TREATMENTS)).min(1),
  defaultTreatment: z.enum(CAPTION_TREATMENTS),
  keywordEntry: z.enum(CAPTION_ENTRIES),
  leadEntry: z.enum(CAPTION_ENTRIES),
  /** Box padding and corner, highlightBox only (keyword em). */
  boxPadding: fraction(0.02, 0.3).default(0.1),
  boxRadius: fraction(0, 0.4).default(0.08),
  /** Script treatment rotation (degrees) and size relative to the keyword. */
  scriptRotation: fraction(-12, 12).default(-5),
  scriptScale: fraction(0.6, 1.2).default(0.92),
  readability: z.strictObject({
    /** WCAG contrast the text needs against the sampled footage behind it (design §4: 4.5:1). */
    minContrast: fraction(1, 21).default(4.5),
    /**
     * What the compiler adds, step by step (cumulative), when the measured contrast or the background texture fails:
     * scrim = a soft, feathered radial darkening behind the phrase (on-footage rule: never a hard box); box = the keyword
     * moves into the template's highlight box; plate = a dark rounded plate (screen recordings only); lighterKeyword = a
     * gradient/script/glow keyword falls back to the solid accent; whiteKeyword = the keyword is set in the lead colour
     * (white); boxAll = the lead lines also sit on the highlight box; inkText = on very bright footage the phrase turns
     * to the palette ink (R3's navy title), with a soft light halo and no scrim. Before any step the solver tries other
     * placements.
     */
    ladder: z.array(z.enum(READABILITY_STEPS)).min(1).max(4),
    /** Scrim opacity at its core (display), at most 35%. */
    scrimOpacity: fraction(0, 0.35).default(0.35),
    plateOpacity: fraction(0, 0.8).default(0.62),
    /** Soft shadow always on (R1 measured: white text with a soft shadow). */
    alwaysShadow: z.boolean().default(false),
  }),
  exitSeconds: fraction(0.1, 0.5).default(0.2),
});

export const sectionComponentSchema = z.strictObject({
  defaultStyle: z.enum(SECTION_STYLES),
  font: z.enum(STYLE_FONT_ROLES),
  color: paletteRole,
  /** bleed: share of the word's width that runs off the frame edge. */
  bleed: fraction(0, 0.4),
  /** bleed: glyph size as a share of the frame height (16:9) or width (9:16). */
  size: fraction(0.2, 0.9),
  /** A soft dark gradient behind bleed words for legibility over footage (opacity 0..1). */
  scrim: fraction(0, 0.9),
  punchCard: z.strictObject({ plate: paletteRole, text: paletteRole, font: z.enum(STYLE_FONT_ROLES) }),
  defaultSeconds: fraction(0.5, 4).default(1.6),
  /** R1: the footage under a bleed title becomes a blurred, darkened copy (the existing studio_backdrop_soft effect). */
  backdrop: z.enum(["none", "blurDarken"]).default("none"),
});

export const lightLeakComponentSchema = z.strictObject({
  /** Warm wash colours, brightest first. */
  colors: z.array(hex).min(2).max(4),
  defaultSeconds: fraction(0.4, 2.5),
  peak: fraction(0.2, 1),
  origin: z.enum(["bottom", "left", "right", "top"]),
});

export const punchInComponentSchema = z.strictObject({
  scale: fraction(1.02, 1.3),
  attackSeconds: fraction(0.08, 0.6),
  curve: z.enum(["expoOut", "quintOut", "backOutSoft"]),
});

export const lookComponentSchema = z.strictObject({
  /** A Hao Film Look v2 id (creative/filmLooksV2.ts), applied through set_clip_grade_v2. */
  filmLookId: z.string().regex(/^hfl2_[a-z0-9_]+$/),
  strength: fraction(0, 1),
  /** Per-genre overrides (travel, food, night…): the same template on different footage. */
  byGenre: z.record(z.string(), z.strictObject({ filmLookId: z.string().regex(/^hfl2_[a-z0-9_]+$/), strength: fraction(0, 1) })).optional(),
});

/** C3 explainer kit colours (palette roles) and fonts. */
export const explainerComponentSchema = z.strictObject({
  font: z.enum(STYLE_FONT_ROLES),
  textFont: z.enum(STYLE_FONT_ROLES),
  /** Base unit as a share of the frame's short side (chips, pill, prompt and cards scale with it). */
  em: fraction(0.03, 0.08),
  pill: z.strictObject({ plate: paletteRole, text: paletteRole }),
  chips: z.strictObject({ active: paletteRole, activeText: paletteRole, idle: paletteRole, idleText: paletteRole }),
  card: z.strictObject({ plate: paletteRole, line: paletteRole }),
  prompt: z.strictObject({ plate: paletteRole, text: paletteRole }),
  cursor: z.strictObject({ fill: paletteRole, outline: paletteRole }),
});
/** C4 annotation kit. */
export const annotationComponentSchema = z.strictObject({
  stroke: paletteRole,
  /** Stroke width as a share of the short side. */
  strokeWidth: fraction(0.003, 0.03),
  dash: z.boolean(),
  pin: paletteRole,
  marker: paletteRole,
  label: paletteRole,
  labelPlate: paletteRole,
  font: z.enum(STYLE_FONT_ROLES),
});
/** C5 insert layouts. */
export const insertComponentSchema = z.strictObject({
  /** PIP corner radius and border width as shares of the short side; null border = none. */
  radius: fraction(0, 0.12),
  border: paletteRole.nullable(),
  borderWidth: fraction(0, 0.02),
  shadow: fraction(0, 1),
  /** PIP width as a share of the frame width. */
  pipScale: fraction(0.25, 0.75),
  paper: paletteRole,
  divider: paletteRole,
});
/** C6 illustration stage. */
export const stageComponentSchema = z.strictObject({
  desk: hex,
  paper: hex,
  leaf: hex,
  captionColor: paletteRole,
  captionFont: z.enum(STYLE_FONT_ROLES),
});
const sfxId = z.string().regex(/^sfx:editkin-procedural-v1-[a-z]+-\d{2}$/);
export const SOUND_EVENTS = ["keyword", "section", "punchCard", "leak", "punchIn", "click", "type", "cards", "pin", "arrow", "stage", "insert"] as const;
export type SoundEvent = typeof SOUND_EVENTS[number];
/** C9 sound cue map: which original procedural SFX (the existing W4-6 library) each style event uses. */
export const soundComponentSchema = z.strictObject({
  gainDb: z.number().min(-30).max(0),
  /** Cues closer than this are thinned (higher-priority events win). */
  minGapSeconds: fraction(0.15, 3),
  /** Events without a cue stay silent (a template need not voice every event). */
  cues: z.partialRecord(z.enum(SOUND_EVENTS), sfxId),
});

export const editorialRulesSchema = z.strictObject({
  /** Design §4: at most this many emphasis treatments in any 2 s window. */
  maxTreatmentsPer2s: z.number().int().min(1).max(4),
  /** Design §4: a keyword stays readable at least this long. */
  minKeywordHoldSeconds: fraction(0.3, 3),
  /** Share of caption phrases that carry a keyword (guidance for VA; validated loosely). */
  keywordDensity: z.strictObject({ min: fraction(0, 1), max: fraction(0, 1) }),
  /** Hold after the last word before a phrase exits (s). */
  phraseTailSeconds: fraction(0, 2),
  placement: z.strictObject({
    policy: z.enum(["negative_space", "center_low"]),
    titleSafe: fraction(0, 0.15),
    /** Face/subject boxes are inflated by this share of the short side before placement. */
    faceMargin: fraction(0, 0.15),
    /** Bands kept clear for platform UI (9:16 Shorts/Reels): bottom and right, as frame shares. */
    portraitUiBottom: fraction(0, 0.35),
    portraitUiRight: fraction(0, 0.25),
    minScale: fraction(0.3, 1),
  }),
});

export const styleTemplateSchemaV1 = z.strictObject({
  schema: z.literal(STYLE_TEMPLATE_SCHEMA_V1),
  id: z.string().regex(/^[SH][0-9]+_[a-z0-9_]+$/),
  revision: z.number().int().min(1),
  names: z.strictObject({ zh: z.string().min(1), en: z.string().min(1) }),
  reference: z.string().min(1),
  videoTypes: z.array(z.string().min(1)).min(1),
  palette: stylePaletteSchema,
  fonts: z.strictObject({ display: styleFontSchema, serif: styleFontSchema, script: styleFontSchema, body: styleFontSchema, mono: styleFontSchema }),
  components: z.strictObject({
    caption: captionComponentSchema,
    section: sectionComponentSchema,
    lightLeak: lightLeakComponentSchema,
    punchIn: punchInComponentSchema,
    look: lookComponentSchema,
    explainer: explainerComponentSchema.optional(),
    annotation: annotationComponentSchema.optional(),
    insert: insertComponentSchema.optional(),
    stage: stageComponentSchema.optional(),
    sound: soundComponentSchema.optional(),
  }),
  editorial: editorialRulesSchema,
  artStatus: z.enum(["pending", "certified"]),
  notes: z.string().optional(),
  /** Editable slots (text, palette colours, pictures) and the component each one feeds (slots/slotSchema.ts). Additive. */
  slots: styleSlotsSchema.optional(),
  /** The clip the template becomes when it is placed with its slots (component, output, length, formats). Needs `slots`. */
  clip: styleTemplateClipSchema.optional(),
}).superRefine((value, context) => {
  if ((value.slots === undefined) !== (value.clip === undefined)) {
    context.addIssue({ code: "custom", path: ["slots"], message: "slots and clip are declared together" });
  } else if (value.slots && value.clip) {
    for (const issue of styleSlotBindingIssues(value.slots, value.clip)) context.addIssue({ code: "custom", ...issue });
  }
  if (!value.components.caption.treatments.includes(value.components.caption.defaultTreatment)) {
    context.addIssue({ code: "custom", path: ["components", "caption", "defaultTreatment"], message: "defaultTreatment must be one of treatments" });
  }
  if (value.editorial.keywordDensity.min > value.editorial.keywordDensity.max) {
    context.addIssue({ code: "custom", path: ["editorial", "keywordDensity"], message: "keywordDensity min > max" });
  }
});
export type StyleTemplateV1 = z.output<typeof styleTemplateSchemaV1>;

// ---------------------------------------------------------------------------
// Style plan
// ---------------------------------------------------------------------------

/** A reference to one existing timed word. `text` is what is shown; `raw` keeps the recognizer's text when an
 * orthography pass (e.g. simplified → traditional characters) changed only the script, never the word. */
export const styleWordSchema = z.strictObject({
  id: z.string().min(1).max(64),
  text: z.string().min(1).max(64).refine(value => !/[\r\n]/.test(value), "a word is one line"),
  start: seconds,
  end: seconds,
  /** Provenance: which recognizer artifact and word index this came from. */
  source: z.strictObject({ artifact: z.string().min(1).max(160), index: z.number().int().min(0), raw: z.string().max(64).optional() }).optional(),
  /** An untimed recognizer word lies between this word and the previous one in the same segment: a caption may not
   * span it, or the shown text would drop a spoken word. */
  gapBefore: z.boolean().optional(),
}).refine(value => value.end > value.start, "word end must be after its start");
export type StyleWordV1 = z.infer<typeof styleWordSchema>;

const range = z.tuple([z.number().int().min(0), z.number().int().min(0)]).refine(([a, b]) => b >= a, "range end before start");
const normBox = z.tuple([fraction(0, 1), fraction(0, 1), fraction(0, 1), fraction(0, 1)])
  .refine(([x0, y0, x1, y1]) => x1 > x0 && y1 > y0, "box needs x0 < x1 and y0 < y1");

export const styleSubjectSchema = z.strictObject({
  from: seconds,
  to: seconds,
  /** Normalized frame box [x0, y0, x1, y1] (0..1, y down). */
  box: normBox,
  /** Important regions the text must leave clear: faces and passers-by, the subject, a UI focus area, a product or dish. */
  kind: z.enum(["face", "person", "subject", "ui_focus", "product"]),
  /** Where it came from: the plan author's frame observation, or Editkin tracking. */
  evidence: z.string().max(200).optional(),
});
export type StyleSubjectV1 = z.infer<typeof styleSubjectSchema>;

const captionBeat = z.strictObject({
  kind: z.literal("caption"),
  at: seconds,
  id: z.string().max(64).optional(),
  /** Inclusive word indices into plan.words. */
  wordRange: range,
  /** Optional explicit lead range; when given it must be the words of wordRange before the keyword. */
  lead: range.optional(),
  /** Inclusive word indices of the keyword (inside wordRange). Omit for a lead-only line. */
  keyword: range.optional(),
  treatment: z.enum(CAPTION_TREATMENTS).optional(),
  entry: z.enum(CAPTION_ENTRIES).optional(),
  placement: z.enum(PLACEMENT_PREFERENCES).optional(),
});
const sectionBeat = z.strictObject({
  kind: z.literal("section"),
  at: seconds,
  id: z.string().max(64).optional(),
  style: z.enum(SECTION_STYLES).optional(),
  /** Spoken words shown as the title (preferred: real words, M10). */
  wordRange: range.optional(),
  /** Free text needs editorial: true (an on-screen string not taken from speech; the seal gate checks it). */
  text: z.string().min(1).max(24).optional(),
  editorial: z.boolean().optional(),
  duration: fraction(0.4, 6).optional(),
  edge: z.enum(["left", "right", "bottom", "top"]).optional(),
});
/** On-screen text for widgets: spoken words (preferred, M10) or free text flagged editorial (the seal gate fact-checks it). */
const textRef = z.union([
  z.strictObject({ wordRange: range }),
  z.strictObject({ text: z.string().min(1).max(40), editorial: z.literal(true) }),
]);
export type StyleTextRefV1 = z.infer<typeof textRef>;
const normPoint = z.tuple([fraction(0, 1), fraction(0, 1)]);

export const STAGE_PROPS = ["bulb", "note", "storyboard", "videoCard", "chart", "phone", "clock"] as const;
export type StageProp = typeof STAGE_PROPS[number];
export const STAGE_SCENES = ["paperDesk", "collage"] as const;
export const INSERT_LAYOUTS = ["full", "pip", "split", "tornPaper"] as const;
export type InsertLayout = typeof INSERT_LAYOUTS[number];

const insertBeat = z.strictObject({
  kind: z.literal("insert"),
  at: seconds,
  id: z.string().max(64).optional(),
  source: z.discriminatedUnion("kind", [
    /** Another of Hao's clips (the asset path is resolved by the caller). */
    z.strictObject({ kind: z.literal("clip"), assetId: z.string().min(1), sourceStart: seconds.default(0) }),
    z.strictObject({ kind: z.literal("still"), assetId: z.string().min(1) }),
    /** C6 illustration stage: a procedural paper desk / collage with original props popping in. */
    z.strictObject({ kind: z.literal("stage"), scene: z.enum(STAGE_SCENES), props: z.array(z.enum(STAGE_PROPS)).min(1).max(6), label: textRef.optional() }),
  ]),
  layout: z.enum(INSERT_LAYOUTS),
  /** Timeline range the insert is on screen. */
  range: z.tuple([seconds, seconds]).refine(([a, b]) => b > a, "insert range must be positive"),
  corner: z.enum(["topRight", "topLeft", "bottomRight", "bottomLeft"]).optional(),
});
const transitionBeat = z.strictObject({
  kind: z.literal("transition"),
  at: seconds,
  id: z.enum(TRANSITION_IDS),
  duration: fraction(0.1, 3).optional(),
  /** punchIn: the normalized point that stays fixed (default: the subject centre, else the frame centre). */
  focus: z.tuple([fraction(0, 1), fraction(0, 1)]).optional(),
  /** punchIn: when the zoom releases back to 1 (default: held until the footage clip ends). */
  until: seconds.optional(),
});
/** An explicit sound cue (C9 adds the template's automatic cues; these add or override). */
const sfxBeat = z.strictObject({ kind: z.literal("sfx"), at: seconds, cue: z.enum(SFX_CUES) });
/** C3 explainer kit (S1, R1): step chips, a pill button clicked by a cursor, a prompt box typing, UI cards popping in. */
const explainerBeat = z.strictObject({
  kind: z.literal("explainer"),
  at: seconds,
  id: z.string().max(64).optional(),
  duration: fraction(0.6, 12),
  widget: z.enum(["steps", "pill", "prompt", "cards"]),
  /** steps: how many chips, which one is active (0-based), optional labels under each. */
  steps: z.strictObject({ count: z.number().int().min(2).max(5), active: z.number().int().min(0).max(4), labels: z.array(textRef).max(5).optional() }).optional(),
  /** pill: the button label; prompt: the typed text. */
  text: textRef.optional(),
  cards: z.strictObject({ count: z.number().int().min(1).max(4) }).optional(),
  /** Blur and darken the footage behind the widget (R1: UI over a blurred, darkened copy). Default: cards yes, others no. */
  backdrop: z.boolean().optional(),
  placement: z.enum(PLACEMENT_PREFERENCES).optional(),
});
/** C4 annotation kit: hand-drawn dashed arrows, circles, underlines, map pins, callout cards, numbered markers. */
const annotationBeat = z.strictObject({
  kind: z.literal("annotation"),
  at: seconds,
  id: z.string().max(64).optional(),
  duration: fraction(0.5, 12),
  mark: z.enum(["arrow", "circle", "underline", "pin", "callout", "marker"]),
  /** What is pointed at: a normalized box (circle / underline / callout) or point (arrow tip / pin / marker). */
  target: z.union([z.strictObject({ box: normBox }), z.strictObject({ point: normPoint })]),
  /** arrow: where the stroke starts (default: from the larger negative space toward the target). */
  from: normPoint.optional(),
  label: textRef.optional(),
  number: z.number().int().min(1).max(99).optional(),
});

export const styleBeatSchema = z.discriminatedUnion("kind", [captionBeat, sectionBeat, insertBeat, transitionBeat, sfxBeat, explainerBeat, annotationBeat]);
export type StyleBeatV1 = z.infer<typeof styleBeatSchema>;
export type StyleCaptionBeatV1 = z.infer<typeof captionBeat>;
export type StyleSectionBeatV1 = z.infer<typeof sectionBeat>;
export type StyleTransitionBeatV1 = z.infer<typeof transitionBeat>;
export type StyleInsertBeatV1 = z.infer<typeof insertBeat>;
export type StyleExplainerBeatV1 = z.infer<typeof explainerBeat>;
export type StyleAnnotationBeatV1 = z.infer<typeof annotationBeat>;

export const stylePlanSchemaV1 = z.strictObject({
  schema: z.literal(STYLE_PLAN_SCHEMA_V1),
  template: z.string().regex(/^[SH][0-9]+_[a-z0-9_]+$/),
  aspect: z.enum(STYLE_ASPECTS),
  palette: stylePaletteOverrideSchema.optional(),
  /** Footage genre hint for the look (travel, food, night…). */
  genre: z.string().max(32).optional(),
  words: z.array(styleWordSchema).max(20_000),
  subjects: z.array(styleSubjectSchema).max(2_000).optional(),
  beats: z.array(styleBeatSchema).max(5_000),
}).superRefine((plan, context) => {
  for (let index = 1; index < plan.words.length; index += 1) {
    if (plan.words[index].start < plan.words[index - 1].start) {
      context.addIssue({ code: "custom", path: ["words", index], message: "words must be sorted by start" });
      break;
    }
  }
  const ids = new Set<string>();
  plan.words.forEach((word, index) => {
    if (ids.has(word.id)) context.addIssue({ code: "custom", path: ["words", index, "id"], message: "duplicate word id" });
    ids.add(word.id);
  });
  for (const [index, subject] of (plan.subjects ?? []).entries()) {
    if (!(subject.to > subject.from)) context.addIssue({ code: "custom", path: ["subjects", index], message: "subject range must be positive" });
  }
});
export type StylePlanV1 = z.output<typeof stylePlanSchemaV1>;

export class StylePlanError extends Error {
  readonly code: string;
  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "StylePlanError";
    this.code = code;
  }
}
