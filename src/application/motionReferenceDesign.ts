import * as z from "zod/v4";
import { createHash } from "node:crypto";
import type { EditProject } from "../domain/types";
import { projectDuration } from "../domain/editGraph";
import { resolveBundledFontFace } from "../typography/fontFaces";

const note = z.string().trim().min(6).max(700);
const evidence = z.array(z.string().trim().min(1).max(160)).min(1).max(12);
const role = z.enum(["hook", "chapter", "proof", "comparison", "recap", "cta"]);
const grammar = z.enum(["chapter_progress", "depth_gallery", "focus_reveal", "context_assembly", "evidence_takeover", "comparison", "focus_wall", "cinematic_stage", "sphere_overview"]);
const color = z.string().regex(/^#[\da-f]{6}$/i);

/** Observations are research inputs. They never grant media reuse or product approval. */
export const motionReferenceStudySchema = z.strictObject({
  id: z.string().trim().min(1).max(80), url: z.url(), sourceSha256: z.string().regex(/^[\da-f]{64}$/i),
  fps: z.number().finite().positive().max(240), totalFrames: z.number().int().positive(),
  width: z.number().int().positive(), height: z.number().int().positive(),
  fullVideoObserved: z.literal(true), boundaryPolicy: z.enum(["coverage_bins_not_cut_receipts", "verified_cut_frames"]),
  referenceOnlyAssetIds: z.array(z.string().min(1)).max(128).default([]),
  sections: z.array(z.strictObject({
    id: z.string().trim().min(1).max(80), startFrame: z.number().int().nonnegative(), endFrame: z.number().int().positive(),
    purpose: role, grammars: z.array(grammar).min(1).max(6),
    composition: note, subjectMotion: note, camera: note, rhythm: note, typography: note,
    colorRoles: note, transition: note, depthAndEdges: note, automationLesson: note, evidenceRefs: evidence,
  })).min(1).max(128),
}).superRefine((study, context) => {
  let cursor = 0;
  const ids = new Set<string>();
  for (const section of study.sections) {
    if (section.startFrame !== cursor || section.endFrame <= section.startFrame || section.endFrame > study.totalFrames || ids.has(section.id)) {
      context.addIssue({ code: "custom", message: "參考研究必須覆蓋整支影片，依序連續、不重疊、不遺漏；每段需要唯一 ID" });
    }
    cursor = section.endFrame; ids.add(section.id);
  }
  if (cursor !== study.totalFrames) context.addIssue({ code: "custom", message: "參考研究缺少結尾，不能以局部效果冒充完整參考" });
});

export const motionBrandSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  logo: z.discriminatedUnion("mode", [
    z.strictObject({ mode: z.literal("asset"), assetId: z.string().min(1), evidenceRefs: evidence }),
    z.strictObject({ mode: z.literal("omit"), reason: note }),
  ]),
  palette: z.strictObject({ surface: color, text: color, accent: color, muted: color, separator: color }),
  typography: z.strictObject({ headingFamily: z.string().trim().min(1).max(80), bodyFamily: z.string().trim().min(1).max(80) }),
  serviceFacts: z.array(z.strictObject({ id: z.string().trim().min(1).max(80), text: z.string().trim().min(1).max(240), evidenceRefs: evidence })).min(1).max(64),
  redesignIntent: note,
});
export type MotionBrand = z.infer<typeof motionBrandSchema>;
export const motionReferenceDesignInputSchema = z.strictObject({
  format: z.enum(["shorts", "longform"]), brand: motionBrandSchema,
  references: z.array(motionReferenceStudySchema).min(1).max(8),
  beats: z.array(z.strictObject({ id: z.string().trim().min(1).max(80), startFrame: z.number().int().nonnegative(), endFrame: z.number().int().positive(),
    purpose: role, narration: z.string().trim().min(1).max(700), title: z.string().trim().min(1).max(48), body: z.string().trim().max(64).optional(),
    clipId: z.string().min(1), factIds: z.array(z.string().min(1)).min(1).max(8), evidenceRefs: evidence,
  })).min(1).max(128),
});
export type MotionReferenceDesignInput = z.infer<typeof motionReferenceDesignInputSchema>;

const nativeCapabilities = { chapter_progress: "prepare_native_reel_scene:editorial_steps", depth_gallery: "prepare_native_reel_scene:spatial_gallery" } as const;
const longformCapabilities = { chapter_progress: "prepare_native_motion_sequence:context_label", focus_reveal: "prepare_native_motion_sequence:focus_hint" } as const;
type Grammar = z.infer<typeof grammar>;
const optionModes = [
  { id: "evidence_first", name: "先看證據", approach: "真素材先建立可信度，再用局部焦點與接管交代服務價值。", grammar: (purpose: string): Grammar => purpose === "comparison" ? "comparison" : purpose === "recap" || purpose === "cta" ? "focus_wall" : "evidence_takeover", focus: "source" },
  { id: "guided_process", name: "跟著操作理解", approach: "由問題、操作與章節進度逐步建立理解，說明停住時畫面也停住。", grammar: (purpose: string): Grammar => purpose === "proof" ? "focus_reveal" : purpose === "comparison" ? "comparison" : "chapter_progress", focus: "instruction" },
  { id: "spatial_relationship", name: "從關係到焦點", approach: "先看素材之間的關係，依旁白選主角，回到單份證據後再總覽收束。", grammar: (purpose: string): Grammar => purpose === "recap" || purpose === "cta" ? "focus_wall" : purpose === "chapter" ? "chapter_progress" : "depth_gallery", focus: "relationship" },
] as const;

/** Read-only design packet: complete reference learning → original brand redesign → distinct storyboards. */
export function prepareMotionReferenceDesign(project: EditProject, raw: MotionReferenceDesignInput) {
  const input = motionReferenceDesignInputSchema.parse(raw);
  if ((input.format === "shorts") !== (project.height > project.width)) throw new Error("片型與畫布方向不同，請先選定短片或長片的原生畫布");
  const gaps: { code: string; subject: string; detail: string }[] = [];
  for (const [role, family] of Object.entries(input.brand.typography)) {
    if (!resolveBundledFontFace(family, role === "headingFamily" ? 700 : 400)) gaps.push({ code: "FONT_REQUIRED", subject: role, detail: `字型 ${family} 沒有核對的實體字型；禁止靜默換字體` });
  }
  const referenceAssets = new Set(input.references.flatMap(ref => ref.referenceOnlyAssetIds));
  if (input.brand.logo.mode === "asset") {
    const logoId = input.brand.logo.assetId;
    const asset = project.assets.find(asset => asset.id === logoId);
    if (asset?.kind !== "image" || referenceAssets.has(asset.id)) gaps.push({ code: "LOGO_REQUIRED", subject: "brand.logo", detail: "品牌 Logo 需要自己可用的圖片，不能拿參考作者的識別" });
  }
  const facts = new Map(input.brand.serviceFacts.map(fact => [fact.id, fact]));
  if (facts.size !== input.brand.serviceFacts.length) throw new Error("服務內容需要唯一且可引用的 ID");
  if (new Set(input.references.map(ref => ref.id)).size !== input.references.length) throw new Error("每支參考需要唯一 ID");
  const totalFrames = Math.round(projectDuration(project) * project.fps);
  let cursor = 0;
  const beatIds = new Set<string>();
  for (const beat of input.beats) {
    if (beatIds.has(beat.id) || beat.startFrame < cursor || beat.endFrame <= beat.startFrame || beat.endFrame > totalFrames) throw new Error("敘事段落需要唯一 ID、已核對且不重疊的影格範圍");
    beatIds.add(beat.id); cursor = beat.endFrame;
    if (beat.factIds.some(id => !facts.has(id))) throw new Error(`段落 ${beat.id} 引用了未核對的服務宣稱`);
    const clip = project.tracks.filter(track => track.kind === "video" && !track.muted).flatMap(track => track.clips).find(clip => clip.id === beat.clipId);
    if (!clip || referenceAssets.has(clip.assetId)) throw new Error(`段落 ${beat.id} 缺少自己的真素材；參考影片不會導入產品`);
    if (Math.round(clip.timelineStart * project.fps) > beat.startFrame || Math.round((clip.timelineStart + clip.duration) * project.fps) < beat.endFrame) throw new Error(`段落 ${beat.id} 超出指定來源片段，不能猜測證據`);
  }
  const capabilities: Partial<Record<Grammar, string>> = input.format === "longform" ? longformCapabilities : nativeCapabilities;
  const referenceCoverage = input.references.map(ref => ({ id: ref.id, url: ref.url, sourceSha256: ref.sourceSha256, totalFrames: ref.totalFrames,
    observedFrames: ref.sections.reduce((sum, section) => sum + section.endFrame - section.startFrame, 0), boundaryPolicy: ref.boundaryPolicy,
    lessons: ref.sections.map(section => ({ ...section, grammarCapabilities: section.grammars.map(g => ({ grammar: g, compiler: capabilities[g] ?? null, state: g in capabilities ? "source_candidate_requires_installed_capability_check" : "IMPLEMENTATION_REQUIRED", adaptation: input.format === "longform" && g in capabilities ? "extract_brief_emphasis_only_not_whole_reference_scene" : "original_format_design_required" })) })),
  }));
  const storyboards = optionModes.map(option => ({ id: option.id, name: option.name, approach: option.approach,
    scenes: input.beats.map(beat => {
      const selectedGrammar: Grammar = input.format === "longform"
        ? option.id === "spatial_relationship" || option.id === "evidence_first" && beat.purpose === "proof" ? "focus_reveal" : "chapter_progress"
        : option.grammar(beat.purpose);
      const refs = input.references.flatMap(ref => ref.sections.filter(section => section.grammars.includes(selectedGrammar)).map(section => `${ref.id}:${section.id}`));
      const compiler = capabilities[selectedGrammar] ?? null;
      return { ...beat, primaryFocus: option.focus, grammar: selectedGrammar, compiler,
        state: compiler ? "DESIGN_REQUIRED_BEFORE_COMPILATION" : "IMPLEMENTATION_REQUIRED",
        referenceSectionIds: refs, selectionReason: refs.length ? "依語意用途選擇参考動作，再以自有品牌與來源重新設計" : "依內容重新設計；參考中沒有這種動作的直接證據",
        canvasPlan: input.format === "shorts" ? "垂直閱讀順序；主要證據居中，字幕與品牌留在獨立安全區" : "完整操作證據優先；保留全尺寸連續素材，只在已觀察留白放短文字或焦點線條，隨後回到乾淨觀看；不套章節底板、分欄或浮窗",
        brand: { name: input.brand.name, logo: input.brand.logo, palette: input.brand.palette, typography: input.brand.typography },
        verifiedFacts: beat.factIds.map(id => facts.get(id)!),
        motionTask: { reveal: "由旁白語句開始，先建立一個主要焦點", hold: "文字讀完及證據看清前不加入第二個主動作", resolve: "帶著來源身分與連續旁白回到下一段" },
      };
    }),
  }));
  const designSha256 = createHash("sha256").update(JSON.stringify({ projectId: project.id, projectRevision: project.revision, input })).digest("hex");
  return { schema: "editkin.reference-motion-design/v1", status: gaps.length ? "MATERIAL_REQUIRED" : "STORYBOARD_REVIEW_REQUIRED", readOnly: true,
    projectId: project.id, projectRevision: project.revision, designSha256, brand: input.brand, referenceCoverage, storyboards, gaps,
    evidenceState: "observations_and_rights_are_caller_declared_require_material_audit",
    directionPolicy: "Learn the complete reference's movement, camera and rhythm; redesign original composition with creator logo, palette, typography and verified service content. Reference footage and third-party UI are never template assets.",
    next: "Agent compares the three narrative approaches, chooses and refines one, compiles supported scenes into the same editable project, inspects every still and continuous section, revises locally, then v4 audit/apply/render and artifact-bound art/performance review. Publish as reusable template/Skill only after product validation.",
  };
}
