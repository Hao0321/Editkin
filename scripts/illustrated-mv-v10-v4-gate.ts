import assert from "node:assert/strict";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { createAutopilotV4Fixture } from "../src/application/autopilotPlanFixture";
import { parseAutopilotPlan, assertAutopilotProjectTimelineBinding, autopilotPlanSha256 } from "../src/application/autopilotPlan";
import { autopilotPlanSourceFromIdentity, readLiveAutopilotIdentity, sha256Canonical } from "../src/application/autopilotInvocationIdentity";
import { compileCurrentDesign, designIdentity } from "../src/mcp/autopilotDesignTools";
import { createEmptyEditkinSkillSelectionReceipt } from "../src/plugins/skillPack";
import { resolveAestheticSystemForDomain } from "../src/application/editkinAesthetic";
import { MOTION_TREATMENT_FAMILIES, motionCommandFamilies } from "../src/application/motionTreatment";
import { prepareMaterialIntelligence, recordMaterialSemantics } from "../src/application/materialIntelligence";
import { auditAutopilotPlan, applyAutopilotPlan } from "../src/mcp/autopilotTools";
import { readProject } from "../src/mcp/storage";
import { probeMedia, renderProject } from "../src/render/ffmpeg";
import type { EditorCommand } from "../src/domain/commandTypes";

const root = resolve(import.meta.dirname, "..");
const out = join(root, ".rd/benchmarks/jpop-mv-motion-20260928/illustrated-mv");
const sourcePath = join(out, "source.editkin.json");
const workflowSourcePath = join(out, "v10-source.editkin.json");
const workflowPath = join(out, "v10-v4-workflow.editkin.json");
const artPath = join(out, "assets/rooftop-evidence-bt709.mp4");
const ffmpegPath = join(root, "vendor/ffmpeg/win32-x64/ffmpeg.exe");
const ffprobePath = join(root, "vendor/ffmpeg/win32-x64/ffprobe.exe");
const cacheRoot = join(out, "material-cache");
process.env.EDITKIN_WORKSPACE = root;
process.env.EDITKIN_CACHE_ROOT = cacheRoot;
const sourceProject = JSON.parse(await readFile(sourcePath, "utf8"));
const v8Project = JSON.parse(await readFile(join(out, "v8-impact-wide-soft-edge-crop.editkin.json"), "utf8"));
const impactArt = v8Project.assets.find((asset: { id: string }) => asset.id === "pose-impact-wide");
assert.ok(impactArt, "Wide impact art missing");
sourceProject.assets.push(impactArt);
await writeFile(workflowSourcePath, JSON.stringify(sourceProject, null, 2));
await copyFile(workflowSourcePath, workflowPath);
const project = await readProject(workflowPath);
const draft = JSON.parse(await readFile(join(out, "v10-motion-grammar-draft.json"), "utf8")) as { commands: EditorCommand[]; editorialGraphics: unknown[] };
const sourceSha256 = createHash("sha256").update(await readFile(artPath)).digest("hex");
const prepared = await prepareMaterialIntelligence({ assetId: "night-evidence-video", clipId: "night-evidence", sourcePath: artPath,
  sourceSha256, sourceStart: 0, duration: 8, fps: 30, kind: "video", includeTranscript: false, maxKeyframes: 1,
  color: project.assets.find(asset => asset.id === "night-evidence-video")?.color, colorManagement: project.colorManagement,
}, { ffmpegPath, ffprobePath, cacheRoot, modelRoot: join(root, ".editkin-models") });
assert.ok(prepared.packet.keyframes.length > 0, JSON.stringify(prepared.packet.analysis));
const semantic = await recordMaterialSemantics(cacheRoot, { materialId: prepared.packet.materialId, sourceSha256,
  overallTopic: "Original illustrated indigo night rooftop background",
  contentType: "original-illustration", language: "none", people: [], locations: ["imagined night rooftop"],
  segments: [{ start: 0, end: 8, summary: "Original indigo rooftop illustration with turquoise city lights and star motifs",
    subjects: ["night skyline"], actions: ["static background"], objects: ["rooftop", "stars"], importance: 1,
    evidenceFrameIds: [prepared.packet.keyframes[0].id], transcriptCueIndexes: [] }],
});
const identity = await readLiveAutopilotIdentity();
const source = autopilotPlanSourceFromIdentity(identity);
const fixture = createAutopilotV4Fixture(source);
const route = { mode: "build" as const, format: "longform" as const, domain: "illustrated_music_mv" };
const aesthetic = resolveAestheticSystemForDomain(route.domain, route.format);
const commands: EditorCommand[] = [{ type: "set_aesthetic_system", aestheticSystem: aesthetic }, ...draft.commands];
const beats = [
  { id: "intro", range: { startFrame: 0, endFrame: 60 }, role: "promise" as const,
    summary: "夜景與角色剪影亮相", energy: .52, primaryFocus: "夜景角色與星屑意象", evidenceRefs: ["demo:bar-1"] },
  { id: "verse", range: { startFrame: 60, endFrame: 120 }, role: "setup" as const,
    summary: "拉近表情並引入快速文字", energy: .68, primaryFocus: "角色近景與瞬間字", evidenceRefs: ["demo:bar-2"] },
  { id: "chorus", range: { startFrame: 120, endFrame: 240 }, role: "payoff" as const,
    summary: "黎明色彩、剪影揭露與角色重音", energy: .9, primaryFocus: "黎明副歌的角色與節拍", evidenceRefs: ["demo:bar-3-4"] },
];
const designRequest = { format: route.format, domain: route.domain, topic: "原創插畫動畫音樂 MV 技術小樣", duration: 8,
  beats: beats.map((beat, index) => ({ id: beat.id, role: index === 0 ? "first_frame" as const : index === 2 ? "payoff" as const : "chapter" as const,
    energy: beat.energy, subject: beat.primaryFocus })) };
const brief = await compileCurrentDesign(designRequest);
const design = designIdentity(brief, project);
const beatCommandIndexes = beats.map(beat => commands.findIndex(command => command.type === "add_clip" && command.clip.id === `mv-bg-${beat.id === "chorus" ? "chorus-a" : beat.id}`));
assert.ok(beatCommandIndexes.every(index => index >= 0));
const motionTreatment = { schema: "editkin.motion-treatment/v1" as const,
  decisions: MOTION_TREATMENT_FAMILIES.map(family => {
    const commandIndexes = commands.flatMap((command, index) => motionCommandFamilies(command).includes(family) ? [index] : []);
    return { family, action: commandIndexes.length ? "use" as const : "omit" as const,
      reason: commandIndexes.length ? `原創插畫 MV 的 ${family} 命令服務角色、場景或節奏` : `此短樣片沒有 ${family} 的實際需求`,
      beatIds: commandIndexes.length ? beats.map(beat => beat.id) : [], commandIndexes };
  }) };
const planInput = {
  ...fixture, source, route, aesthetic, commands,
  extensions: { ...fixture.extensions, skillSelection: createEmptyEditkinSkillSelectionReceipt(source.pluginRegistrySha256,
    { format: route.format, domain: route.domain, semanticRoles: [] }) },
  materialEvidence: { schema: "hao.editkin.material-intelligence/v1", receipts: [{ materialId: prepared.packet.materialId,
    sourceSha256, assetId: "night-evidence-video", clipId: "night-evidence", semanticReceiptSha256: semantic.semanticReceiptSha256 }] },
  designEvidence: { schema: "editkin.autopilot-design-evidence/v1", request: designRequest,
    ...design, decisions: beats.map((beat, index) => ({ beatId: beat.id,
      recipeSha256: sha256Canonical(brief.recipes.find(item => item.beatId === beat.id)!.recipe),
      application: `以原創插畫、角色分層及核對過的音樂節點表現 ${beat.primaryFocus}`,
      commandIndexes: [beatCommandIndexes[index]] })) },
  editorial: { ...fixture.editorial,
    brief: { audience: "日系動畫音樂 MV 觀眾", premise: "夜景中的角色追向黎明",
      promise: "用原創插畫與音樂同步的鏡頭呈現轉折", stakes: "缺少角色與場景變化會失去歌曲能量",
      payoff: "副歌以亮色場景、剪影和節拍重音回報", firstFramePromise: "夜景原創角色剪影立即入鏡" },
    narrative: { backbone: "夜景亮相，近景蓄勢，黎明副歌釋放", beats,
      setupPayoffs: [{ setupBeatId: "verse", payoffBeatId: "chorus" }] },
    graphics: draft.editorialGraphics,
    transitions: [60, 120, 180].map((atFrame, index) => ({ id: `scene-cut-${index}`, atFrame,
      kind: "clean_cut" as const, motivation: "audio" as const, evidenceRefs: [`demo:bar-${index + 2}`] })),
    audio: { dialoguePriority: true, blanketWhooshEveryCut: false,
      layers: [{ id: "music", role: "music", purpose: "完整原創測試配樂與節拍對齊", evidenceRefs: ["asset:song"] }],
      impactFrames: [120, 135, 150, 165, 180, 195, 210, 225], breathFrames: [60] },
    color: { ...fixture.editorial.color, primaryLookId: "cine_neutral_balance" },
    motionTreatment,
  },
};
const plan = parseAutopilotPlan(planInput);
assert.equal(plan.schema, "hao.video-autopilot.edit-plan/v4");
assertAutopilotProjectTimelineBinding(plan, project.fps);
const reparsed = parseAutopilotPlan(plan);
if (autopilotPlanSha256(plan) !== autopilotPlanSha256(reparsed)) {
  const first = JSON.stringify(plan), second = JSON.stringify(reparsed);
  let at = 0; while (at < first.length && first[at] === second[at]) at++;
  throw Error(`v4 parse non-idempotent at ${at}: first=${first.slice(at, at + 130)} second=${second.slice(at, at + 130)}`);
}
await writeFile(join(out, "v10-v4-plan.json"), JSON.stringify(plan, null, 2));
const planSnapshot = JSON.stringify(plan);
const audit = JSON.parse(String((await auditAutopilotPlan(workflowPath, plan)).content[0]?.text ?? "{}"));
assert.equal(audit.status, "ACCEPTED");
if (JSON.stringify(plan) !== planSnapshot) {
  const after = JSON.stringify(plan);
  let first = 0; while (first < planSnapshot.length && planSnapshot[first] === after[first]) first++;
  throw Error(`audit mutated plan at byte ${first}: before=${planSnapshot.slice(first, first + 100)} after=${after.slice(first, first + 100)}`);
}
assert.equal(audit.auditReceipt.planSha256, audit.planSha256);
assert.equal(autopilotPlanSha256(parseAutopilotPlan(plan)), audit.planSha256);
const apply = JSON.parse(String((await applyAutopilotPlan(workflowPath, plan, audit.auditReceipt)).content[0]?.text ?? "{}"));
assert.equal(apply.status, "REVIEW_REQUIRED");
const applied = await readProject(workflowPath);
assert.equal(applied.motionGraphics.length, 5);
const outputPath = join(out, "v10-v4-workflow.mp4");
await renderProject(applied, outputPath, { ffmpegPath, ffprobePath, fontRoot: join(root, "public/fonts"), preferGpu: false, timeoutMs: 240_000 });
const probe = await probeMedia(outputPath, ffprobePath);
assert.ok(probe.hasAudio && probe.hasVideo);
const directHash = createHash("sha256").update(await readFile(join(out, "v10-motion-grammar.mp4"))).digest("hex");
const v4OutputHash = createHash("sha256").update(await readFile(outputPath)).digest("hex");
assert.equal(v4OutputHash, directHash);
const result = { schema: "editkin.illustrated-mv-live-v4-gate/v1", status: "TECHNICAL_V4_AUDIT_APPLY_RENDER_GREEN_ART_REVIEW_REQUIRED",
  materialId: prepared.packet.materialId, semanticReceiptSha256: semantic.semanticReceiptSha256,
  planSha256: audit.planSha256, auditStatus: audit.status, applyStatus: apply.status,
  appliedCommandCount: apply.appliedCommandCount, projectRevision: applied.revision, projectReopened: true,
  hasVideo: probe.hasVideo, hasAudio: probe.hasAudio, outputSha256: v4OutputHash, matchesDirectRenderByteForByte: true,
  humanArtReview: "REVIEW_REQUIRED", installedDesktopTested: false };
await writeFile(join(out, "v10-v4-result.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
