import { testDesignReviewEnvelope } from "./testDesignReviewPolicy";
import { describe, expect, it } from "vitest";
import { cp, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createEmptyProject } from "../domain/editGraph";
import { createAutopilotV4Fixture } from "./autopilotPlanFixture";
import { parseAutopilotPlan, type CurrentAutopilotPlan } from "./autopilotPlan";
import { designEvidenceSchema, designRequestSchema } from "./autopilotDesignContract";
import { MOTION_TREATMENT_FAMILIES } from "./motionTreatment";
import { sha256Canonical } from "./autopilotInvocationIdentity";
import { compileCurrentDesign, designIdentity, verifyAutopilotDesign, assertDesignReviewPolicy, designPage, type CurrentDesignBrief } from "../mcp/autopilotDesignTools";

const publicSkillSource = resolve(import.meta.dirname, "../../../../video-autopilot-kit/codex-skill/video-autopilot");

function fixture() {
  const project = createEmptyProject();
  const plan = parseAutopilotPlan(createAutopilotV4Fixture()) as CurrentAutopilotPlan;
  const request = designRequestSchema.parse({ format: plan.route.format, domain: plan.route.domain,
    topic: "實際證據", duration: 3, beats: plan.editorial.narrative.beats.map(beat => ({
      id: beat.id, role: beat.id === "promise" ? "first_frame" : beat.id === "payoff" ? "payoff" : "chapter",
      energy: beat.energy, subject: beat.primaryFocus,
    })),
  });
  const brief: CurrentDesignBrief = { schema: "hao.editkin.current-design-brief/v1", request,
    sources: [{ path: "knowledge/state.json", sha256: "a".repeat(64) }], sourceSha256: "b".repeat(64), ...testDesignReviewEnvelope(),
    recipes: request.beats.map(beat => ({ beatId: beat.id, recipe: { route: { primary_family: plan.aesthetic.primaryFamily } } })),
  };
  plan.commands.push(...plan.editorial.narrative.beats.map((beat, index) => ({ type: "add_caption" as const,
    caption: { id: `caption-${index}`, text: beat.summary, start: index, duration: 1 } })));
  plan.editorial.motionTreatment = { schema: "editkin.motion-treatment/v1", decisions: MOTION_TREATMENT_FAMILIES.map(family => ({
    family, action: family === "subtitles" ? "use" : "omit", reason: "依這份具體素材與資訊密度保留或省略",
    beatIds: request.beats.map(beat => beat.id), commandIndexes: family === "subtitles" ? [2, 3, 4] : [],
  })) };
  plan.designEvidence = designEvidenceSchema.parse({ schema: "editkin.autopilot-design-evidence/v1", request,
    ...designIdentity(brief, project), decisions: brief.recipes.map((row, index) => ({
      beatId: row.beatId, recipeSha256: sha256Canonical(row.recipe), application: "保留真實畫面，以单色字幕交代本段證據", commandIndexes: [2 + index],
    })),
  });
  return { plan, project, brief, compile: async () => brief };
}

describe("live private design execution binding", () => {
  it("pages Unicode and escaped JSON within one response budget without losing authority metadata", () => {
    const text = JSON.stringify({ authority: "\"\\🎬創作者".repeat(200) }), envelope = {
      status: "GREEN", projectSha256: "a".repeat(64), sourceSha256: "b".repeat(64), briefSha256: "c".repeat(64),
      reviewPolicySha256: "d".repeat(64), reviewPolicyMode: "agent_reference_comparison", quality: "REVIEW_REQUIRED",
    };
    let offset = 0, result = "", count = 0;
    do {
      const row = designPage(text, offset, 900, envelope);
      const estimate = Math.ceil([...JSON.stringify(row)].reduce((total, point) => total + (point.codePointAt(0)! > 127 ? 1 : .5), 0));
      expect(row.estimatedTokens).toBeLessThanOrEqual(900); expect(estimate).toBeLessThanOrEqual(900);
      expect(row.nextOffset).toBeGreaterThan(offset); expect(row.reviewPolicySha256).toBe(envelope.reviewPolicySha256);
      result += row.text; offset = row.nextOffset; count++;
    } while (offset < text.length);
    expect(result).toBe(text); expect(count).toBeGreaterThan(1);
    expect(() => designPage(text, 0, 300, { authority: "x".repeat(1000) })).toThrow(/budget/);
  });
  it.skipIf(!existsSync(join(publicSkillSource, "editkin_design_bridge.py")))("compiles an installed public Kit without the private profile and detects design drift", async () => {
    const root = await mkdtemp(join(tmpdir(), "editkin-public-design-"));
    const skillRoot = join(root, "video-autopilot");
    const plugins = join(root, "plugins");
    await cp(publicSkillSource, skillRoot, { recursive: true });
    await mkdir(plugins);
    const request = designRequestSchema.parse({ format: "vlog", domain: "travel", topic: "陶藝旅行", duration: 15,
      beats: [{ id: "opening", role: "first_frame", energy: 0.65, subject: "做陶的手" }] });
    const first = await compileCurrentDesign(request, { skillPath: join(skillRoot, "SKILL.md"), pluginRoots: [plugins] });
    expect(first.recipes[0].recipe.route.primary_family).toBe("travel_scrapbook");
    expect(first.sources.length).toBeGreaterThanOrEqual(7);
    expect(JSON.stringify(first.context)).not.toContain("Hao0321");
    expect(first.reviewPolicy).toEqual({ mode: "human" });
    const policy = { mode: "agent_reference_comparison" as const, authorization: "Creator authorizes comparison of full rendered scenes" };
    const agent = await compileCurrentDesign(request, { skillPath: join(skillRoot, "SKILL.md"), pluginRoots: [plugins], reviewPolicy: policy });
    expect(agent.reviewPolicy).toEqual(policy);
    expect(agent.reviewPolicySha256).toBe(sha256Canonical(policy));
    expect((agent.context as any).review).toMatchObject({ actor: "agent", checkpoint: "agent_review", required: true, completed: false });
    expect(agent.sources.some(row => row.path === "review_policy.py")).toBe(true);
    const reference = join(skillRoot, "references", "design-reference-dna-v6.md");
    await writeFile(reference, `${await readFile(reference, "utf8")}\n`, "utf8");
    const changed = await compileCurrentDesign(request, { skillPath: join(skillRoot, "SKILL.md"), pluginRoots: [plugins] });
    expect(changed.sourceSha256).not.toBe(first.sourceSha256);
    const policyDependency = join(skillRoot, "review_policy.py");
    await writeFile(policyDependency, `${await readFile(policyDependency, "utf8")}\n`, "utf8");
    const policyChanged = await compileCurrentDesign(request, { skillPath: join(skillRoot, "SKILL.md"), pluginRoots: [plugins] });
    expect(policyChanged.sourceSha256).not.toBe(changed.sourceSha256);
  });
  it("keeps historical v4 plans readable without pretending they meet the current execution gate", async () => {
    const old = parseAutopilotPlan(createAutopilotV4Fixture()) as CurrentAutopilotPlan;
    await expect(verifyAutopilotDesign(old, createEmptyProject())).rejects.toThrow(/designEvidence/);
  });
  it("accepts exact current sources and actual per-beat commands as review required", async () => {
    const f = fixture();
    await expect(verifyAutopilotDesign(f.plan, f.project, f.compile)).resolves.toMatchObject({ beatCount: 3, state: "COMMAND_BOUND_REVIEW_REQUIRED" });
  });
  it("binds creator authority, and rejects an authored policy or later revocation", async () => {
    const f = fixture();
    const policy = { mode: "agent_reference_comparison" as const, authorization: "Creator permits autonomous comparison against the full references" };
    Object.assign(f.brief, testDesignReviewEnvelope(policy));
    f.plan.inference.safeguards.reviewPolicy = policy;
    f.plan.inference.safeguards.humanReviewRequired = false;
    f.plan.designEvidence = { ...f.plan.designEvidence!, ...designIdentity(f.brief, f.project) };
    await expect(verifyAutopilotDesign(f.plan, f.project, f.compile, { reviewPolicy: policy })).resolves.toMatchObject({ state: "COMMAND_BOUND_REVIEW_REQUIRED" });
    await expect(verifyAutopilotDesign(f.plan, f.project, f.compile)).rejects.toThrow(/trusted creator/);
    await expect(verifyAutopilotDesign(f.plan, f.project, f.compile, { reviewPolicy: { ...policy, authorization: "different authority" } })).rejects.toThrow(/trusted creator/);
  });
  it.each(["missingEnvelope", "wrongActor", "completed", "learning", "craft", "learningNull", "craftNull", "forgedHash"])("rejects %s compiler review drift", kind => {
    const f = fixture(), context = f.brief.context as any;
    if (kind === "missingEnvelope") delete context.review;
    if (kind === "wrongActor") context.review.actor = "agent";
    if (kind === "completed") context.review.completed = true;
    if (kind === "learning") context.learning = { quality_95: { review_mode: "agent_reference_comparison", policy_sha256_12: "0".repeat(12) } };
    if (kind === "craft") context.craft = { qa: { visual_review: { completed: true } } };
    if (kind === "learningNull") context.learning = null;
    if (kind === "craftNull") context.craft = null;
    if (kind === "forgedHash") f.brief.reviewPolicySha256 = "0".repeat(64);
    expect(() => assertDesignReviewPolicy(f.brief)).toThrow();
  });
  it.each(["project", "memory", "recipe", "family", "focus", "duration", "treatment", "missingBeat", "duplicateBeat", "metadata", "unknownCommand"])("rejects %s drift or misleading execution before mutation", async kind => {
    const f = fixture(); const before = structuredClone(f.project); const evidence = f.plan.designEvidence!;
    if (kind === "project") evidence.projectSha256 = "0".repeat(64);
    if (kind === "memory") f.brief.sourceSha256 = "c".repeat(64);
    if (kind === "recipe") evidence.decisions[0].recipeSha256 = "0".repeat(64);
    if (kind === "family") f.plan.aesthetic.primaryFamily = "invented";
    if (kind === "focus") f.plan.editorial.narrative.beats[0].primaryFocus = "unrelated subject";
    if (kind === "duration") evidence.request.duration = 4;
    if (kind === "treatment") delete f.plan.editorial.motionTreatment;
    if (kind === "missingBeat") evidence.decisions.pop();
    if (kind === "duplicateBeat") evidence.decisions[1].beatId = evidence.decisions[0].beatId;
    if (kind === "metadata") evidence.decisions[0].commandIndexes = [0];
    if (kind === "unknownCommand") evidence.decisions[0].commandIndexes = [999];
    await expect(verifyAutopilotDesign(f.plan, f.project, f.compile)).rejects.toThrow();
    expect(f.project).toEqual(before);
  });
});
