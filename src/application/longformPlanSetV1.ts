import { createHash } from "node:crypto";
import * as z from "zod/v4";
import { canonicalJson } from "../shared/canonicalJson";
import { readBoundedFile } from "../shared/boundedFile";
import {
  AUTOPILOT_MAX_PLAN_BYTES, AUTOPILOT_PLAN_SCHEMA, autopilotCommands, autopilotPlanSha256, getPlanOriginalMotionSources, parseAutopilotPlan,
  type CurrentAutopilotPlan,
} from "./autopilotPlan";
import { hasReferenceMotionSourceReplacement } from "./referenceMotionReplacementWindows";

/**
 * A long-form plan set (design E1): up to 16 sealed v4 chapter plans for ONE project. All chapters are audited
 * against the same base revision and applied together as one revision; there is no per-chapter render.
 * Plans travel by workspace path plus canonical SHA-256, never inline.
 */
export const LONGFORM_PLAN_SET_SCHEMA_V1 = "hao.video-autopilot.longform-plan-set/v1" as const;
/** planFileBytes is a hard read bound for pretty-printed files; planBytes is the single-plan limit on the plan's compact JSON. */
export const LONGFORM_PLAN_SET_LIMITS_V1 = Object.freeze({ chapters: 16, planFileBytes: 1024 * 1024, planBytes: AUTOPILOT_MAX_PLAN_BYTES, planPathCharacters: 1024 });

export type LongformPlanSetRefusalCode =
  | "LONGFORM_SET_INVALID" | "LONGFORM_SET_CHAPTER_ORDER" | "LONGFORM_SET_DUPLICATE_CHAPTER"
  | "LONGFORM_SET_PLAN_PATH" | "LONGFORM_SET_PLAN_READ" | "LONGFORM_SET_PLAN_INVALID" | "LONGFORM_SET_PLAN_NOT_V4" | "LONGFORM_SET_PLAN_SHA_MISMATCH"
  | "LONGFORM_SET_PLAN_VERSION_MISMATCH" | "LONGFORM_SET_ROUTE_NOT_LONGFORM" | "LONGFORM_SET_SOURCE_STALE" | "LONGFORM_SET_BASE_PROJECT_MISMATCH"
  | "LONGFORM_SET_ORIGINAL_MOTION_REFUSED" | "LONGFORM_SET_OWNER_REVISION_REFUSED" | "LONGFORM_SET_REFERENCE_SOURCE_REPLACEMENT_REFUSED" | "LONGFORM_SET_RELINK_REFUSED"
  | "LONGFORM_SET_EDITORIAL_OUTSIDE_RANGE" | "LONGFORM_SET_MATERIAL_RECEIPT_CONFLICT"
  | "LONGFORM_SET_ENTITY_OUTSIDE_RANGE" | "LONGFORM_SET_DUPLICATE_ENTITY_ID" | "LONGFORM_SET_FOOTPRINT_OVERLAP" | "LONGFORM_SET_ASSET_RECORD_CONFLICT"
  | "LONGFORM_SET_GLOBAL_SETTER_NOT_FIRST" | "LONGFORM_SET_GLOBAL_SETTER_REPEATED" | "LONGFORM_SET_PROJECT_FORMAT_REFUSED"
  | "LONGFORM_SET_COMMUTATIVITY" | "LONGFORM_SET_CAP_OVERFLOW" | "LONGFORM_SET_NATIVE_ASSEMBLY_REFUSED" | "LONGFORM_SET_RECEIPT_TOO_LARGE";

export interface LongformPlanSetConflictV1 { key: string; chapterIds: string[] }

/** A stable refusal: `code` never changes for the same cause; `detail` is for people. Nothing was written. */
export class LongformPlanSetRefusal extends Error {
  readonly status = "BLOCK" as const;
  constructor(readonly code: LongformPlanSetRefusalCode, readonly detail: string, readonly conflicts: readonly LongformPlanSetConflictV1[] = []) {
    super(`${code}: ${detail}`);
    this.name = "LongformPlanSetRefusal";
  }
}

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const frame = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** Chapter keys are 1–32 character slugs (VA's CHAPTER_ID_RE): they name `plans/<chapter>.v4.json` artifacts and receipts. */
export const longformChapterIdSchemaV1 = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/);
export const longformChapterRangeSchemaV1 = z.strictObject({ startFrame: frame, endFrame: frame });
export const longformPlanSetSchemaV1 = z.strictObject({
  schema: z.literal(LONGFORM_PLAN_SET_SCHEMA_V1),
  baseProject: z.strictObject({ id: z.string().min(1).max(1024), revision: frame, contentSha256: sha256 }),
  chapters: z.array(z.strictObject({
    chapterId: longformChapterIdSchemaV1,
    range: longformChapterRangeSchemaV1,
    planPath: z.string().min(1).max(LONGFORM_PLAN_SET_LIMITS_V1.planPathCharacters),
    planSha256: sha256,
  })).min(1).max(LONGFORM_PLAN_SET_LIMITS_V1.chapters),
});
export type LongformPlanSetV1 = z.infer<typeof longformPlanSetSchemaV1>;
export type LongformPlanSetChapterV1 = LongformPlanSetV1["chapters"][number];
export type LongformChapterRangeV1 = LongformPlanSetChapterV1["range"];

export interface LongformChapterPlanV1 { chapter: LongformPlanSetChapterV1; plan: CurrentAutopilotPlan; planSha256: string; planBytes: number }

/** Strict set shape, then ranges that are non-empty, ordered and disjoint, and unique chapters, paths and plans. */
export function parseLongformPlanSetV1(input: unknown): LongformPlanSetV1 {
  const parsed = longformPlanSetSchemaV1.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new LongformPlanSetRefusal("LONGFORM_SET_INVALID", `${issue?.path.join(".") || "planSet"}: ${issue?.message ?? "invalid plan set"}`);
  }
  const set = parsed.data;
  let previousEnd = 0;
  for (const [index, chapter] of set.chapters.entries()) {
    if (chapter.range.endFrame <= chapter.range.startFrame) throw new LongformPlanSetRefusal("LONGFORM_SET_CHAPTER_ORDER", `chapter ${chapter.chapterId} range must end after it starts`);
    if (index > 0 && chapter.range.startFrame < previousEnd) {
      throw new LongformPlanSetRefusal("LONGFORM_SET_CHAPTER_ORDER", `chapter ${chapter.chapterId} must start at or after frame ${previousEnd}; ranges are ordered and disjoint`,
        [{ key: "range", chapterIds: [set.chapters[index - 1].chapterId, chapter.chapterId] }]);
    }
    previousEnd = chapter.range.endFrame;
  }
  for (const [field, normalize] of [["chapterId", (value: string) => value], ["planPath", (value: string) => value.replaceAll("\\", "/").toLowerCase()],
    ["planSha256", (value: string) => value]] as const) {
    const seen = new Map<string, string>();
    for (const chapter of set.chapters) {
      const value = normalize(chapter[field]);
      const first = seen.get(value);
      if (first !== undefined) throw new LongformPlanSetRefusal("LONGFORM_SET_DUPLICATE_CHAPTER", `${field} repeats in chapters ${first} and ${chapter.chapterId}`, [{ key: field, chapterIds: [first, chapter.chapterId] }]);
      seen.set(value, chapter.chapterId);
    }
  }
  return set;
}

/** The plans' own canonical algorithm (autopilotPlan.ts autopilotPlanSha256): content and array order, not key order. */
export function longformPlanSetSha256V1(set: LongformPlanSetV1): string {
  return createHash("sha256").update(canonicalJson(set)).digest("hex");
}

const OWNER_REVISION_COMMANDS = new Set(["revise_original_motion_scene_graphic", "revise_motion_scene_graphics", "rebind_reference_motion_clip_source"]);
const RELINK_COMMANDS = new Set(["relink_asset_source"]);

function commandType(commands: unknown, types: ReadonlySet<string>, depth = 0): string | undefined {
  if (!Array.isArray(commands) || depth > 32) return undefined;
  for (const command of commands) {
    const type = command && typeof command === "object" ? (command as { type?: unknown }).type : undefined;
    if (typeof type === "string" && types.has(type)) return type;
    if (type === "batch") {
      const nested = commandType((command as { commands?: unknown }).commands, types, depth + 1);
      if (nested) return nested;
    }
  }
  return undefined;
}

/** v1 exclusions, read before the product parse so each keeps its own stable code even where that parse also refuses. */
function refuseV1Exclusions(chapterId: string, input: unknown): void {
  if (!input || typeof input !== "object" || Array.isArray(input)) return;
  const plan = input as Record<string, unknown>;
  const evidence = plan.materialEvidence && typeof plan.materialEvidence === "object" ? (plan.materialEvidence as { schema?: unknown }).schema : undefined;
  if (plan.originalMotionEvidence !== undefined || (typeof evidence === "string" && evidence.startsWith("editkin.original-motion-source/"))) {
    throw new LongformPlanSetRefusal("LONGFORM_SET_ORIGINAL_MOTION_REFUSED", `chapter ${chapterId} carries original Motion sources; v1 sets render through render_project and refuse them`);
  }
  const instances = plan.referenceMotion && typeof plan.referenceMotion === "object" ? (plan.referenceMotion as { instances?: unknown }).instances : undefined;
  if (Array.isArray(instances) && instances.some(step => step && typeof step === "object" && (step as { mode?: unknown }).mode === "replace_source")) {
    throw new LongformPlanSetRefusal("LONGFORM_SET_REFERENCE_SOURCE_REPLACEMENT_REFUSED", `chapter ${chapterId} replaces a reference template source; v1 sets refuse it`);
  }
  const relink = commandType(plan.commands, RELINK_COMMANDS);
  if (relink) throw new LongformPlanSetRefusal("LONGFORM_SET_RELINK_REFUSED", `chapter ${chapterId} contains ${relink}; relink through its own verified ingress`);
  const owner = commandType(plan.commands, OWNER_REVISION_COMMANDS);
  if (owner) throw new LongformPlanSetRefusal("LONGFORM_SET_OWNER_REVISION_REFUSED", `chapter ${chapterId} contains ${owner}; v1 sets refuse owner revisions`);
}

/** One chapter plan through the product v4 parse, plus the v1 set refusals (design E3, decision (f)3). */
export function parseLongformChapterPlanV1(chapterId: string, input: unknown): CurrentAutopilotPlan {
  refuseV1Exclusions(chapterId, input);
  let parsed: ReturnType<typeof parseAutopilotPlan>;
  try { parsed = parseAutopilotPlan(input); }
  catch (error) { throw new LongformPlanSetRefusal("LONGFORM_SET_PLAN_INVALID", `chapter ${chapterId}: ${(error instanceof Error ? error.message : String(error)).slice(0, 2000)}`); }
  if (parsed.schema !== AUTOPILOT_PLAN_SCHEMA) throw new LongformPlanSetRefusal("LONGFORM_SET_PLAN_NOT_V4", `chapter ${chapterId} is ${parsed.schema}; a plan set accepts ${AUTOPILOT_PLAN_SCHEMA} only`);
  const plan = parsed as CurrentAutopilotPlan;
  if (plan.materialEvidence.schema !== "hao.editkin.material-intelligence/v1" || getPlanOriginalMotionSources(plan) || hasReferenceMotionSourceReplacement(plan.referenceMotion)) {
    refuseV1Exclusions(chapterId, plan);
    throw new LongformPlanSetRefusal("LONGFORM_SET_ORIGINAL_MOTION_REFUSED", `chapter ${chapterId} is not a media-evidence plan`);
  }
  try { autopilotCommands(plan); }
  catch (error) { throw new LongformPlanSetRefusal("LONGFORM_SET_PLAN_INVALID", `chapter ${chapterId}: ${error instanceof Error ? error.message : String(error)}`); }
  if (plan.route.format !== "longform") throw new LongformPlanSetRefusal("LONGFORM_SET_ROUTE_NOT_LONGFORM", `chapter ${chapterId} route.format is ${plan.route.format}`);
  return plan;
}

/**
 * Bounded read from the caller's workspace resolver: at most 1 MiB of file bytes (VA writes plans pretty-printed), then the
 * single-plan limit of 256 KiB on the plan's compact JSON, the measure autopilotPlan.ts applies. Each plan must re-hash
 * to its declared SHA.
 */
export async function readLongformChapterPlansV1(set: LongformPlanSetV1, options: { resolvePlanPath: (path: string) => Promise<string>; signal?: AbortSignal }): Promise<LongformChapterPlanV1[]> {
  const chapters: LongformChapterPlanV1[] = [];
  for (const chapter of set.chapters) {
    options.signal?.throwIfAborted();
    if (!/\.json$/i.test(chapter.planPath)) throw new LongformPlanSetRefusal("LONGFORM_SET_PLAN_PATH", `chapter ${chapter.chapterId} plan must be a .json file`);
    let path: string;
    try { path = await options.resolvePlanPath(chapter.planPath); }
    catch (error) { throw new LongformPlanSetRefusal("LONGFORM_SET_PLAN_PATH", `chapter ${chapter.chapterId}: ${error instanceof Error ? error.message : String(error)}`); }
    let input: unknown;
    try {
      const bytes = await readBoundedFile(path, LONGFORM_PLAN_SET_LIMITS_V1.planFileBytes, { messages: {
        notRegular: "plan path is not a regular file", tooLarge: `plan file exceeds ${LONGFORM_PLAN_SET_LIMITS_V1.planFileBytes} bytes`, changed: "plan file changed while it was read" } });
      input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch (error) { throw new LongformPlanSetRefusal("LONGFORM_SET_PLAN_READ", `chapter ${chapter.chapterId}: ${error instanceof Error ? error.message : String(error)}`); }
    // Whitespace in the file does not count: the same compact-JSON byte length autopilotPlan.ts checks (canonical JSON has
    // the same length; only key order differs).
    const compactBytes = Buffer.byteLength(JSON.stringify(input), "utf8");
    if (compactBytes > LONGFORM_PLAN_SET_LIMITS_V1.planBytes) {
      throw new LongformPlanSetRefusal("LONGFORM_SET_PLAN_READ", `chapter ${chapter.chapterId}: plan is ${compactBytes} bytes as compact JSON; the limit is ${LONGFORM_PLAN_SET_LIMITS_V1.planBytes}`);
    }
    const plan = parseLongformChapterPlanV1(chapter.chapterId, input);
    const planSha256 = autopilotPlanSha256(plan);
    if (planSha256 !== chapter.planSha256) throw new LongformPlanSetRefusal("LONGFORM_SET_PLAN_SHA_MISMATCH", `chapter ${chapter.chapterId} plan re-hashes to ${planSha256}, not the sealed ${chapter.planSha256}`);
    chapters.push({ chapter, plan, planSha256, planBytes: Buffer.byteLength(JSON.stringify(plan), "utf8") });
  }
  return chapters;
}

/** Every chapter is one version of the same run: identical source, route, assurances, quality state, look and Skill selection. */
export function assertLongformChapterPlanVersionsV1(chapters: readonly LongformChapterPlanV1[]): void {
  const fields: Array<[string, (plan: CurrentAutopilotPlan) => unknown]> = [
    ["source", plan => plan.source], ["route", plan => plan.route], ["assurances", plan => plan.assurances],
    ["quality.state", plan => plan.quality.state], ["aesthetic", plan => plan.aesthetic], ["extensions.skillSelection", plan => plan.extensions.skillSelection],
  ];
  const [first, ...rest] = chapters;
  for (const [field, read] of fields) {
    const expected = canonicalJson(read(first.plan));
    for (const other of rest) {
      if (canonicalJson(read(other.plan)) !== expected) {
        throw new LongformPlanSetRefusal("LONGFORM_SET_PLAN_VERSION_MISMATCH", `chapter ${other.chapter.chapterId} ${field} differs from chapter ${first.chapter.chapterId}`,
          [{ key: field, chapterIds: [first.chapter.chapterId, other.chapter.chapterId] }]);
      }
    }
  }
}

/** Every editorial frame (beats, graphics, cuts, audio accents, colour exceptions) lies inside the chapter's own range. */
export function assertLongformEditorialRangesV1(chapter: LongformPlanSetChapterV1, plan: CurrentAutopilotPlan): void {
  const { startFrame, endFrame } = chapter.range;
  const outside = (what: string) => new LongformPlanSetRefusal("LONGFORM_SET_EDITORIAL_OUTSIDE_RANGE",
    `chapter ${chapter.chapterId} ${what} lies outside its range ${startFrame}–${endFrame}`, [{ key: what, chapterIds: [chapter.chapterId] }]);
  const span = (what: string, range: { startFrame: number; endFrame: number }) => {
    if (range.startFrame < startFrame || range.endFrame > endFrame) throw outside(what);
  };
  const point = (what: string, value: number) => { if (value < startFrame || value >= endFrame) throw outside(what); };
  const editorial = plan.editorial;
  for (const beat of editorial.narrative.beats) span(`beat ${beat.id}`, beat.range);
  for (const graphic of editorial.graphics) span(`graphic ${graphic.id}`, graphic.range);
  for (const exception of editorial.color.exceptions) span("colour exception", exception.range);
  for (const transition of editorial.transitions) point(`transition ${transition.id}`, transition.atFrame);
  for (const value of editorial.audio.impactFrames) point(`impact frame ${value}`, value);
  for (const value of editorial.audio.breathFrames) point(`breath frame ${value}`, value);
}

/** The same materialId must carry an identical receipt in every chapter that cites it. */
export function assertLongformMaterialReceiptsV1(chapters: readonly LongformChapterPlanV1[]): number {
  const seen = new Map<string, { chapterId: string; receipt: string }>();
  for (const { chapter, plan } of chapters) {
    for (const receipt of plan.materialEvidence.receipts) {
      const identity = canonicalJson(receipt);
      const first = seen.get(receipt.materialId);
      if (!first) { seen.set(receipt.materialId, { chapterId: chapter.chapterId, receipt: identity }); continue; }
      if (first.receipt !== identity) {
        throw new LongformPlanSetRefusal("LONGFORM_SET_MATERIAL_RECEIPT_CONFLICT", `material ${receipt.materialId} differs between chapters ${first.chapterId} and ${chapter.chapterId}`,
          [{ key: `material:${receipt.materialId}`, chapterIds: [first.chapterId, chapter.chapterId] }]);
      }
    }
  }
  return seen.size;
}
