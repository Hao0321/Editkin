// Test support for the one-tool Short (not imported by product code): synthetic template compiles with real bundled
// glyphs, and a replay of the r53 hand-written beat maps (build_template_plan.py role patterns) as template beats.
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { applyCommand } from "../domain/commands";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type AestheticReviewPolicy, type EditProject } from "../domain/types";
import type { ReferenceMotionDesignSystem, ReferenceMotionTemplateId, ReferenceMotionTemplateInput } from "../motion/referenceMotionTemplates";
import { REFERENCE_MOTION_DESIGN_THEMES } from "../motion/referenceMotionTemplates";
import { createEmptyEditkinSkillSelectionReceipt } from "../plugins/skillPack";
import { bundledFontFaceSpec, bundledFontFaceSpecs } from "../typography/bundledFontCatalog";
import { resolveBundledFontFace } from "../typography/fontFaces";
import { preparePhysicalFace, type PreparedGlyphRun } from "../typography/preparedGlyphRun";
import { sha256Canonical, type AutopilotPlanLiveSource } from "./autopilotInvocationIdentity";
import { resolveAestheticSystem } from "./editkinAesthetic";
import { AUTOPILOT_CONTEXT_PROTOCOL, inferenceRouterSha256, recommendInferenceRoute, renderInferenceRouterMarkdown } from "./inferencePolicy";
import { parseProject } from "./projectCodec";
import { templateBeatTexts, templateFamilyBeatTable } from "./referenceMotionBeatTables";
import { prepareReferenceMotionTemplateInstance } from "./referenceMotionTemplateInstances";
import type { TemplateShortCopy, TemplateShortFamily } from "./templateShortBrief";
import { toTemplateInput } from "./templateShortCatalog";
import { deriveEditorial, templateShortDesignRequest, type TemplateShortBeat, type TemplateShortComposeInputs, type TemplateShortPacket } from "./templateShortPlan";

export const TEMPLATE_SHORT_FIXTURE_POLICY: AestheticReviewPolicy = { mode: "agent_reference_comparison", authorization: "測試用：明確授權 agent 自行完整對照參考審查" };
/** T01 (三民蝙蝠洞) creator copy, and a T04-shaped step list. */
export const TEMPLATE_SHORT_FIXTURE_COPY: Record<TemplateShortFamily, TemplateShortCopy> = {
  strike_reframe: { hook: "來看蝙蝠", payoff: "其實是來看水簾", accent: "水簾", proof: "名字叫蝙蝠洞，但現在已經沒有蝙蝠", place: "桃園復興｜三民蝙蝠洞", tag: "天然大岩洞" },
  context_stack: { payoff: "越走越懸空", accent: "懸空", place: "桃園復興｜小烏來",
    points: [{ label: "先走樹林步道" }, { label: "站上和平橋", detail: "往下看瀑布" }, { label: "瀑布正上方", detail: "瀑布就在腳底下" }] },
};
/** The corrected r53b maps (authoring/plan-spec.json for T01, editorial.base.json for T04). */
export const TEMPLATE_SHORT_FIXTURE_ROLE_MAPS: Record<TemplateShortFamily, TemplateShortRoleMapBeat[]> = {
  strike_reframe: [
    { id: "strike-hook", narrativeRole: "promise", designRole: "first_frame", roles: ["design:*", "previous*", "strike*"] },
    { id: "curtain-payoff", narrativeRole: "payoff", designRole: "payoff", startsAtRole: "headline:0", roles: ["headline*", "source*", "subtitle*", "tag*"] },
  ],
  context_stack: [
    { id: "path-open", narrativeRole: "promise", designRole: "first_frame", roles: ["design:*", "headline*", "source*"] },
    { id: "three-steps", narrativeRole: "payoff", designRole: "process", startsAtPhase: "hold", roles: ["item:*"] },
  ],
};

// Like the product's provider (src/mcp/referenceMotionPhysicalFonts.ts), each face is digested against the catalog and
// parsed once, and its runs are made from that parse (identical runs to prepareGlyphRun), instead of re-reading and
// re-parsing a 10–16 MB face for every text inside the 10-second preparation deadline. At most eight parsed faces are kept.
const faces = new Map<string, Promise<(text: string) => PreparedGlyphRun>>();
function preparedFace(faceId: string) {
  let face = faces.get(faceId);
  if (!face) {
    face = readFile(join(resolve("public/fonts"), bundledFontFaceSpec(faceId).fontFile)).then(bytes => preparePhysicalFace(faceId, new Uint8Array(bytes)));
    if (faces.size >= 8) faces.delete(faces.keys().next().value!);
    faces.set(faceId, face);
    face.catch(() => faces.delete(faceId));
  }
  return face;
}
/** Reads and parses the faces a theme can draw with once, outside any template preparation deadline (a cold read of
 * ~10 MB CJK faces under heavy parallel load can otherwise use up the 10-second budget of the first compile in a worker). */
export async function warmTemplateShortFonts(designSystems: readonly ReferenceMotionDesignSystem[] = ["trip_pop_v1"]) {
  const known = new Set(bundledFontFaceSpecs().map(spec => spec.faceId));
  for (const theme of designSystems) {
    const style = REFERENCE_MOTION_DESIGN_THEMES[theme].defaultStyle, families = [style.typography.headingFamily, style.typography.bodyFamily,
      String(REFERENCE_MOTION_DESIGN_THEMES[theme].numeralFamily)];
    for (const family of families) for (const weight of [300, 400, 500, 600, 700, 800, 900]) {
      const faceId = resolveBundledFontFace(family, weight)?.faceId;
      if (faceId && known.has(faceId)) await preparedFace(faceId);
    }
  }
}
export async function physicalText(faceId: string, text: string): Promise<PreparedGlyphRun> {
  return (await preparedFace(faceId))(text);
}

/** A bootstrapped one-clip portrait project as create_project + the neutral bootstrap leave it (synthetic metadata, no file). */
export function templateShortFixtureProject(options: { durationFrames?: number; policy?: AestheticReviewPolicy } = {}): EditProject {
  const frames = options.durationFrames ?? 330;
  const empty = createEmptyProject("Template short fixture", { id: "template-short-fixture", width: 1080, height: 1920, fps: 30 });
  const project = applyCommand(empty, { type: "batch", commands: [{ type: "set_editorial_profile", profile: "travel" },
    { type: "set_aesthetic_system", aestheticSystem: resolveAestheticSystem("travel", "shorts", options.policy ?? TEMPLATE_SHORT_FIXTURE_POLICY) }] });
  project.assets = [{ id: "batcave-4022", name: "IMG_4022.MOV", kind: "video", uri: "D:/synthetic/IMG_4022.MOV", duration: 30, width: 1080, height: 1920,
    displayAspectRatio: 9 / 16, color: { interpretation: "rec709" }, provenance: "Synthetic graph only; not a file, rights or footage-content verification" }];
  project.tracks[0].clips = [{ id: "clip-batcave", trackId: project.tracks[0].id, assetId: "batcave-4022", timelineStart: 0, sourceStart: 0,
    duration: frames / 30, volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] }];
  return parseProject(project);
}

/** prepare_reference_motion_template's packet for the adapter's input, with the file tool's defaults and declaration. */
export async function compileTemplateShortFixture(family: TemplateShortFamily, designSystem: ReferenceMotionDesignSystem = "trip_pop_v1",
  project = templateShortFixtureProject(), copy = TEMPLATE_SHORT_FIXTURE_COPY[family], options: { focus?: { x: number; y: number; w: number; h: number } } = {}) {
  const frames = Math.round(project.tracks[0].clips[0].duration * project.fps);
  const input = toTemplateInput(family, copy, { clipId: "clip-batcave", durationFrames: frames, designSystem, shortId: "ts-20261009-batcave-3f9a1c",
    semanticRef: `material:${"5".repeat(64)}:semantic:${"d".repeat(64)}`, brandMark: "Hao0321 Studio", focus: options.focus ?? { x: 0, y: 0.12, w: 1, h: 0.62 } });
  let ordinal = 0;
  const prepared = await prepareReferenceMotionTemplateInstance(project, { ...input, ...(family === "strike_reframe" ? { strikePresentation: "semantic_replace_v1" } : {}) },
    prefix => `${prefix}-${ordinal++}`, { prepareText: physicalText });
  const ids = new Set(prepared.commands.flatMap(command => command.type === "add_motion_graphic" ? [command.graphic.id] : []));
  const packet = { ...prepared, editorialGraphics: prepared.editorialGraphics.filter(graphic => ids.has(graphic.id)),
    planDeclaration: { schema: "editkin.reference-motion-plan/v1" as const, instances: [{ instanceId: prepared.instance.id, mode: "create" as const,
      commandIndexes: prepared.commands.map((_, index) => index) }] } };
  return { project, input, packet };
}

/** One r53-era hand-written beat: exact role names and prefix patterns ("design:*"), anchored on a phase or a role. */
export interface TemplateShortRoleMapBeat {
  id: string;
  narrativeRole: TemplateShortBeat["narrativeRole"];
  designRole: TemplateShortBeat["designRole"];
  startsAtRole?: string | null;
  startsAtPhase?: string;
  roles: readonly string[];
}
/** Replays build_template_plan.py: exact names are claimed first, then patterns in beat order over the visible compiled
 * roles; a beat starts at frame 0, at a compiled phase ("hold", "focus#2") or at a role's first graphic. */
export function templateBeatsFromRoleMap(packet: Pick<TemplateShortPacket, "instance" | "commands"> & { phases?: ReadonlyArray<{ role: string; startFrame: number }> },
  map: readonly TemplateShortRoleMapBeat[], fps: number): TemplateShortBeat[] {
  const keyById = new Map(packet.instance.roles.map(role => [role.id, role.key]));
  const target = (command: TemplateShortPacket["commands"][number]) => command.type === "add_motion_graphic" ? command.graphic.id
    : command.type === "add_clip" ? command.clip.id : command.type === "set_clip_layout" || command.type === "set_clip_creative" ? command.clipId
      : command.type === "add_clip_mask" ? command.mask.id : command.type === "add_keyframe" ? command.keyframe.id : undefined;
  const visible = [...new Set(packet.commands.flatMap(command => { const id = target(command); return id && keyById.has(id) ? [keyById.get(id)!] : []; }))];
  const claimed = new Set(map.flatMap(beat => beat.roles.filter(role => !role.endsWith("*"))));
  const resolved = map.map(beat => beat.roles.filter(role => !role.endsWith("*")));
  map.forEach((beat, index) => {
    for (const exact of resolved[index]) if (!visible.includes(exact)) throw new Error(`Role ${exact} of beat ${beat.id} is not a compiled visible role`);
    for (const pattern of beat.roles.filter(role => role.endsWith("*"))) {
      const matches = visible.filter(role => role.startsWith(pattern.slice(0, -1)) && !claimed.has(role));
      if (!matches.length && pattern !== "*") throw new Error(`Role pattern ${pattern} of beat ${beat.id} matches no unclaimed compiled role`);
      resolved[index].push(...matches); matches.forEach(role => claimed.add(role));
    }
  });
  const input = packet.instance.input, end = input.startFrame + input.durationFrames;
  const starts = map.map(beat => {
    if (beat.startsAtPhase) {
      const [role, nth] = beat.startsAtPhase.split("#"), found = (packet.phases ?? []).filter(phase => phase.role === role)[Number(nth ?? 1) - 1];
      if (!found) throw new Error(`Beat ${beat.id} anchors on a phase the template did not compile: ${beat.startsAtPhase}`);
      return found.startFrame;
    }
    if (!beat.startsAtRole) return input.startFrame;
    const graphic = packet.commands.find(command => command.type === "add_motion_graphic" && keyById.get(command.graphic.id) === beat.startsAtRole);
    if (graphic?.type !== "add_motion_graphic") throw new Error(`Beat ${beat.id} anchors on a role the template did not compile: ${beat.startsAtRole}`);
    return Math.round(graphic.graphic.timelineStart * fps);
  });
  return map.map((beat, index) => ({ id: beat.id, narrativeRole: beat.narrativeRole, designRole: beat.designRole, startFrame: starts[index],
    endFrame: starts[index + 1] ?? end, roleKeys: resolved[index] }));
}

/** The 17 design-theme family fixtures of referenceMotionDesignThemes.test.ts:33-51, copied so that hot test file stays untouched. */
export const TEMPLATE_SHORT_THEME_FIXTURES: Record<ReferenceMotionTemplateId, { frames: number; extra: number; input: Partial<ReferenceMotionTemplateInput> }> = {
  strike_reframe: { frames: 330, extra: 0, input: { previousText: "來看蝙蝠", title: "其實是來看水簾", accentText: "水簾", subtitle: "名字叫蝙蝠洞，但現在已經沒有蝙蝠", tag: "沒有蝙蝠" } },
  comparison_pair: { frames: 150, extra: 1, input: { title: "同樣的皮 兩種做法", accentText: "兩種做法", primaryLabel: "紅油抄手 皮薄透餡", verdicts: ["good", "bad"] } },
  context_stack: { frames: 360, extra: 0, input: { title: "大溪老街 蔡記", accentText: "蔡記",
    items: [{ label: "現場手工做", detail: "鋪粉、壓條全程看得到" }, { label: "麥芽花生 一盒150" }, { label: "全台僅此一家", detail: "申明板寫別無分店" }] } },
  brand_recap: { frames: 420, extra: 0, input: { title: "龍騰斷橋", accentText: "斷橋",
    items: [{ label: "1907", detail: "紅磚拱橋完工" }, { label: "1935", detail: "關刀山大地震震斷" }, { label: "1999", detail: "九二一又斷一次" }, { label: "2003", detail: "列為縣定古蹟" }] } },
  level_bridge: { frames: 180, extra: 0, input: { title: "烏嘎彥竹林", accentText: "竹林", subtitle: "兩邊竹梢往中間彎，太陽從竹縫透進來" } },
  evidence_takeover: { frames: 300, extra: 0, input: { title: "現做麥芽花生糖", accentText: "麥芽花生糖", subtitle: "鋪粉、壓條全程看得到" } },
  focus_wall: { frames: 150, extra: 2, input: { title: "號稱平價版鼎泰豐", accentText: "鼎泰豐", primaryLabel: "紅油抄手" } },
  kinetic_network: { frames: 300, extra: 0, input: { title: "一句話剪成一支片", items: [{ label: "看懂素材" }, { label: "自動剪輯" }, { label: "動態模板" }],
    network: { seed: 32021, points: 32, labels: ["素材", "剪輯", "模板"], hubLabel: "一句話" } } },
  stat_reveal: { frames: 300, extra: 0, input: { title: "一週剪完三支片", accentText: "三支片",
    items: [{ label: "69%", detail: "時間花在挑素材" }, { label: "3 支", detail: "一週完成" }, { label: "NT$0", detail: "不另付費" }] } },
  statement_cut: { frames: 300, extra: 0, input: { title: "用一句話開始剪輯", items: [{ label: "看懂" }, { label: "剪好", detail: "一句話完成" }, { label: "上線" }] } },
  word_build: { frames: 240, extra: 0, input: { title: "你的下一支 影片", accentText: "影片", subtitle: "只要 一句話" } },
  stat_cycle: { frames: 330, extra: 0, input: { title: "一週的成果", items: [{ label: "3 支", detail: "長片完成" }, { label: "69%", detail: "時間花在挑素材" }, { label: "NT$0", detail: "不另付費" }] } },
  word_cycle: { frames: 240, extra: 0, input: { title: "在咖啡涼掉之前", items: [{ label: "剪好" }, { label: "配樂" }, { label: "上線" }] } },
  logo_end: { frames: 180, extra: 0, input: { title: "一句話開始剪輯", subtitle: "AI 剪輯工作室", kicker: "Editkin · Autopilot" } },
  ranked_list: { frames: 300, extra: 0, input: { title: "最常用的三個模板", accentText: "三個", primaryLabel: "使用次數",
    items: [{ label: "數據揭示", detail: "42" }, { label: "宣言快切", detail: "31" }, { label: "逐字標題", detail: "18" }] } },
  ui_demo: { frames: 300, extra: 0, input: { title: "輸出設定", kicker: "Editkin · 匯出", primaryLabel: "開始輸出", subtitle: "影片已輸出",
    items: [{ label: "動態模糊" }, { label: "畫面比例", detail: "9:16" }, { label: "影格率", detail: "30 fps" }] } },
  mark_open: { frames: 270, extra: 0, input: { title: "Hao0321 Studio", kicker: "AI 剪輯 · 2026", subtitle: "每一格都有理由" } },
};
const THEME_FIXTURE_LABELS = ["再炸一盤 起泡翹邊", "蔥鹽雞", "炸餛飩"], THEME_FIXTURE_WALL_LABELS = ["蔥鹽雞", "炸餛飩"];
/** The theme test's synthetic compile of any family × theme (synthetic metadata, real bundled glyphs). */
export async function compileDesignThemeFixture(family: ReferenceMotionTemplateId, theme: ReferenceMotionDesignSystem) {
  const spec = TEMPLATE_SHORT_THEME_FIXTURES[family];
  const project = createEmptyProject("Synthetic design theme control", { id: `theme-${theme}-${family}`, width: 1080, height: 1920, fps: 30 });
  project.assets = Array.from({ length: spec.extra + 1 }, (_, index) => ({ id: `media-${index}`, name: `Synthetic source ${index}`, kind: "video" as const,
    uri: `D:/synthetic/theme-${index}.mov`, duration: 30, width: 1080, height: 1920, displayAspectRatio: 9 / 16,
    color: { interpretation: "rec709" as const }, provenance: "Synthetic graph only; not a file, rights or footage-content verification" }));
  project.tracks[0].clips = [{ id: "primary", trackId: project.tracks[0].id, assetId: "media-0", timelineStart: 0, sourceStart: 1,
    duration: spec.frames / 30, volume: .7, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] }];
  const input = { templateId: family, clipId: "primary", startFrame: 0, durationFrames: spec.frames, graphicCadence: "kinetic", intent: "shortform",
    designSystem: theme, kicker: "桃園復興｜三民蝙蝠洞", brandMark: "Hao0321 Studio",
    sources: Array.from({ length: spec.extra }, (_, index) => ({ assetId: `media-${index + 1}`, sourceStart: 2,
      label: (family === "focus_wall" ? THEME_FIXTURE_WALL_LABELS : THEME_FIXTURE_LABELS)[index] })),
    evidenceRefs: ["synthetic:design-theme"], purpose: "Synthetic design theme control; no rendered art or ownership assertion", ...spec.input } as ReferenceMotionTemplateInput;
  let ordinal = 0;
  const parsed = parseProject(project);
  const packet = await prepareReferenceMotionTemplateInstance(parsed, input, (prefix, role) => `${prefix}-${role?.replaceAll(":", "-")}-${ordinal++}`,
    { prepareText: physicalText });
  return { project: parsed, input, packet };
}

export const TEMPLATE_SHORT_FIXTURE_SOURCE: AutopilotPlanLiveSource = { skillId: "video-autopilot", revision: 185, skillSha256: "a".repeat(64),
  workflowContractRevision: 6, workflowContractSha256: "b".repeat(64), knowledgeRevision: 79, knowledgeSha256: "c".repeat(64),
  stableRulesSha256: "d".repeat(64), pluginRegistrySha256: "e".repeat(64), invocationBindingSha256: "f".repeat(64) };
/** Synthetic one-material compose inputs over a template-emitted compile: the beats come from the template, the words from its
 * beat table, the design request from templateShortDesignRequest. No files, VA bridge or material cache. */
export async function templateShortComposeFixture(family: TemplateShortFamily, designSystem: ReferenceMotionDesignSystem = "trip_pop_v1",
  options: { copy?: TemplateShortCopy; hasAudio?: boolean; project?: EditProject } = {}): Promise<TemplateShortComposeInputs> {
  const copy = options.copy ?? TEMPLATE_SHORT_FIXTURE_COPY[family];
  const { project, packet } = await compileTemplateShortFixture(family, designSystem, options.project ?? templateShortFixtureProject(), copy);
  const aesthetic = project.aestheticSystem!, beats = packet.beats ?? [], table = templateFamilyBeatTable(family)!;
  const texts = templateBeatTexts(family, copy, beats), topic = `${copy.payoff}：synthetic fixture`;
  const request = templateShortDesignRequest({ domain: aesthetic.domain, styleFamily: aesthetic.primaryFamily, topic, durationFrames: packet.instance.input.durationFrames,
    fps: project.fps, beats, texts, templateInput: packet.instance.input });
  const markdown = renderInferenceRouterMarkdown("quality_critical", "quality");
  return {
    project, source: TEMPLATE_SHORT_FIXTURE_SOURCE, route: { ...recommendInferenceRoute("quality_critical", "quality"), taskClass: "quality_critical", priority: "quality" },
    router: { protocol: AUTOPILOT_CONTEXT_PROTOCOL, markdown, markdownRouterSha256: inferenceRouterSha256(markdown) },
    skill: createEmptyEditkinSkillSelectionReceipt(TEMPLATE_SHORT_FIXTURE_SOURCE.pluginRegistrySha256, { format: "shorts", domain: aesthetic.domain, semanticRoles: [...table.skillRoles] }),
    brief: { request, context: { learning: { budget: { estimated_tokens: 900, knowledge_rules_trimmed: 0, within_budget: true, knowledge_rules_selected: 1 },
      knowledge_card: [{ id: "K-03fb82e28066" }] } }, recipes: request.beats.map(beat => ({ beatId: beat.id, recipe: { route: { primary_family: aesthetic.primaryFamily, role: beat.role } } })) },
    identity: { projectSha256: sha256Canonical(project), sourceSha256: "1".repeat(64), briefSha256: "2".repeat(64) },
    packet,
    semantics: [{ materialId: "5".repeat(64), sourceSha256: "4".repeat(64), assetId: "batcave-4022", clipId: "clip-batcave", semanticReceiptSha256: "d".repeat(64) }],
    editorial: deriveEditorial({ family, copy, topic, shortId: "ts-20261009-batcave-3f9a1c", assetId: "batcave-4022", themeName: REFERENCE_MOTION_DESIGN_THEMES[designSystem].name,
      probe: { hasAudio: options.hasAudio ?? true, colorTransfer: "arib-std-b67" }, speech: "absent",
      beats: texts.map(({ id, summary, application }) => ({ id, summary, application })), useReasons: { ...table.useReasons } }),
    policy: TEMPLATE_SHORT_FIXTURE_POLICY, provider: "claude_code",
  };
}
