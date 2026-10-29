import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useTempRoots } from "../test/tempRoot.mjs";
import { createEmptyProject } from "../domain/editGraph";
import { createAutopilotV3Fixture, createAutopilotV4Fixture } from "./autopilotPlanFixture";
import { autopilotPlanSha256, parseAutopilotPlan, type CurrentAutopilotPlan } from "./autopilotPlan";
import { canonicalJson, sha256Canonical, sha256Text } from "./autopilotInvocationIdentity";
import { originalMotionCueEvidenceReference, prepareOriginalMotionSourceEvidence } from "./originalMotionSourceEvidence";
import type { OriginalMotionScene2dInput } from "./originalMotionScene2d";
import {
  LONGFORM_PLAN_SET_LIMITS_V1, LONGFORM_PLAN_SET_SCHEMA_V1, LongformPlanSetRefusal, assertLongformChapterPlanVersionsV1, assertLongformEditorialRangesV1,
  assertLongformMaterialReceiptsV1, longformPlanSetSha256V1, parseLongformChapterPlanV1, parseLongformPlanSetV1, readLongformChapterPlansV1,
  type LongformChapterPlanV1, type LongformPlanSetV1,
} from "./longformPlanSetV1";
import { createEmptyEditkinSkillSelectionReceipt, editkinSkillFormatForAutopilotRoute } from "../plugins/skillPack";
import { resolveAestheticSystemForDomain } from "./editkinAesthetic";

const temp = useTempRoots();
/** Test-only mutable view of a fixture plan, so a case can add or rewrite any top-level field. */
type MutablePlan = Record<string, any>;

/** A v4 chapter plan whose every editorial frame sits in `range` (90 frames: three 30-frame beats). */
function chapterPlan(range: { startFrame: number; endFrame: number }, materialId = "c".repeat(64), mutate?: (plan: MutablePlan) => void) {
  const plan = structuredClone(createAutopilotV4Fixture()) as unknown as MutablePlan;
  const start = range.startFrame;
  plan.editorial.narrative.beats = plan.editorial.narrative.beats.map((beat: { range: object }, index: number) => ({ ...beat, range: { startFrame: start + index * 30, endFrame: start + (index + 1) * 30 } }));
  plan.editorial.transitions = plan.editorial.transitions.map((transition: object) => ({ ...transition, atFrame: start + 30 }));
  plan.editorial.audio.impactFrames = [start + 60];
  plan.editorial.audio.breathFrames = [start + 30];
  plan.materialEvidence.receipts = [{ ...plan.materialEvidence.receipts[0], materialId }];
  plan.commands = [plan.commands[0]];
  mutate?.(plan);
  return plan;
}

function setFor(chapters: Array<{ chapterId: string; range: { startFrame: number; endFrame: number }; planPath?: string; planSha256?: string }>): LongformPlanSetV1 {
  return {
    schema: LONGFORM_PLAN_SET_SCHEMA_V1,
    baseProject: { id: "project-set", revision: 3, contentSha256: "a".repeat(64) },
    chapters: chapters.map((chapter, index) => ({ planPath: `plans/${chapter.chapterId}.v4.json`, planSha256: index.toString(16).padStart(64, "0"), ...chapter })),
  };
}

function refusal(run: () => unknown) {
  try { run(); } catch (error) {
    expect(error).toBeInstanceOf(LongformPlanSetRefusal);
    return error as LongformPlanSetRefusal;
  }
  throw new Error("expected a refusal");
}

async function asyncRefusal(run: () => Promise<unknown>) {
  try { await run(); } catch (error) {
    expect(error).toBeInstanceOf(LongformPlanSetRefusal);
    return error as LongformPlanSetRefusal;
  }
  throw new Error("expected a refusal");
}

describe("long-form plan set v1 (E1)", () => {
  const two = [{ chapterId: "intro", range: { startFrame: 0, endFrame: 90 } }, { chapterId: "setup-2", range: { startFrame: 90, endFrame: 180 } }];

  it("parses a strict ordered set and hashes it with the plans' canonical algorithm", () => {
    const set = parseLongformPlanSetV1(setFor(two));
    expect(set.chapters.map(chapter => chapter.chapterId)).toEqual(["intro", "setup-2"]);
    // VA's CHAPTER_ID_RE: 1–32 lower-case slug characters, inner hyphens only.
    expect(parseLongformPlanSetV1(setFor([{ chapterId: `a${"-b".repeat(15)}c`, range: { startFrame: 0, endFrame: 10 } }])).chapters[0].chapterId).toHaveLength(32);
    const reordered = JSON.parse(JSON.stringify({ chapters: set.chapters.map(({ planSha256, range, planPath, chapterId }) => ({ planSha256, range, planPath, chapterId })),
      baseProject: { contentSha256: set.baseProject.contentSha256, revision: set.baseProject.revision, id: set.baseProject.id }, schema: set.schema }));
    expect(longformPlanSetSha256V1(parseLongformPlanSetV1(reordered))).toBe(longformPlanSetSha256V1(set));
    expect(longformPlanSetSha256V1(set)).toBe(sha256Text(canonicalJson(set)));
    const changed = structuredClone(set); changed.chapters[1].planSha256 = "f".repeat(64);
    expect(longformPlanSetSha256V1(changed)).not.toBe(longformPlanSetSha256V1(set));
  });

  it.each([
    ["extra key", { ...setFor(two), extra: true }],
    ["17 chapters", setFor(Array.from({ length: 17 }, (_, index) => ({ chapterId: `c${index}`, range: { startFrame: index * 10, endFrame: index * 10 + 10 } })))],
    ["upper-case chapter key", setFor([{ chapterId: "Intro", range: { startFrame: 0, endFrame: 10 } }])],
    ["33-character chapter key", setFor([{ chapterId: "a".repeat(33), range: { startFrame: 0, endFrame: 10 } }])],
    ["chapter key ending in a hyphen", setFor([{ chapterId: "intro-", range: { startFrame: 0, endFrame: 10 } }])],
    ["chapter key with an underscore", setFor([{ chapterId: "intro_1", range: { startFrame: 0, endFrame: 10 } }])],
    ["fractional frame", setFor([{ chapterId: "intro", range: { startFrame: 0.5, endFrame: 10 } }])],
  ])("refuses an invalid set shape: %s", (_name, input) => {
    expect(refusal(() => parseLongformPlanSetV1(input)).code).toBe("LONGFORM_SET_INVALID");
  });

  it.each([
    ["empty range", [{ chapterId: "a", range: { startFrame: 10, endFrame: 10 } }]],
    ["overlapping ranges", [{ chapterId: "a", range: { startFrame: 0, endFrame: 100 } }, { chapterId: "b", range: { startFrame: 90, endFrame: 180 } }]],
    ["unordered ranges", [{ chapterId: "a", range: { startFrame: 100, endFrame: 200 } }, { chapterId: "b", range: { startFrame: 0, endFrame: 90 } }]],
  ])("refuses chapter ranges that are not ordered, disjoint and non-empty: %s", (_name, chapters) => {
    const error = refusal(() => parseLongformPlanSetV1(setFor(chapters)));
    expect(error.code).toBe("LONGFORM_SET_CHAPTER_ORDER");
    expect(error.message).toMatch(/^LONGFORM_SET_CHAPTER_ORDER: /);
  });

  it("refuses repeated chapter keys, plan paths (case and slash insensitive) and plan hashes", () => {
    expect(refusal(() => parseLongformPlanSetV1(setFor([two[0], { ...two[1], chapterId: "intro" }]))).code).toBe("LONGFORM_SET_DUPLICATE_CHAPTER");
    const paths = setFor(two); paths.chapters[1].planPath = "PLANS\\intro.v4.json";
    expect(refusal(() => parseLongformPlanSetV1(paths)).conflicts).toEqual([{ key: "planPath", chapterIds: ["intro", "setup-2"] }]);
    const hashes = setFor(two); hashes.chapters[1].planSha256 = hashes.chapters[0].planSha256;
    expect(refusal(() => parseLongformPlanSetV1(hashes)).code).toBe("LONGFORM_SET_DUPLICATE_CHAPTER");
  });

  it("reads each plan bounded from the resolver and requires it to re-hash to its sealed SHA", async () => {
    const root = await temp.create("editkin-planset-read-");
    await mkdir(join(root, "plans"));
    const plans = [chapterPlan(two[0].range, "c".repeat(64)), chapterPlan(two[1].range, "d".repeat(64))];
    const shas = plans.map(plan => autopilotPlanSha256(parseAutopilotPlan(plan)));
    for (const [index, plan] of plans.entries()) await writeFile(join(root, "plans", `${two[index].chapterId}.v4.json`), JSON.stringify(plan));
    const set = parseLongformPlanSetV1(setFor(two.map((chapter, index) => ({ ...chapter, planSha256: shas[index] }))));
    const resolvePlanPath = async (path: string) => join(root, path);
    const read = await readLongformChapterPlansV1(set, { resolvePlanPath });
    expect(read.map(chapter => chapter.planSha256)).toEqual(shas);
    expect(read[1].plan.materialEvidence.receipts[0].materialId).toBe("d".repeat(64));

    const wrong = structuredClone(set); wrong.chapters[1].planSha256 = "e".repeat(64);
    expect((await asyncRefusal(() => readLongformChapterPlansV1(wrong, { resolvePlanPath }))).code).toBe("LONGFORM_SET_PLAN_SHA_MISMATCH");
    await writeFile(join(root, "plans", "setup-2.v4.json"), JSON.stringify({ padding: "x".repeat(LONGFORM_PLAN_SET_LIMITS_V1.planFileBytes) }));
    expect((await asyncRefusal(() => readLongformChapterPlansV1(set, { resolvePlanPath }))).detail).toMatch(/setup-2: plan file exceeds 1048576 bytes/);
    await writeFile(join(root, "plans", "setup-2.v4.json"), Buffer.from([0x7b, 0xff, 0x7d]));
    expect((await asyncRefusal(() => readLongformChapterPlansV1(set, { resolvePlanPath }))).code).toBe("LONGFORM_SET_PLAN_READ");
    await writeFile(join(root, "plans", "setup-2.v4.json"), "{ not json");
    expect((await asyncRefusal(() => readLongformChapterPlansV1(set, { resolvePlanPath }))).code).toBe("LONGFORM_SET_PLAN_READ");
    const notJson = structuredClone(set); notJson.chapters[0].planPath = "plans/intro.v4.txt";
    expect((await asyncRefusal(() => readLongformChapterPlansV1(notJson, { resolvePlanPath }))).code).toBe("LONGFORM_SET_PLAN_PATH");
    const outside = async () => { throw new Error("projectPath 超出 EDITKIN_WORKSPACE"); };
    expect((await asyncRefusal(() => readLongformChapterPlansV1(set, { resolvePlanPath: outside }))).detail).toMatch(/intro: projectPath 超出/);
  });

  it("bounds plan files at 1 MiB but measures the plan as compact JSON, exactly like a single plan", async () => {
    const root = await temp.create("editkin-planset-size-");
    await mkdir(join(root, "plans"));
    const limit = LONGFORM_PLAN_SET_LIMITS_V1.planBytes;
    const sized = (compactBytes: number) => {
      const plan = chapterPlan(two[0].range, "c".repeat(64), mutable => {
        mutable.commands.push({ type: "add_caption", caption: { id: "long-note", text: "", start: 1, duration: 1 } });
      });
      plan.commands[1].caption.text = "x".repeat(compactBytes - Buffer.byteLength(JSON.stringify(plan), "utf8"));
      expect(Buffer.byteLength(JSON.stringify(plan), "utf8")).toBe(compactBytes);
      return plan;
    };
    // VA writes indent=2 JSON: this file is over 256 KiB while the plan itself sits exactly at the single-plan limit.
    const fits = sized(limit);
    const pretty = `${JSON.stringify(fits, null, 2)}\n`;
    expect(Buffer.byteLength(pretty, "utf8")).toBeGreaterThan(limit);
    await writeFile(join(root, "plans", "intro.v4.json"), pretty);
    const set = parseLongformPlanSetV1(setFor([{ ...two[0], planSha256: autopilotPlanSha256(parseAutopilotPlan(fits)) }]));
    const resolvePlanPath = async (path: string) => join(root, path);
    expect((await readLongformChapterPlansV1(set, { resolvePlanPath }))[0].plan.commands).toHaveLength(2);
    // One byte over the limit as compact JSON is refused with the existing code, however the file is formatted.
    await writeFile(join(root, "plans", "intro.v4.json"), `${JSON.stringify(sized(limit + 1), null, 2)}\n`);
    const refused = await asyncRefusal(() => readLongformChapterPlansV1(set, { resolvePlanPath }));
    expect([refused.code, refused.detail]).toEqual(["LONGFORM_SET_PLAN_READ", `chapter intro: plan is ${limit + 1} bytes as compact JSON; the limit is ${limit}`]);
    expect(() => parseAutopilotPlan(sized(limit + 1))).toThrow(/超過 262144 bytes/);
  });

  it("refuses non-v4, non-long-form and v1-excluded chapter plans with stable codes", async () => {
    expect(refusal(() => parseLongformChapterPlanV1("a", createAutopilotV3Fixture())).code).toBe("LONGFORM_SET_PLAN_NOT_V4");
    expect(refusal(() => parseLongformChapterPlanV1("a", { schema: "hao.video-autopilot.edit-plan/v4" })).code).toBe("LONGFORM_SET_PLAN_INVALID");
    const relink = chapterPlan(two[0].range, undefined, plan => { plan.commands.push({ type: "relink_asset_source", assetId: "asset-source-1", sourceUri: "moved.mp4", expectedSourceSha256: "d".repeat(64) }); });
    expect(refusal(() => parseLongformChapterPlanV1("a", relink)).code).toBe("LONGFORM_SET_RELINK_REFUSED");
    const nested = chapterPlan(two[0].range, undefined, plan => { plan.commands.push({ type: "batch", commands: [{ type: "relink_asset_source", assetId: "asset-source-1", sourceUri: "moved.mp4", expectedSourceSha256: "d".repeat(64) }] }); });
    expect(refusal(() => parseLongformChapterPlanV1("a", nested)).code).toBe("LONGFORM_SET_RELINK_REFUSED");
    const rebind = chapterPlan(two[0].range, undefined, plan => { plan.commands.push({ type: "rebind_reference_motion_clip_source", clipId: "clip-source-1",
      expected: { assetId: "asset-source-1", sourceStart: 0, duration: 1 }, assetId: "asset-source-1", sourceStart: 1, duration: 1 }); });
    expect(refusal(() => parseLongformChapterPlanV1("a", rebind)).code).toBe("LONGFORM_SET_OWNER_REVISION_REFUSED");
    const replace = chapterPlan(two[0].range, undefined, plan => { plan.referenceMotion = { schema: "editkin.reference-motion-plan/v1", instances: [{ mode: "replace_source" }] }; });
    expect(refusal(() => parseLongformChapterPlanV1("a", replace)).code).toBe("LONGFORM_SET_REFERENCE_SOURCE_REPLACEMENT_REFUSED");
    const shorts = chapterPlan(two[0].range, undefined, plan => {
      plan.route = { ...plan.route, format: "shorts" };
      plan.aesthetic = resolveAestheticSystemForDomain(plan.route.domain, "shorts");
      plan.commands = [{ type: "set_aesthetic_system", aestheticSystem: plan.aesthetic }];
      plan.extensions = { ...plan.extensions, skillSelection: createEmptyEditkinSkillSelectionReceipt(plan.source.pluginRegistrySha256,
        { format: editkinSkillFormatForAutopilotRoute("shorts"), domain: plan.route.domain, semanticRoles: [] }) };
    });
    expect(refusal(() => parseLongformChapterPlanV1("a", shorts)).code).toBe("LONGFORM_SET_ROUTE_NOT_LONGFORM");
    expect(parseLongformChapterPlanV1("a", chapterPlan(two[0].range)).schema).toBe("hao.video-autopilot.edit-plan/v4");
  });

  it("refuses original Motion sources in a v1 set", async () => {
    const root = await temp.create("editkin-planset-original-");
    const before = createEmptyProject("Original refusal", { id: "project-original", width: 640, height: 360, fps: 30 });
    const input: OriginalMotionScene2dInput = { sceneId: "set-scene", expectedRevision: before.revision, intent: "standalone_showcase",
      reason: "Keep an original stable panel through three authored camera cues", startFrame: 0, durationFrames: 90,
      safeArea: { left: 20, right: 20, top: 20, bottom: 20 },
      style: { palette: { surface: "#FFFFFF", text: "#172033", accent: "#175CD3", muted: "#5B6678", separator: "#D8DEE8" }, typography: { headingFamily: "Bebas Neue", bodyFamily: "Noto Sans TC" }, animationSpeed: 1 },
      camera: { initial: { centerX: 320, centerY: 180, zoom: 1 }, dynamics: { stiffness: 120, damping: 24, mass: 1 } },
      elements: [{ id: "set-panel", kind: "panel", range: { startFrame: 0, endFrame: 90 }, xPixels: 220, yPixels: 140, widthPixels: 120, heightPixels: 70, cornerRadiusPixels: 8, colorRole: "accent" }],
      semanticCues: [0, 35, 70].map((frame, index) => ({ id: `phase-${index}`, frame, purpose: "Authored stable-panel handoff", graphicIds: ["set-panel"], evidenceRefs: [`brief:phase-${index}`], focus: { centerX: 320 + index, centerY: 180, zoom: 1 } })),
    };
    const rights = { origin: "self_authored" as const, medium: "native_vector_and_glyph" as const, contentKind: "authored_illustration" as const, realityProof: false as const, importedReferenceMedia: false as const, declaration: "Original test illustration with no external media or factual proof" };
    const payload = { schema: "editkin.original-motion-authoring/v1", usage: "standalone", audio: "silent", fps: before.fps, authoring: input, rights, fontBindings: [] };
    const raw = `${canonicalJson(payload)}\n`;
    await writeFile(join(root, "source.json"), raw);
    const prepared = await prepareOriginalMotionSourceEvidence(before, input, rights, 1, { authoringSource: {
      sourcePath: ".editkin/original-sources/set.json", sourceSha256: sha256Text(raw), sourcePayloadSha256: sha256Canonical(payload), bytes: Buffer.byteLength(raw) } });
    const base = createAutopilotV4Fixture();
    const original = { ...base, materialEvidence: { schema: "editkin.original-motion-source/v1", sources: [prepared.evidence], receipts: [] },
      commands: [base.commands[0], ...prepared.preparation.commands], editorial: { ...base.editorial, graphics: prepared.preparation.editorialGraphics, transitions: [],
        narrative: { ...base.editorial.narrative, beats: base.editorial.narrative.beats.map((beat, index) => ({ ...beat, range: { startFrame: index * 30, endFrame: (index + 1) * 30 },
          evidenceRefs: [originalMotionCueEvidenceReference(prepared.evidence.sourceSha256, `phase-${index}`)] })) },
        audio: { ...base.editorial.audio, mode: "silent_original", layers: [], impactFrames: [], breathFrames: [] },
        color: { ...base.editorial.color, sourceMode: "authored_palette", shotMatchRequired: false } } };
    expect(parseAutopilotPlan(original).schema).toBe("hao.video-autopilot.edit-plan/v4");
    expect(refusal(() => parseLongformChapterPlanV1("original", original)).code).toBe("LONGFORM_SET_ORIGINAL_MOTION_REFUSED");
  });

  it("requires every chapter to be the same plan version and keeps editorial frames inside each chapter", () => {
    const chapter = (index: number, mutate?: (plan: MutablePlan) => void): LongformChapterPlanV1 => {
      const plan = parseAutopilotPlan(chapterPlan(two[index].range, String(index + 1).repeat(64), mutate)) as CurrentAutopilotPlan;
      return { chapter: { ...setFor(two).chapters[index] }, plan, planSha256: autopilotPlanSha256(plan), planBytes: 1 };
    };
    expect(() => assertLongformChapterPlanVersionsV1([chapter(0), chapter(1)])).not.toThrow();
    const quality = refusal(() => assertLongformChapterPlanVersionsV1([chapter(0), chapter(1, plan => { plan.quality = { state: "draft" }; })]));
    expect([quality.code, quality.conflicts]).toEqual(["LONGFORM_SET_PLAN_VERSION_MISMATCH", [{ key: "quality.state", chapterIds: ["intro", "setup-2"] }]]);
    expect(refusal(() => assertLongformChapterPlanVersionsV1([chapter(0), chapter(1, plan => { plan.source = { ...plan.source, revision: 184 }; })])).detail)
      .toMatch(/source differs/);

    expect(() => assertLongformEditorialRangesV1(chapter(1).chapter, chapter(1).plan)).not.toThrow();
    const late = chapter(0, plan => { plan.editorial.audio.impactFrames = [90]; });
    expect(refusal(() => assertLongformEditorialRangesV1(late.chapter, late.plan)).code).toBe("LONGFORM_SET_EDITORIAL_OUTSIDE_RANGE");
    const cut = chapter(1, plan => { plan.editorial.transitions = [{ ...plan.editorial.transitions[0], atFrame: 89 }]; });
    expect(refusal(() => assertLongformEditorialRangesV1(cut.chapter, cut.plan)).detail).toMatch(/transition cut-1 lies outside its range 90–180/);
    const beat = chapter(1, plan => { plan.editorial.narrative.beats[2].range = { startFrame: 150, endFrame: 181 }; });
    expect(refusal(() => assertLongformEditorialRangesV1(beat.chapter, beat.plan)).detail).toMatch(/beat payoff/);
  });

  it("allows one materialId in several chapters only with an identical receipt", () => {
    const shared = "9".repeat(64);
    const chapter = (index: number, sourceSha256?: string): LongformChapterPlanV1 => {
      const plan = parseAutopilotPlan(chapterPlan(two[index].range, shared, sourceSha256 ? plan => {
        plan.materialEvidence.receipts = [{ ...plan.materialEvidence.receipts[0], sourceSha256 }];
      } : undefined)) as CurrentAutopilotPlan;
      return { chapter: setFor(two).chapters[index], plan, planSha256: autopilotPlanSha256(plan), planBytes: 1 };
    };
    expect(assertLongformMaterialReceiptsV1([chapter(0), chapter(1)])).toBe(1);
    const conflict = refusal(() => assertLongformMaterialReceiptsV1([chapter(0), chapter(1, "7".repeat(64))]));
    expect([conflict.code, conflict.conflicts]).toEqual(["LONGFORM_SET_MATERIAL_RECEIPT_CONFLICT", [{ key: `material:${shared}`, chapterIds: ["intro", "setup-2"] }]]);
  });
});
