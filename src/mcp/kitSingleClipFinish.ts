/** Finish a reviewed single-clip draft through the original Kit gates in one Agent process. */
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { AUTOPILOT_PLAN_SCHEMA, autopilotPlanSha256, parseAutopilotPlan } from "../application/autopilotPlan";
import { readKitPlanContext, verifyKitRunOriginalSources } from "./kitWorkflowBridge";
import { evidenceBoundKeepRanges } from "./kitSingleClipCut";
import { readProject } from "./storage";

type InvokeGateway = (name: string, args: Record<string, unknown>) => Promise<any>;
type GatewayResult = { value: Record<string, any>; reference?: Record<string, any> };

function unpack(response: any, operation: string): GatewayResult {
  const parts = Array.isArray(response?.content) ? response.content.filter((part: any) => part?.type === "text") : [];
  if (response?.isError || !parts.length) throw Error(`${operation} failed: ${String(parts[0]?.text || "no result").slice(0, 500)}`);
  const value = JSON.parse(parts[0].text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error(`${operation} returned no object`);
  const reference = parts[1] ? JSON.parse(parts[1].text) : undefined;
  return { value, reference };
}

export async function finishKitSingleClipEdit(input: { run: string }, invoke: InvokeGateway) {
  return finishKitEdit(input, invoke, "single");
}

export async function finishKitTwoClipEdit(input: { run: string }, invoke: InvokeGateway) {
  return finishKitEdit(input, invoke, "two");
}

async function finishKitEdit(input: { run: string }, invoke: InvokeGateway, shape: "single" | "two") {
  const run = input?.run;
  if (typeof run !== "string" || !run) throw Error("Kit run is required");
  const context = await readKitPlanContext(run, { includeTranscriptCues: true });
  if (context.planStep !== "pending" || !context.ready.includes("plan")
    || context.materials.length !== (shape === "single" ? 1 : 2)
    || context.materials.some(material => shape === "two" ? material.transcriptPolicy !== "visual-only"
      : !["visual-only", "required"].includes(material.transcriptPolicy))
    || context.savedDraft.status !== "VALID")
    throw Error(`Only a pending ${shape}-source Kit plan with verified material evidence can be finished by this tool`);
  const workspace = process.env.EDITKIN_WORKSPACE || "";
  if (!workspace) throw Error("Bound Editkin workspace is unavailable");
  const planPath = await realpath(resolve(workspace, context.run, "plan.v4.json"));
  const planRelative = relative(await realpath(workspace), planPath);
  if (!planRelative || planRelative === ".." || planRelative.startsWith("..\\") || planRelative.startsWith("../") || isAbsolute(planRelative))
    throw Error("Saved plan is outside the bound workspace");
  const plan = parseAutopilotPlan(JSON.parse(await readFile(planPath, "utf8")));
  if (plan.schema !== AUTOPILOT_PLAN_SCHEMA) throw Error("Only a current v4 plan can be finished");
  if (autopilotPlanSha256(plan) !== context.savedDraft.planSha256) throw Error("Saved plan changed after Kit context was read");
  const types = plan.commands.map(command => command.type);
  if (!plan.designEvidence) throw Error("The draft has no design evidence");
  const voiced = shape === "single" && context.materials[0].transcriptPolicy === "required";
  if (voiced) {
    const layer = plan.editorial.audio.layers[0];
    if (plan.editorial.audio.layers.length !== 1 || layer?.role !== "dialogue"
      || !layer.evidenceRefs.includes(`asset:${plan.materialEvidence.receipts[0]?.assetId}:audio`)
      || context.materials[0].transcriptState !== "ready" || !context.materials[0].contextComplete)
      throw Error("Voiced finish requires one source-dialogue layer and a fully read transcript");
  } else if (plan.editorial.audio.layers.length !== 0)
    throw Error("Visual-only finish does not accept audio layers");
  let editableCaptionCount = 1;
  if (shape === "single") {
    const captionOnly = types.length === 2 && types[0] === "set_aesthetic_system" && types[1] === "add_caption";
    const cutAndCaption = types.length === 3 && types[0] === "set_aesthetic_system"
      && types[1] === "smart_cut_clip" && types[2] === "add_caption";
    if (!captionOnly && !cutAndCaption)
      throw Error("This finish tool accepts only a single-source caption draft, optionally with an evidenced Smart Cut");
    if (voiced && cutAndCaption) throw Error("Smart Cut cannot be finished on a voiced source clip");
    const project = await readProject(process.env.EDITKIN_AGENT_PROJECT_PATH || "");
    const clips = project.tracks.flatMap(track => track.clips);
    const target = clips.find(clip => clip.id === context.materials[0].clipId);
    const fps = context.sourceBoundSeed.projectSummary.fps;
    if (!target || clips.filter(clip => clip.id === target.id).length !== 1 || project.fps !== fps
      || Math.abs(target.duration - context.materials[0].duration) > 0.5 / fps)
      throw Error("The bound source clip no longer matches the project timeline");
    if (voiced && (target.volume <= 0 || project.tracks.find(track => track.id === target.trackId)?.muted))
      throw Error("The source dialogue is muted on the timeline; unmute it before finishing a voiced edit");
    if (cutAndCaption && (clips.length !== 1 || target.timelineStart !== 0
      || project.captions.length > 0 || project.motionGraphics.length > 0))
      throw Error("Smart Cut requires one unaltered source clip on an otherwise empty timeline");
    if (cutAndCaption) {
      const command = plan.commands[1];
      if (command.type !== "smart_cut_clip" || command.clipId !== context.materials[0].clipId)
        throw Error("Smart Cut does not target the bound source clip");
      const outline = context.sourceBoundSeed.submittedSemanticOutlines.find(item => item.clipId === command.clipId);
      if (!outline || context.materials[0].semanticSegmentCount !== outline.segments.length)
        throw Error("Smart Cut requires the complete submitted semantic outline");
      const selected = evidenceBoundKeepRanges(command.keepRanges, outline.segments,
        context.materials[0].duration, context.sourceBoundSeed.projectSummary.fps);
      if (Math.abs(plan.designEvidence.request.duration - selected.frames / context.sourceBoundSeed.projectSummary.fps)
        > 0.5 / context.sourceBoundSeed.projectSummary.fps)
        throw Error("Smart Cut duration differs from the design request");
    }
    const caption = plan.commands[cutAndCaption ? 2 : 1];
    const voiceCue = voiced && caption.type === "add_caption" ? context.materials[0].transcriptCues?.find((cue: { index: number; start: number; end: number; text: string }) =>
      context.materials[0].semanticCueIndexes.includes(cue.index)
      && cue.text.includes(caption.caption.text)
      && Math.abs(caption.caption.start - (target.timelineStart + Math.round(cue.start * fps) / fps)) <= 0.5 / fps
      && Math.abs(caption.caption.duration - (Math.round(cue.end * fps) - Math.round(cue.start * fps)) / fps) <= 0.5 / fps)
      : undefined;
    if (voiced && !voiceCue) throw Error("Voiced caption no longer matches a cited transcript cue or its timing");
    const captionStart = voiced && voiceCue ? target.timelineStart + Math.round(voiceCue.start * fps) / fps
      : cutAndCaption ? 0 : target.timelineStart;
    const captionDuration = voiced && voiceCue ? (Math.round(voiceCue.end * fps) - Math.round(voiceCue.start * fps)) / fps
      : cutAndCaption ? plan.designEvidence.request.duration : target.duration;
    const beatStart = cutAndCaption ? 0 : target.timelineStart;
    const beatDuration = cutAndCaption ? plan.designEvidence.request.duration : target.duration;
    const beat = plan.editorial.narrative.beats[0];
    if (caption.type !== "add_caption" || Math.abs(caption.caption.start - captionStart) > 0.5 / fps
      || Math.abs(caption.caption.duration - captionDuration) > 0.5 / fps
      || plan.editorial.narrative.beats.length !== 1
      || beat.range.startFrame !== Math.round(beatStart * fps)
      || beat.range.endFrame !== Math.round((beatStart + beatDuration) * fps)
      || !beat.evidenceRefs.includes(`material:${plan.materialEvidence.receipts[0]?.materialId}`)
      || plan.materialEvidence.receipts[0]?.clipId !== target.id
      || plan.designEvidence.request.duration + 0.5 / fps < beatStart + beatDuration)
      throw Error("The editable caption and proof beat must match the bound clip's timeline interval");
  } else {
    if (types.join(",") !== "set_aesthetic_system,delete_clip,delete_clip,add_clip,add_clip,add_caption,add_caption")
      throw Error("Two-source finish accepts only a story reorder and two editable captions");
    const project = await readProject(process.env.EDITKIN_AGENT_PROJECT_PATH || "");
    const original = project.tracks.flatMap(track => track.clips);
    const deletions = plan.commands.flatMap(command => command.type === "delete_clip" ? [command.clipId] : []);
    const additions = plan.commands.flatMap(command => command.type === "add_clip" ? [command.clip] : []);
    const captions = plan.commands.flatMap(command => command.type === "add_caption" ? [command.caption] : []);
    const boundIds = context.materials.map(material => material.clipId).sort();
    if (original.length !== 2 || additions.length !== 2 || captions.length !== 2
      || !isDeepStrictEqual(deletions.sort(), boundIds)
      || !isDeepStrictEqual(additions.map(clip => clip.id).sort(), boundIds)
      || plan.materialEvidence.receipts.length !== 2 || plan.editorial.narrative.beats.length !== 2)
      throw Error("Two-source story does not match the bound Kit materials");
    let cursor = 0;
    for (const [index, added] of additions.entries()) {
      const source = original.find(clip => clip.id === added.id);
      const receipt = plan.materialEvidence.receipts.find(item => item.clipId === added.id);
      const beat = plan.editorial.narrative.beats[index];
      const caption = captions[index];
      const expected = source && { ...source, timelineStart: cursor };
      if (!source || !receipt || !isDeepStrictEqual(added, expected)
        || Math.abs(caption.start - cursor) > 0.5 / project.fps
        || Math.abs(caption.duration - added.duration) > 0.5 / project.fps
        || beat.range.startFrame !== Math.round(cursor * project.fps)
        || beat.range.endFrame !== Math.round((cursor + added.duration) * project.fps)
        || !beat.evidenceRefs.includes(`material:${receipt.materialId}`))
        throw Error("Two-source story beat, caption or clip differs from its source evidence");
      cursor += added.duration;
    }
    if (Math.abs(plan.designEvidence.request.duration - cursor) > 0.5 / project.fps)
      throw Error("Two-source story duration differs from its design request");
    editableCaptionCount = 2;
  }
  await verifyKitRunOriginalSources(run);
  const workflow = async (args: Record<string, unknown>) => unpack(await invoke("run_kit_workflow", { run, ...args }), "Kit workflow").value;
  const ready = await workflow({ command: "next" });
  if (ready.ready?.length !== 1 || ready.ready[0]?.step !== "plan") throw Error("Kit plan is no longer the sole ready step");
  const planClaim = await workflow({ command: "claim", step: "plan" });
  if (typeof planClaim.claim_token !== "string") throw Error("Kit did not issue a plan claim");
  await workflow({ command: "complete", step: "plan", token: planClaim.claim_token,
    receiptTemplate: { artifact: planPath, plan_sha256: autopilotPlanSha256(plan) } });

  const advance = async (step: "audit" | "apply" | "render", expectedTool: string, nextStep: string) => {
    const pending = await workflow({ command: "next" });
    if (pending.ready?.length !== 1 || pending.ready[0]?.step !== step) throw Error(`Kit ${step} is not the sole ready step`);
    const claim = await workflow({ command: "claim", step });
    if (claim.instruction?.tool !== expectedTool || typeof claim.claim_token !== "string")
      throw Error(`Kit ${step} instruction differs from the expected Editkin tool`);
    const result = unpack(await invoke("call_editkin_tool", { name: expectedTool, arguments: claim.instruction.request,
      retainResult: true, run, ...(step === "audit" ? {} : { claimToken: claim.claim_token }) }), expectedTool);
    if (typeof result.reference?.resultRef !== "string") throw Error(`Kit ${step} tool evidence was not retained`);
    const expectedStatus = step === "audit" ? "ACCEPTED" : step === "apply" ? "REVIEW_REQUIRED" : "GREEN";
    if (result.value.status !== expectedStatus) throw Error(`Kit ${step} returned ${String(result.value.status || "unknown")}`);
    await workflow({ command: "complete", step, token: claim.claim_token,
      receiptTemplate: { $resultRef: result.reference.resultRef } });
    const after = await workflow({ command: "next" });
    if (after.ready?.length !== 1 || after.ready[0]?.step !== nextStep)
      throw Error(`Kit ${step} did not advance to ${nextStep}`);
    return result.value;
  };
  await advance("audit", "audit_autopilot_plan", "apply");
  await advance("apply", "apply_autopilot_plan", "render");
  const rendered = await advance("render", "render_project", "human-review");
  await verifyKitRunOriginalSources(run);
  if (typeof rendered.outputPath !== "string" || !isAbsolute(rendered.outputPath))
    throw Error("Renderer did not return an absolute output path");
  const output = await realpath(resolve(rendered.outputPath));
  const within = relative(await realpath(workspace), output);
  if (!within || within === ".." || within.startsWith("..\\") || within.startsWith("../") || isAbsolute(within))
    throw Error("Render output is outside the bound workspace");
  if (!(await stat(output)).isFile()) throw Error("Render output is missing");
  return { status: "RENDERED_AWAITING_HUMAN_REVIEW", run: context.run,
    outputPath: within.replaceAll("\\", "/"), editableCaptionCount, nextStep: "human-review",
    note: "The Kit gates passed. Review the rendered video and editable project before accepting the edit." };
}
