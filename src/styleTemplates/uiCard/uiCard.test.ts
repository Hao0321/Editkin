import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { styleComponentFrame } from "../jobs";
import { getStyleTemplateV1 } from "../templates";
import type { StyleWordV1 } from "../types";
import { compileUiCardPlanV1, type UiCardShotInput } from "./compile";
import { displayChars, phrasesFromSegments, segmentPhrases, spaceMixedScript } from "./phrases";
import type { UiCardPlanInputV1 } from "./plan";
import { followRoi, type RoiHeat } from "./roi";

const PROOF = join(__dirname, "../../../.rd/benchmarks/style-system-20261022/proof");
const words = JSON.parse(readFileSync(join(PROOF, "words-s1.json"), "utf8")).words as StyleWordV1[];
const segments = (JSON.parse(readFileSync(join(PROOF, "asr-s1-medium.json"), "utf8")).segments as Array<{ start: number; end: number; text: string }>)
  .map(({ start, end, text }) => ({ start, end, text }));

function flatHeat(width = 1920, height = 1080): RoiHeat {
  return { rate: 10, source: { width, height }, content: { x0: 0, y0: 0, x1: width, y1: height }, cols: 48, rows: 27, frames: [new Float32Array(48 * 27)] };
}

describe("S1 v2 phrases", () => {
  it("builds complete clauses from the recognizer's segments: every timed word once, no repeated windows, ≤ 16 characters", () => {
    const phrases = phrasesFromSegments(segments, words);
    const used = phrases.flatMap(phrase => phrase.offsets.map(offset => offset.word));
    expect(used).toEqual(words.map((_, index) => index));
    for (const phrase of phrases) expect(displayChars(phrase.text)).toBeLessThanOrEqual(16.5);
    const texts = phrases.map(phrase => phrase.text);
    expect(texts).toContain("沒碰任何一個遊戲引擎");
    expect(texts).toContain("我本身是做遊戲的"); // includes the untimed 本身 / 的
    expect(new Set(texts).size).toBe(texts.length);
  });
  it("spaces CJK and Latin runs", () => {
    expect(spaceMixedScript("美術圖我就用GPT來生")).toBe("美術圖我就用 GPT 來生");
    expect(spaceMixedScript("主要在做 3D 跟技術美術")).toBe("主要在做 3D 跟技術美術");
  });
  it("pause phrases never split a word and respect hard pauses", () => {
    const phrases = segmentPhrases(words, { maxChars: 16 });
    expect(phrases[0][0]).toBe(0);
    for (let i = 1; i < phrases.length; i += 1) expect(phrases[i][0]).toBe(phrases[i - 1][1] + 1);
  });
});

describe("S1 v2 ROI follow", () => {
  it("holds still without action and moves smoothly (no overshoot) toward it", () => {
    const quiet = followRoi(flatHeat(), { width: 800, height: 770, fps: 30, frames: 60 });
    expect(new Set(quiet.map(window => `${window.cx.toFixed(3)},${window.cy.toFixed(3)}`)).size).toBe(1);
    const frames = Array.from({ length: 30 }, (_, i) => {
      const grid = new Float32Array(48 * 27);
      if (i >= 5) for (let r = 2; r < 8; r += 1) for (let c = 38; c < 46; c += 1) grid[r * 48 + c] = 50;
      return grid;
    });
    const heat: RoiHeat = { ...flatHeat(), frames };
    const moving = followRoi(heat, { width: 800, height: 770, fps: 30, frames: 90 });
    const xs = moving.map(window => window.cx);
    for (let i = 1; i < xs.length; i += 1) expect(xs[i]).toBeGreaterThanOrEqual(xs[i - 1] - 1e-6);
    expect(xs[xs.length - 1]).toBeLessThanOrEqual(1920 - 400 + 1e-6);
    for (const window of moving) { expect(window.cx - 400).toBeGreaterThanOrEqual(-1e-6); expect(window.cy - 385).toBeGreaterThanOrEqual(-1e-6); }
  });
});

describe("S1 v2 compile", () => {
  const shots: UiCardShotInput[] = [
    { clipId: "a", timelineStart: 0, duration: 6, sourceStart: 1, source: { width: 1920, height: 1080 }, heat: flatHeat(), tail: 0.4 },
    { clipId: "b", timelineStart: 6, duration: 6, sourceStart: 1, source: { width: 1920, height: 1080 }, heat: flatHeat(), tail: 0.4 },
  ];
  const plan: UiCardPlanInputV1 = {
    schema: "editkin.ui-card-plan/v1", template: "S1_explainer_ui", aspect: "9:16", words: words.slice(0, 40), segments: segments.slice(0, 3),
    shots: [{ id: "a" }, { id: "b", card: "wide", region: [0.2, 0.5, 0.7, 0.8], follow: false }],
    chapters: [{ at: 0, number: "01", label: { text: "用 AI 做一款遊戲", editorial: true } }],
    keys: [{ keyword: [12, 14] }], tags: [{ at: 6.1, text: { wordRange: [31, 31] } }],
    clicks: [{ at: 8, shot: "b", point: [0.5, 0.6], evidence: "test" }],
  };
  const compiled = compileUiCardPlanV1(getStyleTemplateV1("S1_explainer_ui"), plan, { width: 1080, height: 1920, fps: 30, shots });
  it("lays out the grid: chip, hero card, lockup replacing the subtitle, bottom kept clear", () => {
    expect(compiled.ok).toBe(true);
    const lockup = compiled.jobs.find(job => job.params.component === "lowerThird" && job.params.content.mode === "lockup");
    expect(lockup && lockup.params.component === "lowerThird" && lockup.params.content.mode === "lockup" && lockup.params.content.keyword).toBe("角色立繪");
    expect(compiled.phrases.filter(phrase => phrase.text.includes("角色立繪")).map(phrase => phrase.mode)).toEqual(["lockup"]);
    const card = compiled.layers.find(layer => layer.id === "card-a")!;
    expect(card.rect).toEqual({ x: 45, y: 236, w: 990, h: 950 });
    // Wide card: the strip's aspect.
    const wide = compiled.layers.find(layer => layer.id === "card-b")!;
    expect(wide.rect.h).toBeLessThan(500);
    // The card enters with a 40 px slide-up and fade; the first card only fades.
    expect(wide.frames[0].dy).toBeCloseTo(40, 1);
    expect(wide.frames[0].opacity).toBeLessThan(0.05);
    expect(wide.frames[Math.round(0.45 * 30)].dy).toBeLessThan(0.5);
  });
  it("punches in toward the ROI on the key beat (1.12–1.2×) and settles back", () => {
    const card = compiled.layers.find(layer => layer.id === "card-a")!;
    const zooms = card.frames.map(frame => card.frames[0].w / frame.w);
    const peak = Math.max(...zooms);
    expect(peak).toBeGreaterThanOrEqual(1.12);
    expect(peak).toBeLessThanOrEqual(1.2 + 1e-9);
    // After the peak the zoom only eases back (the settle runs past this short test shot's end).
    const at = zooms.indexOf(peak);
    for (let i = at + 1; i < zooms.length; i += 1) expect(zooms[i]).toBeLessThanOrEqual(zooms[i - 1] + 1e-9);
    expect(zooms[0]).toBeCloseTo(1, 9);
  });
  it("every overlay job renders a frame", () => {
    for (const job of compiled.jobs) {
      const svg = styleComponentFrame(job.params, Math.min(1, job.frameCount / job.fps / 2));
      expect(svg.startsWith("<svg")).toBe(true);
    }
  });
});

describe("S1 v2 product binding", () => {
  it("applies to an Editkin project: fixed-window card bodies, held slide-ins and tails, callouts, posed stills; the project validates", async () => {
    const { applyCommand } = await import("../../domain/commands");
    const { createEmptyProject } = await import("../../domain/editGraph");
    const { validateProject } = await import("../../domain/projectValidation");
    const { fixedTemplateWindowSamplesV3 } = await import("../../domain/fixedTemplateWindowPathV3");
    const { DEFAULT_COLOR } = await import("../../domain/types");
    const { uiCardProductCommands, bindUiCardJob, uiCardTracks } = await import("./product");
    const shots: UiCardShotInput[] = ["a", "b"].map((id, i) => ({ clipId: id, timelineStart: i * 6, duration: 6, sourceStart: 1, source: { width: 1920, height: 1080 },
      heat: { ...flatHeat(), content: { x0: 100, y0: 40, x1: 1820, y1: 1040 } }, tail: 0.4 }));
    const plan: UiCardPlanInputV1 = { schema: "editkin.ui-card-plan/v1", template: "S1_explainer_ui", aspect: "9:16", words: words.slice(0, 40), segments: segments.slice(0, 3),
      shots: [{ id: "a" }, { id: "b" }], keys: [{ keyword: [12, 14] }], callouts: [{ at: 8, until: 10, shot: "b", region: [0.3, 0.3, 0.5, 0.5], scale: 1.4 }] };
    const compiled = compileUiCardPlanV1(getStyleTemplateV1("S1_explainer_ui"), plan, { width: 1080, height: 1920, fps: 30, shots });
    let project = createEmptyProject("ui card", { width: 1080, height: 1920, fps: 30 });
    for (const shot of shots) {
      project = applyCommand(project, { type: "import_asset", asset: { id: `asset-${shot.clipId}`, name: `${shot.clipId}.mp4`, kind: "video", uri: `file:///s/${shot.clipId}.mp4`, duration: 20, width: 1920, height: 1080 } });
      project = applyCommand(project, { type: "add_clip", clip: { id: shot.clipId, assetId: `asset-${shot.clipId}`, trackId: "video-main", timelineStart: shot.timelineStart, sourceStart: shot.sourceStart,
        duration: shot.duration, volume: 0, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, color: { ...DEFAULT_COLOR }, keyframes: [] } });
    }
    const tracks = uiCardTracks(compiled);
    for (const track of tracks.order) if (track !== "footage") project = applyCommand(project, { type: "add_track", track: { id: track.id, name: track.name, kind: "video", locked: false, muted: false, clips: [] } });
    const binding = { shots: new Map(shots.map(shot => [shot.clipId, { assetId: `asset-${shot.clipId}`, source: shot.source }])), tracks };
    for (const command of uiCardProductCommands(compiled, binding)) project = applyCommand(project, command);
    for (const job of compiled.jobs) {
      for (const command of bindUiCardJob(job, { assetId: `job-${job.key}-${job.id}`, uri: `file:///cache/${job.key}.${job.output === "still" ? "png" : "mov"}`, durationSeconds: job.frameCount / job.fps },
        tracks.jobTrack.get(job.id)!, { width: 1080, height: 1920 })) project = applyCommand(project, command);
    }
    expect(() => validateProject(project)).not.toThrow();
    const clips = project.tracks.flatMap(track => track.clips);
    const body = clips.find(clip => clip.id === "b-card")!;
    expect(body.layout).toBeDefined();
    const fixed = body.masks!.find(mask => mask.fixedWindowV3)!;
    // The window stays inside the recording for every frame of the follow and the punch-in.
    expect(() => fixedTemplateWindowSamplesV3(project, body, fixed)).not.toThrow();
    expect(clips.find(clip => clip.id === "a-tail")?.trackId).toBe(tracks.cardTail);
    expect(clips.find(clip => clip.id === "style-callout-0")?.masks?.length).toBe(1);
  }, 60_000);
});
