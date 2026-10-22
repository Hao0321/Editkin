import type { EditorCommand } from "../domain/commandTypes";
import { DEFAULT_CLIP_LAYER, DEFAULT_COLOR } from "../domain/types";
import type { ClipKeyframe, ClipLayout, ClipMask, TimelineClip } from "../domain/types";
import { contrastRatio } from "../motionLibrary/svg/color";
import { layoutLine } from "../motionLibrary/svg/glyphs";
import { ANNOTATION_REVISION, type AnnotationParams } from "./components/annotationKit";
import { EXPLAINER_REVISION, measureExplainer, type ExplainerColors, type ExplainerParams } from "./components/explainerKit";
import { INSERT_FRAME_REVISION, insertOutline, insertPose, type InsertFrameParams, type InsertRect } from "./components/insertLayouts";
import { STAGE_REVISION, type StageColors, type StagePropsParams, type StageTextureJobParams } from "./components/illustrationStage";
import {
  EPS, fontOf, frameTime, occupiedDuring, resolveTextRef, round2, round4, round6, subjectBoxes,
  type OccupiedBox, type StyleCompileIssue,
} from "./compileShared";
import type { StyleComponentParams, StyleJobTrack, StyleRenderJobV1 } from "./jobs";
import type { ResolvedStylePalette } from "./palette";
import { boxFromNormalized, intersects, safeArea, solvePlacementCandidates, type Box } from "./placement";
import { contrastAgainstBackground, STYLE_BUSY_TEXTURE, type BackgroundStats } from "./readability";
import {
  StylePlanError,
  type SoundEvent, type StyleAnnotationBeatV1, type StyleExplainerBeatV1, type StyleInsertBeatV1, type StylePaletteRole, type StylePlanV1, type StyleTemplateV1,
} from "./types";

/**
 * Phase B compile (design §2.1 C3–C6): explainer widgets, annotations, insert layouts and the illustration stage.
 * Same contract as Phase A: a beat becomes rendered overlay jobs + ordinary EditorCommands; all on-screen text is
 * spoken words or flagged editorial text (M10); placement leaves every important region clear.
 *
 * Insert clips are Hao's own footage or stills placed with ordinary commands (add_clip with a layout, a polygon
 * mask and baked linear pose keyframes); the frame generators draw only what surrounds them (shadow, torn paper,
 * border, divider) from the same pose, so card and footage move as one.
 */

export interface PhaseBProject {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly sampleBackground?: (box: Box, from: number, to: number) => BackgroundStats | undefined;
  /** Display size of an insert source asset (already imported by the caller); undefined = unknown. */
  readonly insertSource?: (assetId: string) => { readonly width: number; readonly height: number } | undefined;
}

export interface StyleSoundEventV1 { readonly at: number; readonly event: SoundEvent; readonly beatIndex: number }

/** An insert placed on the timeline (what the product commands do, and what a review harness mirrors). */
export interface StyleInsertPlacementV1 {
  readonly beatIndex: number;
  readonly layout: StyleInsertBeatV1["layout"];
  readonly source: { readonly kind: "clip" | "still"; readonly assetId: string; readonly sourceStart: number } | { readonly kind: "stage"; readonly jobId: string };
  readonly clipId: string;
  readonly timelineStart: number;
  readonly duration: number;
  /** Insert rect (px) and the source's contain-fit canvas crop shown in it. */
  readonly rect: InsertRect;
  readonly layoutNorm: ClipLayout;
  /** Outline in rect-local px (rounded card, torn paper, or the plain rect). */
  readonly outline: ReadonlyArray<readonly [number, number]>;
  readonly rotation: number;
  /** Clip-local pose keys (linear): px offset and opacity. */
  readonly keys: ReadonlyArray<{ readonly time: number; readonly dx: number; readonly dy: number; readonly opacity: number }>;
}

/** The main footage moved into the other half while a split insert plays (set_clip_layout on the split piece). */
export interface StyleSplitV1 { readonly from: number; readonly to: number; readonly beatIndex: number; readonly layout: ClipLayout }

export interface PhaseBEnv {
  readonly template: StyleTemplateV1;
  readonly palette: ResolvedStylePalette;
  readonly plan: StylePlanV1;
  readonly project: PhaseBProject;
  readonly issues: StyleCompileIssue[];
  readonly occupied: OccupiedBox[];
  readonly events: StyleSoundEventV1[];
  readonly backdrops: Array<{ from: number; to: number; beatIndex: number }>;
  readonly inserts: StyleInsertPlacementV1[];
  readonly splits: StyleSplitV1[];
  readonly commands: EditorCommand[];
  readonly insertTrackId: string;
  readonly addJob: (beatIndex: number, params: StyleComponentParams, timelineStart: number, frameCount: number,
    track: StyleJobTrack, output: StyleRenderJobV1["output"], blendMode: StyleRenderJobV1["blendMode"], extra?: { keys?: StyleInsertPlacementV1["keys"]; rotation?: number }) => string;
}

const MIN_TEXT_CONTRAST = 4.5;
/** Non-text graphics (strokes, pins) need 3:1 against what is behind them (WCAG 1.4.11). */
const MIN_GRAPHIC_CONTRAST = 3;

function requireComponent<T>(value: T | undefined, template: StyleTemplateV1, name: string): T {
  if (!value) throw new StylePlanError("STYLE_COMPONENT_MISSING", `${template.id} has no ${name} component`);
  return value;
}

function checkPair(issues: StyleCompileIssue[], beatIndex: number, what: string, text: string, plate: string): void {
  const ratio = contrastRatio(text, plate);
  if (ratio < MIN_TEXT_CONTRAST - EPS) issues.push({ severity: "error", code: "STYLE_PALETTE_CONTRAST", beatIndex, detail: `${what}: ${text} on ${plate} is ${ratio.toFixed(2)}:1 (< ${MIN_TEXT_CONTRAST})` });
}

function placementRules(env: PhaseBEnv) {
  const rules = env.template.editorial.placement, short = Math.min(env.project.width, env.project.height);
  return { frame: { width: env.project.width, height: env.project.height }, avoidMargin: rules.faceMargin * short, titleSafe: rules.titleSafe,
    uiBottom: rules.portraitUiBottom, uiRight: rules.portraitUiRight, minScale: rules.minScale };
}

// ---------------------------------------------------------------------------
// C3 explainer kit
// ---------------------------------------------------------------------------

export function compileExplainer(env: PhaseBEnv, beat: StyleExplainerBeatV1, beatIndex: number): void {
  const { template, palette, plan, project, issues } = env;
  const cfg = requireComponent(template.components.explainer, template, "explainer");
  const fps = project.fps, short = Math.min(project.width, project.height);
  const em = cfg.em * short;
  const font = fontOf(template, cfg.font), textFont = fontOf(template, cfg.textFont);
  const start = frameTime(beat.at, fps), duration = beat.duration, end = start + duration;
  const rules = placementRules(env);
  const safe = safeArea(rules);
  const role = (name: StylePaletteRole) => palette[name];

  let text: string | undefined, typeTimes: number[] | undefined, clickAt: number | undefined;
  if (beat.widget === "pill" || beat.widget === "prompt") {
    if (!beat.text) throw new StylePlanError("STYLE_EXPLAINER_TEXT", `a ${beat.widget} needs text (spoken words or editorial)`);
    const resolved = resolveTextRef(plan, beat.text, issues, beatIndex);
    text = resolved.text;
    if (beat.widget === "prompt" && resolved.words) {
      // Typing follows the voice: each word's characters appear across that word's spoken time.
      typeTimes = resolved.words.flatMap(word => {
        const chars = [...word.text];
        return chars.map((_, index) => round4(Math.max(0.2, word.start - start + (index / chars.length) * (word.end - word.start))));
      });
      if (resolved.words[0].start < start + 0.2 - EPS) {
        issues.push({ severity: "warning", code: "STYLE_EXPLAINER_EARLY_TEXT", beatIndex, detail: "the prompt box appears less than 0.2 s before its first word; open it earlier" });
      }
    }
    if (beat.widget === "pill") {
      // The cursor clicks the button as its word is spoken.
      const spoken = resolved.words?.[0]?.start;
      clickAt = round4(Math.min(Math.max(0.45, (spoken ?? start + 0.75) - start), Math.max(0.45, duration - 0.5)));
    }
  }
  if (beat.widget === "steps" && !beat.steps) throw new StylePlanError("STYLE_EXPLAINER_STEPS", "a steps widget needs steps { count, active }");
  const labels = beat.steps?.labels?.map(label => resolveTextRef(plan, label, issues, beatIndex).text);
  if (beat.steps && beat.steps.active >= beat.steps.count) throw new StylePlanError("STYLE_EXPLAINER_STEPS", "active step is outside count");

  const measured = measureExplainer(beat.widget, { em, font, textFont, count: beat.steps?.count ?? beat.cards?.count, labels, text, maxWidth: safe.x1 - safe.x0 });
  const subjects = subjectBoxes(plan, start, end, rules.frame);
  const candidates = solvePlacementCandidates({ ...rules, block: { width: measured.width, height: measured.height },
    avoid: [...subjects, ...occupiedDuring(env.occupied, start, end)], preference: beat.placement ?? "auto" }, 8)
    .filter(candidate => candidate.fits);
  if (!candidates.length) throw new StylePlanError("STYLE_PLACEMENT_FACE_CONFLICT", `no negative space fits the ${beat.widget} widget without covering an important region`);
  const placement = candidates[0];

  const pillPlate = role(cfg.pill.plate), pillText = role(cfg.pill.text);
  const colors: ExplainerColors = {
    plate: role(cfg.prompt.plate), text: role(cfg.prompt.text),
    accent: beat.widget === "steps" ? role(cfg.chips.active) : pillPlate, accentText: beat.widget === "steps" ? role(cfg.chips.activeText) : pillText,
    idle: role(cfg.chips.idle), idleText: role(cfg.chips.idleText),
    cursorFill: role(cfg.cursor.fill), cursorOutline: role(cfg.cursor.outline), shadow: palette.derived.shadow,
    cardPlate: role(cfg.card.plate), cardLine: role(cfg.card.line),
  };
  // Widgets carry their own plates: the text must read on them whatever the footage does.
  if (beat.widget === "pill") checkPair(issues, beatIndex, "pill label", colors.accentText, colors.accent);
  if (beat.widget === "prompt" || labels?.length) checkPair(issues, beatIndex, "prompt / step label text", colors.text, colors.plate);
  if (beat.widget === "steps") { checkPair(issues, beatIndex, "active chip", colors.accentText, colors.accent); checkPair(issues, beatIndex, "idle chip", colors.idleText, colors.idle); }

  let activeAt: number[] | undefined;
  if (beat.steps) {
    // Chips before the active one tick through quickly, then the active one lights (R1's "step 2 of 3").
    activeAt = Array.from({ length: beat.steps.active + 1 }, (_, index) => round4(0.3 + index * 0.16 + (index === beat.steps!.active ? 0.18 : 0)));
  }
  const params: ExplainerParams = {
    component: "explainer", revision: EXPLAINER_REVISION, width: project.width, height: project.height, widget: beat.widget, duration,
    box: { x: round2(placement.x), y: round2(placement.y), scale: placement.scale }, em: round2(em), font, textFont, colors,
    ...(beat.steps ? { steps: { count: beat.steps.count, ...(labels ? { labels } : {}), activeAt: activeAt! } } : {}),
    ...(text !== undefined ? { text } : {}), ...(clickAt !== undefined ? { clickAt } : {}), ...(typeTimes ? { typeTimes } : {}),
    ...(beat.cards ? { cards: { count: beat.cards.count } } : {}), seed: Math.round(beat.at * 1000) % 2_147_483_647,
  };
  env.addJob(beatIndex, params, start, Math.max(1, Math.round(duration * fps)), "explainers", "alpha", "normal");
  env.occupied.push({ box: placement.box, from: start, to: end, beatIndex });
  if (beat.backdrop ?? beat.widget === "cards") env.backdrops.push({ from: start, to: end, beatIndex });
  const cue = beat.widget === "pill" ? { at: start + clickAt!, event: "click" as const }
    : beat.widget === "prompt" ? { at: start + (typeTimes?.[0] ?? 0.3), event: "type" as const }
      : beat.widget === "cards" ? { at: start + 0.1, event: "cards" as const }
        : { at: start + activeAt![activeAt!.length - 1], event: "click" as const };
  env.events.push({ ...cue, beatIndex });
}

// ---------------------------------------------------------------------------
// C4 annotation kit
// ---------------------------------------------------------------------------

export function compileAnnotation(env: PhaseBEnv, beat: StyleAnnotationBeatV1, beatIndex: number): void {
  const { template, palette, plan, project, issues } = env;
  const cfg = requireComponent(template.components.annotation, template, "annotation");
  const fps = project.fps, W = project.width, H = project.height, short = Math.min(W, H);
  const em = short * 0.04;
  const start = frameTime(beat.at, fps), duration = beat.duration, end = start + duration;
  const rules = placementRules(env);
  const safe = safeArea(rules);
  const targetBox = "box" in beat.target ? boxFromNormalized(beat.target.box, rules.frame) : undefined;
  const targetPoint = "point" in beat.target ? { x: beat.target.point[0] * W, y: beat.target.point[1] * H } : undefined;
  if ((beat.mark === "circle" || beat.mark === "underline") && !targetBox) throw new StylePlanError("STYLE_ANNOTATION_TARGET", `${beat.mark} needs a target box`);
  if ((beat.mark === "pin" || beat.mark === "marker") && !targetPoint) throw new StylePlanError("STYLE_ANNOTATION_TARGET", `${beat.mark} needs a target point`);
  if (beat.mark === "callout" && !beat.label) throw new StylePlanError("STYLE_ANNOTATION_LABEL", "a callout needs a label");
  const tip = targetPoint ?? { x: (targetBox!.x0 + targetBox!.x1) / 2, y: beat.mark === "arrow" ? targetBox!.y0 : (targetBox!.y0 + targetBox!.y1) / 2 };

  // Arrow tail: from the plan, else from the larger open side toward the target (about 7 em away), inside the safe area.
  let from: { x: number; y: number } | undefined;
  if (beat.mark === "arrow") {
    if (beat.from) from = { x: beat.from[0] * W, y: beat.from[1] * H };
    else {
      const cx = (safe.x0 + safe.x1) / 2, cy = (safe.y0 + safe.y1) / 2;
      let vx = cx - tip.x, vy = cy - tip.y;
      const length = Math.hypot(vx, vy);
      if (length < 2 * em) { vx = -0.6; vy = 0.8; } else { vx /= length; vy /= length; }
      from = { x: Math.min(safe.x1 - em, Math.max(safe.x0 + em, tip.x + vx * 7 * em)), y: Math.min(safe.y1 - em, Math.max(safe.y0 + em, tip.y + vy * 7 * em)) };
    }
  }

  // Label card: text from speech (or editorial), placed by mark, kept inside the safe area and off important regions.
  let label: AnnotationParams["label"];
  let labelBox: Box | undefined;
  if (beat.label) {
    const text = resolveTextRef(plan, beat.label, issues, beatIndex).text;
    const font = fontOf(template, cfg.font), size = round2(em * 0.95);
    const line = layoutLine(text, { ...font, size });
    const ink = line.inkBox ?? { x0: 0, y0: -size * 0.8, x1: line.width, y1: 0 };
    const w = ink.x1 - ink.x0 + size * 1.1, h = ink.y1 - ink.y0 + size * 0.76;
    const boxAt = (x: number, y: number): Box => ({ x0: x - w / 2, y0: y - h / 2, x1: x + w / 2, y1: y + h / 2 });
    const clampX = (x: number) => Math.min(safe.x1 - w / 2, Math.max(safe.x0 + w / 2, x));
    const clampY = (y: number) => Math.min(safe.y1 - h / 2, Math.max(safe.y0 + h / 2, y));
    const avoid = [...subjectBoxes(plan, start, end, rules.frame).filter(box => !targetBox || !intersects(box, targetBox)), ...occupiedDuring(env.occupied, start, end)];
    const options: Array<{ x: number; y: number }> = [];
    switch (beat.mark) {
      case "pin": options.push({ x: tip.x, y: tip.y - 4.6 * em }, { x: tip.x + w / 2 + 1.6 * em, y: tip.y - 2.2 * em }, { x: tip.x - w / 2 - 1.6 * em, y: tip.y - 2.2 * em }); break;
      case "marker": options.push({ x: tip.x + 1.5 * em + w / 2, y: tip.y }, { x: tip.x - 1.5 * em - w / 2, y: tip.y }, { x: tip.x, y: tip.y + 2.2 * em }); break;
      case "arrow": {
        const ux = tip.x - from!.x, uy = tip.y - from!.y, length = Math.hypot(ux, uy) || 1;
        options.push({ x: from!.x - (ux / length) * (w / 2 + 0.6 * em), y: from!.y - (uy / length) * (h / 2 + 0.6 * em) }, { x: from!.x, y: from!.y + h }, { x: from!.x, y: from!.y - h });
        break;
      }
      case "underline": options.push({ x: tip.x, y: targetBox!.y1 + 1.7 * em }, { x: tip.x, y: targetBox!.y0 - 1.2 * em }); break;
      case "circle": options.push({ x: tip.x, y: targetBox!.y0 - (targetBox!.y1 - targetBox!.y0) * 0.12 - 1.6 * em }, { x: tip.x, y: targetBox!.y1 + 1.8 * em }); break;
      case "callout": {
        const toward = tip.y > (safe.y0 + safe.y1) / 2 ? -1 : 1, side = tip.x > (safe.x0 + safe.x1) / 2 ? -1 : 1;
        options.push({ x: tip.x + side * 5 * em, y: tip.y + toward * 5 * em }, { x: tip.x - side * 5 * em, y: tip.y + toward * 5 * em }, { x: tip.x + side * 5 * em, y: tip.y - toward * 5 * em });
        break;
      }
    }
    const clamped = options.map(option => ({ x: clampX(option.x), y: clampY(option.y) }));
    const chosen = clamped.find(option => !avoid.some(box => intersects(boxAt(option.x, option.y), box))
      && (!targetBox || !intersects(boxAt(option.x, option.y), targetBox))) ?? clamped[0];
    if (avoid.some(box => intersects(boxAt(chosen.x, chosen.y), box))) {
      issues.push({ severity: "warning", code: "STYLE_ANNOTATION_LABEL_OVERLAP", beatIndex, detail: "the label could not clear every important region" });
    }
    label = { text, font, size, x: round2(chosen.x), y: round2(chosen.y) };
    labelBox = boxAt(chosen.x, chosen.y);
    checkPair(issues, beatIndex, "annotation label", palette[cfg.label], palette[cfg.labelPlate]);
  }

  // Stroke colour: the template's, unless the footage behind the mark leaves it under 3:1; then the better of paper / ink.
  let stroke = palette[cfg.stroke];
  const markBox: Box = targetBox && beat.mark !== "arrow" ? targetBox
    : { x0: Math.min(tip.x, from?.x ?? tip.x) - 2 * em, y0: Math.min(tip.y, from?.y ?? tip.y) - 2.5 * em, x1: Math.max(tip.x, from?.x ?? tip.x) + 2 * em, y1: Math.max(tip.y, from?.y ?? tip.y) + 0.8 * em };
  const visible: Box = { x0: Math.max(0, markBox.x0), y0: Math.max(0, markBox.y0), x1: Math.min(W, markBox.x1), y1: Math.min(H, markBox.y1) };
  const stats = visible.x1 > visible.x0 && visible.y1 > visible.y0 ? project.sampleBackground?.(visible, start, end) : undefined;
  let shadow = 0.45;
  if (stats) {
    const best = [stroke, palette.paper, palette.ink].map(color => ({ color, ratio: contrastAgainstBackground(color, stats) })).sort((a, b) => b.ratio - a.ratio);
    const own = contrastAgainstBackground(stroke, stats);
    if (own < MIN_GRAPHIC_CONTRAST - EPS) stroke = best[0].color;
    const ratio = Math.max(own, best[0].ratio);
    if (ratio < MIN_GRAPHIC_CONTRAST - EPS) issues.push({ severity: "warning", code: "STYLE_ANNOTATION_CONTRAST", beatIndex, detail: `best stroke contrast ${ratio.toFixed(2)}:1 < ${MIN_GRAPHIC_CONTRAST}` });
    shadow = stats.texture > STYLE_BUSY_TEXTURE || contrastAgainstBackground(stroke, stats) < MIN_TEXT_CONTRAST ? 0.6 : 0.35;
  }
  const params: AnnotationParams = {
    component: "annotation", revision: ANNOTATION_REVISION, width: W, height: H, mark: beat.mark, duration, em: round2(em),
    seed: (Math.round(beat.at * 1000) + beatIndex) % 2_147_483_647,
    colors: { stroke, pin: palette[cfg.pin], pinCore: palette.paper, label: palette[cfg.label], labelPlate: palette[cfg.labelPlate],
      marker: palette[cfg.marker], markerText: contrastRatio(palette.ink, palette[cfg.marker]) >= contrastRatio(palette.paper, palette[cfg.marker]) ? palette.ink : palette.paper,
      shadow: palette.derived.shadow },
    strokeWidth: round2(cfg.strokeWidth * short), dash: cfg.dash, strokeShadow: shadow,
    target: { ...(targetBox ? { box: roundBox(targetBox) } : {}), ...(targetPoint ? { point: { x: round2(targetPoint.x), y: round2(targetPoint.y) } } : {}) },
    ...(from ? { from: { x: round2(from.x), y: round2(from.y) } } : {}), ...(label ? { label } : {}), ...(beat.number !== undefined ? { number: beat.number } : {}),
  };
  env.addJob(beatIndex, params, start, Math.max(1, Math.round(duration * fps)), "annotations", "alpha", "normal");
  if (labelBox) env.occupied.push({ box: labelBox, from: start, to: end, beatIndex });
  const at = beat.mark === "pin" ? start + 0.5 : beat.mark === "callout" ? start + 0.25 : start;
  env.events.push({ at, event: beat.mark === "pin" || beat.mark === "marker" ? "pin" : "arrow", beatIndex });
}

const roundBox = (box: Box) => ({ x0: round2(box.x0), y0: round2(box.y0), x1: round2(box.x1), y1: round2(box.y1) });

// ---------------------------------------------------------------------------
// C5 insert layouts + C6 illustration stage
// ---------------------------------------------------------------------------

const CORNERS = ["topRight", "topLeft", "bottomRight", "bottomLeft"] as const;

export function compileInsert(env: PhaseBEnv, beat: StyleInsertBeatV1, beatIndex: number): void {
  const { template, palette, plan, project, issues } = env;
  const fps = project.fps, W = project.width, H = project.height, short = Math.min(W, H), portrait = H > W;
  const start = frameTime(beat.range[0], fps), end = frameTime(beat.range[1], fps), duration = end - start;
  if (duration < 0.5 - EPS) throw new StylePlanError("STYLE_INSERT_RANGE", "an insert stays at least 0.5 s");
  const cfg = beat.layout === "full" ? template.components.insert : requireComponent(template.components.insert, template, "insert");
  const rules = placementRules(env);
  const safe = safeArea(rules);
  const seed = (Math.round(beat.range[0] * 1000) + beatIndex * 7919) % 2_147_483_647;

  // Source aspect (display): Hao's clip / still, or the stage, which is drawn to fit its rect.
  let sourceAspect: number | undefined;
  if (beat.source.kind !== "stage") {
    const size = project.insertSource?.(beat.source.assetId);
    if (!size || !(size.width > 0 && size.height > 0)) throw new StylePlanError("STYLE_INSERT_SOURCE_UNKNOWN", `asset ${beat.source.assetId} has no known display size`);
    sourceAspect = size.width / size.height;
  } else {
    if (!template.components.stage) throw new StylePlanError("STYLE_COMPONENT_MISSING", `${template.id} has no stage component`);
    // The stage is a set (R2 desk, R5 collage): it fills the frame or one half; its props are not a card that slides.
    if (beat.layout === "pip" || beat.layout === "tornPaper") throw new StylePlanError("STYLE_STAGE_LAYOUT", "a stage insert is full or split");
  }

  // Rect.
  let rect: InsertRect;
  let rotation = 0, slide = { dx: 0, dy: 0 };
  const subjects = subjectBoxes(plan, start, end, rules.frame);
  if (beat.layout === "full") rect = { x: 0, y: 0, w: W, h: H };
  else if (beat.layout === "split") {
    rect = portrait ? { x: 0, y: 0, w: W, h: Math.round(H / 2) } : { x: 0, y: 0, w: Math.round(W / 2), h: H };
    if (beat.source.kind !== "stage") slide = portrait ? { dx: 0, dy: -Math.round(H * 0.06) } : { dx: -Math.round(W * 0.06), dy: 0 };
  } else {
    const share = beat.layout === "tornPaper" ? Math.min(0.75, cfg!.pipScale * 1.25) : cfg!.pipScale;
    const aspect = sourceAspect ?? (portrait ? 3 / 4 : 4 / 3);
    let w = W * share, h = w / aspect;
    const maxH = (safe.y1 - safe.y0) * (beat.layout === "tornPaper" ? 0.55 : 0.46);
    if (h > maxH) { h = maxH; w = h * aspect; }
    w = Math.round(w); h = Math.round(h);
    const margin = short * 0.045;
    const at = (corner: typeof CORNERS[number]): InsertRect => ({
      x: corner.endsWith("Left") ? safe.x0 + margin * 0.2 : safe.x1 - w - margin * 0.2,
      y: corner.startsWith("top") ? safe.y0 + margin * 0.6 : safe.y1 - h - margin * 0.2, w, h });
    const order = [beat.corner ?? (portrait ? "topLeft" : "topRight"), ...CORNERS.filter(corner => corner !== (beat.corner ?? (portrait ? "topLeft" : "topRight")))];
    const asBox = (r: InsertRect): Box => ({ x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h });
    const clear = order.find(corner => !subjects.some(box => intersects(asBox(at(corner)), box)));
    if (!clear) issues.push({ severity: "warning", code: "STYLE_INSERT_OVER_SUBJECT", beatIndex, detail: "every corner covers an important region; the card sits in the requested corner" });
    const corner = clear ?? order[0];
    rect = at(corner);
    rotation = beat.layout === "tornPaper" ? (corner.endsWith("Left") ? -2.4 : 2.4) : 0;
    slide = { dx: Math.round((corner.endsWith("Left") ? -1 : 1) * W * 0.08), dy: 0 };
    env.occupied.push({ box: asBox(rect), from: start, to: end, beatIndex });
  }
  const radius = beat.layout === "pip" ? Math.round((cfg?.radius ?? 0) * short) : 0;
  const outline = insertOutline(beat.layout === "split" ? "full" : beat.layout, rect.w, rect.h, radius, seed);

  // Pose keys, baked per frame through entry and exit (linear in between: preview == export).
  const keys: Array<{ time: number; dx: number; dy: number; opacity: number }> = [];
  if (beat.layout !== "full") {
    const frames = Math.round(duration * fps), entry = Math.ceil(0.32 * fps), exit = Math.ceil(0.22 * fps);
    const indices = new Set<number>([...Array.from({ length: entry + 1 }, (_, i) => i), ...Array.from({ length: exit + 1 }, (_, i) => frames - exit + i)]);
    for (const index of [...indices].filter(i => i >= 0 && i <= frames).sort((a, b) => a - b)) {
      const t = Math.min(index / fps, duration - 1e-4);
      const pose = insertPose({ slide, duration }, t);
      keys.push({ time: round6(index / fps), dx: round2(pose.dx), dy: round2(pose.dy), opacity: round4(pose.opacity) });
    }
  }

  // The source's contain-fit canvas region shown in the rect (cover, centred on the source).
  const layoutNorm = coverLayout(rect, W, H, sourceAspect ?? rect.w / rect.h);
  const clipId = `style-insert-${String(beatIndex).padStart(3, "0")}`;
  let source: StyleInsertPlacementV1["source"];
  if (beat.source.kind === "stage") {
    const stage = template.components.stage!;
    const colors: StageColors = { desk: stage.desk, paper: stage.paper, ink: palette.ink, accent: palette.accent, accent2: palette.accent2, highlight: palette.highlight,
      leaf: stage.leaf, shadow: palette.derived.shadow, caption: palette[stage.captionColor] };
    const texture: StageTextureJobParams = { component: "stageTexture", revision: STAGE_REVISION, width: W, height: H, rect, scene: beat.source.scene,
      shape: { layout: beat.layout, radius, seed }, colors, seed };
    // The texture is a canvas-sized still: its pose keys fade it (split) and its outline is drawn into it, so it needs no mask or rotation.
    const jobId = env.addJob(beatIndex, texture, start, Math.max(1, Math.round(duration * fps)), "stage", "still", "normal", { keys });
    source = { kind: "stage", jobId };
    let label: StagePropsParams["label"];
    if (beat.source.label) {
      const text = resolveTextRef(plan, beat.source.label, issues, beatIndex).text;
      label = { text, font: fontOf(template, stage.captionFont), size: round2(Math.min(rect.w, rect.h) * (portrait ? 0.075 : 0.085)) };
      checkPair(issues, beatIndex, "stage caption on paper", colors.caption, stage.paper);
    }
    const props: StagePropsParams = { component: "stage", revision: STAGE_REVISION, width: W, height: H, rect, scene: beat.source.scene, props: beat.source.props,
      colors, duration, seed, ...(label ? { label } : {}) };
    env.addJob(beatIndex, props, start, Math.max(1, Math.round(duration * fps)), "stage", "alpha", "normal");
    env.events.push({ at: start + 0.15, event: "stage", beatIndex });
  } else {
    source = { kind: beat.source.kind, assetId: beat.source.assetId, sourceStart: beat.source.kind === "clip" ? beat.source.sourceStart : 0 };
    env.commands.push(...insertClipCommands(env, clipId, beat.source.assetId, source.sourceStart, start, duration, layoutNorm, outline, rect, rotation, keys));
  }
  env.inserts.push({ beatIndex, layout: beat.layout, source, clipId, timelineStart: start, duration, rect, layoutNorm, outline, rotation, keys });

  // Frame parts around the insert: shadow / torn paper under it, border / divider over it.
  if (beat.layout !== "full" && cfg) {
    const frameParams = (part: "under" | "over"): InsertFrameParams => ({
      component: "insertFrame", revision: INSERT_FRAME_REVISION, width: W, height: H, layout: beat.layout as "pip" | "split" | "tornPaper", part, duration, rect,
      radius, rotation, slide, colors: { ...(cfg.border ? { border: palette[cfg.border] } : {}), paper: palette[cfg.paper], shadow: palette.derived.shadow, divider: palette[cfg.divider] },
      borderWidth: round2(cfg.borderWidth * short), shadowOpacity: cfg.shadow, seed });
    const frames = Math.max(1, Math.round(duration * fps));
    if (beat.layout === "pip" || beat.layout === "tornPaper") env.addJob(beatIndex, frameParams("under"), start, frames, "insertUnder", "alpha", "normal");
    if ((beat.layout === "pip" && cfg.border && cfg.borderWidth > 0) || beat.layout === "split") env.addJob(beatIndex, frameParams("over"), start, frames, "insertOver", "alpha", "normal");
  }
  if (beat.layout === "split") {
    // The main footage moves into the other half (centred on the subject when there is one).
    const subject = subjects[0];
    const focusY = subject ? (subject.y0 + subject.y1) / 2 / H : 0.5, focusX = subject ? (subject.x0 + subject.x1) / 2 / W : 0.5;
    const layout: ClipLayout = portrait
      ? { crop: { x: 0, y: round4(Math.min(0.5, Math.max(0, focusY - 0.25))), width: 1, height: 0.5 }, viewport: { x: 0, y: 0.5, width: 1, height: 0.5 } }
      : { crop: { x: round4(Math.min(0.5, Math.max(0, focusX - 0.25))), y: 0, width: 0.5, height: 1 }, viewport: { x: 0.5, y: 0, width: 0.5, height: 1 } };
    env.splits.push({ from: start, to: end, beatIndex, layout });
  }
  env.events.push({ at: start, event: "insert", beatIndex });
}

/** Cover-fit: the region of the source's contain-fitted canvas whose aspect matches the rect, centred. Normalized to the canvas. */
function coverLayout(rect: InsertRect, W: number, H: number, sourceAspect: number): ClipLayout {
  // Where the source sits on the canvas after contain-fit.
  const canvasAspect = W / H;
  const content = sourceAspect > canvasAspect ? { w: 1, h: canvasAspect / sourceAspect } : { w: sourceAspect / canvasAspect, h: 1 };
  const contentPx = { w: content.w * W, h: content.h * H };
  const rectAspect = rect.w / rect.h;
  const cropPx = contentPx.w / contentPx.h > rectAspect ? { w: contentPx.h * rectAspect, h: contentPx.h } : { w: contentPx.w, h: contentPx.w / rectAspect };
  const crop = { width: round6(cropPx.w / W), height: round6(cropPx.h / H) };
  return {
    crop: { x: round6((1 - crop.width) / 2), y: round6((1 - crop.height) / 2), ...crop },
    viewport: { x: round6(rect.x / W), y: round6(rect.y / H), width: round6(rect.w / W), height: round6(rect.h / H) },
  };
}

function insertClipCommands(env: PhaseBEnv, clipId: string, assetId: string, sourceStart: number, start: number, duration: number, layout: ClipLayout,
  outline: ReadonlyArray<readonly [number, number]>, rect: InsertRect, rotation: number, keys: StyleInsertPlacementV1["keys"]): EditorCommand[] {
  const base = { x: 0, y: 0, scale: 1, rotation, opacity: 1 };
  const clip: TimelineClip = {
    id: clipId, assetId, trackId: env.insertTrackId, timelineStart: start, sourceStart, duration, volume: 0, transform: { ...base },
    color: { ...DEFAULT_COLOR }, keyframes: [], layer: { ...DEFAULT_CLIP_LAYER }, layout,
  };
  const commands: EditorCommand[] = [{ type: "add_clip", clip }];
  if (outline.length > 4 || rotation) {
    // Mask paths live on the contain-fitted canvas (before the layout crop): map rect-local px through the crop.
    const toCanvas = ([x, y]: readonly [number, number]) => ({ x: round6(Math.min(1, Math.max(0, layout.crop.x + (x / rect.w) * layout.crop.width))),
      y: round6(Math.min(1, Math.max(0, layout.crop.y + (y / rect.h) * layout.crop.height))) });
    const mask: ClipMask = {
      id: `${clipId}-outline`, name: "Style insert outline", kind: "polygon", mode: "add", enabled: true, inverted: false, opacity: 1, feather: 0, expansion: 0,
      path: outline.map((point, index) => ({ id: `p${index + 1}`, ...toCanvas(point) })), keyframes: [], refine: { edgeShift: 0, contrast: 0.5, chatterReduction: 0 },
    };
    commands.push({ type: "add_clip_mask", clipId, mask });
  }
  for (const [index, key] of keys.entries()) {
    const keyframe: ClipKeyframe = { id: `${clipId}-pose-${index}`, time: key.time, easing: "linear",
      transform: { ...base, x: key.dx, y: key.dy, opacity: key.opacity }, color: { ...DEFAULT_COLOR } };
    commands.push({ type: "add_keyframe", clipId, keyframe });
  }
  return commands;
}
