import { z } from "zod";
import { MOTION_ENERGIES, type MotionEnergy } from "../motion/motionLanguage";

/**
 * Editkin Motion Library 160: item kinds, parameter schemas and the item contract.
 * Counts are per kind (80 text, 40 transitions, 40 backgrounds); nothing assumes a total.
 *
 * Everything under src/motionLibrary except render/ is browser-safe (no static
 * node: imports) so the editor webview can draw the same SVG frames that the
 * FFmpeg/librsvg path rasterizes into cached clips.
 */

/** Bump when any generator, document builder or glyph layout change alters output bytes. */
/** 1.2.0: full-scale 10-bit alpha in every ProRes 4444 output (text clips, mattes, overlays). */
/**
 * 1.3.0: background speed 0.25–2 and density 0.5–2 in quarter steps; loops stretch by 1, 2 or 4 instead of rounding
 * the cycle count (backgroundLoop). Default-params output is unchanged; other speeds now really change the rate.
 */
export const MOTION_LIBRARY_ENGINE_VERSION = "editkin.motion-library-engine/1.3.0" as const;

export const MOTION_LIBRARY_KINDS = ["text", "transition", "background"] as const;
export type MotionLibraryKind = typeof MOTION_LIBRARY_KINDS[number];

export const MOTION_PALETTE_ROLES = ["bg", "ink", "paper", "accent", "accent2"] as const;
export type MotionPaletteRole = typeof MOTION_PALETTE_ROLES[number];
/** Every role is an uppercase #RRGGBB sRGB colour. */
export type MotionPalette = Readonly<Record<MotionPaletteRole, string>>;

/** Reference palettes measured from the reference frames (ART_DIRECTION §0): the catalog defaults, one per category. */
export const MOTION_REFERENCE_PALETTE_THEMES = ["ref_lime", "ref_coral", "ref_violet", "ref_teal", "ref_gold", "ref_red", "ref_yellow", "ref_aqua",
  "ref_lavender", "ref_orange", "ref_pink"] as const;
/** Hao's own themes: selectable alternatives, never a catalog default. */
export const MOTION_HAO_PALETTE_THEMES = ["hao_impact", "swiss_blue", "travel_note", "tech_spec", "esports_hud"] as const;
export const MOTION_PALETTE_THEMES = [...MOTION_HAO_PALETTE_THEMES, ...MOTION_REFERENCE_PALETTE_THEMES] as const;
export type MotionPaletteTheme = typeof MOTION_PALETTE_THEMES[number];
export type MotionReferencePaletteTheme = typeof MOTION_REFERENCE_PALETTE_THEMES[number];

export { MOTION_ENERGIES, type MotionEnergy };

/** Font roles a text item may choose for its main lines (see svg/glyphs.ts for the face registry). */
export const MOTION_TEXT_FONT_ROLES = ["display", "serif", "hand", "latin"] as const;
export type MotionTextFontRole = typeof MOTION_TEXT_FONT_ROLES[number];

/**
 * Text plate (ART_DIRECTION §9). A text clip is transparent ("none") and sits over
 * footage; any other value paints a full-frame plate in that palette role first
 * (the 字卡 title-card mode) without changing geometry or timing.
 */
export const MOTION_TEXT_PLATES = ["none", "bg", "accent", "paper"] as const;
export type MotionTextPlate = typeof MOTION_TEXT_PLATES[number];
/** The plate each text item was designed on; library thumbnails and contact sheets draw it. */
export const MOTION_SHOWCASE_PLATES = ["bg", "accent", "paper"] as const;
export type MotionShowcasePlate = typeof MOTION_SHOWCASE_PLATES[number];

/** Travel direction of a directional transition (the leading edge moves this way). */
export const MOTION_TRANSITION_DIRECTIONS = ["left_to_right", "right_to_left", "top_to_bottom", "bottom_to_top"] as const;
export type MotionTransitionDirection = typeof MOTION_TRANSITION_DIRECTIONS[number];

export const MOTION_ART_STATUSES = ["pending", "certified"] as const;
export type MotionArtStatus = typeof MOTION_ART_STATUSES[number];

export const MOTION_TEXT_MAX_LINE_CODE_POINTS = 48;
/** LF, CR, NEL, LINE SEPARATOR, PARAGRAPH SEPARATOR: a text line may not contain these. */
const LINE_BREAK_CODES: ReadonlySet<number> = new Set([0x0A, 0x0D, 0x85, 0x2028, 0x2029]);
export const MOTION_FRAME_MIN_SIDE = 16;
export const MOTION_FRAME_MAX_SIDE = 7680;

// ---------------------------------------------------------------------------
// Parameter schemas
// ---------------------------------------------------------------------------

const hexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/, "palette colours must be #RRGGBB").transform(value => value.toUpperCase());

export const motionPaletteSchema = z.strictObject({
  bg: hexColor, ink: hexColor, paper: hexColor, accent: hexColor, accent2: hexColor,
});

/** Caller-facing palette: start from a theme (or the item default) and override any role. */
export const motionPaletteInputSchema = z.strictObject({
  theme: z.enum(MOTION_PALETTE_THEMES).optional(),
  bg: hexColor.optional(), ink: hexColor.optional(), paper: hexColor.optional(),
  accent: hexColor.optional(), accent2: hexColor.optional(),
});
export type MotionPaletteInput = z.input<typeof motionPaletteInputSchema>;

const seedSchema = z.number().int().min(0).max(2_147_483_647);
const energySchema = z.enum(MOTION_ENERGIES);

const lineSchema = z.string().min(1).max(MOTION_TEXT_MAX_LINE_CODE_POINTS * 2)
  .refine(value => value.trim().length > 0, "text lines must contain visible characters")
  .refine(value => ![...value].some(character => LINE_BREAK_CODES.has(character.codePointAt(0) ?? 0)), "one line per array entry; line breaks are not allowed inside a line")
  .refine(value => [...value].length <= MOTION_TEXT_MAX_LINE_CODE_POINTS, `a line holds at most ${MOTION_TEXT_MAX_LINE_CODE_POINTS} characters`);

export const textMotionParamsSchema = z.strictObject({
  palette: motionPaletteSchema,
  energy: energySchema,
  seed: seedSchema,
  lines: z.array(lineSchema).min(1).max(4),
  font: z.enum(MOTION_TEXT_FONT_ROLES),
  durationSeconds: z.number().finite().min(0.5).max(30),
  plate: z.enum(MOTION_TEXT_PLATES).default("none"),
});

export const transitionMotionParamsSchema = z.strictObject({
  palette: motionPaletteSchema,
  energy: energySchema,
  seed: seedSchema,
  durationSeconds: z.number().finite().min(0.2).max(2.0),
  direction: z.enum(MOTION_TRANSITION_DIRECTIONS).optional(),
});

/** Background speed and density are quarter steps: a value in range snaps to the nearest 0.25. */
const quarterStep = (min: number, max: number) => z.number().finite().min(min).max(max).transform(value => Math.round(value * 4) / 4);

export const backgroundMotionParamsSchema = z.strictObject({
  palette: motionPaletteSchema,
  energy: energySchema,
  seed: seedSchema,
  durationSeconds: z.number().finite().min(0.5).max(120),
  /**
   * Motion rate multiplier, 0.25–2 in quarter steps. A loop item runs speed × its base cycles: the seamless period
   * stretches by 1, 2 or 4 to keep the cycle count whole (items/backgrounds/backgroundLoop.ts; the period is
   * motionBackgroundLoopSeconds(item, params) in catalog.ts).
   */
  speed: quarterStep(0.25, 2),
  /** Element density multiplier (grid pitch, particle count), 0.5–2 in quarter steps. */
  density: quarterStep(0.5, 2),
});

export const textMotionParamsInputSchema = z.strictObject({
  palette: motionPaletteInputSchema.optional(),
  energy: energySchema.optional(),
  seed: seedSchema.optional(),
  lines: textMotionParamsSchema.shape.lines.optional(),
  font: z.enum(MOTION_TEXT_FONT_ROLES).optional(),
  durationSeconds: textMotionParamsSchema.shape.durationSeconds.optional(),
  plate: z.enum(MOTION_TEXT_PLATES).optional(),
});
export const transitionMotionParamsInputSchema = z.strictObject({
  palette: motionPaletteInputSchema.optional(),
  energy: energySchema.optional(),
  seed: seedSchema.optional(),
  durationSeconds: transitionMotionParamsSchema.shape.durationSeconds.optional(),
  direction: z.enum(MOTION_TRANSITION_DIRECTIONS).optional(),
});
export const backgroundMotionParamsInputSchema = z.strictObject({
  palette: motionPaletteInputSchema.optional(),
  energy: energySchema.optional(),
  seed: seedSchema.optional(),
  durationSeconds: backgroundMotionParamsSchema.shape.durationSeconds.optional(),
  speed: backgroundMotionParamsSchema.shape.speed.optional(),
  density: backgroundMotionParamsSchema.shape.density.optional(),
});

/** Fully resolved parameters a generator receives (frozen, palette complete). */
export type TextMotionParams = Readonly<z.output<typeof textMotionParamsSchema>>;
export type TransitionMotionParams = Readonly<z.output<typeof transitionMotionParamsSchema>>;
export type BackgroundMotionParams = Readonly<z.output<typeof backgroundMotionParamsSchema>>;
export type MotionLibraryParams = TextMotionParams | TransitionMotionParams | BackgroundMotionParams;

/** Partial caller input merged over an item's defaultParams (see params.ts). */
export type TextMotionParamsInput = z.input<typeof textMotionParamsInputSchema>;
export type TransitionMotionParamsInput = z.input<typeof transitionMotionParamsInputSchema>;
export type BackgroundMotionParamsInput = z.input<typeof backgroundMotionParamsInputSchema>;

// ---------------------------------------------------------------------------
// Item contract
// ---------------------------------------------------------------------------

/** Output frame size in pixels. SVG user units equal pixels (viewBox 0 0 width height). */
export interface MotionFrameSize {
  readonly width: number;
  readonly height: number;
}

/**
 * A transition frame. `matte` is a full-frame luminance image: white shows B,
 * black (or transparent) shows A, grey mixes. `overlay` is an RGBA layer drawn
 * over mix(A, B, matte); omit it (or return undefined) when there is none.
 */
export interface TransitionFrame {
  readonly matte: string;
  readonly overlay?: string;
}

export type TextMotionGenerator = (params: TextMotionParams, tSeconds: number, size: MotionFrameSize) => string;
export type TransitionMotionGenerator = (params: TransitionMotionParams, tSeconds: number, size: MotionFrameSize) => TransitionFrame;
export type BackgroundMotionGenerator = (params: BackgroundMotionParams, tSeconds: number, size: MotionFrameSize) => string;

export interface MotionLibraryNames {
  /** Traditional Chinese display name. */
  readonly zh: string;
  /** The reference's Japanese name (katakana renderings where the reference only showed English). */
  readonly ja: string;
  /** The reference's English name. */
  readonly en: string;
}

interface MotionLibraryItemCommon {
  /** T01–T80, X01–X40, B01–B40. */
  readonly id: string;
  /** Reference group. Text: impact/flow/depth/switch/style (first reference), drama/play/physics/rhythm/mood (second);
   * transitions: sweep/shape/fluid_impact/panel/mosaic; backgrounds: halftone/grid/lines/shapes/minimal. */
  readonly category: string;
  readonly names: MotionLibraryNames;
  readonly tags: readonly string[];
  readonly defaultDurationSeconds: number;
  /** Seamless period of the motion when the item loops (backgrounds always; some text items). */
  readonly loopSeconds?: number;
  /** Sample text for library thumbnails (text items). */
  readonly previewText?: string;
  /** VA defaults only pick certified items; every item starts pending until Claude reviews real renders. */
  readonly artStatus: MotionArtStatus;
  /** False while the item still points at the notImplemented generator. */
  readonly implemented: boolean;
  /**
   * Art revision of the item's generator: an integer ≥ 1, default 1 (the catalog always fills it in). It is
   * part of the clip cache key (itemRevision), so bump it whenever the item's output bytes change.
   */
  readonly revision?: number;
  /** Free-form production notes (rights, VA exclusions, art rulings). */
  readonly notes?: string;
}

export interface TextMotionItem extends MotionLibraryItemCommon {
  readonly kind: "text";
  readonly defaultParams: TextMotionParams;
  /** Plate the item was designed on (ART_DIRECTION §9); defaultParams.plate stays "none" (transparent clip). */
  readonly showcasePlate: MotionShowcasePlate;
  readonly generate: TextMotionGenerator;
}

export interface TransitionMotionItem extends MotionLibraryItemCommon {
  readonly kind: "transition";
  readonly defaultParams: TransitionMotionParams;
  readonly generate: TransitionMotionGenerator;
  /** Directions the generator honours; undefined means the item is not directional. */
  readonly supportedDirections?: readonly MotionTransitionDirection[];
}

export interface BackgroundMotionItem extends MotionLibraryItemCommon {
  readonly kind: "background";
  readonly defaultParams: BackgroundMotionParams;
  readonly generate: BackgroundMotionGenerator;
  /** The base seamless period at speed 1; at other speeds use motionBackgroundLoopSeconds(item, params) (catalog.ts). */
  readonly loopSeconds: number;
  /** Whole motion cycles per base loop at speed 1, as the generator declares it (default 1); see backgroundLoop. */
  readonly loopCycles: number;
}

export type MotionLibraryItem = TextMotionItem | TransitionMotionItem | BackgroundMotionItem;

/** What an item file exports; catalog.ts binds it to the registered metadata. */
export type MotionLibraryImplementation =
  | { readonly id: string; readonly kind: "text"; readonly generate: TextMotionGenerator; readonly revision?: number }
  | { readonly id: string; readonly kind: "transition"; readonly generate: TransitionMotionGenerator; readonly revision?: number;
    readonly supportedDirections?: readonly MotionTransitionDirection[] }
  | { readonly id: string; readonly kind: "background"; readonly generate: BackgroundMotionGenerator; readonly revision?: number;
    readonly loopSeconds?: number; readonly loopCycles?: number };

export const MOTION_ITEM_DEFAULT_REVISION = 1;

/** An item's art revision: undefined → 1; anything but an integer in 1..1_000_000 throws. */
export function resolveMotionItemRevision(revision: number | undefined): number {
  if (revision === undefined) return MOTION_ITEM_DEFAULT_REVISION;
  if (!Number.isInteger(revision) || revision < 1 || revision > 1_000_000) {
    throw new Error(`Motion library item revision must be an integer from 1 to 1000000 (got ${String(revision)})`);
  }
  return revision;
}

export interface MotionImplementationOptions {
  /** Art revision (integer ≥ 1, default 1). Bump it whenever this item's output bytes change: it is part of the clip cache key. */
  readonly revision?: number;
}

export function defineTextMotion(id: string, generate: TextMotionGenerator, options: MotionImplementationOptions = {}):
  Extract<MotionLibraryImplementation, { kind: "text" }> {
  return Object.freeze({ id, kind: "text" as const, generate, revision: resolveMotionItemRevision(options.revision) });
}
export function defineTransitionMotion(id: string, generate: TransitionMotionGenerator,
  options: MotionImplementationOptions & { supportedDirections?: readonly MotionTransitionDirection[] } = {}): Extract<MotionLibraryImplementation, { kind: "transition" }> {
  return Object.freeze({ id, kind: "transition" as const, generate, revision: resolveMotionItemRevision(options.revision),
    ...(options.supportedDirections ? { supportedDirections: Object.freeze([...options.supportedDirections]) } : {}) });
}
export interface BackgroundImplementationOptions extends MotionImplementationOptions {
  /** The base loop (seconds at speed 1) the generator assumes; the catalog checks it against the registered loop. */
  readonly loopSeconds?: number;
  /** Whole motion cycles the generator runs per base loop at speed 1 (integer ≥ 1, default 1); see backgroundLoop. */
  readonly loopCycles?: number;
}

export function defineBackgroundMotion(id: string, generate: BackgroundMotionGenerator, options: BackgroundImplementationOptions = {}):
  Extract<MotionLibraryImplementation, { kind: "background" }> {
  if (options.loopSeconds !== undefined && !(Number.isFinite(options.loopSeconds) && options.loopSeconds > 0)) {
    throw new Error(`Background ${id} loopSeconds must be a positive number of seconds`);
  }
  if (options.loopCycles !== undefined && !(Number.isInteger(options.loopCycles) && options.loopCycles >= 1)) {
    throw new Error(`Background ${id} loopCycles must be a whole number ≥ 1`);
  }
  return Object.freeze({ id, kind: "background" as const, generate, revision: resolveMotionItemRevision(options.revision),
    ...(options.loopSeconds !== undefined ? { loopSeconds: options.loopSeconds } : {}),
    ...(options.loopCycles !== undefined ? { loopCycles: options.loopCycles } : {}) });
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class MotionLibraryNotImplementedError extends Error {
  readonly itemId: string;
  constructor(itemId: string) {
    super(`Motion library item ${itemId} is registered but not implemented yet`);
    this.name = "MotionLibraryNotImplementedError";
    this.itemId = itemId;
  }
}

export class MotionLibraryParamsError extends Error {
  readonly itemId: string;
  readonly issues: readonly string[];
  constructor(itemId: string, issues: readonly string[]) {
    super(`Invalid parameters for motion library item ${itemId}: ${issues.join("; ")}`);
    this.name = "MotionLibraryParamsError";
    this.itemId = itemId;
    this.issues = Object.freeze([...issues]);
  }
}

/** Validate an output size; every frame builder and the renderer use the same rule. */
export function assertMotionFrameSize(size: MotionFrameSize): void {
  if (!size || !Number.isInteger(size.width) || !Number.isInteger(size.height)
    || size.width < MOTION_FRAME_MIN_SIDE || size.height < MOTION_FRAME_MIN_SIDE
    || size.width > MOTION_FRAME_MAX_SIDE || size.height > MOTION_FRAME_MAX_SIDE) {
    throw new Error(`Motion library frame size must be integers within ${MOTION_FRAME_MIN_SIDE}..${MOTION_FRAME_MAX_SIDE}`);
  }
}
