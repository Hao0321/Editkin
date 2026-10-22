import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createSeededRng } from "../motionLibrary/svg/random";
import { compileStylePlanV1 } from "./compiler";
import { captionWordStates, CAPTION_MAX_BLUR_PX, kineticCaptionFrame, type KineticCaptionParams } from "./components/kineticCaption";
import { lightLeakFrame } from "./components/lightLeak";
import { sectionTitleFrame } from "./components/sectionTitle";
import { evaluatePunchInKeys } from "./components/finish";
import { styleJobFrame } from "./jobs";
import { intersects, solvePlacement, solvePlacementCandidates, type Box } from "./placement";
import type { BackgroundStats } from "./readability";
import { fixturePlan, fixtureProject } from "./styleTemplates.fixture";
import { getStyleTemplateV1, parseStyleTemplateV1, styleTemplateCatalogV1 } from "./templates";
import { stylePlanSchemaV1, styleTemplateSchemaV1 } from "./types";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const TEMPLATE_IDS = ["S1_explainer_ui", "S2_story_illustrated", "S3_lifestyle_promo"] as const;

describe("schemas", () => {
  it("parses the three Phase A templates with the measured palettes", () => {
    const catalog = styleTemplateCatalogV1();
    expect([...catalog.keys()]).toEqual([...TEMPLATE_IDS]);
    expect(getStyleTemplateV1("S1_explainer_ui").palette).toMatchObject({ accent: "#FCC834", paper: "#FFFFFF", ink: "#121214" });
    expect(getStyleTemplateV1("S2_story_illustrated").palette).toMatchObject({ accent: "#E49A1C", highlight: "#E8DA26", accent2: "#9C6418" });
    expect(getStyleTemplateV1("S3_lifestyle_promo").palette).toMatchObject({ accent: "#FCCC2C", accent2: "#F28C40", ink: "#0C1424", highlight: "#F45C5C", script: "#F2B23C" });
    for (const template of catalog.values()) expect(template.artStatus).toBe("pending");
  });

  it("refuses broken templates", () => {
    const base = structuredClone(getStyleTemplateV1("S1_explainer_ui")) as Record<string, unknown> & { components: { caption: Record<string, unknown>; look: Record<string, unknown> } };
    expect(styleTemplateSchemaV1.safeParse({ ...base, palette: { ...(base.palette as object), accent: "yellow" } }).success).toBe(false);
    const wrongDefault = structuredClone(base);
    wrongDefault.components.caption.defaultTreatment = "glow";
    expect(styleTemplateSchemaV1.safeParse(wrongDefault).success).toBe(false);
    const hierarchy = structuredClone(base);
    hierarchy.components.caption.keywordScale = 1.5;
    expect(styleTemplateSchemaV1.safeParse(hierarchy).success).toBe(false);
    const look = structuredClone(base);
    look.components.look.filmLookId = "hfl2_does_not_exist";
    expect(() => parseStyleTemplateV1(look)).toThrow(/unknown film look/);
    expect(styleTemplateSchemaV1.safeParse({ ...base, extra: true }).success).toBe(false);
  });

  it("validates plans: words sorted and unique, ranges, phase B stubs", () => {
    const plan = fixturePlan("S1_explainer_ui");
    expect(stylePlanSchemaV1.safeParse(plan).success).toBe(true);
    expect(stylePlanSchemaV1.safeParse({ ...plan, words: [...plan.words].reverse() }).success).toBe(false);
    expect(stylePlanSchemaV1.safeParse({ ...plan, words: [plan.words[0], plan.words[0]] }).success).toBe(false);
    expect(stylePlanSchemaV1.safeParse({ ...plan, beats: [{ kind: "caption", at: 0.4, wordRange: [3, 1] }] }).success).toBe(false);
    expect(stylePlanSchemaV1.safeParse({ ...plan, beats: [{ kind: "caption", at: 0.4, wordRange: [0, 1], treatment: "sparkle" }] }).success).toBe(false);
    // Phase B beats parse with their own schemas; this compiler still refuses them (C3/C4 live in the S1 v2 UI-card path for now).
    expect(stylePlanSchemaV1.safeParse({ ...plan, beats: [{ kind: "explainer", at: 1, phase: "B", spec: {} }] }).success).toBe(false);
    const phaseB = { ...plan, beats: [{ kind: "explainer", at: 1, duration: 2, widget: "steps", steps: { count: 3, active: 1 } },
      { kind: "annotation", at: 2, duration: 1.5, mark: "pin", target: { point: [0.5, 0.4] }, label: { text: "新北", editorial: true } }] };
    expect(stylePlanSchemaV1.safeParse(phaseB).success).toBe(true);
    const compiled = compileStylePlanV1(getStyleTemplateV1("S1_explainer_ui"), phaseB, fixtureProject());
    expect(compiled.ok).toBe(false);
    expect(compiled.issues.map(issue => issue.code)).toEqual(["STYLE_PLAN_PHASE_B", "STYLE_PLAN_PHASE_B"]);
  });

  it("enforces the editorial rules: word gaps (M10), density, at, template treatments", () => {
    const template = getStyleTemplateV1("S1_explainer_ui");
    const plan = fixturePlan(template.id);
    const gap = { ...plan, words: plan.words.map((word, index) => (index === 2 ? { ...word, gapBefore: true } : word)) };
    expect(compileStylePlanV1(template, gap, fixtureProject()).issues.some(issue => issue.code === "STYLE_WORD_GAP")).toBe(true);
    const dense = { ...plan, beats: [...plan.beats, { kind: "section", at: 1.0, wordRange: [6, 6] }, { kind: "section", at: 1.5, wordRange: [8, 8] }] };
    expect(compileStylePlanV1(template, dense, fixtureProject()).issues.some(issue => issue.code === "STYLE_DENSITY")).toBe(true);
    const wrongAt = { ...plan, beats: [{ kind: "caption", at: 0.9, wordRange: [0, 4] }] };
    expect(compileStylePlanV1(template, wrongAt, fixtureProject()).issues.some(issue => issue.code === "STYLE_BEAT_AT")).toBe(true);
    const glow = { ...plan, beats: [{ kind: "caption", at: 0.4, wordRange: [0, 4], keyword: [3, 4], treatment: "glow" }] };
    expect(compileStylePlanV1(template, glow, fixtureProject()).issues.some(issue => issue.code === "STYLE_TREATMENT")).toBe(true);
    const free = { ...plan, beats: [{ kind: "section", at: 1, text: "新章節" }] };
    expect(compileStylePlanV1(template, free, fixtureProject()).issues.some(issue => issue.code === "STYLE_SECTION_TEXT")).toBe(true);
  });
});

describe("compiler", () => {
  for (const id of TEMPLATE_IDS) {
    for (const aspect of ["9:16", "16:9"] as const) {
      it(`compiles the fixture plan for ${id} at ${aspect}`, () => {
        const template = getStyleTemplateV1(id);
        const result = compileStylePlanV1(template, fixturePlan(id, aspect), fixtureProject(aspect));
        expect(result.issues.filter(issue => issue.severity === "error")).toEqual([]);
        expect(result.jobs.map(job => job.component)).toEqual(["caption", "lightLeak", "caption", "section", "caption"]);
        expect(result.commands.filter(command => command.type === "set_clip_grade_v2")).toHaveLength(2);
        expect(result.commands.filter(command => command.type === "add_keyframe").length).toBeGreaterThan(2);
        expect(result.pendingClips.find(clip => clip.jobId.startsWith("lightLeak"))?.blendMode).toBe("screen");
        expect(result.sfx).toEqual([{ at: 3.92, cue: "pop" }]);
        expect(result.manifest.timelineBinding).toBe("pending_asset_binding");
        // Every job's frames are pure: same input → byte-identical SVG.
        for (const job of result.jobs) expect(styleJobFrame(job, Math.floor(job.frameCount / 2))).toBe(styleJobFrame(job, Math.floor(job.frameCount / 2)));
      });
    }
  }

  it("keeps captions off the face box and inside title-safe in both aspects", () => {
    for (const id of TEMPLATE_IDS) {
      for (const aspect of ["9:16", "16:9"] as const) {
        const project = fixtureProject(aspect);
        const result = compileStylePlanV1(getStyleTemplateV1(id), fixturePlan(id, aspect), project);
        const face: Box = { x0: 0.3 * project.width, y0: 0.45 * project.height, x1: 0.7 * project.width, y1: 0.95 * project.height };
        for (const job of result.jobs) {
          if (job.params.component !== "caption") continue;
          const { x, y, scale } = job.params.block;
          const boxes = captionInkBoxes(job.params);
          for (const box of boxes) {
            const placed = { x0: x + box.x0 * scale, y0: y + box.y0 * scale, x1: x + box.x1 * scale, y1: y + box.y1 * scale };
            expect(intersects(placed, face), `${id} ${aspect} ${job.id}`).toBe(false);
            expect(placed.x0).toBeGreaterThanOrEqual(project.width * 0.05 - 1);
            expect(placed.x1).toBeLessThanOrEqual(project.width * 0.95 + 1);
          }
        }
      }
    }
  });

  it("reaches the measured contrast against the sampled footage: placement first, then the template ladder", () => {
    const flat = (stats: BackgroundStats) => () => stats;
    const compileWith = (id: string, stats: BackgroundStats, plan = fixturePlan(id)) =>
      compileStylePlanV1(getStyleTemplateV1(id), plan, { ...fixtureProject(), sampleBackground: flat(stats) });
    const captions = (result: ReturnType<typeof compileWith>) => result.jobs.flatMap(job => (job.params.component === "caption" ? [job.params] : []));
    // Dark, calm footage: plain, the standard soft shadow, no plate or scrim; every beat passes 4.5:1.
    const calm = compileWith("S1_explainer_ui", { mean: 0.03, high: 0.05, low: 0.01, texture: 0.04 });
    expect(calm.captionReadability.every(row => row.step === "plain" && row.pass && row.lead >= 4.5)).toBe(true);
    for (const params of captions(calm)) { expect(params.readability.plate).toBeUndefined(); expect(params.readability.shadow?.opacity).toBe(0.6); }
    // A white page or a dense UI: S1 adds its plate and passes.
    for (const stats of [{ mean: 0.8, high: 0.9, low: 0.6, texture: 0.05 }, { mean: 0.05, high: 0.1, low: 0.01, texture: 0.2 }]) {
      const result = compileWith("S1_explainer_ui", stats);
      expect(result.captionReadability.every(row => row.step.startsWith("plate") && row.pass)).toBe(true);
      for (const params of captions(result)) expect(params.readability.plate).toBeDefined();
    }
    // S2 on bright, busy foliage: a soft scrim (never a plate); a glow keyword is not allowed there and moves into the amber box.
    const s2 = fixturePlan("S2_story_illustrated");
    const glowPlan = { ...s2, beats: s2.beats.map((beat, index) => (index === 0 ? { ...beat, treatment: "glow" as const } : beat)) };
    const foliage = compileWith("S2_story_illustrated", { mean: 0.2, high: 0.3, low: 0.1, texture: 0.2 }, glowPlan);
    expect(foliage.captionReadability.every(row => row.pass)).toBe(true);
    const first = captions(foliage)[0];
    expect(first.typography.keyword.treatment).toBe("highlightBox");
    expect(first.readability.scrim?.opacity).toBeLessThanOrEqual(0.35);
    expect(first.readability.plate).toBeUndefined();
    // S3 gradient over a mid-bright background: scrim plus the solid accent keyword (the orange stop cannot reach 4.5:1).
    const s3 = compileWith("S3_lifestyle_promo", { mean: 0.15, high: 0.25, low: 0.08, texture: 0.08 });
    const s3Keyword = s3.captionReadability.find(row => row.keyword !== undefined)!;
    expect(s3Keyword).toMatchObject({ step: "scrim+lighterKeyword", treatment: "accentColor", pass: true });
    // A white sky: the last rung sets the line in ink (no dark box on bright footage) and passes.
    const sky = compileWith("S3_lifestyle_promo", { mean: 0.9, high: 0.95, low: 0.85, texture: 0.02 });
    expect(sky.captionReadability.every(row => row.pass && row.step.endsWith("inkText"))).toBe(true);
    // Unreachable (busy mid-tones: white fails even under the 35% scrim, ink fails on the shadows): the best attempt is kept and flagged.
    const mixed = compileWith("S3_lifestyle_promo", { mean: 0.3, high: 0.5, low: 0.1, texture: 0.2 });
    expect(mixed.issues.some(issue => issue.code === "STYLE_CONTRAST_BELOW_TARGET")).toBe(true);
  });

  it("ranks placement candidates and keeps the first one identical to solvePlacement", () => {
    const request = { frame: { width: 1080, height: 1920 }, block: { width: 700, height: 360 }, avoid: [{ x0: 300, y0: 800, x1: 800, y1: 1500 }], uiBottom: 0.2, uiRight: 0.12 };
    const candidates = solvePlacementCandidates(request, 6);
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    expect(candidates[0]).toEqual(solvePlacement(request));
    for (const candidate of candidates) expect(intersects(candidate.box, request.avoid[0])).toBe(false);
  });

  it("puts a punch-in's keyframes on the footage clip under the beat and evaluates them linearly", () => {
    const template = getStyleTemplateV1("S2_story_illustrated");
    const result = compileStylePlanV1(template, fixturePlan(template.id), fixtureProject());
    const punch = result.punchIns[0];
    expect(punch.clipId).toBe("clip-a");
    expect(evaluatePunchInKeys(punch.keys, 3.0).scale).toBeCloseTo(1, 4);
    expect(evaluatePunchInKeys(punch.keys, 4.9).scale).toBeCloseTo(template.components.punchIn.scale, 6);
    const look = result.commands.find(command => command.type === "set_clip_grade_v2");
    expect(look).toMatchObject({ grade: { schema: "editkin.color-grade/v2", look: { id: "hfl2_vlog_soft_film", strength: 0.85 } } });
  });
});

function captionInkBoxes(params: KineticCaptionParams): Box[] {
  // Every glyph outline's extent, from the generated hold frame (no transforms on the words at the hold).
  const hold = params.exit.at - 0.01;
  const svg = kineticCaptionFrame(params, hold);
  const boxes: Box[] = [];
  for (const match of svg.matchAll(/<path d="([^"]+)"/g)) {
    const numbers = match[1].match(/-?\d+(?:\.\d+)?/g)!.map(Number);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let index = 0; index + 1 < numbers.length; index += 2) {
      x0 = Math.min(x0, numbers[index]); x1 = Math.max(x1, numbers[index]);
      y0 = Math.min(y0, numbers[index + 1]); y1 = Math.max(y1, numbers[index + 1]);
    }
    boxes.push({ x0, y0, x1, y1 });
  }
  return boxes;
}

describe("placement solver", () => {
  it("never overlaps a given face box (randomized)", () => {
    const rng = createSeededRng("placement-test", 7);
    let placed = 0;
    for (let trial = 0; trial < 600; trial += 1) {
      const portrait = rng.chance(0.5);
      const frame = portrait ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 };
      const fw = rng.range(0.1, 0.6) * frame.width, fh = rng.range(0.1, 0.6) * frame.height;
      const fx = rng.range(0, frame.width - fw), fy = rng.range(0, frame.height - fh);
      const face = { x0: fx, y0: fy, x1: fx + fw, y1: fy + fh };
      const block = { width: rng.range(150, 900), height: rng.range(100, 700) };
      const margin = rng.range(0, 60);
      const result = solvePlacement({ frame, block, avoid: [face], avoidMargin: margin, uiBottom: 0.2, uiRight: 0.12, preference: rng.pick(["auto", "left", "right", "top", "bottom"] as const) });
      if (!result.fits) continue;
      placed += 1;
      expect(intersects(result.box, { x0: face.x0 - margin, y0: face.y0 - margin, x1: face.x1 + margin, y1: face.y1 + margin })).toBe(false);
      expect(result.box.x0).toBeGreaterThanOrEqual(frame.width * 0.05 - 0.5);
      expect(result.box.y1).toBeLessThanOrEqual(frame.height * (portrait ? 0.8 : 0.95) + 0.5);
    }
    expect(placed).toBeGreaterThan(400);
  });

  it("clears several separate important regions (UI focus, passers-by, a dish), not just their union", () => {
    const frame = { width: 1920, height: 1080 };
    const avoid = [{ x0: 100, y0: 100, x1: 700, y1: 1000 }, { x0: 1300, y0: 100, x1: 1850, y1: 1000 }, { x0: 760, y0: 820, x1: 1240, y1: 1020 }];
    const result = solvePlacement({ frame, block: { width: 480, height: 300 }, avoid, avoidMargin: 20 });
    expect(result.fits).toBe(true);
    for (const box of avoid) expect(intersects(result.box, { x0: box.x0 - 20, y0: box.y0 - 20, x1: box.x1 + 20, y1: box.y1 + 20 })).toBe(false);
    expect(result.scale).toBe(1);
  });

  it("uses the larger negative space and hugs the subject", () => {
    const frame = { width: 1920, height: 1080 };
    const right = solvePlacement({ frame, block: { width: 600, height: 300 }, avoid: [{ x0: 200, y0: 150, x1: 800, y1: 1000 }] });
    expect(right.region).toBe("right");
    expect(right.align).toBe("start");
    const left = solvePlacement({ frame, block: { width: 600, height: 300 }, avoid: [{ x0: 1100, y0: 150, x1: 1700, y1: 1000 }] });
    expect(left.region).toBe("left");
    expect(left.align).toBe("end");
    const none = solvePlacement({ frame: { width: 1080, height: 1920 }, block: { width: 800, height: 400 }, uiBottom: 0.2 });
    expect(none.region).toBe("center_low");
    expect(none.box.y1).toBeLessThanOrEqual(1920 * 0.8);
  });
});

describe("kinetic caption timing", () => {
  it("shows each word within ±1 frame of its recognizer start, built word by word", () => {
    const fps = 30;
    for (const id of TEMPLATE_IDS) {
      const result = compileStylePlanV1(getStyleTemplateV1(id), fixturePlan(id), fixtureProject());
      for (const job of result.jobs) {
        if (job.params.component !== "caption") continue;
        const firstVisible = new Map<number, number>();
        for (let frame = 0; frame < job.frameCount; frame += 1) {
          const svg = styleJobFrame(job, frame);
          for (const state of captionWordStates(job.params, frame / fps)) {
            if (state.opacity > 0 && !firstVisible.has(state.index)) {
              firstVisible.set(state.index, job.startFrame + frame);
              expect(svg).toContain(`data-w="${state.index}"`);
            }
          }
        }
        job.params.words.forEach((word, index) => {
          const expected = Math.round((job.timelineStart + word.t0) * fps);
          expect(Math.abs(firstVisible.get(index)! - expected), `${id} ${job.id} word ${word.text}`).toBeLessThanOrEqual(1);
        });
        // Not a uniform block: at the first word's first frame the last word is not on screen yet.
        if (job.params.words.length > 1) {
          const states = captionWordStates(job.params, job.params.words[0].t0 + 1e-6);
          expect(states[states.length - 1].opacity).toBe(0);
        }
      }
    }
  });

  it("keeps the keyword 3–4× the lead and blur ≤ 8 px only during the entry", () => {
    for (const id of TEMPLATE_IDS) {
      const result = compileStylePlanV1(getStyleTemplateV1(id), fixturePlan(id), fixtureProject());
      const job = result.jobs.find(candidate => candidate.params.component === "caption" && candidate.params.words.some(word => word.role === "keyword"))!;
      const params = job.params as KineticCaptionParams;
      const ratio = params.typography.keyword.size / params.typography.lead.size;
      expect(ratio).toBeGreaterThanOrEqual(3 * (params.typography.keyword.treatment === "script" ? 0.9 : 1) - 1e-9);
      expect(ratio).toBeLessThanOrEqual(4);
      for (let frame = 0; frame < job.frameCount; frame += 1) {
        const svg = styleJobFrame(job, frame);
        for (const match of svg.matchAll(/<feGaussianBlur in="SourceGraphic" stdDeviation="([\d.]+)"/g)) {
          // Entry/exit blur on words (the glow halo is a separate, static treatment and uses larger sigmas on purpose).
          if (params.typography.keyword.treatment === "glow") continue;
          expect(Number(match[1]) * params.block.scale).toBeLessThanOrEqual(CAPTION_MAX_BLUR_PX + 1e-6);
        }
      }
      // At the hold nothing is blurred (glow aside).
      const hold = styleJobFrame(job, Math.round((params.exit.at - 0.02) * 30));
      if (params.typography.keyword.treatment !== "glow") expect(hold).not.toContain('in="SourceGraphic" stdDeviation');
    }
  });
});

describe("golden generators", () => {
  // Pinned SVG hashes: a change to a generator, layout or compiler output must be deliberate (bump the component
  // revision and re-pin with STYLE_GOLDEN_UPDATE=1).
  it("produces stable SVG for fixed inputs", () => {
    const hashes: Record<string, string> = {};
    for (const id of TEMPLATE_IDS) {
      for (const aspect of ["9:16", "16:9"] as const) {
        const result = compileStylePlanV1(getStyleTemplateV1(id), fixturePlan(id, aspect), fixtureProject(aspect));
        for (const job of result.jobs) {
          for (const frame of [0, 3, 8, Math.floor(job.frameCount / 2), job.frameCount - 1]) hashes[`${id}/${aspect}/${job.id}/${frame}`] = sha(styleJobFrame(job, frame));
        }
      }
    }
    const goldenPath = join(dirname(fileURLToPath(import.meta.url)), "styleTemplates.golden.json");
    if (process.env.STYLE_GOLDEN_UPDATE === "1") writeFileSync(goldenPath, JSON.stringify(hashes, null, 1) + "\n");
    const pinned = JSON.parse(readFileSync(goldenPath, "utf8")) as Record<string, string>;
    expect(Object.keys(pinned).length).toBeGreaterThan(100);
    expect(hashes).toEqual(pinned);
  });
});

describe("performance", () => {
  it("generates a frame in ≤ 20 ms at 1080×1920 (median of a full caption, section and leak)", () => {
    const template = getStyleTemplateV1("S2_story_illustrated");
    const result = compileStylePlanV1(template, fixturePlan(template.id), fixtureProject());
    for (const job of result.jobs) styleJobFrame(job, 0); // warm fonts and layout caches
    const times: number[] = [];
    for (const job of result.jobs) {
      for (let frame = 0; frame < job.frameCount; frame += 1) {
        const started = performance.now();
        styleJobFrame(job, frame);
        times.push(performance.now() - started);
      }
    }
    times.sort((a, b) => a - b);
    expect(times[Math.floor(times.length / 2)]).toBeLessThanOrEqual(20);
    expect(times[Math.floor(times.length * 0.95)]).toBeLessThanOrEqual(20);
  });

  it("frames are self-contained SVG without text, images or scripts", () => {
    const template = getStyleTemplateV1("S3_lifestyle_promo");
    const result = compileStylePlanV1(template, fixturePlan(template.id), fixtureProject());
    for (const job of result.jobs) {
      const svg = styleJobFrame(job, Math.floor(job.frameCount / 2));
      expect(svg.startsWith("<svg ")).toBe(true);
      expect(svg).not.toMatch(/<(?:text|image|script|foreignObject|use)\b/);
    }
    expect(sectionTitleFrame).toBeTypeOf("function");
    expect(lightLeakFrame).toBeTypeOf("function");
  });
});
