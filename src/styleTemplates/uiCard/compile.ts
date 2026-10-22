import { contrastRatio } from "../../motionLibrary/svg/color";
import { clamp01, curve } from "../../motionLibrary/svg/easing";
import { styleJobKey, styleKey, type StyleComponentParams, type StyleJobTrack, type StyleRenderJobV1 } from "../jobs";
import { StylePlanError, STYLE_ENGINE_VERSION, type StyleTemplateV1, type StyleWordV1 } from "../types";
import {
  easeInOut, fitSize, promptBubbleHeight, UI_CARD_REVISION,
  type CardChromeParams, type ChapterChipParams, type CursorClickParams, type LowerThirdParams, type PromptBubbleParams, type ToolTagParams, type UiBackdropParams,
} from "./components";
import { designScale, S1V2 } from "./design";
import { uiCardGrid } from "./grid";
import { displayChars, phrasesFromSegments, segmentPhrases, spaceMixedScript, type SegmentPhrase } from "./phrases";
import { uiCardPlanSchemaV1, type UiCardPlanV1, type UiTextRefV1 } from "./plan";
import { followRoi, type RoiBox, type RoiHeat } from "./roi";

/**
 * compileUiCardPlanV1: an S1 v2 plan + measured screens → the frame layout of every moment.
 *
 * Grid (9:16, design px): chapter chip 118–194 · the UI card in 236–1186 (near-square 990 × 950, or a strip) ·
 * lower third 1260–1500 (subtitle, or the keyword lockup that replaces it, or step chips) · bottom ~400 px kept
 * empty for the platform UI. The card shows the screen recording cropped to its region of interest, followed by a
 * critically damped camera, punched in on key beats; swaps slide up and fade.
 *
 * Output: overlay jobs (the same render path as every style job), the card layers (per output frame: the source
 * window and the card's pose) that the product binds as a fixed-window clip and the review renderer draws, and
 * the phrase report (every spoken word shown, or listed as hidden with its reason).
 */

export const UI_CARD_COMPILE_SCHEMA_V1 = "editkin.ui-card-compile/v1" as const;

export interface UiCardShotInput {
  readonly clipId: string;
  readonly timelineStart: number;
  readonly duration: number;
  /** Source time (s) of the shot's first frame and the source's display size. */
  readonly sourceStart: number;
  readonly source: { readonly width: number; readonly height: number };
  /** Measured heat for [sourceStart, sourceStart + duration + tail] (frame 0 = sourceStart). */
  readonly heat: RoiHeat;
  /** Source seconds available after the shot's end (the outgoing card plays on under the swap). */
  readonly tail: number;
}

export interface UiCardProject {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly shots: readonly UiCardShotInput[];
}

export interface UiCardFrame {
  /** Source window (px) shown in the rect. */
  readonly cx: number; readonly cy: number; readonly w: number; readonly h: number;
  /** Pose of the whole card: px offset, scale about the rect centre, opacity. */
  readonly dx: number; readonly dy: number; readonly scale: number; readonly opacity: number;
}

export interface UiCardLayer {
  readonly kind: "card" | "callout";
  readonly id: string;
  readonly shotId: string;
  /** First output frame and the per-frame states. */
  readonly startFrame: number;
  readonly frames: readonly UiCardFrame[];
  /** Source time (s) at the layer's first frame. */
  readonly sourceStart: number;
  readonly rect: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
  readonly radius: number;
  /** Chrome stills (job ids) drawn under / over this layer with its pose. */
  readonly under: string;
  readonly over: string;
  /** Cards: frames [0, entry) slide in, [entry, body) follow inside a fixed window, [body, end) leave under the next card. */
  readonly spans?: { readonly entry: number; readonly body: number };
}

export interface UiCardIssue { readonly severity: "error" | "warning"; readonly code: string; readonly detail: string }

export interface UiCardCompileResultV1 {
  readonly schema: typeof UI_CARD_COMPILE_SCHEMA_V1;
  readonly engine: typeof STYLE_ENGINE_VERSION;
  readonly template: { readonly id: string; readonly revision: number };
  readonly ok: boolean;
  readonly frame: { readonly width: number; readonly height: number; readonly fps: number; readonly frames: number };
  readonly jobs: readonly StyleRenderJobV1[];
  readonly layers: readonly UiCardLayer[];
  readonly phrases: ReadonlyArray<{ readonly words: readonly [number, number]; readonly text: string; readonly mode: "subtitle" | "lockup" | "steps" | "hidden"; readonly at: number }>;
  readonly hiddenWords: ReadonlyArray<{ readonly word: number; readonly text: string; readonly reason: string }>;
  readonly editorial: ReadonlyArray<{ readonly text: string; readonly evidence: string }>;
  readonly issues: readonly UiCardIssue[];
}

const EPS = 1e-6;

export function compileUiCardPlanV1(template: StyleTemplateV1, planInput: unknown, project: UiCardProject): UiCardCompileResultV1 {
  const plan = uiCardPlanSchemaV1.parse(planInput);
  if (plan.template !== template.id) throw new StylePlanError("STYLE_TEMPLATE_MISMATCH", `plan names ${plan.template}, compiling with ${template.id}`);
  const { width: W, height: H, fps } = project;
  const grid = uiCardGrid(W, H), s = grid.s;
  void designScale;
  const accent = plan.palette?.accent ?? template.palette.accent, ink = plan.palette?.ink ?? template.palette.ink;
  const issues: UiCardIssue[] = [];
  const jobs: StyleRenderJobV1[] = [];
  const layers: UiCardLayer[] = [];
  const editorial: Array<{ text: string; evidence: string }> = [];
  if (contrastRatio(ink, accent) < 4.5) issues.push({ severity: "error", code: "UI_CARD_PALETTE", detail: `ink on accent is ${contrastRatio(ink, accent).toFixed(2)}:1` });

  // Words as shown (recognizer corrections are listed for the seal gate).
  const words: StyleWordV1[] = plan.words.map(word => ({ ...word }));
  for (const correction of plan.corrections ?? []) {
    if (!words[correction.word]) throw new StylePlanError("STYLE_WORD_RANGE", `correction for missing word ${correction.word}`);
    editorial.push({ text: `${words[correction.word].text} → ${correction.text}`, evidence: correction.reason });
    words[correction.word] = { ...words[correction.word], text: correction.text };
  }
  const textOf = (ref: UiTextRefV1, evidence: string): string => {
    if ("wordRange" in ref) {
      const [a, b] = ref.wordRange;
      if (b >= words.length) throw new StylePlanError("STYLE_WORD_RANGE", `word ${b} does not exist`);
      return words.slice(a, b + 1).map(word => word.text).join("");
    }
    editorial.push({ text: ref.text, evidence });
    return ref.text;
  };

  const shots = project.shots;
  const totalSeconds = shots.reduce((end, shot) => Math.max(end, shot.timelineStart + shot.duration), 0);
  const totalFrames = Math.round(totalSeconds * fps);
  const frameOf = (seconds: number) => Math.round(seconds * fps);
  const addJob = (id: string, params: StyleComponentParams, startFrame: number, frameCount: number, track: StyleJobTrack, output: StyleRenderJobV1["output"],
    extra: Pick<StyleRenderJobV1, "pose" | "pivot"> = {}) => {
    const key = styleJobKey(params.component, params, frameCount, fps);
    jobs.push(Object.freeze({ id, key, component: params.component, params, timelineStart: startFrame / fps, startFrame, frameCount: Math.max(1, frameCount), fps,
      output, blendMode: "normal" as const, track, beatIndex: jobs.length, ...extra }));
    return id;
  };

  // Backdrop: one still under everything.
  const backdrop: UiBackdropParams = { component: "uiBackdrop", revision: UI_CARD_REVISION, width: W, height: H, seed: 7 };
  addJob("ui-backdrop", backdrop, 0, totalFrames, "backdrop", "still");

  // ---------------------------------------------------------------------------
  // Cards
  // ---------------------------------------------------------------------------
  const C = S1V2.card, M = S1V2.motion;
  const keyStarts = plan.keys.filter(key => key.punch).map(key => words[key.keyword[0]]?.start ?? Infinity);
  const shotPlans = new Map(plan.shots.map(shot => [shot.id, shot]));
  const cardRects = new Map<string, UiCardLayer["rect"]>();
  shots.forEach((shot, index) => {
    const shotPlan: { card: "square" | "wide"; follow: boolean; region?: readonly number[]; zoom?: number } = shotPlans.get(shot.clipId) ?? { card: "square", follow: true };
    const content = shot.heat.content;
    const hasBubble = plan.bubbles.some(bubble => bubble.shot === shot.clipId);
    let rect: UiCardLayer["rect"], windowW: number, windowH: number, fixed: RoiBox | undefined;
    const regionPx = shotPlan.region ? { x0: shotPlan.region[0] * shot.source.width, y0: shotPlan.region[1] * shot.source.height,
      x1: shotPlan.region[2] * shot.source.width, y1: shotPlan.region[3] * shot.source.height } : undefined;
    if (shotPlan.card === "wide") {
      if (!regionPx) throw new StylePlanError("UI_CARD_WIDE_REGION", `wide card ${shot.clipId} needs a region`);
      const aspect = (regionPx.x1 - regionPx.x0) / (regionPx.y1 - regionPx.y0);
      const h = Math.max(grid.card.wideMinH, Math.min(grid.card.squareH, grid.card.w / aspect));
      const bubbleLines = Math.max(0, ...plan.bubbles.filter(bubble => bubble.shot === shot.clipId).map(bubble => bubble.lines.length));
      const y = hasBubble ? grid.bubble.y + promptBubbleHeight(bubbleLines, s) + grid.bubble.cardGap : (grid.card.bandY0 + grid.card.bandY1) / 2 - h / 2;
      rect = { x: grid.card.x, y, w: grid.card.w, h };
      const cardAspect = rect.w / rect.h;
      windowW = regionPx.x1 - regionPx.x0; windowH = windowW / cardAspect;
      if (windowH < regionPx.y1 - regionPx.y0) { windowH = regionPx.y1 - regionPx.y0; windowW = windowH * cardAspect; }
      fixed = regionPx;
    } else {
      rect = { x: grid.card.x, y: grid.card.squareY, w: grid.card.w, h: grid.card.squareH };
      const cardAspect = rect.w / rect.h, cw = content.x1 - content.x0, ch = content.y1 - content.y0;
      windowH = Math.min(ch, cw / cardAspect) * 0.9 / (shotPlan.zoom ?? 1); windowW = windowH * cardAspect;
      fixed = shotPlan.follow ? regionPx : (regionPx ?? content);
    }
    cardRects.set(shot.clipId, rect);
    const radius = (shotPlan.card === "wide" ? C.wideRadius : C.radius) * s;
    const next = shots[index + 1];
    const startFrame = frameOf(shot.timelineStart);
    const bodyFrames = frameOf(shot.timelineStart + shot.duration) - startFrame;
    const exitFrames = next ? Math.min(Math.round(M.exit * fps), Math.max(0, Math.floor(shot.tail * fps))) : 0;
    const frames = bodyFrames + exitFrames;
    const follow = followRoi(shot.heat, { width: windowW, height: windowH, fps, frames, ...(fixed ? { fixed } : {}) });
    const first = index === 0;
    // The window holds still while the card slides in and while it leaves: the product binds those spans as
    // clips with a static mask (the window moves only inside the fixed-window body), so the preview does the same.
    const entryFrames = first ? 0 : Math.min(bodyFrames - 1, Math.round(M.enter * fps));
    const framing = follow.map((window, i) => {
      const time = shot.timelineStart + i / fps;
      // Punch-in toward the ROI centre on key beats (eased in, held, eased back), never during the entry.
      let zoom = 1;
      for (const at of keyStarts) {
        if (at < shot.timelineStart - EPS || at > shot.timelineStart + shot.duration) continue;
        const k = time - Math.max(at, shot.timelineStart + entryFrames / fps);
        if (k < 0) continue;
        const P = M.punch;
        const z = k < P.attack ? curve("expoOut", k / P.attack) : k < P.attack + P.hold ? 1 : 1 - easeInOut((k - P.attack - P.hold) / P.release);
        zoom = Math.max(zoom, 1 + (P.scale - 1) * clamp01(z));
      }
      const w = window.w / zoom, h = window.h / zoom;
      return { cx: Math.min(Math.max(window.cx, content.x0 + w / 2), content.x1 - w / 2), cy: Math.min(Math.max(window.cy, content.y0 + h / 2), content.y1 - h / 2), w, h };
    });
    const states: UiCardFrame[] = framing.map((_, i) => {
      const t = i / fps;
      const view = framing[i < entryFrames ? entryFrames : i >= bodyFrames ? bodyFrames - 1 : i];
      // Entry: slide up + fade; exit (under the next card): fade + settle.
      const e = curve("expoOut", clamp01(t / M.enter));
      const x = i >= bodyFrames ? clamp01((i - bodyFrames + 1) / Math.max(1, exitFrames)) : 0;
      const exitE = curve("quintOut", x);
      // Settled values snap exactly (the eases land within 1e-9, and "at rest" lets renderers reuse the still chrome).
      const dy = first ? 0 : (1 - e) * M.enterDy * s, scale = 1 - (1 - M.exitScale) * exitE, opacity = (first ? Math.min(1, t / 0.3) : e) * (1 - exitE);
      return { ...view, dx: 0, dy: Math.abs(dy) < 1e-3 ? 0 : dy, scale: Math.abs(scale - 1) < 1e-6 ? 1 : scale, opacity: opacity > 0.9995 ? 1 : opacity };
    });
    const chrome = (part: "under" | "over") => {
      const params: CardChromeParams = { component: "cardChrome", revision: UI_CARD_REVISION, width: W, height: H, part, rect, radius,
        shadows: C.shadows.map(shadow => ({ blur: shadow.blur * s, dy: shadow.dy * s, alpha: shadow.alpha })), rim: { width: C.rim.width * s, alpha: C.rim.alpha } };
      const pivot = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
      // The span under the next card is its own clip on a lower track (the incoming card stays on top).
      if (frames > bodyFrames) addJob(`card-${part}-tail-${shot.clipId}`, params, startFrame + bodyFrames, frames - bodyFrames, part === "under" ? "cardUnderTail" : "cardOverTail", "still",
        { pose: poseKeys(states.slice(bodyFrames), fps), pivot });
      return addJob(`card-${part}-${shot.clipId}`, params, startFrame, bodyFrames, part === "under" ? "cardUnder" : "cardOver", "still",
        { pose: poseKeys(states.slice(0, bodyFrames), fps), pivot });
    };
    layers.push({ kind: "card", id: `card-${shot.clipId}`, shotId: shot.clipId, startFrame, frames: states, sourceStart: shot.sourceStart, rect, radius,
      under: chrome("under"), over: chrome("over"), spans: { entry: entryFrames, body: bodyFrames } });
  });

  const cardAt = (time: number) => layers.filter(layer => layer.kind === "card").find(layer => {
    const i = Math.round(time * fps) - layer.startFrame;
    return i >= 0 && i < layer.frames.length && (layer.frames[i].opacity > 0.5 || i < layer.frames.length - Math.round(M.exit * fps));
  });
  /** Output px of a source point (source px) in a card layer at frame i. */
  const project2 = (layer: UiCardLayer, i: number, sx: number, sy: number) => {
    const f = layer.frames[Math.max(0, Math.min(layer.frames.length - 1, i))];
    const k = layer.rect.w / f.w, rcx = layer.rect.x + layer.rect.w / 2, rcy = layer.rect.y + layer.rect.h / 2;
    return { x: rcx + ((sx - f.cx) * k) * f.scale + f.dx, y: rcy + ((sy - f.cy) * k) * f.scale + f.dy };
  };

  // ---------------------------------------------------------------------------
  // Callouts: a UI detail pops out of the card (crop × scale, own shadow).
  // ---------------------------------------------------------------------------
  plan.callouts.forEach((callout, index) => {
    const shot = shots.find(candidate => candidate.clipId === callout.shot);
    const card = layers.find(layer => layer.kind === "card" && layer.shotId === callout.shot);
    if (!shot || !card) { issues.push({ severity: "error", code: "UI_CARD_CALLOUT_SHOT", detail: `callout ${index} names unknown shot ${callout.shot}` }); return; }
    const region = { x0: callout.region[0] * shot.source.width, y0: callout.region[1] * shot.source.height, x1: callout.region[2] * shot.source.width, y1: callout.region[3] * shot.source.height };
    const startFrame = frameOf(callout.at), endFrame = frameOf(callout.until), frames = endFrame - startFrame;
    if (frames < Math.round(0.8 * fps)) { issues.push({ severity: "error", code: "UI_CARD_CALLOUT_SHORT", detail: `callout ${index} needs at least 0.8 s` }); return; }
    const i0 = startFrame - card.startFrame;
    const a = project2(card, i0, region.x0, region.y0), b = project2(card, i0, region.x1, region.y1);
    const home = { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
    // Target: scaled up and lifted toward the frame centre, kept inside the card band.
    const w = home.w * callout.scale, h = home.h * callout.scale;
    const band = grid.card.calloutBand;
    // Lifted clearly off its home toward the card's centre, so it reads as a separate card above the screen.
    const cardCx = card.rect.x + card.rect.w / 2, cardCy = card.rect.y + card.rect.h / 2;
    const tx = Math.min(Math.max(home.x + home.w / 2 + (cardCx - (home.x + home.w / 2)) * 0.6 - w / 2, band.x0), band.x1 - w);
    const ty = Math.min(Math.max(home.y + home.h / 2 + (cardCy - (home.y + home.h / 2)) * 0.4 - h / 2, band.y0), band.y1 - h);
    const rect = { x: tx, y: ty, w, h };
    const states: UiCardFrame[] = Array.from({ length: frames }, (_, i) => {
      const t = i / fps, outP = clamp01((t - (frames / fps - 0.3)) / 0.3);
      const p = clamp01(t / 0.5);
      // Grow out of the card with a slight overshoot (≤ 1.06), then return home on the way out.
      const grow = p < 0.6 ? curve("quintOut", p / 0.6) * 1.06 : 1.06 - 0.06 * easeInOut((p - 0.6) / 0.4);
      const g = grow * (1 - curve("quintOut", outP));
      const scale = (home.w + (w - home.w) * g) / w;
      const cx = home.x + home.w / 2 + (tx + w / 2 - (home.x + home.w / 2)) * Math.min(1, g), cy = home.y + home.h / 2 + (ty + h / 2 - (home.y + home.h / 2)) * Math.min(1, g);
      return { cx: (region.x0 + region.x1) / 2, cy: (region.y0 + region.y1) / 2, w: region.x1 - region.x0, h: region.y1 - region.y0,
        dx: cx - (tx + w / 2), dy: cy - (ty + h / 2), scale, opacity: Math.min(1, t / 0.08) * (1 - curve("snapIn", clamp01((outP - 0.6) / 0.4))) };
    });
    const radius = S1V2.callout.radius * s;
    const chrome = (part: "under" | "over") => addJob(`callout-${part}-${index}`, { component: "cardChrome", revision: UI_CARD_REVISION, width: W, height: H, part, rect, radius,
      shadows: S1V2.callout.shadows.map(shadow => ({ blur: shadow.blur * s, dy: shadow.dy * s, alpha: shadow.alpha })), rim: { width: S1V2.callout.rim.width * s, alpha: S1V2.callout.rim.alpha } },
    startFrame, frames, part === "under" ? "calloutUnder" : "calloutOver", "still", { pose: poseKeys(states, fps), pivot: { x: rect.x + w / 2, y: rect.y + h / 2 } });
    layers.push({ kind: "callout", id: `callout-${index}`, shotId: callout.shot, startFrame, frames: states,
      sourceStart: shot.sourceStart + (callout.at - shot.timelineStart), rect, radius, under: chrome("under"), over: chrome("over") });
  });

  // ---------------------------------------------------------------------------
  // Chapter chip, tool tags, prompt bubbles, clicks
  // ---------------------------------------------------------------------------
  plan.chapters.forEach((chapter, index) => {
    const next = plan.chapters[index + 1];
    const startFrame = frameOf(chapter.at), endFrame = next ? frameOf(next.at) : totalFrames;
    const label = textOf(chapter.label, `chapter ${chapter.number}`);
    const params: ChapterChipParams = { component: "chapterChip", revision: UI_CARD_REVISION, width: W, height: H, number: chapter.number, label, accent,
      scale: s, cx: grid.chip.cx, y: grid.chip.y,
      duration: (endFrame - startFrame) / fps + (next ? 0.3 : 0), ...(next ? { exitAt: (endFrame - startFrame) / fps } : {}) };
    addJob(`chip-${chapter.number}`, params, startFrame, endFrame - startFrame + (next ? Math.round(0.3 * fps) : 0), "overlay", "alpha");
  });
  plan.tags.forEach((tag, index) => {
    const card = cardAt(tag.at + 0.02);
    if (!card) { issues.push({ severity: "error", code: "UI_CARD_TAG_NO_CARD", detail: `tag ${index} at ${tag.at}s has no card` }); return; }
    const startFrame = frameOf(tag.at);
    const cardEnd = card.startFrame + card.frames.length - Math.round(M.exit * fps);
    const endFrame = Math.min(tag.until === undefined ? cardEnd : frameOf(tag.until), cardEnd);
    const follow = card.frames.slice(startFrame - card.startFrame, endFrame - card.startFrame + Math.round(0.2 * fps))
      .map((frame, i) => ({ t: i / fps, dx: frame.dx, dy: frame.dy, opacity: frame.opacity }));
    const params: ToolTagParams = { component: "toolTag", revision: UI_CARD_REVISION, width: W, height: H, text: textOf(tag.text, "tool name"), accent, ink,
      x: card.rect.x + S1V2.tag.dx * s, y: card.rect.y + S1V2.tag.dy * s, duration: (endFrame - startFrame) / fps + 0.2, exitAt: (endFrame - startFrame) / fps,
      follow: thinKeys(follow), scale: s };
    addJob(`tag-${index}`, params, startFrame, endFrame - startFrame + Math.round(0.2 * fps), "overlay", "alpha");
  });
  plan.bubbles.forEach((bubble, index) => {
    editorial.push({ text: bubble.lines.join(""), evidence: bubble.evidence });
    const startFrame = frameOf(bubble.at), endFrame = frameOf(bubble.until);
    const params: PromptBubbleParams = { component: "promptBubble", revision: UI_CARD_REVISION, width: W, height: H,
      ...(bubble.label ? { label: textOf(bubble.label, bubble.evidence) } : {}), lines: bubble.lines,
      x: grid.bubble.x, y: grid.bubble.y, w: grid.bubble.w, duration: (endFrame - startFrame) / fps + 0.25, exitAt: (endFrame - startFrame) / fps, scale: s };
    const rect = cardRects.get(bubble.shot);
    if (rect && grid.bubble.y + promptBubbleHeight(bubble.lines.length, s) > rect.y - 40 * s) {
      issues.push({ severity: "warning", code: "UI_CARD_BUBBLE_OVERLAP", detail: `bubble ${index} reaches the card` });
    }
    addJob(`bubble-${index}`, params, startFrame, endFrame - startFrame + Math.round(0.25 * fps), "overlay", "alpha");
  });
  plan.clicks.forEach((click, index) => {
    editorial.push({ text: `click @${click.at}s`, evidence: click.evidence });
    const card = layers.find(layer => layer.kind === "card" && layer.shotId === click.shot);
    const shot = shots.find(candidate => candidate.clipId === click.shot);
    if (!card || !shot) { issues.push({ severity: "error", code: "UI_CARD_CLICK_SHOT", detail: `click ${index} names unknown shot ${click.shot}` }); return; }
    const lead = 0.6, hold = 0.9;
    const startFrame = Math.max(card.startFrame, frameOf(click.at - lead)), frames = Math.round((lead + hold) * fps);
    const sx = click.point[0] * shot.source.width, sy = click.point[1] * shot.source.height;
    const track = Array.from({ length: Math.ceil(frames / 2) + 1 }, (_, j) => {
      const i = Math.min(frames, j * 2), point = project2(card, startFrame - card.startFrame + i, sx, sy);
      return { t: i / fps, x: Math.round(point.x * 10) / 10, y: Math.round(point.y * 10) / 10 };
    });
    const params: CursorClickParams = { component: "cursorClick", revision: UI_CARD_REVISION, width: W, height: H, accent, ink, duration: frames / fps,
      clickAt: click.at - startFrame / fps, track, scale: s };
    addJob(`click-${index}`, params, startFrame, frames, "overlay", "alpha");
  });

  // ---------------------------------------------------------------------------
  // Lower third: complete phrases (subtitles), key lockups, step chips
  // ---------------------------------------------------------------------------
  const L = S1V2.lower;
  const at = { subtitleCx: grid.lower.subtitleCx, subtitleY: grid.lower.subtitleY, lockupCx: grid.lower.lockupCx, leadY: grid.lower.leadY, keywordY: grid.lower.keywordY, stepsY: grid.lower.stepsY };
  const phrases = buildPhrases(plan);
  const phraseReport: Array<{ words: [number, number]; text: string; mode: "subtitle" | "lockup" | "steps" | "hidden"; at: number }> = [];
  const hiddenWords: Array<{ word: number; text: string; reason: string }> = [];
  const stepsSpans = plan.steps.map(steps => [steps.items[0].wordRange[0], steps.items[steps.items.length - 1].wordRange[1]] as const);
  // Lower-third entries in time order: subtitle / lockup (one phrase each), steps (a run of phrases).
  type Entry = { kind: "subtitle"; phrase: Phrase } | { kind: "lockup"; phrase: Phrase; key: readonly [number, number]; lead: string; keyword: string; tail: string }
    | { kind: "steps"; index: number; phrases: Phrase[] };
  const entries: Entry[] = [];
  for (const phrase of phrases) {
    const steps = stepsSpans.findIndex(([s0, s1]) => phrase.words[0] <= s1 && phrase.words[1] >= s0);
    if (steps >= 0 && phrase.words[0] < stepsSpans[steps][0]) {
      // The words before the first enumerated item stay a subtitle ("你可以看到"), the rest goes to the chips.
      const cut = phrase.offsets.findIndex(offset => offset.word >= stepsSpans[steps][0]);
      const at = phrase.offsets[cut].from;
      const head = phrase.offsets.slice(0, cut), rest = phrase.offsets.slice(cut);
      entries.push({ kind: "subtitle", phrase: { text: phrase.text.slice(0, at).trim(), offsets: head, words: [head[0].word, head[head.length - 1].word],
        start: phrase.start, end: words[head[head.length - 1].word].end } });
      entries.push({ kind: "steps", index: steps, phrases: [{ text: phrase.text.slice(at).trim(), offsets: rest.map(offset => ({ ...offset, from: offset.from - at, to: offset.to - at })),
        words: [rest[0].word, rest[rest.length - 1].word], start: words[rest[0].word].start, end: phrase.end }] });
      continue;
    }
    if (steps >= 0) {
      const last = entries[entries.length - 1];
      if (last?.kind === "steps" && last.index === steps) last.phrases.push(phrase); else entries.push({ kind: "steps", index: steps, phrases: [phrase] });
      continue;
    }
    const key = plan.keys.find(candidate => candidate.keyword[0] >= phrase.words[0] && candidate.keyword[1] <= phrase.words[1]);
    const k0 = key && phrase.offsets.find(offset => offset.word === key.keyword[0]), k1 = key && phrase.offsets.find(offset => offset.word === key.keyword[1]);
    if (!key || !k0 || !k1 || k1.to <= k0.from) { entries.push({ kind: "subtitle", phrase }); continue; }
    const lead = phrase.text.slice(0, k0.from).trim(), keyword = phrase.text.slice(k0.from, k1.to).trim(), tail = phrase.text.slice(k1.to).trim();
    if (displayChars(tail) <= 3) { entries.push({ kind: "lockup", phrase, key: key.keyword, lead, keyword, tail }); continue; }
    // A long tail becomes the next subtitle (the lockup ends on its keyword).
    const cut = phrase.offsets.findIndex(offset => offset.word === key.keyword[1]) + 1;
    const head: Phrase = { ...phrase, text: phrase.text.slice(0, k1.to).trim(), offsets: phrase.offsets.slice(0, cut), words: [phrase.words[0], key.keyword[1]], end: words[key.keyword[1]].end };
    const rest = phrase.offsets.slice(cut);
    entries.push({ kind: "lockup", phrase: head, key: key.keyword, lead, keyword, tail: "" });
    if (rest.length) entries.push({ kind: "subtitle", phrase: { text: tail, offsets: rest.map(offset => ({ ...offset, from: Math.max(0, offset.from - k1.to), to: Math.max(0, offset.to - k1.to) })),
      words: [rest[0].word, rest[rest.length - 1].word], start: words[rest[0].word].start, end: phrase.end } });
  }
  const entryStart = (entry: Entry) => (entry.kind === "steps" ? entry.phrases[0].start : entry.phrase.start);
  const entryEnd = (entry: Entry) => (entry.kind === "steps" ? Math.max(...entry.phrases.map(p => p.end)) : entry.phrase.end);
  let lastKeyAt = -Infinity, lag = 0;
  entries.forEach((entry, index) => {
    const next = entries[index + 1];
    const start = Math.max(0, entryStart(entry) - 0.06, lag);
    const nextStart = next ? entryStart(next) - 0.06 : totalSeconds;
    const startFrame = frameOf(start);
    const id = `lower-${String(index).padStart(3, "0")}`;
    if (entry.kind === "subtitle") {
      // Gone (fade 0.14 s) by the time the next line rises in: lines never stack.
      const exit = Math.max(start + 0.5, Math.min(nextStart - S1V2.motion.subtitleOut, entryEnd(entry) + 0.7));
      const offs = entry.phrase.offsets;
      const breaks = offs.slice(0, -1).map((offset, k) => ({ at: offset.to, pause: Math.max(0, words[offs[k + 1].word].start - words[offset.word].end),
        tight: [...words[offset.word].text].length === 1 && [...words[offs[k + 1].word].text].length === 1,
        single: ([...words[offset.word].text].length === 1 ? 1 : 0) + ([...words[offs[k + 1].word].text].length === 1 ? 1 : 0) }));
      const { size, lines } = setSubtitle(entry.phrase.text, L.subtitle.size * s, grid.lower.subtitleMaxWidth, breaks);
      const params: LowerThirdParams = { component: "lowerThird", revision: UI_CARD_REVISION, width: W, height: H, accent, ink, scale: s, at,
        duration: exit - start + S1V2.motion.subtitleOut, exitAt: exit - start, content: { mode: "subtitle", text: entry.phrase.text, size, ...(lines.length > 1 ? { lines } : {}) } };
      addJob(id, params, startFrame, Math.max(2, Math.floor((exit - start + S1V2.motion.subtitleOut) * fps)), "overlay", "alpha");
      phraseReport.push({ words: [entry.phrase.words[0], entry.phrase.words[1]], text: entry.phrase.text, mode: "subtitle", at: start });
      lag = 0;
    } else if (entry.kind === "lockup") {
      const keywordStart = words[entry.key[0]].start;
      if (keywordStart - lastKeyAt < 3 - EPS) issues.push({ severity: "warning", code: "UI_CARD_KEY_DENSITY", detail: `keyword "${entry.keyword}" lands ${(keywordStart - lastKeyAt).toFixed(1)} s after the previous one (>= 3 s)` });
      lastKeyAt = keywordStart;
      // The keyword holds at least ~1.1 s; the next subtitle may wait up to 0.5 s for it.
      const natural = Math.min(Math.max(keywordStart + 1.25, entryEnd(entry) + 0.45), nextStart - S1V2.motion.subtitleOut);
      const exit = Math.max(natural, Math.min(keywordStart + 1.1, nextStart + 0.5));
      const leadSize = fitSize(entry.lead || " ", { font: "display", weight: L.lead.weight }, L.lead.size * s, L.lead.tracking, grid.lower.lockupMaxWidth);
      const tailWidth = entry.tail ? leadSize * (displayChars(entry.tail) + 0.4) : 0;
      const keywordSize = fitSize(entry.keyword, { font: "display", weight: L.keyword.weight }, L.keyword.size * s, L.keyword.tracking, grid.lower.lockupMaxWidth - tailWidth);
      const params: LowerThirdParams = { component: "lowerThird", revision: UI_CARD_REVISION, width: W, height: H, accent, ink, scale: s, at,
        duration: exit - start + 0.25, exitAt: exit - start,
        content: { mode: "lockup", lead: entry.lead, leadSize, keyword: entry.keyword, keywordSize, keywordAt: Math.max(0, keywordStart - start), ...(entry.tail ? { tail: entry.tail } : {}) } };
      addJob(id, params, startFrame, Math.round((exit - start + 0.25) * fps), "overlay", "alpha");
      phraseReport.push({ words: [entry.phrase.words[0], entry.phrase.words[1]], text: entry.phrase.text, mode: "lockup", at: start });
      lag = exit + S1V2.motion.subtitleOut + S1V2.motion.stagger;
    } else {
      const steps = plan.steps[entry.index];
      const lastItem = words[steps.items[steps.items.length - 1].wordRange[1]].end;
      const exit = Math.max(start + 1, Math.min(nextStart - S1V2.motion.subtitleOut, Math.max(lastItem + 1.0, entryEnd(entry) + 0.3)));
      const items = steps.items.map((item, i) => ({ number: String(i + 1).padStart(2, "0"), label: textOf(item, "steps"), at: words[item.wordRange[0]].start - start }));
      const params: LowerThirdParams = { component: "lowerThird", revision: UI_CARD_REVISION, width: W, height: H, accent, ink, scale: s, at, duration: exit - start + 0.2, exitAt: exit - start,
        content: { mode: "steps", items, scale: stepsScale(items, s, grid.lower.lockupMaxWidth) } };
      addJob(id, params, startFrame, Math.round((exit - start + 0.2) * fps), "overlay", "alpha");
      for (const phrase of entry.phrases) {
        phraseReport.push({ words: [phrase.words[0], phrase.words[1]], text: phrase.text, mode: "steps", at: phrase.start });
        for (let w = phrase.words[0]; w <= phrase.words[1]; w += 1) {
          if (!steps.items.some(item => w >= item.wordRange[0] && w <= item.wordRange[1])) hiddenWords.push({ word: w, text: words[w].text, reason: "spoken between enumerated items (the step chips show the items)" });
        }
      }
      lag = 0;
    }
  });

  jobs.sort((x, y) => x.startFrame - y.startFrame || x.id.localeCompare(y.id));
  return Object.freeze({
    schema: UI_CARD_COMPILE_SCHEMA_V1, engine: STYLE_ENGINE_VERSION, template: { id: template.id, revision: template.revision },
    ok: !issues.some(issue => issue.severity === "error"), frame: { width: W, height: H, fps, frames: totalFrames },
    jobs, layers, phrases: phraseReport, hiddenWords, editorial, issues,
  });
}

/** Pose keys of a layer for its chrome stills: every frame where the pose changes, thinned where it holds. */
function poseKeys(states: readonly UiCardFrame[], fps: number): Array<{ t: number; dx: number; dy: number; scale: number; opacity: number }> {
  const keys: Array<{ t: number; dx: number; dy: number; scale: number; opacity: number }> = [];
  states.forEach((state, i) => {
    const key = { t: i / fps, dx: Math.round(state.dx * 100) / 100, dy: Math.round(state.dy * 100) / 100, scale: Math.round(state.scale * 1e5) / 1e5, opacity: Math.round(state.opacity * 1e4) / 1e4 };
    const last = keys[keys.length - 1], before = keys[keys.length - 2];
    const same = (p: typeof key, q: typeof key) => p.dx === q.dx && p.dy === q.dy && p.scale === q.scale && p.opacity === q.opacity;
    if (last && before && same(last, key) && same(before, key)) keys[keys.length - 1] = key;
    else keys.push(key);
  });
  return keys;
}

function thinKeys<T extends { t: number; dx: number; dy: number; opacity: number }>(keys: readonly T[]): T[] {
  const out: T[] = [];
  keys.forEach(key => {
    const last = out[out.length - 1], before = out[out.length - 2];
    const same = (p: T, q: T) => Math.abs(p.dx - q.dx) < 0.01 && Math.abs(p.dy - q.dy) < 0.01 && Math.abs(p.opacity - q.opacity) < 1e-3;
    if (last && before && same(last, key) && same(before, key)) out[out.length - 1] = key;
    else out.push(key);
  });
  return out;
}

export const uiCardPlanKey = (plan: UiCardPlanV1) => styleKey(plan);

type Phrase = SegmentPhrase;

const SUBTITLE_FONT = { font: "display" as const, weight: S1V2.lower.subtitle.weight };

/** One line when it fits; else two balanced lines broken after a recognized word (never inside one, never before punctuation), then fit. */
function setSubtitle(text: string, size: number, maxWidth: number, breaks: ReadonlyArray<{ at: number; pause: number; tight: boolean; single: number }> = []): { size: number; lines: string[] } {
  const tracking = S1V2.lower.subtitle.tracking;
  if (fitSize(text, SUBTITLE_FONT, size, tracking, maxWidth) >= size * 0.92) return { size: fitSize(text, SUBTITLE_FONT, size, tracking, maxWidth), lines: [text] };
  const chars = [...text];
  // Break candidates: after a recognized word; a pause or a comma makes a good break, splitting two one-character words a bad one.
  const allowed = new Map(breaks.map(item => [[...text.slice(0, item.at)].length, item]));
  let best: string[] | undefined, bestScore = Infinity;
  for (let i = 2; i < chars.length - 1; i += 1) {
    const at = allowed.get(i);
    if (allowed.size && !at) continue;
    // Never between two Latin words ("Claude | Code"); one-character words usually bind to a neighbour.
    const prev = text.slice(0, [...chars.slice(0, i)].join("").length).trimEnd().slice(-1), next = chars.slice(i).join("").trimStart().slice(0, 1);
    if (/[A-Za-z0-9]/.test(prev) && /[A-Za-z0-9]/.test(next)) continue;
    const punct = /[、，,]/.test(chars[i - 1]) ? -4 : 0, pause = at ? -Math.min(0.4, at.pause) * 10 : 0, tight = at?.tight ? 3 : 0, single = (at?.single ?? 0) * 1.5;
    const fits = fitSize(chars.slice(0, i).join(""), SUBTITLE_FONT, size, tracking, maxWidth) >= size * 0.85 && fitSize(chars.slice(i).join(""), SUBTITLE_FONT, size, tracking, maxWidth) >= size * 0.85 ? 0 : 6;
    const a = chars.slice(0, i).join("").trim(), b = chars.slice(i).join("").trim();
    if (/[A-Za-z0-9]/.test(chars[i - 1]) && /[A-Za-z0-9]/.test(chars[i])) continue;
    if (/^[，、。！？,.!?」）)]/.test(b)) continue;
    const score = Math.abs(displayChars(a) - displayChars(b)) * 0.5 + (chars[i - 1] === " " || chars[i] === " " ? -0.5 : 0) + punct + pause + tight + single + fits;
    if (score < bestScore) { bestScore = score; best = [a, b]; }
  }
  if (!best) return { size: fitSize(text, SUBTITLE_FONT, size, tracking, maxWidth), lines: [text] };
  return { size: Math.min(...best.map(line => fitSize(line, SUBTITLE_FONT, size, tracking, maxWidth))), lines: best };
}

/** Step chips shrink together so the row fits the zone. */
function stepsScale(items: ReadonlyArray<{ number: string; label: string }>, s: number, maxWidth: number): number {
  const S = S1V2.lower.steps;
  const width = items.reduce((sum, item) => sum + (S.padX * 2 + 14) * s + (displayChars(item.number) * 0.6 * S.numberSize + displayChars(item.label) * S.size) * s, 0) + S.gap * s * (items.length - 1);
  return Math.min(1, maxWidth / width);
}

/** Phrases: the recognizer's complete clauses when the plan has its segments, else pause-based phrases of the timed words. Corrections applied. */
function buildPhrases(plan: UiCardPlanV1): Phrase[] {
  const corrected = new Map((plan.corrections ?? []).map(correction => [correction.word, correction.text]));
  const original = plan.words;
  let phrases: Phrase[];
  if (plan.segments?.length) phrases = phrasesFromSegments(plan.segments, original);
  else {
    phrases = segmentPhrases(original, { maxChars: 16 }).map(([a, b]) => {
      let text = "";
      const offsets: Array<{ word: number; from: number; to: number }> = [];
      for (let w = a; w <= b; w += 1) { offsets.push({ word: w, from: text.length, to: text.length + original[w].text.length }); text += original[w].text; }
      return { text, offsets, words: [a, b] as const, start: original[a].start, end: original[b].end };
    });
  }
  if (!corrected.size) return phrases;
  return phrases.map(phrase => {
    let text = phrase.text;
    let offsets = phrase.offsets.map(offset => ({ ...offset }));
    for (const offset of [...phrase.offsets].reverse()) {
      const replacement = corrected.get(offset.word);
      if (replacement === undefined || offset.to <= offset.from) continue;
      const delta = replacement.length - (offset.to - offset.from);
      text = text.slice(0, offset.from) + replacement + text.slice(offset.to);
      offsets = offsets.map(other => other.from >= offset.to ? { ...other, from: other.from + delta, to: other.to + delta } : other.word === offset.word ? { ...other, to: other.to + delta } : other);
    }
    return { ...phrase, text, offsets };
  });
}
