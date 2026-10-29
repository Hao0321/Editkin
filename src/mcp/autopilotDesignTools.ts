import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";
import { designRequestSchema, assertDesignDecisionBinding, assertNativeTemplateDirectionBinding, type DesignRequest } from "../application/autopilotDesignContract";
import { getPlanOriginalMotionSources, type CurrentAutopilotPlan } from "../application/autopilotPlan";
import { canonicalOriginalVisibleProjection } from "../application/originalMotionSourceSets";
import { readLiveAutopilotIdentity, resolveLiveVideoAutopilotSkillPath, sha256Canonical } from "../application/autopilotInvocationIdentity";
import { assertMotionTreatmentBinding } from "../application/motionTreatment";
import { assertScopedMotionRevisionEffects } from "../application/scopedMotionRevision";
import { assertScopedPaletteRevisionEffects } from "../application/scopedPaletteRevision";
import { referenceMotionVisibleProjectionCompatible as referenceMotionVisibleProjection } from "../application/referenceMotionSourcePlanV2";
import { verifyReferenceMotionPlan } from "./referenceMotionPlanVerification";
import type { EditProject } from "../domain/types";
import type { EditorCommand } from "../domain/commands";
import { readProject } from "./storage";
import { normalizeReviewPolicy, reviewPolicyActor } from "../domain/reviewPolicy";
import type { AestheticReviewPolicy } from "../domain/types";
import { readCreatorReviewPolicy, assertCreatorReviewPolicyCurrent } from "./creatorReviewPolicy";

export interface CurrentDesignBrief {
  schema: "hao.editkin.current-design-brief/v1";
  request: DesignRequest;
  sources: { path: string; sha256: string }[];
  sourceSha256: string;
  reviewPolicy: AestheticReviewPolicy;
  reviewPolicySha256: string;
  context: unknown;
  recipes: { beatId: string; recipe: { route: { primary_family: string }; [key: string]: unknown } }[];
}
export interface CurrentDesignOptions { skillPath?: string; pluginRoots?: string[]; reviewPolicy?: AestheticReviewPolicy }

export function assertDesignReviewPolicy(brief: CurrentDesignBrief, input?: AestheticReviewPolicy) {
  const policy = normalizeReviewPolicy(input), hash = sha256Canonical(policy), actor = reviewPolicyActor(policy);
  const checkpoint = actor === "agent" ? "agent_review" : "human_review";
  const context = brief.context as { review?: Record<string, unknown>; learning?: { quality_95?: Record<string, unknown> }; craft?: { qa?: Record<string, any> } } | null;
  const review = context?.review;
  if (sha256Canonical(brief.reviewPolicy) !== hash || brief.reviewPolicySha256 !== hash ||
      !review || sha256Canonical(review.policy) !== hash || review.policySha256 !== hash ||
      review.actor !== actor || review.checkpoint !== checkpoint || review.required !== true || review.completed !== false) {
    throw new Error("Current design review policy is missing or differs from trusted creator authority");
  }
  if (context && Object.prototype.hasOwnProperty.call(context, "learning") &&
      (!context.learning || context.learning.quality_95?.review_mode !== policy.mode || context.learning.quality_95?.policy_sha256_12 !== hash.slice(0, 12))) {
    throw new Error("Current learning context review policy differs from creator authority");
  }
  if (context && Object.prototype.hasOwnProperty.call(context, "craft")) {
    const qa = context.craft?.qa;
    if (!qa || sha256Canonical(qa.review_policy) !== hash || qa.review_policy_sha256 !== hash ||
        qa.visual_review?.actor !== actor || qa.visual_review?.checkpoint !== checkpoint ||
        qa.visual_review?.required !== true || qa.visual_review?.completed !== false ||
        qa.human_review?.required !== (actor === "human") || qa.human_review?.completed !== false) {
      throw new Error("Current craft review policy differs from creator authority or claims completed review");
    }
  }
}

export async function compileCurrentDesign(request: DesignRequest, options: CurrentDesignOptions = {}): Promise<CurrentDesignBrief> {
  const policy = normalizeReviewPolicy(options.reviewPolicy);
  const skillPath = await resolveLiveVideoAutopilotSkillPath(options.skillPath);
  await readLiveAutopilotIdentity({ skillPath, pluginRoots: options.pluginRoots });
  const script = resolve(dirname(skillPath), "editkin_design_bridge.py");
  const { stdout } = await promisify(execFile)(process.env.EDITKIN_PYTHON_EXECUTABLE ?? "python", ["-B", "-X", "utf8", script, "--request-json", JSON.stringify(request), "--review-policy-json", JSON.stringify(policy)], {
    windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024, encoding: "utf8",
  });
  const brief = JSON.parse(stdout) as CurrentDesignBrief;
  if (brief.schema !== "hao.editkin.current-design-brief/v1" ||
      sha256Canonical(brief.request) !== sha256Canonical(request) ||
      !Array.isArray(brief.sources) || brief.sources.length === 0 ||
      brief.sources.some(row => !row || typeof row.path !== "string" || !/^[a-f0-9]{64}$/.test(row.sha256)) ||
      brief.sourceSha256 !== sha256Canonical(brief.sources) ||
      !Array.isArray(brief.recipes) || brief.recipes.length !== request.beats.length ||
      brief.recipes.some((row, i) => row.beatId !== request.beats[i].id || !row.recipe?.route?.primary_family)) {
    throw new Error("Current Skill design compiler returned an invalid brief");
  }
  assertDesignReviewPolicy(brief, policy);
  return brief;
}

/**
 * W3-6: the compiled brief, cached per (request, review policy, Skill, plugin roots, interpreter). Every hit re-hashes
 * each source file the brief names (Skill, contract, design runtime, references, learning memory) and recompiles when
 * any byte changed, so pages 2…n and the one-call read no longer re-run Python. Audit and apply never use this cache:
 * verifyAutopilotDesign always recompiles, and forgets every cached brief when the identity it bound has changed.
 */
const DESIGN_CACHE_TTL_MS = 10 * 60_000;
const DESIGN_CACHE_MAX_ENTRIES = 16;
const designCache = new Map<string, { brief: CurrentDesignBrief; root: string; at: number }>();
export function forgetCurrentDesignBriefs(): void { designCache.clear(); }

async function sourcesUnchanged(root: string, sources: CurrentDesignBrief["sources"]): Promise<boolean> {
  try {
    for (const source of sources) {
      if (createHash("sha256").update(await readFile(resolve(root, source.path))).digest("hex") !== source.sha256) return false;
    }
    return true;
  } catch { return false; }
}

export async function compileCurrentDesignCached(request: DesignRequest, options: CurrentDesignOptions = {}, compile = compileCurrentDesign): Promise<{ brief: CurrentDesignBrief; cacheHit: boolean }> {
  const policy = normalizeReviewPolicy(options.reviewPolicy);
  const skillPath = await resolveLiveVideoAutopilotSkillPath(options.skillPath);
  const key = sha256Canonical({ request, policy, skillPath, pluginRoots: options.pluginRoots ?? null, python: process.env.EDITKIN_PYTHON_EXECUTABLE ?? "python" });
  const cached = designCache.get(key);
  if (cached && Date.now() - cached.at < DESIGN_CACHE_TTL_MS && await sourcesUnchanged(cached.root, cached.brief.sources)) {
    return { brief: structuredClone(cached.brief), cacheHit: true };
  }
  const brief = await compile(request, { ...options, skillPath, reviewPolicy: policy });
  designCache.delete(key);
  designCache.set(key, { brief: structuredClone(brief), root: dirname(skillPath), at: Date.now() });
  while (designCache.size > DESIGN_CACHE_MAX_ENTRIES) designCache.delete(designCache.keys().next().value!);
  return { brief, cacheHit: false };
}

export function designIdentity(brief: CurrentDesignBrief, project: EditProject) {
  return { projectSha256: sha256Canonical(project), sourceSha256: brief.sourceSha256, briefSha256: sha256Canonical(brief) };
}

// Stateless and deterministic: a paused batch can re-read the same current brief
// after a host restart. Source/project drift invalidates it without rewriting plans.
export async function verifyAutopilotDesign(plan: CurrentAutopilotPlan, project: EditProject,
  compile = compileCurrentDesign, options: CurrentDesignOptions = {},
  captureNativePaintOwnerRevision?: (proof: object) => void, captureReferenceMotionSourceOwner?: (proof: object) => void) {
  const policy = normalizeReviewPolicy(options.reviewPolicy);
  if (sha256Canonical(normalizeReviewPolicy(plan.inference.safeguards.reviewPolicy)) !== sha256Canonical(policy) ||
      plan.inference.safeguards.humanReviewRequired !== (policy.mode === "human")) {
    throw new Error("Plan review policy differs from trusted creator authority");
  }
  const evidence = plan.designEvidence;
  if (!evidence) throw new Error("Current Skill designEvidence is required; call get_autopilot_design_brief before authoring the plan");
  const original = getPlanOriginalMotionSources(plan);
  const expectedScope = original ? { schema: "editkin.original-motion-design-scope/v1", sourceSetSha256: sha256Canonical(original), usage: plan.materialEvidence.schema !== "hao.editkin.material-intelligence/v1" ? "standalone" : "authored_overlay" } : undefined;
  if (sha256Canonical(evidence.request.originalSourceScope ?? null) !== sha256Canonical(expectedScope ?? null)) throw new Error("Design request original-source scope differs from the actual plan");
  if (!plan.editorial.motionTreatment) throw new Error("All ten motionTreatment families must explicitly use or omit with a reason");
  if (evidence.request.format !== plan.route.format || evidence.request.domain !== plan.route.domain) throw new Error("Design request route differs from the plan");
  const beats = plan.editorial.narrative.beats;
  for (const beat of beats) {
    const designBeat = evidence.request.beats.find(row => row.id === beat.id);
    if (designBeat?.subject !== beat.primaryFocus || designBeat.energy !== beat.energy) throw new Error(`Design focus/energy differs from narrative beat ${beat.id}`);
  }
  const duration = Math.max(...beats.map(beat => beat.range.endFrame)) / project.fps;
  if (Math.abs(evidence.request.duration - duration) > 1 / project.fps + 1e-6) throw new Error("Design duration differs from the narrative timeline");
  const reference = await verifyReferenceMotionPlan(plan.referenceMotion, project, plan.commands as EditorCommand[]);
  assertNativeTemplateDirectionBinding(evidence, plan.commands as EditorCommand[], plan.referenceMotion);
  const visibleCommands = canonicalOriginalVisibleProjection(original, referenceMotionVisibleProjection(plan.referenceMotion, plan.commands as EditorCommand[]));
  assertDesignDecisionBinding(evidence, visibleCommands, beats.map(beat => beat.id));
  assertMotionTreatmentBinding(plan.editorial.motionTreatment, visibleCommands, beats.map(beat => beat.id));
  // Only independently recompiled commands enter the separate template lane.
  assertScopedMotionRevisionEffects(project, (plan.commands as EditorCommand[]).filter((_, index) => !reference.indexes.has(index)));
  assertScopedPaletteRevisionEffects(project, (plan.commands as EditorCommand[]).filter((_, index) => !reference.indexes.has(index)));
  const brief = await compile(evidence.request, { ...options, reviewPolicy: policy });
  assertDesignReviewPolicy(brief, policy);
  const identity = designIdentity(brief, project);
  for (const key of ["projectSha256", "sourceSha256", "briefSha256"] as const) {
    if (evidence[key] !== identity[key]) {
      // The next brief read must compile again, not serve what this plan was bound to.
      forgetCurrentDesignBriefs();
      throw new Error(`Current design ${key} changed; read current sources and revise the plan`);
    }
  }
  for (const row of evidence.decisions) {
    const recipe = brief.recipes.find(item => item.beatId === row.beatId)?.recipe;
    if (!recipe || row.recipeSha256 !== sha256Canonical(recipe)) throw new Error(`Design recipe mismatch for ${row.beatId}`);
    if (recipe.route.primary_family !== plan.aesthetic.primaryFamily) throw new Error(`Design family mismatch for ${row.beatId}`);
  }
  if ("nativePaintOwnerRevisionProof" in reference && reference.nativePaintOwnerRevisionProof) captureNativePaintOwnerRevision?.(reference.nativePaintOwnerRevisionProof);
  if ("referenceMotionSourceOwnerProof" in reference && reference.referenceMotionSourceOwnerProof) captureReferenceMotionSourceOwner?.(reference.referenceMotionSourceOwnerProof);
  return { ...identity, beatCount: beats.length, sourceCount: brief.sources.length, state: "COMMAND_BOUND_REVIEW_REQUIRED" };
}

export function designPage(text: string, offset: number, maxTokens: number, envelope: Record<string, unknown> = {}): Record<string, unknown> & { text: string; offset: number; nextOffset: number; hasMore: boolean; estimatedTokens: number } {
  if (offset > text.length || (offset > 0 && /[\uDC00-\uDFFF]/.test(text[offset] ?? ""))) throw new Error("Invalid design page offset");
  const estimate = (value: string) => Math.ceil([...value].reduce((total, point) => total + (point.codePointAt(0)! > 127 ? 1 : 0.5), 0));
  const make = (end: number, estimatedTokens: number) => ({ ...envelope, text: text.slice(offset, end), offset, nextOffset: end, hasMore: end < text.length, estimatedTokens });
  let end = offset;
  if (estimate(JSON.stringify(make(end, maxTokens))) > maxTokens) throw new Error("Design response envelope exceeds requested token budget");
  // Count the serialized response too: JSON escaping and identity metadata are
  // part of the same budget. This is an estimate, not a model tokenizer claim.
  for (const point of text.slice(offset)) {
    const candidate = end + point.length;
    if (estimate(JSON.stringify(make(candidate, maxTokens))) > maxTokens) break;
    end = candidate;
  }
  if (end === offset && end < text.length) throw new Error("Design response budget cannot advance the page");
  const estimatedTokens = estimate(JSON.stringify(make(end, maxTokens)));
  return make(end, estimatedTokens);
}

/** W3-6 one-call read (pageId "all"): the whole brief as plain JSON when it fits, else the page index to read instead. */
export const DESIGN_BRIEF_ONE_CALL_MAX_BYTES = 64 * 1024;
export function designBriefOneCall(brief: CurrentDesignBrief, envelope: Record<string, unknown>, maxBytes = DESIGN_BRIEF_ONE_CALL_MAX_BYTES): Record<string, unknown> {
  const beats = brief.recipes.map(row => ({ beatId: row.beatId, recipeSha256: sha256Canonical(row.recipe), recipe: row.recipe }));
  const whole = { ...envelope, pageId: "all", quality: "REVIEW_REQUIRED", hasMore: false, context: brief.context, beats };
  if (Buffer.byteLength(JSON.stringify(whole), "utf8") <= maxBytes) return whole;
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
  return { ...envelope, pageId: "all", quality: "REVIEW_REQUIRED", hasMore: true, oversize: true, maxBytes,
    pages: [{ pageId: "context", bytes: bytes(brief.context) }, ...beats.map(beat => ({ pageId: `beat:${beat.beatId}`, recipeSha256: beat.recipeSha256, bytes: bytes(beat.recipe) }))],
    next: "Read each listed pageId with offset/maxTokens until hasMore=false." };
}

export function registerAutopilotDesignTools(server: McpServer) {
  server.registerTool("get_autopilot_design_brief", {
    description: "從目前啟用的 Video Autopilot Skill 編譯段落設計配方。分頁讀完 context 及每個 beat:<id>（或 pageId=all 一次取整份，超過 64 KB 改回頁索引），將 identity、request、recipeSha256 與實際 commandIndexes 放入 v4 designEvidence。只讀，不認證美感。",
    inputSchema: z.object({ projectPath: z.string(), request: designRequestSchema,
      pageId: z.string().max(90).default("context"), offset: z.number().int().nonnegative().default(0),
      maxTokens: z.number().int().min(300).max(900).default(900) }),
  }, async ({ projectPath, request, pageId, offset, maxTokens }) => {
    try {
      const [project, review] = await Promise.all([readProject(projectPath), readCreatorReviewPolicy()]);
      const { brief, cacheHit } = await compileCurrentDesignCached(request, { reviewPolicy: review.policy });
      await assertCreatorReviewPolicyCurrent(review);
      if (pageId === "all") {
        return { content: [{ type: "text" as const, text: JSON.stringify(designBriefOneCall(brief, { status: "GREEN", ...designIdentity(brief, project),
          reviewPolicyMode: brief.reviewPolicy.mode, reviewPolicySha256: brief.reviewPolicySha256, cacheHit })) }] };
      }
      const recipe = brief.recipes.find(row => `beat:${row.beatId}` === pageId);
      const content = pageId === "context" ? brief.context : recipe?.recipe;
      if (!content) throw new Error("Unknown design page; use context, beat:<narrative beat ID> or all");
      return { content: [{ type: "text" as const, text: JSON.stringify(designPage(JSON.stringify(content), offset, maxTokens, { status: "GREEN",
        ...designIdentity(brief, project), reviewPolicyMode: brief.reviewPolicy.mode, reviewPolicySha256: brief.reviewPolicySha256, pageId,
        recipeSha256: recipe ? sha256Canonical(recipe.recipe) : undefined, quality: "REVIEW_REQUIRED" })) }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ status: "BLOCK", error: error instanceof Error ? error.message : String(error) }) }] };
    }
  });
}
