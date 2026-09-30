/** A narrow, source-bound first draft for one verified Kit clip. Never applies an edit. */
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AUTOPILOT_PLAN_SCHEMA, autopilotPlanSha256, parseAutopilotPlan } from "../application/autopilotPlan";
import { AUTOPILOT_CONTEXT_PROTOCOL, AUTOPILOT_INFERENCE_SCHEMA } from "../application/inferencePolicy";
import { MOTION_TREATMENT_FAMILIES, motionCommandFamilies } from "../application/motionTreatment";
import { createEmptyEditkinSkillSelectionReceipt, editkinSkillFormatForAutopilotRoute } from "../plugins/skillPack";
import { readKitPlanContext } from "./kitWorkflowBridge";
import { evidenceBoundKeepRanges } from "./kitSingleClipCut";
import { readProject } from "./storage";

export type SingleClipDraftIntent = { run: string; captionText: string; topic: string; beatSummary: string;
  subject: string; audience: string; format?: "shorts" | "longform"; domain?: string;
  keepRanges?: { start: number; end: number }[]; captionCueIndex?: number };
type CallTarget = (name: string, args: Record<string, unknown>) => Promise<any>;

export function bounded(value: unknown, label: string, min: number, max: number) {
  if (typeof value !== "string" || value.trim().length < min || value.trim().length > max || /[\x00-\x1f]/u.test(value))
    throw Error(`${label} must be ${min}–${max} printable characters`);
  return value.trim();
}

export async function designPage(call: CallTarget, projectPath: string, request: Record<string, unknown>, pageId: string) {
  let offset = 0, body = "", identity: any;
  for (let page = 0; page < 30; page++) {
    const response = await call("get_autopilot_design_brief", { projectPath, request, pageId, offset, maxTokens: 900 });
    if (response.status !== "GREEN" || typeof response.text !== "string") throw Error(`Design page ${pageId} is unavailable`);
    const current = { projectSha256: response.projectSha256, sourceSha256: response.sourceSha256,
      briefSha256: response.briefSha256, recipeSha256: response.recipeSha256 };
    if (identity && (identity.projectSha256 !== current.projectSha256 || identity.sourceSha256 !== current.sourceSha256
      || identity.briefSha256 !== current.briefSha256 || identity.recipeSha256 !== current.recipeSha256))
      throw Error(`Design page ${pageId} changed during reading`);
    identity = current;
    body += response.text;
    if (body.length > 256_000) throw Error("Design page exceeds the draft limit");
    if (!response.hasMore) return { ...current, value: JSON.parse(body) };
    if (!Number.isInteger(response.nextOffset) || response.nextOffset <= offset) throw Error("Design page did not advance");
    offset = response.nextOffset;
  }
  throw Error("Design page did not finish");
}

export async function draftKitSingleClipPlan(input: SingleClipDraftIntent, call: CallTarget) {
  const captionText = bounded(input.captionText, "captionText", 2, 60);
  const topic = bounded(input.topic, "topic", 4, 180);
  const beatSummary = bounded(input.beatSummary, "beatSummary", 4, 240);
  const subject = bounded(input.subject, "subject", 3, 120);
  const audience = bounded(input.audience, "audience", 3, 120);
  const format = input.format ?? "shorts", domain = bounded(input.domain ?? "general", "domain", 3, 80);
  const context = await readKitPlanContext(input.run, { includeTranscriptCues: true });
  if (context.planStep !== "pending" || !context.ready.includes("plan")) throw Error("Kit plan is not ready for drafting");
  if (context.materials.length !== 1 || !["visual-only", "required"].includes(context.materials[0].transcriptPolicy))
    throw Error("This draft tool needs one bound source clip with a verified transcript policy");
  const voiced = context.materials[0].transcriptPolicy === "required";
  if (voiced && (context.materials[0].transcriptState !== "ready" || !context.materials[0].contextComplete
    || !Number.isInteger(input.captionCueIndex)))
    throw Error("A voiced draft needs a ready, fully read transcript and captionCueIndex");
  if (!voiced && input.captionCueIndex !== undefined) throw Error("A visual-only clip has no transcript cue");
  if (voiced && input.keepRanges !== undefined)
    throw Error("Smart Cut is unavailable for voiced clips because it can remove spoken words");
  const cue = voiced ? context.materials[0].transcriptCues?.find((item: { index: number; start: number; end: number; text: string }) =>
    item.index === input.captionCueIndex) : undefined;
  if (voiced && (!cue || !context.materials[0].semanticCueIndexes.includes(input.captionCueIndex)
    || !cue.text.includes(captionText)))
    throw Error("Caption must quote a transcript cue already referenced by the verified semantic receipt");
  const seed = context.sourceBoundSeed;
  if (!seed.source || seed.materialEvidence.receipts.length !== 1 || !seed.routerSha256
    || !seed.projectSummary || !Number.isFinite(seed.projectSummary.fps)) throw Error("Kit source-bound seed is incomplete");
  const sourceDuration = context.materials[0].duration;
  if (!Number.isFinite(sourceDuration) || sourceDuration <= 0 || sourceDuration > 60)
    throw Error("This draft tool supports source clips up to 60 seconds");
  const fps = seed.projectSummary.fps;
  let cut: ReturnType<typeof evidenceBoundKeepRanges> | undefined;
  if (input.keepRanges !== undefined) {
    const outline = seed.submittedSemanticOutlines.find(item => item.clipId === context.materials[0].clipId);
    if (!outline || context.materials[0].semanticSegmentCount !== outline.segments.length)
      throw Error("The complete semantic segment list is required for Smart Cut");
    cut = evidenceBoundKeepRanges(input.keepRanges, outline.segments, sourceDuration, fps);
  }
  const frames = cut?.frames ?? Math.round(sourceDuration * fps);
  const duration = frames / fps;
  if (frames < 24 || frames > 3600)
    throw Error("This draft tool supports 24–3600 frames and at most 60 seconds");
  const workspace = process.env.EDITKIN_WORKSPACE || "";
  const projectPath = process.env.EDITKIN_AGENT_PROJECT_PATH || "";
  if (!workspace || !projectPath) throw Error("Bound Editkin project is unavailable");
  const project = await readProject(projectPath);
  const clips = project.tracks.flatMap(track => track.clips);
  const target = clips.find(clip => clip.id === context.materials[0].clipId);
  if (!target || clips.filter(clip => clip.id === target.id).length !== 1 || project.fps !== fps
    || Math.abs(target.duration - sourceDuration) > 0.5 / fps)
    throw Error("The bound source clip no longer matches the project timeline");
  if (voiced && (target.volume <= 0 || project.tracks.find(track => track.id === target.trackId)?.muted))
    throw Error("The source dialogue is muted on the timeline; unmute it before drafting a voiced edit");
  const startFrame = Math.round(target.timelineStart * fps);
  if (Math.abs(startFrame / fps - target.timelineStart) > 0.5 / fps)
    throw Error("The bound source clip is not frame-aligned");
  if (cut) {
    if (clips.length !== 1 || target.timelineStart !== 0
      || project.captions.length > 0 || project.motionGraphics.length > 0)
      throw Error("Smart Cut requires one unaltered source clip on an otherwise empty timeline");
  }
  const cueStartFrame = cue ? Math.round(cue.start * fps) : 0;
  const cueEndFrame = cue ? Math.round(cue.end * fps) : 0;
  if (voiced && (cueStartFrame < 0 || cueEndFrame - cueStartFrame < 24
    || cueEndFrame > Math.round(sourceDuration * fps)))
    throw Error("The cited speech cue cannot support a readable caption within this clip");
  const captionStart = cue ? target.timelineStart + cueStartFrame / fps : cut ? 0 : target.timelineStart;
  const captionDuration = cue ? (cueEndFrame - cueStartFrame) / fps : duration;
  const projectDuration = cut ? duration : Math.max(target.timelineStart + duration,
    ...clips.map(clip => clip.timelineStart + clip.duration));
  const request = { format, domain, topic, duration: projectDuration,
    beats: [{ id: "proof", role: "proof", energy: 0.5, subject }] };
  const design = await designPage(call, projectPath, request, "context");
  const recipe = await designPage(call, projectPath, request, "beat:proof");
  if (design.briefSha256 !== recipe.briefSha256 || !recipe.recipeSha256) throw Error("Design recipe binding changed");
  const selectedFamily = recipe.value?.route?.primary_family;
  if (typeof selectedFamily !== "string") throw Error("Design recipe has no aesthetic family");
  const aestheticResult = await call("get_autopilot_aesthetic_system", { domain, format, selectedFamily });
  if (aestheticResult.status !== "GREEN" || aestheticResult.aestheticSystem?.primaryFamily !== selectedFamily)
    throw Error("Aesthetic system does not match the design recipe");
  const aesthetic = aestheticResult.aestheticSystem;
  const commands = [{ type: "set_aesthetic_system", aestheticSystem: aesthetic },
    ...(cut ? [{ type: "smart_cut_clip", clipId: context.materials[0].clipId,
      keepRanges: cut.keepRanges, segmentIds: cut.keepRanges.map((_, index) => index === 0
        ? context.materials[0].clipId : `${context.materials[0].clipId}-kit-${index + 1}`) }] : []),
    { type: "add_caption", caption: { id: `kit-proof-caption-${target.id}`, text: captionText,
      start: captionStart, duration: captionDuration } }];
  const treatment = { schema: "editkin.motion-treatment/v1",
    decisions: MOTION_TREATMENT_FAMILIES.map(family => {
      const indexes = commands.flatMap((command, index) => motionCommandFamilies(command as any).includes(family) ? [index] : []);
      return { family, action: indexes.length ? "use" : "omit", beatIds: indexes.length ? ["proof"] : [],
        commandIndexes: indexes, reason: indexes.length
          ? `Caption makes the source-backed proof beat visible: ${captionText}`
          : "The single source clip has no evidence or need for this treatment." };
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
      brief: { audience, premise: topic, promise: captionText, stakes: "Identify the source footage accurately",
        payoff: beatSummary, firstFramePromise: captionText },
      narrative: { backbone: beatSummary, beats: [{ id: "proof", role: "proof", range: { startFrame: cut ? 0 : startFrame,
        endFrame: (cut ? 0 : startFrame) + frames },
        summary: beatSummary, energy: 0.5, primaryFocus: subject,
        evidenceRefs: [`material:${seed.materialEvidence.receipts[0].materialId}`] }], setupPayoffs: [] },
      packaging: { hypotheses: [{ id: "source-proof", title: captionText, thumbnailPromise: captionText,
        openingFulfillment: captionText, distinctFromIds: [] }], evaluationMetric: "watch_time_share",
        introMustFulfillPackagingPromise: true },
      captions: { mode: "semantic", maxCharsPerLine: 30, maxLines: 2, minimumOnScreenFrames: 24,
        semanticEmphasisOnly: true, separateFromGraphics: true },
      graphics: [], transitions: [],
      audio: { dialoguePriority: true, blanketWhooshEveryCut: false,
        layers: voiced ? [{ id: "source-dialogue", role: "dialogue", purpose: "保留來源人聲與逐字稿對位",
          evidenceRefs: [`asset:${seed.materialEvidence.receipts[0].assetId}:audio`] }] : [],
        impactFrames: [], breathFrames: [] },
      color: { primaryLookId: "source-original", onePrimaryLook: true, shotMatchRequired: true,
        graphicsAfterGrade: true, exceptions: [] },
      assets: { truthSourceFirst: true, semanticSelectionOnly: true, candidateIds: [],
        resolutionOrder: ["truth_source", "semantic_broll", "motion", "card", "clean_hold"] },
      delivery: { currentArtifactOnly: true, platforms: ["archive"],
        variants: [{ id: "source-proof", aspectRatio: "16:9", purpose: "Source-bound review" }],
        outcomeCheckpoints: ["D2", "D7", "D28"] }, motionTreatment: treatment },
    designEvidence: { schema: "editkin.autopilot-design-evidence/v1", request,
      projectSha256: design.projectSha256, sourceSha256: design.sourceSha256, briefSha256: design.briefSha256,
      decisions: [{ beatId: "proof", recipeSha256: recipe.recipeSha256,
        application: cut
          ? `Keep verified semantic intervals (${cut.selectedSummaries.join("; ").slice(0, 300)}); identify them with editable caption: ${captionText}`
          : `A factual editable caption identifies the source: ${captionText}`,
        commandIndexes: cut ? [1, 2] : [1] }] },
    commands,
  };
  const plan = parseAutopilotPlan(planInput);
  if (plan.schema !== AUTOPILOT_PLAN_SCHEMA) throw Error("Draft did not produce a current v4 plan");
  const path = resolve(workspace, context.run, "plan.v4.json");
  await writeFile(path, `${JSON.stringify(plan, null, 2)}\n`, { flag: "wx" });
  return { status: "DRAFT_WRITTEN", run: context.run, planPath: join(context.run, "plan.v4.json").replaceAll("\\", "/"),
    planSha256: autopilotPlanSha256(plan), commandTypes: commands.map(command => command.type),
    note: cut
      ? "One source, evidence-aligned Smart Cut and editable caption. Review chosen segments and wording before original Kit audit/apply."
      : voiced
        ? "One voiced source. The editable caption quotes a verified transcript cue; source speech remains intact. Review wording and timing before Kit audit/apply."
        : "Single visual-only source. Review the factual caption, complete the original Kit plan step, then audit before apply." };
}
