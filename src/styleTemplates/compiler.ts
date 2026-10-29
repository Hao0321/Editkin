import type { EditorCommand } from "../domain/commandTypes";
import { DEFAULT_COLOR } from "../domain/types";
import type { MediaAsset, TimelineClip, Transform2D } from "../domain/types";
import { mostContrasting } from "../motionLibrary/svg/color";
import type { MotionFontSelector } from "../motionLibrary/svg/glyphs";
import { fitFontSize } from "../motionLibrary/svg/glyphs";
import { KINETIC_CAPTION_REVISION, layoutKineticCaption, type CaptionWord, type KeywordFill, type KineticCaptionParams, type KineticCaptionTypography } from "./components/kineticCaption";
import { LIGHT_LEAK_REVISION, type LightLeakParams } from "./components/lightLeak";
import { SECTION_TITLE_REVISION, layoutSectionTitle, sectionBleedSize, type SectionTitleParams } from "./components/sectionTitle";
import { punchInCommands, punchInKeys, styleLookCommands, styleLookFor, type PunchInSpec } from "./components/finish";
import { styleJobKey, styleKey, type StyleComponentParams, type StyleJobTrack, type StyleRenderJobV1 } from "./jobs";
import { contrastOverLuminance, resolveStylePalette, type ResolvedStylePalette } from "./palette";
import { boxFromNormalized, intersects, solvePlacementCandidates, unionBoxes, type Box, type PlacementResult } from "./placement";
import { evaluateCaptionReadability, STYLE_BUSY_TEXTURE, type BackgroundStats, type CaptionColours, type CaptionReadabilityResult } from "./readability";
import {
  STYLE_ENGINE_VERSION, StylePlanError, stylePlanSchemaV1,
  type CaptionTreatment, type ReadabilityStep, type StyleCaptionBeatV1, type StyleFontRole, type StylePlanV1, type StyleSectionBeatV1, type StyleTemplateV1, type StyleTransitionBeatV1,
} from "./types";

/**
 * compileStylePlanV1(template, plan, project) → render jobs + timeline commands
 * (design §2: plan → ordinary EditorCommands + rendered overlay clips → audit →
 * apply → preview == export).
 *
 * The agent decides WHAT (words, keywords, sections, transitions); the template
 * guarantees HOW (sizes, colours, eases, holds, placement). Browser-safe.
 *
 * Overlay clips: add_motion_library_clip (Phase 3 core) only admits catalog items
 * (T01–T80 / X01–X40 / B01–B40) with a catalog cache key, so style components
 * cannot use it yet. Until a style-template clip field exists, every job is
 * returned as a pending clip; bindStyleJobClip() turns a rendered job into
 * ordinary import_asset + add_clip commands, and the manifest lists the jobs.
 */

export const STYLE_COMPILE_SCHEMA_V1 = "editkin.style-compile/v1" as const;
export const STYLE_RENDER_MANIFEST_SCHEMA_V1 = "editkin.style-render-manifest/v1" as const;

export interface StyleFootageClip {
  readonly clipId: string;
  readonly timelineStart: number;
  readonly duration: number;
  readonly transform?: Transform2D;
  readonly color?: TimelineClip["color"];
  readonly keyframes?: TimelineClip["keyframes"];
  readonly genre?: string;
}

export interface StyleCompileProject {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  /** The footage clips the look and punch-ins apply to, in timeline order. */
  readonly footage: readonly StyleFootageClip[];
  readonly tracks?: Partial<Readonly<Record<StyleJobTrack, string>>>;
  /** Mean relative luminance (0..1) of the footage inside `box` (px) over [from, to] (timeline s); undefined = unknown. */
  /**
   * The footage behind `box` (px) over [from, to] (timeline s): luminance percentiles and texture, sampled from the real
   * (graded) pixels; undefined = unknown. Captions must reach the template contrast against it (readability.ts).
   */
  readonly sampleBackground?: (box: Box, from: number, to: number) => BackgroundStats | undefined;
}

export type StyleIssueSeverity = "error" | "warning";
export interface StyleCompileIssue { readonly severity: StyleIssueSeverity; readonly code: string; readonly beatIndex?: number; readonly detail: string }

export interface StylePendingClipV1 {
  readonly jobId: string;
  readonly jobKey: string;
  readonly track: StyleRenderJobV1["track"];
  readonly trackId: string;
  readonly timelineStart: number;
  readonly duration: number;
  readonly blendMode: "normal" | "screen";
}

export interface StyleCompileResultV1 {
  readonly schema: typeof STYLE_COMPILE_SCHEMA_V1;
  readonly engine: typeof STYLE_ENGINE_VERSION;
  readonly template: { readonly id: string; readonly revision: number };
  readonly ok: boolean;
  readonly jobs: readonly StyleRenderJobV1[];
  /** Commands that need no rendered asset: looks and punch-ins on the footage clips. */
  readonly commands: readonly EditorCommand[];
  readonly pendingClips: readonly StylePendingClipV1[];
  readonly sfx: ReadonlyArray<{ readonly at: number; readonly cue: string }>;
  /** The plan-level look (undefined when the plan's genre is never graded, e.g. screen recordings). */
  readonly look: { readonly filmLookId: string; readonly strength: number } | undefined;
  /** Timeline ranges where the footage shows as a blurred, darkened copy (split + studio_backdrop_soft). */
  readonly backdrops: ReadonlyArray<{ readonly from: number; readonly to: number }>;
  /** Punch-in keys per footage clip (clip-local), for previews that evaluate keyframes outside the editor. */
  readonly punchIns: ReadonlyArray<{ readonly clipId: string; readonly keys: ReturnType<typeof punchInKeys> }>;
  /** Per caption beat: the measured contrast it reached, with which placement and readability step. */
  readonly captionReadability: readonly StyleCaptionReadabilityV1[];
  readonly issues: readonly StyleCompileIssue[];
  readonly manifest: StyleRenderManifestV1;
}

export interface StyleCaptionReadabilityV1 {
  readonly beatIndex: number;
  readonly step: string;
  readonly candidate: number;
  readonly treatment: CaptionTreatment;
  readonly lead: number;
  readonly keyword?: number;
  readonly texture: number;
  readonly pass: boolean;
}

export interface StyleRenderManifestV1 {
  readonly schema: typeof STYLE_RENDER_MANIFEST_SCHEMA_V1;
  readonly engine: typeof STYLE_ENGINE_VERSION;
  readonly template: { readonly id: string; readonly revision: number };
  readonly planKey: string;
  readonly frame: { readonly width: number; readonly height: number; readonly fps: number };
  readonly jobs: ReadonlyArray<Pick<StyleRenderJobV1, "id" | "key" | "component" | "timelineStart" | "startFrame" | "frameCount" | "output" | "blendMode" | "track" | "beatIndex">>;
  readonly timelineBinding: "pending_asset_binding";
  readonly bindingNote: string;
}

const EPS = 1e-6;
const DEFAULT_TRACKS: Readonly<Record<StyleJobTrack, string>> = { captions: "style-captions", titles: "style-titles", finish: "style-finish",
  insertUnder: "style-insert-under", insertOver: "style-insert-over", stage: "style-stage", annotations: "style-annotations", explainers: "style-explainers",
  backdrop: "style-backdrop", cardUnder: "style-card-under", cardOver: "style-card-over", overlay: "style-overlay",
  cardUnderTail: "style-card-under-tail", cardOverTail: "style-card-over-tail", calloutUnder: "style-callout-under", calloutOver: "style-callout-over" };

// ---------------------------------------------------------------------------

export function compileStylePlanV1(template: StyleTemplateV1, planInput: unknown, project: StyleCompileProject): StyleCompileResultV1 {
  const plan = stylePlanSchemaV1.parse(planInput);
  if (plan.template !== template.id) throw new StylePlanError("STYLE_TEMPLATE_MISMATCH", `plan names ${plan.template}, compiling with ${template.id}`);
  assertProject(project);
  const palette = resolveStylePalette(template, plan.palette);
  const frame = { width: project.width, height: project.height };
  const shortSide = Math.min(frame.width, frame.height);
  const fps = project.fps;
  const issues: StyleCompileIssue[] = [];
  const jobs: StyleRenderJobV1[] = [];
  const commands: EditorCommand[] = [];
  const sfx: Array<{ at: number; cue: string }> = [];
  const punchIns: Array<{ clipId: string; keys: ReturnType<typeof punchInKeys> }> = [];
  const backdrops: Array<{ from: number; to: number; beatIndex: number }> = [];
  const readabilityReport: StyleCaptionReadabilityV1[] = [];
  const tracks = { ...DEFAULT_TRACKS, ...project.tracks };

  validateEditorial(template, plan, issues, fps);

  const addJob = (beatIndex: number, params: StyleComponentParams, timelineStart: number, frameCount: number,
    track: StyleRenderJobV1["track"], output: StyleRenderJobV1["output"], blendMode: StyleRenderJobV1["blendMode"]) => {
    const startFrame = Math.round(timelineStart * fps);
    const key = styleJobKey(params.component, params, frameCount, fps);
    jobs.push(Object.freeze({ id: `${params.component}-${String(beatIndex).padStart(3, "0")}`, key, component: params.component, params,
      timelineStart: startFrame / fps, startFrame, frameCount, fps, output, blendMode, track, beatIndex }));
  };

  plan.beats.forEach((beat, beatIndex) => {
    try {
      switch (beat.kind) {
        case "caption": {
          // The phrase exits before the next phrase or the next section title (sections are phrase boundaries).
          const ownStart = firstWordStart(plan, beat);
          const boundaries = plan.beats.flatMap((other, index) => index === beatIndex ? []
            : other.kind === "caption" ? [firstWordStart(plan, other)] : other.kind === "section" ? [other.at] : []).filter(at => at > ownStart + EPS);
          const nextStart = boundaries.length ? Math.min(...boundaries) : undefined;
          const compiled = compileCaption(template, palette, plan, beat, beatIndex, project, nextStart, issues, readabilityReport);
          if (compiled) addJob(beatIndex, compiled.params, compiled.start, compiled.frameCount, "captions", "alpha", "normal");
          break;
        }
        case "section": {
          const compiled = compileSection(template, palette, plan, beat, beatIndex, project, issues);
          if (compiled) {
            addJob(beatIndex, compiled.params, compiled.start, compiled.frameCount, "titles", "alpha", "normal");
            if (compiled.params.style === "bleed" && template.components.section.backdrop === "blurDarken") {
              backdrops.push({ from: compiled.start, to: compiled.start + compiled.frameCount / fps, beatIndex });
            }
          }
          break;
        }
        case "transition": {
          if (beat.id === "lightLeak") {
            const leak = template.components.lightLeak;
            const duration = beat.duration ?? leak.defaultSeconds;
            // The leak peaks on the beat (its plateau spans 32–50% of the clip).
            const start = Math.max(0, beat.at - duration * 0.4);
            const params: LightLeakParams = { component: "lightLeak", revision: LIGHT_LEAK_REVISION, width: frame.width, height: frame.height, duration,
              colors: leak.colors, peak: leak.peak, origin: leak.origin, seed: Math.round(beat.at * 1000) % 2_147_483_647 };
            addJob(beatIndex, params, start, Math.max(1, Math.round(duration * fps)), "finish", "opaque", "screen");
          } else {
            const result = compilePunchIn(template, plan, beat, project);
            if ("error" in result) issues.push({ severity: "error", code: result.error, beatIndex, detail: result.detail });
            else { commands.push(...result.commands); punchIns.push({ clipId: result.clipId, keys: result.keys }); }
          }
          break;
        }
        case "sfx": sfx.push({ at: beat.at, cue: beat.cue }); break;
        case "insert":
          issues.push({ severity: "error", code: "STYLE_INSERT_PHASE_B", beatIndex,
            detail: `insert layout ${beat.layout} (C5) is Phase B; cut the B-roll with ordinary clip commands for now` });
          break;
        case "explainer": case "annotation":
          issues.push({ severity: "error", code: "STYLE_PLAN_PHASE_B", beatIndex, detail: `${beat.kind} beats (C3/C4) are Phase B` });
          break;
      }
    } catch (error) {
      issues.push({ severity: "error", code: error instanceof StylePlanError ? error.code : "STYLE_BEAT_FAILED", beatIndex, detail: (error as Error).message });
    }
  });

  // Look on every footage clip (one choice per plan; per-clip genres pick their own look when set).
  const look = styleLookFor(template, plan.genre);
  const byLook = new Map<string, string[]>();
  for (const clip of project.footage) {
    const choice = clip.genre ? styleLookFor(template, clip.genre) : look;
    if (!choice) continue;
    const key = `${choice.filmLookId}\u0000${choice.strength}`;
    byLook.set(key, [...(byLook.get(key) ?? []), clip.clipId]);
  }
  const lookCommands = [...byLook.entries()].flatMap(([key, clipIds]) => {
    const [filmLookId, strength] = key.split("\u0000");
    return styleLookCommands(clipIds, { filmLookId, strength: Number(strength) });
  });

  // Backdrops last: they split footage clips, and splits carry the looks and punch-in keyframes already applied.
  const segments = project.footage.map(clip => ({ id: clip.clipId, start: clip.timelineStart, end: clip.timelineStart + clip.duration }));
  const backdropCommands = backdrops.flatMap(range => backdropSplitCommands(project, segments, range.from, range.to, range.beatIndex));
  jobs.sort((a, b) => a.startFrame - b.startFrame || a.beatIndex - b.beatIndex);
  const trackIdOf = (track: StyleRenderJobV1["track"]) => tracks[track];
  const pendingClips: StylePendingClipV1[] = jobs.map(job => ({ jobId: job.id, jobKey: job.key, track: job.track, trackId: trackIdOf(job.track),
    timelineStart: job.timelineStart, duration: job.frameCount / fps, blendMode: job.blendMode }));
  const planKey = styleKey({ engine: STYLE_ENGINE_VERSION, template: [template.id, template.revision], plan, frame, fps });
  const manifest: StyleRenderManifestV1 = {
    schema: STYLE_RENDER_MANIFEST_SCHEMA_V1, engine: STYLE_ENGINE_VERSION, template: { id: template.id, revision: template.revision }, planKey,
    frame: { ...frame, fps },
    jobs: jobs.map(({ id, key, component, timelineStart, startFrame, frameCount, output, blendMode, track, beatIndex }) =>
      ({ id, key, component, timelineStart, startFrame, frameCount, output, blendMode, track, beatIndex })),
    timelineBinding: "pending_asset_binding",
    bindingNote: "add_motion_library_clip admits catalog items only; style jobs bind as import_asset + add_clip (bindStyleJobClip) until a style clip field exists",
  };
  return Object.freeze({
    schema: STYLE_COMPILE_SCHEMA_V1, engine: STYLE_ENGINE_VERSION, template: { id: template.id, revision: template.revision },
    ok: !issues.some(issue => issue.severity === "error"), jobs, commands: [...lookCommands, ...commands, ...backdropCommands], pendingClips, sfx, look, punchIns,
    backdrops: backdrops.map(({ from, to }) => ({ from, to })), captionReadability: readabilityReport, issues, manifest,
  });
}

function assertProject(project: StyleCompileProject): void {
  if (!Number.isInteger(project.width) || !Number.isInteger(project.height) || project.width < 16 || project.height < 16) throw new StylePlanError("STYLE_PROJECT_INVALID", "frame size");
  if (!(project.fps > 0 && project.fps <= 240)) throw new StylePlanError("STYLE_PROJECT_INVALID", "fps");
}

const firstWordStart = (plan: StylePlanV1, beat: StyleCaptionBeatV1) => plan.words[beat.wordRange[0]]?.start ?? beat.at;

// ---------------------------------------------------------------------------
// Editorial validation (design §3 / §4)
// ---------------------------------------------------------------------------

function validateEditorial(template: StyleTemplateV1, plan: StylePlanV1, issues: StyleCompileIssue[], fps: number): void {
  const rules = template.editorial;
  const emphasis: Array<{ at: number; beatIndex: number }> = [];
  let previousEnd = -Infinity, keywordCount = 0, captionCount = 0;
  plan.beats.forEach((beat, beatIndex) => {
    if (beat.kind === "caption") {
      captionCount += 1;
      const [a, b] = beat.wordRange;
      if (b >= plan.words.length) { issues.push({ severity: "error", code: "STYLE_WORD_RANGE", beatIndex, detail: `word ${b} does not exist` }); return; }
      for (let index = a + 1; index <= b; index += 1) {
        if (plan.words[index].gapBefore) issues.push({ severity: "error", code: "STYLE_WORD_GAP", beatIndex,
          detail: `an untimed spoken word lies before "${plan.words[index].text}"; the caption would drop it (M10)` });
      }
      if (Math.abs(beat.at - plan.words[a].start) > Math.max(0.05, 1.5 / fps)) {
        issues.push({ severity: "error", code: "STYLE_BEAT_AT", beatIndex, detail: `at ${beat.at} is not the first word's start ${plan.words[a].start}` });
      }
      if (plan.words[a].start < previousEnd - EPS) issues.push({ severity: "error", code: "STYLE_CAPTION_OVERLAP", beatIndex, detail: "captions overlap in time" });
      previousEnd = plan.words[b].end;
      if (beat.keyword) {
        keywordCount += 1;
        const [k0, k1] = beat.keyword;
        if (k0 < a || k1 > b) issues.push({ severity: "error", code: "STYLE_KEYWORD_RANGE", beatIndex, detail: "keyword outside wordRange" });
        const treatment = beat.treatment ?? template.components.caption.defaultTreatment;
        if (!template.components.caption.treatments.includes(treatment)) {
          issues.push({ severity: "error", code: "STYLE_TREATMENT", beatIndex, detail: `${template.id} does not offer ${treatment}` });
        }
        if (beat.lead && (beat.lead[0] !== a || beat.lead[1] !== k0 - 1)) {
          issues.push({ severity: "error", code: "STYLE_LEAD_RANGE", beatIndex, detail: "lead must be the words before the keyword" });
        }
        emphasis.push({ at: plan.words[k0]?.start ?? beat.at, beatIndex });
      } else if (beat.treatment) {
        issues.push({ severity: "error", code: "STYLE_TREATMENT_WITHOUT_KEYWORD", beatIndex, detail: "a treatment needs a keyword" });
      }
    } else if (beat.kind === "section") {
      emphasis.push({ at: beat.at, beatIndex });
    }
  });
  emphasis.sort((x, y) => x.at - y.at);
  for (let i = 0; i < emphasis.length; i += 1) {
    let count = 1;
    for (let j = i + 1; j < emphasis.length && emphasis[j].at < emphasis[i].at + 2; j += 1) count += 1;
    if (count > rules.maxTreatmentsPer2s) {
      issues.push({ severity: "error", code: "STYLE_DENSITY", beatIndex: emphasis[i].beatIndex,
        detail: `${count} emphasis treatments within 2 s from ${emphasis[i].at.toFixed(2)} s (max ${rules.maxTreatmentsPer2s})` });
      break;
    }
  }
  if (captionCount >= 4) {
    const density = keywordCount / captionCount;
    if (density < rules.keywordDensity.min || density > rules.keywordDensity.max) {
      issues.push({ severity: "warning", code: "STYLE_KEYWORD_DENSITY", detail: `${(density * 100).toFixed(0)}% of captions carry a keyword (template asks ${rules.keywordDensity.min}–${rules.keywordDensity.max})` });
    }
  }
}

// ---------------------------------------------------------------------------
// Captions
// ---------------------------------------------------------------------------

function fontOf(template: StyleTemplateV1, role: StyleFontRole): MotionFontSelector {
  const font = template.fonts[role];
  return font.weight === undefined ? { font: font.font } : { font: font.font, weight: font.weight };
}

function subjectBoxes(plan: StylePlanV1, from: number, to: number, frame: { width: number; height: number }): Box[] {
  return (plan.subjects ?? []).filter(subject => subject.from < to && subject.to > from).map(subject => boxFromNormalized(subject.box, frame));
}

function keywordStyle(template: StyleTemplateV1, palette: ResolvedStylePalette, treatment: CaptionTreatment, keywordSize: number):
  Pick<KineticCaptionTypography["keyword"], "fill" | "box" | "glow" | "rotation" | "font" | "size"> {
  const caption = template.components.caption;
  const font = fontOf(template, caption.keywordFont);
  const solid = (color: string): KeywordFill => ({ kind: "solid", color });
  switch (treatment) {
    case "accentColor": return { font, size: keywordSize, fill: solid(palette.accent) };
    case "highlightBox": return { font, size: keywordSize, fill: solid(palette.derived.onAccent), box: { color: palette.accent, padding: caption.boxPadding, radius: caption.boxRadius } };
    case "glow": return { font, size: keywordSize, fill: solid(palette.highlight), glow: { color: palette.highlight, core: palette.derived.glowCore } };
    case "gradient": return { font, size: keywordSize, fill: { kind: "gradient", top: palette.derived.gradientTop, bottom: palette.derived.gradientBottom } };
    case "script": return { font: fontOf(template, "script"), size: keywordSize * caption.scriptScale, fill: solid(palette.script), rotation: caption.scriptRotation };
    case "size": return { font, size: keywordSize, fill: solid(palette[caption.leadColor]) };
  }
}

function compileCaption(template: StyleTemplateV1, palette: ResolvedStylePalette, plan: StylePlanV1, beat: StyleCaptionBeatV1, beatIndex: number,
  project: StyleCompileProject, nextStart: number | undefined, issues: StyleCompileIssue[], readabilityReport: StyleCaptionReadabilityV1[]):
  { params: KineticCaptionParams; start: number; frameCount: number } | undefined {
  const caption = template.components.caption, rules = template.editorial;
  const frame = { width: project.width, height: project.height }, fps = project.fps;
  const shortSide = Math.min(frame.width, frame.height), portrait = frame.height > frame.width;
  const [a, b] = beat.wordRange;
  if (b >= plan.words.length) return undefined;
  const words = plan.words.slice(a, b + 1);
  const [k0, k1] = beat.keyword ?? [-1, -2];
  const role = (index: number): CaptionWord["role"] => (index >= k0 && index <= k1 ? "keyword" : k0 >= 0 && index > k1 ? "tail" : "lead");
  const jobStart = Math.floor(words[0].start * fps + EPS) / fps;
  let treatment = beat.treatment ?? caption.defaultTreatment;
  // No Latin script face is bundled (only LXGW WenKai for CJK): a Latin script keyword falls back to the solid accent.
  if (treatment === "script" && k0 >= 0 && /[A-Za-z]/.test(plan.words.slice(k0, k1 + 1).map(word => word.text).join(""))) {
    treatment = caption.treatments.includes("accentColor") ? "accentColor" : "size";
    issues.push({ severity: "warning", code: "STYLE_SCRIPT_LATIN_UNAVAILABLE", beatIndex, detail: `no bundled Latin script face; the keyword uses ${treatment}` });
  }
  // A phrase with no keyword reads as one mid-size line (1.45× lead): hierarchy without inventing emphasis.
  const leadOnly = k0 < 0;
  const leadSize = caption.leadSize * shortSide * (leadOnly ? 1.45 : 1);
  // Keyword size follows its length inside the 3–4× band: short words go huge, long ones stay readable.
  const keywordChars = k0 < 0 ? 0 : [...plan.words.slice(k0, k1 + 1).map(word => word.text).join("")]
    .reduce((sum, character) => sum + (/[\u0000-\u024F]/.test(character) ? 0.55 : 1), 0);
  const keywordScale = Math.max(3, Math.min(4, caption.keywordScale * (3 / Math.max(1, keywordChars)) ** 0.35));
  const keywordSize = leadSize * keywordScale;
  const kw = keywordStyle(template, palette, treatment, keywordSize);

  // Timing: exit after the tail hold and the keyword's minimum hold, never into the next phrase.
  const lastEnd = words[words.length - 1].end;
  const keywordStart = k0 >= 0 ? plan.words[k0].start : undefined;
  let exitAt = Math.max(lastEnd + rules.phraseTailSeconds, keywordStart === undefined ? -Infinity : keywordStart + rules.minKeywordHoldSeconds + 0.25);
  if (nextStart !== undefined && exitAt + caption.exitSeconds > nextStart - EPS) {
    exitAt = Math.max(lastEnd, nextStart - caption.exitSeconds);
    if (keywordStart !== undefined && exitAt < keywordStart + rules.minKeywordHoldSeconds - EPS) {
      issues.push({ severity: "error", code: "STYLE_KEYWORD_HOLD", beatIndex, detail: `keyword holds ${(exitAt - keywordStart).toFixed(2)} s before the next phrase (min ${rules.minKeywordHoldSeconds})` });
    }
  }
  const end = exitAt + caption.exitSeconds;
  // Subjects on screen while the phrase is read (its exit tail may run into the next shot).
  const subjects = subjectBoxes(plan, words[0].start, Math.max(exitAt, words[0].start + 1 / fps), frame);
  const landscapeSide = !portrait && subjects.length > 0;
  const safeWidth = frame.width * (1 - 2 * rules.placement.titleSafe) - (portrait ? frame.width * Math.max(0, rules.placement.portraitUiRight - rules.placement.titleSafe) : 0);
  const keywordMaxWidth = portrait ? safeWidth * 0.94 : frame.width * (landscapeSide ? 0.42 : 0.66);
  const typographyFor = (align: KineticCaptionTypography["align"]): KineticCaptionTypography => ({
    lead: { font: fontOf(template, caption.leadFont), size: leadSize, tracking: caption.leadTracking, color: palette[caption.leadColor],
      maxWidth: Math.min(caption.leadMaxEm * leadSize, keywordMaxWidth) },
    keyword: { ...kw, tracking: caption.keywordTracking, maxWidth: keywordMaxWidth, treatment },
    lineGap: caption.lineGap * leadSize,
    align,
  });
  const captionWords: CaptionWord[] = words.map((word, offset) => ({ text: word.text, t0: word.start - jobStart, t1: word.end - jobStart, role: role(a + offset) }));
  const measured = layoutKineticCaption(captionWords, typographyFor("center"));
  const candidates = solvePlacementCandidates({
    frame, block: { width: measured.width, height: measured.height }, avoid: subjects,
    avoidMargin: rules.placement.faceMargin * shortSide, titleSafe: rules.placement.titleSafe,
    uiBottom: rules.placement.portraitUiBottom, uiRight: rules.placement.portraitUiRight,
    preference: beat.placement ?? (rules.placement.policy === "center_low" ? "center_low" : "auto"), minScale: rules.placement.minScale,
  }, 24).filter(candidate => candidate.fits);
  if (!candidates.length) {
    issues.push({ severity: "error", code: "STYLE_PLACEMENT_FACE_CONFLICT", beatIndex, detail: "no negative space fits this phrase without covering the subject; shorten the phrase" });
    return undefined;
  }

  // Readability against the footage actually behind the block (design §4): try every placement plainly, then each
  // cumulative step of the template's ladder (scrim → box / lighter keyword, or plate), before settling below target.
  const readability = caption.readability;
  const steps: ReadabilityStep[][] = [[], ...readability.ladder.map((_, index) => readability.ladder.slice(0, index + 1))];
  const configFor = (step: readonly ReadabilityStep[]) => {
    let stepTreatment: CaptionTreatment = treatment;
    if (k0 >= 0 && step.includes("box") && caption.treatments.includes("highlightBox") && treatment !== "highlightBox") stepTreatment = "highlightBox";
    if (k0 >= 0 && step.includes("lighterKeyword") && ["gradient", "script", "glow"].includes(stepTreatment)) stepTreatment = "accentColor";
    if (k0 >= 0 && step.includes("whiteKeyword") && caption.treatments.includes("size") && stepTreatment !== "highlightBox") stepTreatment = "size";
    const inkText = step.includes("inkText");
    if (inkText && k0 >= 0) stepTreatment = "size";
    // Dark (ink) text needs no dark scrim: the ink step stands alone.
    const darken = inkText ? 0 : step.includes("plate") ? readability.plateOpacity : step.includes("scrim") ? readability.scrimOpacity : 0;
    return { step, treatment: stepTreatment, darken, leadBox: step.includes("boxAll"), inkText };
  };
  const coloursFor = (stepTreatment: CaptionTreatment, leadBox = false): CaptionColours => {
    const lead = palette[caption.leadColor];
    if (leadBox) {
      const boxed = { lead, leadOnBox: { text: palette.derived.onAccent, box: palette.accent } };
      if (k0 < 0) return boxed;
      return stepTreatment === "highlightBox" ? { ...boxed, keywordOnBox: { text: palette.derived.onAccent, box: palette.accent } } : { ...boxed, ...coloursFor(stepTreatment) , ...{ leadOnBox: boxed.leadOnBox } };
    }
    if (k0 < 0) return { lead };
    switch (stepTreatment) {
      case "highlightBox": return { lead, keywordOnBox: { text: palette.derived.onAccent, box: palette.accent } };
      case "glow": return { lead, keyword: [palette.highlight], glow: true };
      case "gradient": return { lead, keyword: [palette.derived.gradientTop, palette.derived.gradientBottom] };
      case "script": return { lead, keyword: [palette.script] };
      case "size": return { lead, keyword: [lead] };
      default: return { lead, keyword: [palette.accent] };
    }
  };
  const inkColours = (): CaptionColours => (k0 < 0 ? { lead: palette.ink } : { lead: palette.ink, keyword: [palette.ink] });
  let chosen: { placement: PlacementResult; config: ReturnType<typeof configFor>; result?: CaptionReadabilityResult; candidateIndex: number } | undefined;
  if (project.sampleBackground) {
    search: for (const step of steps) {
      const config = configFor(step);
      for (const [candidateIndex, placement] of candidates.entries()) {
        const stats = project.sampleBackground(placement.box, jobStart, end);
        if (!stats) { chosen = { placement, config: configFor([]), candidateIndex }; break search; }
        const result = evaluateCaptionReadability(config.inkText ? inkColours() : coloursFor(config.treatment, config.leadBox), stats,
          { minContrast: readability.minContrast, darken: config.darken, plain: step.length === 0 });
        if (result.pass) { chosen = { placement, config, result, candidateIndex }; break search; }
      }
    }
    if (!chosen) {
      const config = configFor(steps[steps.length - 1]);
      const stats = project.sampleBackground(candidates[0].box, jobStart, end)!;
      const result = evaluateCaptionReadability(config.inkText ? inkColours() : coloursFor(config.treatment, config.leadBox), stats,
        { minContrast: readability.minContrast, darken: config.darken, plain: false });
      chosen = { placement: candidates[0], config, result, candidateIndex: 0 };
      issues.push({ severity: "warning", code: "STYLE_CONTRAST_BELOW_TARGET", beatIndex,
        detail: `best measured contrast lead ${result.lead.toFixed(2)}${result.keyword === undefined ? "" : `, keyword ${result.keyword.toFixed(2)}`} < ${readability.minContrast} after ${config.step.join("+") || "plain"}` });
    }
  } else chosen = { placement: candidates[0], config: configFor([]), candidateIndex: 0 };
  const placement = chosen.placement, config = chosen.config;
  const styled = config.treatment === treatment ? kw : keywordStyle(template, palette, config.treatment, keywordSize);
  const finalKeyword = config.inkText ? { ...styled, fill: { kind: "solid" as const, color: palette.ink } } : styled;
  const baseTypography = typographyFor(placement.align);
  const typography: KineticCaptionTypography = { ...baseTypography,
    lead: config.leadBox ? { ...baseTypography.lead, color: palette.derived.onAccent,
      box: { color: palette.accent, padding: caption.boxPadding * 1.6, radius: caption.boxRadius * 1.6 } }
      : config.inkText ? { ...baseTypography.lead, color: palette.ink } : baseTypography.lead,
    keyword: { ...finalKeyword, tracking: caption.keywordTracking, maxWidth: keywordMaxWidth, treatment: config.treatment } };
  const strong = config.step.length > 0 || (chosen.result !== undefined && chosen.result.texture > STYLE_BUSY_TEXTURE);
  const paramsReadability: KineticCaptionParams["readability"] = {
    ...(config.inkText ? { shadow: { color: palette.paper, opacity: 0.5, blur: leadSize * 0.16 } }
      : readability.alwaysShadow || strong ? { shadow: { color: palette.derived.shadow, opacity: strong ? 0.78 : 0.6, blur: leadSize * (strong ? 0.14 : 0.11) } } : {}),
    ...(config.step.includes("plate") ? { plate: { color: palette.derived.plate, opacity: readability.plateOpacity } } : {}),
    ...(config.step.includes("scrim") ? { scrim: { color: palette.derived.shadow, opacity: readability.scrimOpacity } } : {}),
  };
  if (chosen.result) {
    readabilityReport.push({ beatIndex, step: config.step.join("+") || "plain", candidate: chosen.candidateIndex, treatment: config.treatment,
      lead: round2(chosen.result.lead), ...(chosen.result.keyword === undefined ? {} : { keyword: round2(chosen.result.keyword) }),
      texture: round4(chosen.result.texture), pass: chosen.result.pass });
  }
  const params: KineticCaptionParams = {
    component: "caption", revision: KINETIC_CAPTION_REVISION, width: frame.width, height: frame.height,
    words: captionWords, typography, block: { x: round2(placement.x), y: round2(placement.y), scale: placement.scale },
    entry: { lead: caption.leadEntry, keyword: beat.entry ?? (config.treatment === "script" ? "typeOn" : caption.keywordEntry) },
    exit: { at: round4(exitAt - jobStart), duration: caption.exitSeconds }, readability: paramsReadability,
  };
  return { params, start: jobStart, frameCount: Math.max(1, Math.ceil((end - jobStart) * fps - EPS)) };
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function compileSection(template: StyleTemplateV1, palette: ResolvedStylePalette, plan: StylePlanV1, beat: StyleSectionBeatV1, beatIndex: number,
  project: StyleCompileProject, issues: StyleCompileIssue[]): { params: SectionTitleParams; start: number; frameCount: number } | undefined {
  const section = template.components.section;
  const frame = { width: project.width, height: project.height }, fps = project.fps, portrait = frame.height > frame.width;
  let text: string;
  if (beat.wordRange) {
    const [a, b] = beat.wordRange;
    if (b >= plan.words.length) throw new StylePlanError("STYLE_WORD_RANGE", `word ${b} does not exist`);
    for (let index = a + 1; index <= b; index += 1) if (plan.words[index].gapBefore) throw new StylePlanError("STYLE_WORD_GAP", "section spans an untimed word");
    text = plan.words.slice(a, b + 1).map(word => word.text).join("");
    if (beat.text !== undefined && beat.text !== text) throw new StylePlanError("STYLE_SECTION_TEXT", `text "${beat.text}" is not the spoken words "${text}"`);
  } else if (beat.text !== undefined && beat.editorial) {
    text = beat.text;
    issues.push({ severity: "warning", code: "STYLE_EDITORIAL_TEXT", beatIndex, detail: `"${text}" is not from speech; the seal gate must fact-check it (M10)` });
  } else throw new StylePlanError("STYLE_SECTION_TEXT", "a section needs spoken words (wordRange) or text with editorial: true");
  const style = beat.style ?? section.defaultStyle;
  const duration = beat.duration ?? section.defaultSeconds;
  const start = Math.round(beat.at * fps) / fps;
  const end = start + duration;
  const subjects = subjectBoxes(plan, start, end, frame);
  const subject = unionBoxes(subjects);
  let params: SectionTitleParams;
  if (style === "punchCard") {
    const card = section.punchCard;
    const font = fontOf(template, card.font);
    const size = fitFontSize([text], { ...font, tracking: -0.04 }, { maxWidth: frame.width * 0.8, maxHeight: frame.height * (portrait ? 0.2 : 0.4), maxSize: 4000, minSize: 40 });
    params = { component: "section", revision: SECTION_TITLE_REVISION, width: frame.width, height: frame.height, style, text, font, tracking: -0.04,
      size: round2(size), color: palette[card.text], duration, edge: "left", bleed: 0, centerY: frame.height / 2, plate: palette[card.plate] };
  } else {
    const font = fontOf(template, section.font);
    const tracking = [...text].length >= 3 ? -0.04 : -0.02;
    const bleedSize = sectionBleedSize(text, font, tracking, frame, section.bleed, portrait ? 0.3 : 0.62);
    const size = Math.min(bleedSize, section.size * (portrait ? frame.width : frame.height));
    const edge = beat.edge ?? (subject && (subject.x0 + subject.x1) / 2 < frame.width / 2 ? "right" : "left");
    // Vertical centre: the first candidate band that clears the subject.
    const probe = (centerY: number) => layoutSectionTitle({ component: "section", revision: SECTION_TITLE_REVISION, width: frame.width, height: frame.height,
      style, text, font, tracking, size, color: "#FFFFFF", duration, edge, bleed: section.bleed, centerY });
    const candidates = portrait ? [0.36, 0.62, 0.72, 0.27, 0.5] : [0.5, 0.32, 0.68];
    let centerY = frame.height * candidates[0];
    for (const share of candidates) {
      const ink = probe(frame.height * share).ink;
      if (!subjects.some(box => intersects(ink, box))) { centerY = frame.height * share; break; }
    }
    const ink = probe(centerY).ink;
    const visible = { x0: Math.max(0, ink.x0), y0: Math.max(0, ink.y0), x1: Math.min(frame.width, ink.x1), y1: Math.min(frame.height, ink.y1) };
    if (subjects.some(box => intersects(ink, box))) {
      issues.push({ severity: "warning", code: "STYLE_SECTION_OVER_SUBJECT", beatIndex, detail: "the bleed title crosses the subject box (no subject matte in Phase A)" });
    }
    const luminance = project.sampleBackground?.(visible, start, end)?.mean;
    let color = palette[section.color];
    if (luminance !== undefined && contrastOverLuminance(color, luminance) < 3) color = mostContrasting(luminance > 0.4 ? "#FFFFFF" : "#000000", [palette.paper, palette.ink]);
    const light = contrastOverLuminance(color, 0) > contrastOverLuminance(color, 1);
    params = { component: "section", revision: SECTION_TITLE_REVISION, width: frame.width, height: frame.height, style, text, font, tracking, size: round2(size),
      color, duration, edge, bleed: section.bleed, centerY: round2(centerY),
      ...(section.scrim > 0 ? { scrim: { color: light ? palette.ink : palette.paper, opacity: section.scrim } } : {}) };
  }
  return { params, start, frameCount: Math.max(1, Math.round(duration * fps)) };
}

// ---------------------------------------------------------------------------
// Backdrop (R1: titles over a blurred, darkened copy of the footage)
// ---------------------------------------------------------------------------

export const STYLE_BACKDROP_EFFECT_ID = "studio_backdrop_soft";

/**
 * split_clip at the range edges, then the existing studio_backdrop_soft effect on the middle piece of every footage
 * segment it covers. `segments` tracks the footage clips as earlier backdrops split them.
 */
function backdropSplitCommands(project: StyleCompileProject, segments: Array<{ id: string; start: number; end: number }>, from: number, to: number,
  beatIndex: number): EditorCommand[] {
  const commands: EditorCommand[] = [];
  const frame = (seconds: number) => Math.round(seconds * project.fps) / project.fps;
  const a = frame(from), b = frame(to);
  for (const segment of [...segments]) {
    if (!(a < segment.end - EPS && b > segment.start + EPS)) continue;
    let middle = segment;
    if (a > segment.start + EPS) {
      middle = { id: `${segment.id}-bd${beatIndex}`, start: a, end: segment.end };
      commands.push({ type: "split_clip", clipId: segment.id, at: a, newClipId: middle.id });
      segment.end = a;
      segments.push(middle);
    }
    if (b < middle.end - EPS) {
      const after = { id: `${middle.id}-after`, start: b, end: middle.end };
      commands.push({ type: "split_clip", clipId: middle.id, at: b, newClipId: after.id });
      middle.end = b;
      segments.push(after);
    }
    commands.push({ type: "set_clip_creative", clipId: middle.id, patch: { effectPresetIds: [STYLE_BACKDROP_EFFECT_ID] } });
  }
  return commands;
}

// ---------------------------------------------------------------------------
// Punch-in
// ---------------------------------------------------------------------------

function compilePunchIn(template: StyleTemplateV1, plan: StylePlanV1, beat: StyleTransitionBeatV1, project: StyleCompileProject):
  { commands: EditorCommand[]; clipId: string; keys: ReturnType<typeof punchInKeys> } | { error: string; detail: string } {
  const clip = project.footage.find(candidate => beat.at >= candidate.timelineStart - EPS && beat.at < candidate.timelineStart + candidate.duration - EPS);
  if (!clip) return { error: "STYLE_PUNCH_NO_CLIP", detail: `no footage clip under ${beat.at}s` };
  const subject = (plan.subjects ?? []).find(candidate => candidate.from <= beat.at && candidate.to > beat.at);
  const focus: [number, number] = beat.focus ? [beat.focus[0], beat.focus[1]]
    : subject ? [(subject.box[0] + subject.box[2]) / 2, (subject.box[1] + subject.box[3]) / 2] : [0.5, 0.5];
  const punch = template.components.punchIn;
  const spec: PunchInSpec = { at: beat.at - clip.timelineStart, until: beat.until === undefined ? undefined : beat.until - clip.timelineStart,
    scale: punch.scale, attackSeconds: beat.duration ?? punch.attackSeconds, curve: punch.curve, focus, fps: project.fps, width: project.width, height: project.height };
  try {
    const keys = punchInKeys(spec, clip.duration);
    const commands = punchInCommands({ id: clip.clipId, transform: clip.transform ?? { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
      color: clip.color ?? { ...DEFAULT_COLOR }, keyframes: clip.keyframes ?? [], duration: clip.duration }, spec);
    return { commands, clipId: clip.clipId, keys };
  } catch (error) {
    return { error: "STYLE_PUNCH_REFUSED", detail: (error as Error).message };
  }
}

// ---------------------------------------------------------------------------
// Binding a rendered job to the timeline
// ---------------------------------------------------------------------------

export interface RenderedStyleJob {
  readonly assetId: string;
  readonly uri: string;
  readonly width: number;
  readonly height: number;
  readonly durationSeconds: number;
}

/** import_asset + add_clip for one rendered job (ordinary commands; one Undo when the caller batches them). */
export function bindStyleJobClip(pending: StylePendingClipV1, rendered: RenderedStyleJob, output: StyleRenderJobV1["output"]): EditorCommand[] {
  const asset: MediaAsset = {
    id: rendered.assetId, name: `Style ${pending.jobId}`, kind: "video", uri: rendered.uri, duration: rendered.durationSeconds,
    width: rendered.width, height: rendered.height, ...(output === "alpha" ? { alphaMode: "straight" as const } : {}),
    provenance: `editkin style template job ${pending.jobKey}`, license: "Editkin original", redistributable: true,
  };
  const clip: TimelineClip = {
    id: `style-${pending.jobId}`, assetId: asset.id, trackId: pending.trackId, timelineStart: pending.timelineStart, sourceStart: 0,
    duration: Math.min(pending.duration, rendered.durationSeconds), volume: 0, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    color: { ...DEFAULT_COLOR }, keyframes: [], layer: { enabled: true, blendMode: pending.blendMode, role: "content" },
  };
  return [{ type: "import_asset", asset }, { type: "add_clip", clip }];
}

const round2 = (value: number) => Math.round(value * 100) / 100;
const round4 = (value: number) => Math.round(value * 10_000) / 10_000;
