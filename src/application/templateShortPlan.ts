import * as z from "zod/v4";
import type { EditorCommand } from "../domain/commands";
import type { AestheticReviewPolicy, EditProject } from "../domain/types";
import type { ReferenceMotionTemplateInstance } from "../domain/referenceMotionInstance";
import { normalizeReviewPolicy } from "../domain/reviewPolicy";
import type { EditkinSkillSelectionReceipt } from "../plugins/skillPack";
import { canonicalJson } from "../shared/canonicalJson";
import { AUTOPILOT_MAX_COMMANDS, AUTOPILOT_MAX_PLAN_BYTES, AUTOPILOT_PLAN_SCHEMA, autopilotPlanSha256, parseAutopilotPlan, type CurrentAutopilotPlan } from "./autopilotPlan";
import { sha256Canonical, sha256Text, type AutopilotPlanLiveSource } from "./autopilotInvocationIdentity";
import { assertNativeTemplateDirectionBinding, type DesignEvidence, type DesignRequest } from "./autopilotDesignContract";
import type { EditorialPlan } from "./editorialPlan";
import { AUTOPILOT_INFERENCE_SCHEMA, type InferencePriority, type InferenceRecommendation, type InferenceTaskClass } from "./inferencePolicy";
import { MOTION_TREATMENT_FAMILIES, motionCommandFamilies, type MotionTreatmentFamily } from "./motionTreatment";
import { REFERENCE_MOTION_EDITORIAL_BINDING_CAPABILITY, referenceMotionVisibleProjection, type ReferenceMotionPlan } from "./referenceMotionPlan";
import { TemplateShortBlockError, assertCopySlots, type TemplateShortCopy, type TemplateShortFamily } from "./templateShortBrief";

/** M1 one-tool Short, plan composition (design §3.5, §5.4; TS port of acceptance-100/tools/build_template_plan.py). Every
 * fact comes from an in-memory receipt the caller already holds; the template's beats bind its compiled roles. The
 * product audit/apply stays the acceptance authority: this compile is only a proposal they independently redo. */

/** Template-emitted narrative beat (design §5.1; the compile's `beats`, ReferenceMotionTemplateBeat). Frames are project frames. */
export interface TemplateShortBeat {
  id: string;
  narrativeRole: "promise" | "build" | "proof" | "reveal" | "payoff";
  designRole: "first_frame" | "proof" | "process" | "comparison" | "payoff";
  startFrame: number;
  endFrame: number;
  roleKeys: readonly string[];
}
/** What the composer reads from a generation-2 prepare_reference_motion_template packet. */
export interface TemplateShortPacket {
  schema: string;
  status: string;
  readOnly: boolean;
  sourceGeneration: { projectId: string; projectRevision: number; projectSha256: string };
  instance: ReferenceMotionTemplateInstance;
  commands: EditorCommand[];
  planDeclaration: ReferenceMotionPlan;
  editorialGraphics: EditorialPlan["graphics"];
  /** The beats the design theme declared while drawing ([] when the family declares none yet; absent on pre-beat compiles). */
  beats?: readonly TemplateShortBeat[];
}

// A reference-motion compiler group may contain these; add_track is structural, never a visible design command.
const COMPILER_COMMAND_TYPES = new Set(["add_motion_graphic", "add_track", "add_clip", "set_clip_layout", "add_clip_mask", "add_keyframe", "set_clip_creative"]);
const VISIBLE_COMPILER_COMMAND_TYPES = new Set([...COMPILER_COMMAND_TYPES].filter(type => type !== "add_track"));
/** The id a compiler role records for this command (graphic, clip, mask or keyframe). */
function compilerCommandTarget(command: EditorCommand): string | undefined {
  if (command.type === "add_motion_graphic") return command.graphic.id;
  if (command.type === "add_clip") return command.clip.id;
  if (command.type === "set_clip_layout" || command.type === "set_clip_creative") return command.clipId;
  if (command.type === "add_clip_mask") return command.mask.id;
  if (command.type === "add_keyframe") return command.keyframe.id;
  return undefined;
}

/** §5.4 coverage invariant, shared by the composer and the contract tests: every visible compiled role in exactly one
 * beat, beats ordered over the template window, promise first and payoff last, each beat binding visible commands and
 * the first (directed) beat a motion graphic. Command indexes are packet-relative. */
export function assertTemplateBeatCoverage(packet: Pick<TemplateShortPacket, "instance" | "commands">, beats: readonly TemplateShortBeat[]) {
  const fail = (detail: string) => new TemplateShortBlockError("BLOCK_TEMPLATE_BEATS", detail);
  const roles = packet.instance.roles, input = packet.instance.input;
  if (new Set(roles.map(role => role.id)).size !== roles.length) throw fail("compiler role identities must be unique");
  const keyById = new Map(roles.map(role => [role.id, role.key])), indexByRole = new Map<string, number[]>();
  packet.commands.forEach((command, index) => {
    if (!VISIBLE_COMPILER_COMMAND_TYPES.has(command.type)) return;
    const target = compilerCommandTarget(command), key = target === undefined ? undefined : keyById.get(target);
    if (key === undefined) throw fail(`visible command ${index} (${command.type}) has no compiler role`);
    indexByRole.set(key, [...indexByRole.get(key) ?? [], index]);
  });
  if (!beats.length) throw fail("the template declares no beats");
  if (new Set(beats.map(beat => beat.id)).size !== beats.length) throw fail("beat ids must be unique");
  const start = input.startFrame, end = input.startFrame + input.durationFrames;
  beats.forEach((beat, index) => {
    if (index === 0 && beat.startFrame !== start) throw fail(`beat ${beat.id} must start at the template start frame ${start}`);
    if (index > 0 && beat.startFrame <= beats[index - 1].startFrame) throw fail(`beat ${beat.id} must start after beat ${beats[index - 1].id}`);
    const expectedEnd = beats[index + 1]?.startFrame ?? end;
    if (beat.endFrame !== expectedEnd || beat.startFrame >= end) throw fail(`beat ${beat.id} must end at frame ${expectedEnd}, inside the template window`);
  });
  if (beats[0].narrativeRole !== "promise") throw fail(`the first beat ${beats[0].id} must be the promise`);
  if (beats.at(-1)!.narrativeRole !== "payoff") throw fail(`the last beat ${beats.at(-1)!.id} must be the payoff`);
  const beatOfRole = new Map<string, string>();
  for (const beat of beats) for (const key of beat.roleKeys) {
    const other = beatOfRole.get(key);
    if (other !== undefined) throw fail(`role ${key} is in beats ${other} and ${beat.id}`);
    beatOfRole.set(key, beat.id);
  }
  for (const key of indexByRole.keys()) if (!beatOfRole.has(key)) throw fail(`role ${key} is in no beat`);
  const beatIndexes = beats.map(beat => beat.roleKeys.flatMap(key => indexByRole.get(key) ?? []).sort((a, b) => a - b));
  beats.forEach((beat, index) => { if (!beatIndexes[index].length) throw fail(`beat ${beat.id} binds no visible command`); });
  if (!beatIndexes[0].some(index => packet.commands[index].type === "add_motion_graphic")) throw fail(`the first beat ${beats[0].id} binds no motion graphic`);
  return { indexByRole, beatIndexes };
}

/** The creator-facing editorial content: brief/packaging/captions/…/delivery, plus beat and family-reason texts. */
export interface TemplateShortEditorial {
  base: Omit<EditorialPlan, "narrative" | "graphics" | "motionTreatment">;
  backbone: string;
  beats: ReadonlyArray<{ id: string; summary: string; application: string }>;
  familyReasons: { use: Partial<Record<MotionTreatmentFamily, string>>; omit: Partial<Record<MotionTreatmentFamily, string>> & { default: string } };
}

/** The 31 editorial fields identical in all eight r53 units (design §3.5), and the family omit reasons. Clone before use. */
export const TEMPLATE_SHORT_EDITORIAL_DEFAULTS: {
  captions: EditorialPlan["captions"]; transitions: EditorialPlan["transitions"]; assets: EditorialPlan["assets"];
  color: Omit<EditorialPlan["color"], "primaryLookId">; audio: Omit<EditorialPlan["audio"], "mode" | "layers">;
  delivery: Omit<EditorialPlan["delivery"], "variants">; packaging: Omit<EditorialPlan["packaging"], "hypotheses">;
  familyReasonsOmit: Partial<Record<MotionTreatmentFamily, string>> & { default: string };
} = {
  captions: { mode: "semantic", maxCharsPerLine: 18, maxLines: 2, minimumOnScreenFrames: 24, semanticEmphasisOnly: true, separateFromGraphics: true },
  transitions: [],
  assets: { truthSourceFirst: true, semanticSelectionOnly: true, candidateIds: [], resolutionOrder: ["truth_source", "semantic_broll", "motion", "card", "clean_hold"] },
  color: { sourceMode: "media_grade", onePrimaryLook: true, shotMatchRequired: true, graphicsAfterGrade: true, exceptions: [] },
  audio: { dialoguePriority: true, blanketWhooshEveryCut: false, impactFrames: [], breathFrames: [] },
  delivery: { currentArtifactOnly: true, platforms: ["archive"], outcomeCheckpoints: ["D2", "D7", "D28"] },
  packaging: { evaluationMetric: "watch_time_share", introMustFulfillPackagingPromise: true },
  familyReasonsOmit: {
    default: "此單一實拍片段不需要；不添加未觀測的剪接、追蹤、特效或轉場",
    hud: "主題版面只用標題與圖卡角色，不加常駐資訊條",
    tracking_masks: "素材放在主題相框／視窗內，不需要追蹤或遮罩",
    vfx: "不加特效，保留現場真實光線",
    transitions_camera: "單一連續鏡頭，不加轉場或數位運鏡",
  },
};

export interface TemplateShortEditorialInputs {
  family: TemplateShortFamily;
  copy: TemplateShortCopy;
  /** ≤120 characters; the design default is payoff plus the first seen note. */
  topic: string;
  shortId: string;
  /** Project asset of the source clip (audio layer evidence). */
  assetId: string;
  /** Theme display name, e.g. 旅遊手帳. */
  themeName: string;
  probe: { hasAudio: boolean; colorTransfer?: string };
  speech: "present" | "absent" | "unmeasured";
  /** Per-beat summary/application sentences filled from copy (the family's beat table, written at certification). */
  beats: ReadonlyArray<{ id: string; summary: string; application: string }>;
  /** Per-family `use` reasons written at certification; only families the commands actually use are read. */
  useReasons: Partial<Record<MotionTreatmentFamily, string>>;
}
/** The 22 derived editorial fields. Sentence templates restate the creator's copy only and add no facts (M10). */
export function deriveEditorial(inputs: TemplateShortEditorialInputs): TemplateShortEditorial {
  const { copy, family } = inputs, defaults = structuredClone(TEMPLATE_SHORT_EDITORIAL_DEFAULTS);
  assertCopySlots(family, copy);
  const labels = copy.points?.map(point => point.label) ?? [];
  const hlg = inputs.probe.colorTransfer === "arib-std-b67", pq = inputs.probe.colorTransfer === "smpte2084";
  const brief = family === "strike_reframe" ? {
    audience: `對「${inputs.topic}」有興趣的觀眾`,
    premise: `原本以為「${copy.hook}」，其實是「${copy.payoff}」`,
    promise: `第一格讀到「${copy.hook}」，接著換成「${copy.payoff}」`,
    stakes: `只記得「${copy.hook}」，會錯過「${copy.payoff}」`,
    payoff: copy.proof ? `「${copy.payoff}」：${copy.proof}` : `「${copy.payoff}」`,
    firstFramePromise: copy.place ? `第一格讀到「${copy.place}」與「${copy.hook}」` : `第一格讀到「${copy.hook}」`,
  } : {
    audience: `對「${inputs.topic}」有興趣的觀眾`,
    premise: `「${copy.payoff}」的重點依序出現`,
    promise: `第一格讀到「${copy.payoff}」，接著依序看到每個重點`,
    stakes: `少看一個重點就不完整：${labels.map(label => `「${label}」`).join("、")}`,
    payoff: `最後停在「${labels.at(-1)}」`,
    firstFramePromise: copy.place ? `第一格讀到「${copy.place}」與「${copy.payoff}」` : `第一格讀到「${copy.payoff}」`,
  };
  const subtitles = !inputs.probe.hasAudio || inputs.speech === "absent" ? "片中沒有旁白或對話；文案已由主題圖文承擔，不另加逐字字幕"
    : inputs.speech === "present" ? "本版只用主題圖文承擔文案，不另加逐字字幕" : "語音未量測；本版只用主題圖文承擔文案，不另加逐字字幕";
  return {
    base: {
      brief,
      packaging: { ...defaults.packaging, hypotheses: [{ id: inputs.shortId, title: copy.payoff, thumbnailPromise: inputs.topic,
        openingFulfillment: family === "strike_reframe" ? `第一格刪掉「${copy.hook}」，換成「${copy.payoff}」` : `第一格讀到「${copy.payoff}」，重點依序出現`,
        distinctFromIds: [] }] },
      captions: defaults.captions,
      transitions: defaults.transitions,
      audio: inputs.probe.hasAudio
        ? { mode: "source_layers", ...defaults.audio, layers: [{ id: "source-audio", role: "production_sound",
          purpose: "保留原片連續時鐘與現場聲音；不新增旁白、音效或配樂", evidenceRefs: [`asset:${inputs.assetId}`] }] }
        : { mode: "silent_media", ...defaults.audio, layers: [] },
      color: { ...defaults.color, primaryLookId: hlg ? "neutral-hlg-display-sdr" : pq ? "neutral-pq-display-sdr" : "neutral-source-sdr" },
      assets: defaults.assets,
      delivery: { ...defaults.delivery, variants: [{ id: `${inputs.shortId}-portrait`, aspectRatio: "9:16", purpose: `${inputs.themeName}・${family} 模板短片，尚未發布` }] },
    },
    backbone: family === "strike_reframe" ? `「${copy.hook}」被刪去，換成「${copy.payoff}」${copy.proof ? `；${copy.proof}` : ""}`
      : `「${copy.payoff}」→ ${labels.join(" → ")}`,
    beats: inputs.beats.map(beat => ({ ...beat })),
    familyReasons: {
      use: { ...inputs.useReasons },
      omit: { ...defaults.familyReasonsOmit, subtitles,
        color: hlg ? "HLG 原片以已驗證的 HLG→SDR 顯示轉換輸出，不另外調色" : pq ? "PQ 原片以 HDR→SDR 顯示轉換輸出，不另外調色" : "原片維持原始 SDR 顯示，不另外調色",
        sound: inputs.probe.hasAudio ? "保留原片現場聲音，不加音效或配樂" : "原片沒有音軌；不加音效或配樂" },
    },
  };
}

export interface TemplateShortComposeInputs {
  /** The bootstrapped project the template was compiled against. */
  project: EditProject;
  /** Live Video Autopilot identity at seal (autopilotPlanSourceFromIdentity). */
  source: AutopilotPlanLiveSource;
  route: Pick<InferenceRecommendation, "preferred" | "executionMode" | "secondPassRequired"> & { taskClass: InferenceTaskClass; priority: InferencePriority };
  router: { protocol: string; markdown: string; markdownRouterSha256: string };
  skill: EditkinSkillSelectionReceipt;
  /** compileCurrentDesign output (request, context, recipes). */
  brief: { request: DesignRequest; context: unknown; recipes: ReadonlyArray<{ beatId: string; recipe: { route: { primary_family: string } } }> };
  /** designIdentity(brief, project). */
  identity: { projectSha256: string; sourceSha256: string; briefSha256: string };
  packet: TemplateShortPacket;
  /** Defaults to the template-emitted packet.beats. An explicit list only replays an r53-era hand-written beat map. */
  beats?: readonly TemplateShortBeat[];
  /** One row per material: the semantic receipt bound to the prepared material packet source. */
  semantics: ReadonlyArray<{ materialId: string; sourceSha256: string; assetId: string; clipId: string; semanticReceiptSha256: string }>;
  /** deriveEditorial(copy, probe, …), or an authored editorial for replay. */
  editorial: TemplateShortEditorial;
  policy: AestheticReviewPolicy;
  provider: "codex" | "claude_code" | "other";
  /** Who actually wrote the semantic inputs. Absent seals the route's preferred model (the r53 Codex runs); a caller that
   * cannot name its model, or the in-app creator flow with no model at all, must say so instead of borrowing that id. */
  model?: { modelId: string; modelTier: "frontier" | "balanced" | "efficient" | "unknown"; reasoningEffort: "none" | "low" | "medium" | "high" | "xhigh" | "max" | "unknown" };
}

/** M8 (design §4): the design request of a compiled template. Its beats are the template-emitted beats, with the beat
 * table's energy and focus; the first beat directs the template exactly as it was compiled (templateId, cadence, style). */
export function templateShortDesignRequest(input: { domain: string; styleFamily: string; topic: string; durationFrames: number; fps: number;
  beats: readonly TemplateShortBeat[]; texts: ReadonlyArray<{ id: string; energy: number; primaryFocus: string }>;
  templateInput: Pick<ReferenceMotionTemplateInstance["input"], "templateId" | "graphicCadence" | "style"> }): DesignRequest {
  const { templateInput } = input;
  if (!templateInput.style) throw new TemplateShortBlockError("BLOCK_COMPOSE", "The compiled template input has no explicit style to direct");
  if (canonicalJson(input.texts.map(row => row.id)) !== canonicalJson(input.beats.map(beat => beat.id))) {
    throw new TemplateShortBlockError("BLOCK_TEMPLATE_BEATS", "Beat-table words differ from the template-emitted beats");
  }
  return { format: "shorts", domain: input.domain, topic: input.topic, duration: input.durationFrames / input.fps, styleFamily: input.styleFamily,
    beats: input.beats.map((beat, index) => ({ id: beat.id, role: beat.designRole, energy: input.texts[index].energy, subject: input.texts[index].primaryFocus,
      ...(index === 0 ? { nativeTemplateDirection: { templateId: templateInput.templateId, graphicCadence: templateInput.graphicCadence ?? "legacy",
        style: structuredClone(templateInput.style) } } : {}) })) };
}

const designContextSchema = z.object({ learning: z.object({
  budget: z.object({ estimated_tokens: z.number().int().min(1), knowledge_rules_trimmed: z.number().int().nonnegative(),
    within_budget: z.boolean(), knowledge_rules_selected: z.number().int().nonnegative() }),
  knowledge_card: z.array(z.object({ id: z.string() })),
}) });

/** Composes the REVIEW_REQUIRED v4 plan and self-checks it (caps, the full v4 parse, native direction). Throws only
 * TemplateShortBlockError: BLOCK_TEMPLATE_BEATS for beat coverage, BLOCK_COMPOSE for anything else; nothing is written.
 * `legacyViewedRefs` only replays r53-era template inputs that still carried a viewed-frame label beside their semantic receipt. */
export function composeTemplateShortPlan(inputs: TemplateShortComposeInputs, options: { legacyViewedRefs?: boolean } = {}) {
  try { return composeCheckedPlan(inputs, options); }
  catch (error) {
    if (error instanceof TemplateShortBlockError) throw error;
    throw new TemplateShortBlockError("BLOCK_COMPOSE", `Composer input is malformed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
function composeCheckedPlan(inputs: TemplateShortComposeInputs, options: { legacyViewedRefs?: boolean }) {
  const fail = (detail: string) => new TemplateShortBlockError("BLOCK_COMPOSE", detail);
  const check = (condition: unknown, detail: string) => { if (!condition) throw fail(detail); };
  const { project, packet, brief, editorial } = inputs, request = brief.request, policy = normalizeReviewPolicy(inputs.policy);
  check(inputs.route.executionMode === "audit_then_apply" && inputs.route.secondPassRequired === true, "Unsupported inference route");
  check(sha256Text(inputs.router.markdown) === inputs.router.markdownRouterSha256, "Router Markdown SHA mismatch");
  check(inputs.skill.pluginRegistrySha256 === inputs.source.pluginRegistrySha256, "Skill receipt plugin registry drift");
  check(inputs.skill.context.format === request.format && inputs.skill.context.domain === request.domain, "Skill receipt route differs from design request");
  check(brief.recipes.length === request.beats.length && brief.recipes.every((row, index) => row.beatId === request.beats[index].id), "Design recipes differ from the request beats");
  const context = designContextSchema.safeParse(brief.context);
  check(context.success, "Design context packet has no learning budget");
  const budget = context.data!.learning.budget, memory = context.data!.learning.knowledge_card.map(row => row.id);
  check(budget.within_budget === true && budget.knowledge_rules_selected === memory.length, "Context packet incomplete");
  const projectSha256 = sha256Canonical(project);
  check(inputs.identity.projectSha256 === projectSha256, "Design brief was read for a different project state");

  // Compiled template.
  check(packet.status === "REVIEW_REQUIRED" && packet.schema === "editkin.reference-motion-template/v2" && packet.readOnly === true,
    "Expected an actual read-only generation-2 template preparation");
  const generation = packet.sourceGeneration;
  check(generation.projectId === project.id && generation.projectRevision === project.revision && generation.projectSha256 === projectSha256,
    "Template was compiled for a different project state");
  const instance = packet.instance, authored = instance.input, commands = structuredClone(packet.commands);
  const metadata = commands.at(-1);
  check(metadata?.type === "upsert_reference_motion_instance" && canonicalJson(metadata.instance) === canonicalJson(instance)
    && commands.slice(0, -1).every(command => COMPILER_COMMAND_TYPES.has(command.type)), "Unexpected template command set");
  const declaration = structuredClone(packet.planDeclaration), group = declaration.instances;
  check(group.length === 1 && group[0].instanceId === instance.id && canonicalJson(group[0].commandIndexes) === canonicalJson(commands.map((_, index) => index)),
    "Incomplete compiler group");
  if (!project.aestheticSystem) throw fail("Project has no aesthetic system");
  const aesthetic = structuredClone(project.aestheticSystem);
  check(canonicalJson(normalizeReviewPolicy(aesthetic.reviewPolicy)) === canonicalJson(policy) && aesthetic.review.status === "REVIEW",
    "Project aesthetic is not the authorized pending review");
  check(request.styleFamily === aesthetic.primaryFamily, "Design style family differs from the project aesthetic");
  check(brief.recipes.every(row => row.recipe.route.primary_family === aesthetic.primaryFamily), "Recipe family mismatch");
  const beats = inputs.beats ?? packet.beats ?? [], coverage = assertTemplateBeatCoverage(packet, beats);
  commands.unshift({ type: "set_aesthetic_system", aestheticSystem: structuredClone(aesthetic) });
  check(commands.length <= AUTOPILOT_MAX_COMMANDS, `Plan has ${commands.length} commands; the v4 limit is ${AUTOPILOT_MAX_COMMANDS}`);
  group[0].commandIndexes = group[0].commandIndexes.map(index => index + 1);
  for (const beat of request.beats) if (beat.nativeTemplateDirection) {
    check(canonicalJson(beat.nativeTemplateDirection) === canonicalJson({ templateId: authored.templateId, graphicCadence: authored.graphicCadence ?? "legacy", style: authored.style }),
      `Native direction of ${beat.id} differs from the compiled template input`);
  }
  const fps = project.fps;
  check(canonicalJson(request.beats.map(beat => [beat.id, beat.role])) === canonicalJson(beats.map(beat => [beat.id, beat.designRole])), "Template beats differ from the design request beats");
  check(canonicalJson(editorial.beats.map(beat => beat.id)) === canonicalJson(beats.map(beat => beat.id)), "Editorial beat texts differ from the template beats");
  const total = Math.round(Math.max(0, ...project.tracks.filter(track => track.kind === "video").flatMap(track => track.clips.map(clip => clip.timelineStart + clip.duration))) * fps);
  check(authored.startFrame === 0 && authored.startFrame + authored.durationFrames === total, "The template must span the whole short");
  check(Math.abs(request.duration - total / fps) <= 1 / fps + 1e-6, "Design duration differs from the timeline");

  // Editorial graphics: one event per compiled visible graphic, bound to its compiler role (compact binding).
  const graphics = structuredClone(packet.editorialGraphics);
  if (options.legacyViewedRefs) for (const event of graphics) {
    event.evidenceRefs = event.evidenceRefs.filter(ref => {
      const viewed = /^material:([a-f0-9]{64}):viewed-.+$/.exec(ref);
      return !viewed || !event.evidenceRefs.some(other => new RegExp(`^material:${viewed[1]}:semantic:[a-f0-9]{64}$`).test(other));
    });
    check(event.evidenceRefs.length, "Graphic evidence cannot be emptied by reference compaction");
  }
  const presetSha = new Map(instance.dependencies.presetHashes.map(row => [row.presetId, row.sha256]));
  for (const event of graphics) {
    const matches = commands.flatMap((command, index) => command.type === "add_motion_graphic" && command.graphic.id === event.id ? [{ index, graphic: command.graphic }] : []);
    const roles = instance.roles.filter(role => role.kind === "graphic" && role.id === event.id);
    check(matches.length === 1 && roles.length === 1, "Compact event must have one complete compiler graphic and role");
    const { index, graphic } = matches[0];
    check(group[0].commandIndexes.slice(0, -1).includes(index) && graphic.presetId === event.presetId && !event.referenceMotionBinding
      && event.presetVariant?.schema === "editkin.motion-preset-variant/v1" && event.presetVariant.basePresetSha256 === presetSha.get(event.presetId),
      "Compact event compiler/preset identity differs");
    delete event.presetVariant;
    event.referenceMotionBinding = { schema: REFERENCE_MOTION_EDITORIAL_BINDING_CAPABILITY.schema, instanceId: instance.id, roleKey: roles[0].key, commandIndex: index };
  }
  const graphicIds = commands.flatMap(command => command.type === "add_motion_graphic" ? [command.graphic.id] : []);
  check(canonicalJson([...graphicIds].sort()) === canonicalJson(graphics.map(event => event.id).sort()), "Editorial graphics omit actual visible commands");
  for (const event of graphics) {
    const graphic = commands.flatMap(command => command.type === "add_motion_graphic" && command.graphic.id === event.id ? [command.graphic] : [])[0];
    check(event.message === graphic.text && event.range.startFrame === Math.round(graphic.timelineStart * fps)
      && event.range.endFrame === Math.round((graphic.timelineStart + graphic.duration) * fps), "Graphic range/message drift");
  }

  // Beats, design decisions and the ten-family treatment, all bound to plan-relative command indexes.
  const refs = [...authored.evidenceRefs];
  const recipeSha = new Map(brief.recipes.map(row => [row.beatId, sha256Canonical(row.recipe)]));
  const decisions = beats.map((beat, index) => ({ beatId: beat.id, recipeSha256: recipeSha.get(beat.id)!,
    application: editorial.beats[index].application, commandIndexes: coverage.beatIndexes[index].map(command => command + 1) }));
  const narrativeBeats = beats.map((beat, index) => {
    const designBeat = request.beats[index];
    return { id: beat.id, range: { startFrame: beat.startFrame, endFrame: beat.endFrame }, role: beat.narrativeRole,
      summary: editorial.beats[index].summary, energy: designBeat.energy, primaryFocus: designBeat.subject, evidenceRefs: [...refs] };
  });
  const visible = referenceMotionVisibleProjection(declaration, commands);
  const used = Object.fromEntries(MOTION_TREATMENT_FAMILIES.map(family => [family,
    visible.flatMap((command, index) => motionCommandFamilies(command).includes(family) ? [index] : [])])) as Record<MotionTreatmentFamily, number[]>;
  const unexplained = MOTION_TREATMENT_FAMILIES.filter(family => used[family].length && !editorial.familyReasons.use[family]);
  check(!unexplained.length, `Used families need an authored reason: ${unexplained.join(", ")}`);
  const motionTreatment = { schema: "editkin.motion-treatment/v1" as const, decisions: MOTION_TREATMENT_FAMILIES.map(family => used[family].length
    ? { family, action: "use" as const, reason: editorial.familyReasons.use[family]!,
      beatIds: decisions.filter(row => row.commandIndexes.some(index => used[family].includes(index))).map(row => row.beatId), commandIndexes: used[family] }
    : { family, action: "omit" as const, reason: editorial.familyReasons.omit[family] ?? editorial.familyReasons.omit.default, beatIds: [], commandIndexes: [] }) };

  // Material evidence from actual receipts, bound to project clips; the template clip must be evidenced.
  check(inputs.semantics.length > 0 && inputs.semantics.some(row => row.clipId === authored.clipId), "The template clip has no material semantics receipt");
  const clips = project.tracks.flatMap(track => track.clips);
  for (const row of inputs.semantics) {
    check(clips.some(clip => clip.id === row.clipId && clip.assetId === row.assetId), `Material ${row.materialId} is not a clip of this project`);
  }
  const receipts = inputs.semantics.map(({ materialId, sourceSha256, assetId, clipId, semanticReceiptSha256 }) => ({ materialId, sourceSha256, assetId, clipId, semanticReceiptSha256 }));
  const editorialPlan = { ...structuredClone(editorial.base),
    narrative: { backbone: editorial.backbone, beats: narrativeBeats,
      setupPayoffs: beats.length > 1 ? [{ setupBeatId: beats[0].id, payoffBeatId: beats.at(-1)!.id }] : [] },
    graphics, motionTreatment };
  const designEvidence: DesignEvidence = { schema: "editkin.autopilot-design-evidence/v1", request: structuredClone(request), ...inputs.identity, decisions };
  const plan = {
    schema: AUTOPILOT_PLAN_SCHEMA, source: structuredClone(inputs.source),
    route: { mode: "build", format: request.format, domain: request.domain },
    budget: { contextTokens: budget.estimated_tokens, selectedMemoryRuleIds: memory, trimmedMemoryRuleCount: budget.knowledge_rules_trimmed, assetCandidateCount: 0 },
    assurances: { originalAssetsReadOnly: true, structuredCommandsOnly: true, semanticAssetsOnly: true, licenseFailClosed: true,
      captionsSeparateFromGraphics: true, reviewDoesNotEqualCertification: true },
    quality: { state: "review_required" },
    inference: { schema: AUTOPILOT_INFERENCE_SCHEMA, provider: inputs.provider, modelId: inputs.model?.modelId ?? inputs.route.preferred.modelId,
      modelTier: inputs.model?.modelTier ?? "frontier", reasoningEffort: inputs.model?.reasoningEffort ?? inputs.route.preferred.reasoningEffort,
      taskClass: inputs.route.taskClass, priority: inputs.route.priority,
      context: { protocol: inputs.router.protocol, markdownRouterSha256: inputs.router.markdownRouterSha256, packetTokens: budget.estimated_tokens,
        progressiveDisclosure: true, structuredExecutionTruth: true },
      evaluation: { state: "unmeasured" },
      safeguards: { semanticAuditRequired: true, automaticEscalationOnBlock: true, executionMode: "audit_then_apply", secondPassRequired: true,
        humanReviewRequired: policy.mode === "human", reviewPolicy: structuredClone(policy) } },
    materialEvidence: { schema: "hao.editkin.material-intelligence/v1", receipts },
    referenceMotion: declaration, extensions: { skillSelection: structuredClone(inputs.skill), pluginApplications: [] },
    aesthetic, editorial: editorialPlan, commands, designEvidence,
  };

  // Self-check (design §4 M9): the byte cap (the command cap ran above), the full v4 parse, and the native template direction.
  const bytes = new TextEncoder().encode(canonicalJson(plan)).byteLength;
  check(bytes <= AUTOPILOT_MAX_PLAN_BYTES, `Plan is ${bytes} bytes; the v4 limit is ${AUTOPILOT_MAX_PLAN_BYTES}`);
  let parsed: CurrentAutopilotPlan;
  try {
    parsed = parseAutopilotPlan(plan) as CurrentAutopilotPlan;
    assertNativeTemplateDirectionBinding(parsed.designEvidence!, parsed.commands as EditorCommand[], parsed.referenceMotion);
  } catch (error) { throw fail(`Composed plan fails the v4 contract: ${error instanceof Error ? error.message : String(error)}`); }
  // The sealed bytes must hash exactly as audit/apply re-hash the parsed plan.
  const planSha256 = autopilotPlanSha256(plan as unknown as CurrentAutopilotPlan);
  check(autopilotPlanSha256(parsed) === planSha256, "Composed plan changes under v4 parsing");
  return { plan, planSha256, bytes, commandCount: commands.length,
    beats: beats.map(beat => ({ id: beat.id, range: [beat.startFrame, beat.endFrame] as [number, number] })) };
}
