/** A narrow two-source story draft: order two evidenced, silent clips and caption each beat. */
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AUTOPILOT_PLAN_SCHEMA, autopilotPlanSha256, parseAutopilotPlan } from "../application/autopilotPlan";
import { AUTOPILOT_CONTEXT_PROTOCOL, AUTOPILOT_INFERENCE_SCHEMA } from "../application/inferencePolicy";
import { MOTION_TREATMENT_FAMILIES, motionCommandFamilies } from "../application/motionTreatment";
import { createEmptyEditkinSkillSelectionReceipt, editkinSkillFormatForAutopilotRoute } from "../plugins/skillPack";
import { readKitPlanContext } from "./kitWorkflowBridge";
import { bounded, designPage } from "./kitSingleClipDraft";
import { readProject } from "./storage";

export type TwoClipStoryIntent = { run: string; topic: string; audience: string; domain?: string;
  beats: [{ clipId: string; summary: string; focus: string; captionText: string },
    { clipId: string; summary: string; focus: string; captionText: string }] };
type CallTarget = (name: string, args: Record<string, unknown>) => Promise<any>;

export async function draftKitTwoClipStoryPlan(input: TwoClipStoryIntent, call: CallTarget) {
  const topic = bounded(input.topic, "topic", 4, 180);
  const audience = bounded(input.audience, "audience", 3, 120);
  const domain = bounded(input.domain ?? "general", "domain", 3, 80);
  if (!Array.isArray(input.beats) || input.beats.length !== 2) throw Error("The story needs exactly two ordered beats");
  const beats = input.beats.map((beat, index) => ({
    id: index === 0 ? "setup" : "payoff",
    clipId: bounded(beat?.clipId, `beats[${index}].clipId`, 1, 80),
    summary: bounded(beat?.summary, `beats[${index}].summary`, 4, 240),
    focus: bounded(beat?.focus, `beats[${index}].focus`, 3, 120),
    captionText: bounded(beat?.captionText, `beats[${index}].captionText`, 2, 60),
    energy: index === 0 ? 0.45 : 0.75,
    role: index === 0 ? "first_frame" : "payoff",
    narrativeRole: index === 0 ? "setup" : "payoff",
  }));
  if (new Set(beats.map(beat => beat.clipId)).size !== 2) throw Error("The two story beats must use different source clips");
  const context = await readKitPlanContext(input.run);
  if (context.planStep !== "pending" || !context.ready.includes("plan")
    || context.materials.length !== 2 || context.materials.some(item => item.transcriptPolicy !== "visual-only"))
    throw Error("Only a pending Kit run with two visual-only source clips can use this draft tool");
  const seed = context.sourceBoundSeed;
  if (!seed.source || seed.materialEvidence.receipts.length !== 2 || !seed.routerSha256
    || !seed.projectSummary || !Number.isFinite(seed.projectSummary.fps)) throw Error("Kit source-bound seed is incomplete");
  const fps = seed.projectSummary.fps;
  const workspace = process.env.EDITKIN_WORKSPACE || "";
  const projectPath = process.env.EDITKIN_AGENT_PROJECT_PATH || "";
  if (!workspace || !projectPath) throw Error("Bound Editkin project is unavailable");
  const project = await readProject(projectPath);
  const original = project.tracks.flatMap(track => track.clips).sort((a, b) => a.timelineStart - b.timelineStart);
  if (original.length !== 2 || original.some(clip => clip.trackId !== original[0].trackId || clip.sourceStart !== 0)
    || original[0].timelineStart !== 0 || Math.abs(original[1].timelineStart - original[0].duration) > 0.5 / fps
    || project.tracks.find(track => track.id === original[0].trackId)?.kind !== "video"
    || project.captions.length || project.motionGraphics.length || project.fps !== fps)
    throw Error("The story draft requires two adjacent, unaltered source clips on one video track");
  const originalsById = new Map(original.map(clip => [clip.id, clip]));
  const materialByClip = new Map(context.materials.map(item => [item.clipId, item]));
  const evidenceByClip = new Map(seed.materialEvidence.receipts.map(item => [item.clipId, item]));
  let cursor = 0;
  const selected = beats.map(beat => {
    const clip = originalsById.get(beat.clipId), material = materialByClip.get(beat.clipId);
    const receipt = evidenceByClip.get(beat.clipId);
    const outline = seed.submittedSemanticOutlines.find(item => item.clipId === beat.clipId);
    if (!clip || !material || !receipt || !outline || material.semanticSegmentCount !== 1
      || outline.segments.length !== 1 || outline.segments[0].evidenceFrameCount < 1
      || Math.abs(outline.segments[0].start) > 1e-6
      || Math.abs(outline.segments[0].end - clip.duration) > 0.5 / fps
      || Math.abs(material.duration - clip.duration) > 0.5 / fps
      || clip.duration > 60 || Math.round(clip.duration * fps) < 24)
      throw Error(`Story beat ${beat.id} needs one complete, viewed semantic segment bound to its source clip`);
    const startFrame = Math.round(cursor * fps);
    cursor += clip.duration;
    return { ...beat, clip, material, receipt, start: startFrame / fps,
      startFrame, endFrame: Math.round(cursor * fps) };
  });
  if (cursor > 60 || Math.round(cursor * fps) > 3600) throw Error("The two-source draft is limited to 60 seconds");
  const format = "shorts";
  const request = { format, domain, topic, duration: cursor,
    beats: selected.map(item => ({ id: item.id, role: item.role, energy: item.energy, subject: item.focus })) };
  const design = await designPage(call, projectPath, request, "context");
  const recipes = await Promise.all(selected.map(item => designPage(call, projectPath, request, `beat:${item.id}`)));
  if (recipes.some(recipe => recipe.briefSha256 !== design.briefSha256 || !recipe.recipeSha256))
    throw Error("Design recipe binding changed");
  const family = recipes[0].value?.route?.primary_family;
  if (typeof family !== "string" || recipes.some(recipe => recipe.value?.route?.primary_family !== family))
    throw Error("The two beats need one consistent aesthetic family");
  const aestheticResult = await call("get_autopilot_aesthetic_system", { domain, format, selectedFamily: family });
  if (aestheticResult.status !== "GREEN" || aestheticResult.aestheticSystem?.primaryFamily !== family)
    throw Error("Aesthetic system does not match the design recipes");
  const aesthetic = aestheticResult.aestheticSystem;
  const commands = [
    { type: "set_aesthetic_system", aestheticSystem: aesthetic },
    ...original.map(clip => ({ type: "delete_clip", clipId: clip.id })),
    ...selected.map(item => ({ type: "add_clip", clip: { ...structuredClone(item.clip), timelineStart: item.start } })),
    ...selected.map((item, index) => ({ type: "add_caption", caption: { id: `kit-story-caption-${index + 1}`,
      text: item.captionText, start: item.start, duration: item.clip.duration } })),
  ];
  const treatment = { schema: "editkin.motion-treatment/v1", decisions: MOTION_TREATMENT_FAMILIES.map(family => {
    const indexes = commands.flatMap((command, index) => motionCommandFamilies(command as any).includes(family) ? [index] : []);
    return { family, action: indexes.length ? "use" : "omit",
      beatIds: indexes.length ? selected.map(item => item.id) : [], commandIndexes: indexes,
      reason: indexes.length ? "Editable captions identify each evidenced story beat."
        : "No evidence or purpose for this motion treatment in the two-source cut." };
  }) };
  const source = seed.source;
  const planInput = {
    schema: AUTOPILOT_PLAN_SCHEMA, source, route: { mode: "plan", format, domain },
    budget: { contextTokens: 600, selectedMemoryRuleIds: [], trimmedMemoryRuleCount: 0, assetCandidateCount: 0 },
    assurances: { originalAssetsReadOnly: true, structuredCommandsOnly: true, semanticAssetsOnly: true,
      licenseFailClosed: true, captionsSeparateFromGraphics: true, reviewDoesNotEqualCertification: true },
    quality: { state: "draft" },
    inference: { schema: AUTOPILOT_INFERENCE_SCHEMA, provider: "other", modelId: "unverified-agent-model",
      modelTier: "unknown", reasoningEffort: "unknown", taskClass: "editorial_plan", priority: "quality",
      context: { protocol: AUTOPILOT_CONTEXT_PROTOCOL, markdownRouterSha256: seed.routerSha256,
        packetTokens: 600, progressiveDisclosure: true, structuredExecutionTruth: true }, evaluation: { state: "unmeasured" },
      safeguards: { semanticAuditRequired: true, automaticEscalationOnBlock: true, executionMode: "audit_then_apply",
        secondPassRequired: true, humanReviewRequired: true } },
    materialEvidence: seed.materialEvidence,
    extensions: { skillSelection: createEmptyEditkinSkillSelectionReceipt(source.pluginRegistrySha256,
      { format: editkinSkillFormatForAutopilotRoute(format), domain, semanticRoles: [] }), pluginApplications: [] },
    aesthetic,
    editorial: {
      brief: { audience, premise: topic, promise: selected[0].captionText,
        stakes: "Show the sequence of the two evidenced source clips", payoff: selected[1].summary,
        firstFramePromise: selected[0].captionText },
      narrative: { backbone: `${selected[0].summary} → ${selected[1].summary}`.slice(0, 240),
        beats: selected.map(item => ({ id: item.id, role: item.narrativeRole,
          range: { startFrame: item.startFrame, endFrame: item.endFrame }, summary: item.summary,
          energy: item.energy, primaryFocus: item.focus, evidenceRefs: [`material:${item.receipt.materialId}`] })),
        setupPayoffs: [{ setupBeatId: "setup", payoffBeatId: "payoff" }] },
      packaging: { hypotheses: [{ id: "two-source-story", title: selected[0].captionText,
        thumbnailPromise: selected[0].captionText, openingFulfillment: selected[0].captionText,
        distinctFromIds: [] }], evaluationMetric: "watch_time_share", introMustFulfillPackagingPromise: true },
      captions: { mode: "semantic", maxCharsPerLine: 30, maxLines: 2, minimumOnScreenFrames: 24,
        semanticEmphasisOnly: true, separateFromGraphics: true }, graphics: [], transitions: [],
      audio: { dialoguePriority: true, blanketWhooshEveryCut: false, layers: [], impactFrames: [], breathFrames: [] },
      color: { primaryLookId: "source-original", onePrimaryLook: true, shotMatchRequired: true,
        graphicsAfterGrade: true, exceptions: [] },
      assets: { truthSourceFirst: true, semanticSelectionOnly: true, candidateIds: [],
        resolutionOrder: ["truth_source", "semantic_broll", "motion", "card", "clean_hold"] },
      delivery: { currentArtifactOnly: true, platforms: ["archive"],
        variants: [{ id: "two-source-story", aspectRatio: "16:9", purpose: "Two-source review" }],
        outcomeCheckpoints: ["D2", "D7", "D28"] }, motionTreatment: treatment },
    designEvidence: { schema: "editkin.autopilot-design-evidence/v1", request,
      projectSha256: design.projectSha256, sourceSha256: design.sourceSha256, briefSha256: design.briefSha256,
      decisions: selected.map((item, index) => ({ beatId: item.id, recipeSha256: recipes[index].recipeSha256,
        application: `Use source ${item.clipId} for the ${item.id} beat and identify it with editable caption ${item.captionText}`,
        commandIndexes: [3 + index, 5 + index] })) }, commands,
  };
  const plan = parseAutopilotPlan(planInput);
  if (plan.schema !== AUTOPILOT_PLAN_SCHEMA) throw Error("Draft did not produce a current v4 plan");
  const path = resolve(workspace, context.run, "plan.v4.json");
  await writeFile(path, `${JSON.stringify(plan, null, 2)}\n`, { flag: "wx" });
  return { status: "DRAFT_WRITTEN", run: context.run,
    planPath: join(context.run, "plan.v4.json").replaceAll("\\", "/"),
    planSha256: autopilotPlanSha256(plan), commandTypes: commands.map(command => command.type),
    storyOrder: selected.map(item => item.clipId),
    note: "Two evidenced, silent sources. Review story order and captions before original Kit audit/apply." };
}
