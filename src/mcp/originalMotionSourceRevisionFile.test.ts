import { afterAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createEmptyProject } from "../domain/editGraph";
import { applyCommand } from "../domain/commands";
import type { EditorCommand } from "../domain/commandTypes";
import { canonicalJson } from "../shared/canonicalJson";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { prepareOriginalMotionSourceFile, originalMotionAuthoringFileSchema, type OriginalMotionAuthoringFile } from "./originalMotionSourceFile";
import { prepareOriginalMotionSourceRevisionFile } from "./originalMotionSourceRevisionFile";
import { verifyCurrentOriginalMotionEvidence, verifyOriginalMotionFiles } from "./originalMotionWorkflow";
import { createAutopilotV4Fixture } from "../application/autopilotPlanFixture";
import { parseAutopilotPlan, getPlanOriginalMotionSources, assertAutopilotProjectTimelineBinding, compactAutopilotContract } from "../application/autopilotPlan";
import { canonicalOriginalVisibleProjection } from "../application/originalMotionSourceSets";
import { originalMotionSourceSetSchema, originalMotionCueEvidenceReference } from "../application/originalMotionSourceEvidence";
import { encodeProjectBytes, decodeProjectBytes } from "../application/projectCodec";
import { applyProjectCommands } from "./storage";
import { sha256Canonical } from "../application/autopilotInvocationIdentity";
import { MOTION_TREATMENT_FAMILIES, motionCommandFamilies, assertMotionTreatmentBinding } from "../application/motionTreatment";

const fontRoot = resolve("public/fonts");
const beforePath = ".editkin/original-sources/before.json", afterPath = ".editkin/original-sources/after.json";
const evidenceRoot = resolve(".rd/benchmarks/original-source-owner-revision-20261005");
const originalWorkspace = process.env.EDITKIN_WORKSPACE;
afterAll(() => { if (originalWorkspace === undefined) delete process.env.EDITKIN_WORKSPACE; else process.env.EDITKIN_WORKSPACE = originalWorkspace; });
function payload(): OriginalMotionAuthoringFile {
  const face = bundledFontFaceSpec("EditkinFace-noto-sans-tc-700");
  return originalMotionAuthoringFileSchema.parse({ schema: "editkin.original-motion-authoring/v1", usage: "standalone", audio: "silent", fps: 30,
    rights: { origin: "self_authored", medium: "native_vector_and_glyph", contentKind: "authored_illustration", realityProof: false, importedReferenceMedia: false, declaration: "Original controlled Chinese typography, not third-party UI or outside reality proof" },
    authoring: { sceneId: "source-owner", expectedRevision: 0, intent: "standalone_showcase", reason: "原創場景的字型與長標題修改",
      startFrame: 0, durationFrames: 150, safeArea: { left: 20, right: 20, top: 20, bottom: 20 },
      style: { palette: { surface: "#FFFFFF", text: "#172033", accent: "#175CD3", muted: "#5B6678", separator: "#D8DEE8" }, typography: { headingFamily: "Noto Sans TC", bodyFamily: "Noto Sans TC" }, animationSpeed: 1 },
      camera: { initial: { centerX: 320, centerY: 180, zoom: 1 }, dynamics: { stiffness: 120, damping: 24, mass: 1 } },
      elements: [{ id: "source-title", kind: "text", text: "我的作品", typographyRole: "heading", fontWeight: 700, range: { startFrame: 0, endFrame: 150 },
        xPixels: 60, yPixels: 100, widthPixels: 500, fontSize: 64, minFontSize: 32, maxLines: 1, lineGapPixels: 8, letterSpacingPixels: 0, colorRole: "text" }],
      semanticCues: [0, 50, 100].map((frame, index) => ({ id: `owner-phase-${index}`, frame, purpose: "依語意讀完原創標題", graphicIds: ["source-title"], evidenceRefs: [`brief:owner-${index}`] })) },
    fontBindings: [{ graphicId: "source-title", faceId: face.faceId, fontSha256: face.sha256, manifestSha256: face.manifestSha256, parserVersion: "opentype.js@1.3.4" }] });
}
async function fixture() {
  // Owned generated source controls retained for failure diagnosis; no user media.
  const root = await mkdtemp(join(tmpdir(), "editkin-owner-revision-control-"));
  await mkdir(join(root, ".editkin", "original-sources"), { recursive: true });
  const before = payload(), after = structuredClone(before);
  after.authoring.expectedRevision = 7;
  const face = bundledFontFaceSpec("EditkinFace-noto-sans-tc-500"), element = after.authoring.elements[0];
  if (element.kind !== "text") throw new Error("control title missing");
  element.text = "我的作品可以換成更長的標題"; element.fontWeight = 500; element.fontSize = 48; element.maxLines = 2;
  const phase = { durationFrames: 8, offsetXPixels: 0, offsetYPixels: 0, scale: 1, opacity: 1, easing: { type: "linear" as const } };
  element.motionV2 = { sequence: { unit: "character", order: "forward", exitOrder: "forward", staggerFrames: 2 }, entrance: phase, exit: { ...phase, durationFrames: 5 } };
  after.authoring.style.palette.text = "#4C256E";
  after.fontBindings[0] = { graphicId: "source-title", faceId: face.faceId, fontSha256: face.sha256, manifestSha256: face.manifestSha256, parserVersion: "opentype.js@1.3.4" };
  await writeFile(join(root, beforePath), canonicalJson(before) + "\n");
  await writeFile(join(root, afterPath), canonicalJson(after) + "\n");
  const empty = createEmptyProject("Current saved owner control", { width: 640, height: 360, fps: 30 });
  const creation = await prepareOriginalMotionSourceFile(empty, beforePath, 0, { workspace: root, fontRoot });
  const project = applyCommand(empty, { type: "batch", commands: creation.prepared.preparation.commands });
  project.revision = 7; // Historical raw before revision 0; saved owner is currently 7.
  process.env.EDITKIN_WORKSPACE = root;
  const revision = await prepareOriginalMotionSourceRevisionFile(project, beforePath, afterPath, 1, { workspace: root, fontRoot });
  const base = createAutopilotV4Fixture();
  const plan = parseAutopilotPlan({ ...base, materialEvidence: { ...revision.sourceSet, receipts: [] }, commands: [base.commands[0], ...revision.preparation.commands], editorial: {
    ...base.editorial, graphics: revision.preparation.editorialGraphics, transitions: [],
    narrative: { ...base.editorial.narrative, beats: base.editorial.narrative.beats.map((beat, index) => ({ ...beat, range: { startFrame: index * 50, endFrame: (index + 1) * 50 }, evidenceRefs: [originalMotionCueEvidenceReference(revision.evidence.sourceSha256, `owner-phase-${index}`)] })) },
    audio: { ...base.editorial.audio, mode: "silent_original", layers: [], impactFrames: [], breathFrames: [] },
    color: { ...base.editorial.color, sourceMode: "authored_palette", shotMatchRequired: false },
  } });
  if (plan.schema !== "hao.video-autopilot.edit-plan/v4") throw new Error("current control plan missing");
  return { root, before, after, project, revision, plan };
}
async function actualAuthority(f: Awaited<ReturnType<typeof fixture>>) {
  const batch: EditorCommand = { type: "batch", commands: structuredClone(f.plan.commands as EditorCommand[]) };
  let proof: object | undefined;
  await verifyCurrentOriginalMotionEvidence(f.plan, f.project, undefined, { batch, capture: value => { proof = value; } });
  return { batch, context: { originalSourceOwnerRevisionProof: proof } };
}
describe("canonical file-bound saved owner revision", () => {
  it("recompiles actual immutable historical before and new after with physical Chinese weights and all scene frames", async () => {
    const f = await fixture();
    expect(f.project.revision).toBe(7); expect(f.revision.evidence.before.authoring.expectedRevision).toBe(0);
    expect(f.revision.evidence.after.graphicBindings[0].physicalFont?.faceId).toBe("EditkinFace-noto-sans-tc-500");
    expect(f.revision.preparation.commands[0]).toMatchObject({ type: "revise_original_motion_scene_graphic", sceneId: "source-owner", graphic: { text: "我的作品可以換成更長的標題", fontWeight: 500, layoutV2: { maxLines: 2 } } });
    expect(f.revision.evidence.scene).toEqual(f.project.motionScenes![0]);
    expect(f.revision.preparation.preparedSafety).toMatchObject({ before: { framesChecked: 150, graphicFramesChecked: 150 }, after: { framesChecked: 150, graphicFramesChecked: 150 } });
    expect(await readFile(join(f.root, beforePath), "utf8")).toBe(canonicalJson(f.before) + "\n");
    const descriptorPath = ".editkin/original-sources/revision.json";
    const descriptor = { schema: "editkin.original-motion-revision-source/v1", usage: "standalone", audio: "silent", fps: f.project.fps, expectedRevision: f.project.revision,
      owner: { sceneId: f.revision.evidence.scene.id, sceneSha256: sha256Canonical(f.revision.evidence.scene), orderedGraphicsSha256: sha256Canonical(f.revision.evidence.expectedGraphics) },
      before: f.revision.evidence.before.authoringSource, after: f.revision.evidence.after.authoringSource };
    await writeFile(join(f.root, descriptorPath), canonicalJson(descriptor) + "\n");
    await writeFile(join(evidenceRoot, "ACTUAL_SOURCE_PACKET.json"), canonicalJson({ workspace: f.root, descriptor: "1=" + descriptorPath,
      project: f.project, before: f.before, after: f.after, packet: f.revision, plan: f.plan, boundary: "Actual component source compiler output, not fresh MCP transport or authenticated audit/apply/render" }) + "\n");
  });
  it("independently verifies for audit and again for apply, binds exact full batch and saves/reopens the same owner", async () => {
    const f = await fixture(), snapshot = structuredClone(f.project);
    const audit = await actualAuthority(f); const auditCandidate = applyCommand(f.project, audit.batch, audit.context);
    const apply = await actualAuthority(f); const candidate = applyCommand(f.project, apply.batch, apply.context);
    expect(f.project).toEqual(snapshot); expect(candidate.motionScenes).toEqual(snapshot.motionScenes);
    expect(candidate.motionGraphics).toEqual(auditCandidate.motionGraphics); expect(candidate.assets).toEqual(snapshot.assets); expect(candidate.tracks).toEqual(snapshot.tracks);
    const reopened = decodeProjectBytes(encodeProjectBytes(candidate));
    expect(reopened.motionGraphics).toEqual(candidate.motionGraphics); expect(reopened.motionScenes).toEqual(candidate.motionScenes);
    await verifyOriginalMotionFiles(f.revision.sourceSet, candidate); // Committed render reads both pins against unchanged source clock.
  });
  it("keeps physical command indexes for editorial and design families without crediting an unchanged camera", async () => {
    const f = await fixture(), visible = canonicalOriginalVisibleProjection(getPlanOriginalMotionSources(f.plan), f.plan.commands as EditorCommand[]);
    expect(visible).toHaveLength(f.plan.commands.length); expect(visible[1].type).toBe("add_motion_graphic");
    expect(visible.some(command => command.type === "add_motion_scene")).toBe(false);
    const treatment = { schema: "editkin.motion-treatment/v1" as const, decisions: MOTION_TREATMENT_FAMILIES.map(family => {
      const indexes = visible.flatMap((command, index) => motionCommandFamilies(command).includes(family) ? [index] : []);
      return { family, action: indexes.length ? "use" as const : "omit" as const, reason: "Only real changed graphics count; preserved camera is not a new treatment", beatIds: f.plan.editorial.narrative.beats.map(beat => beat.id), commandIndexes: indexes };
    }) };
    expect(() => assertMotionTreatmentBinding(treatment, visible, f.plan.editorial.narrative.beats.map(beat => beat.id))).not.toThrow();
    expect(() => assertAutopilotProjectTimelineBinding(f.plan, 30)).not.toThrow();
    expect(compactAutopilotContract().originalSourceExecution.sourceRevisionV1.sourceAdmissionOnly).toBe(true);
    expect(() => originalMotionSourceSetSchema.parse(f.revision.sourceSet)).toThrow();
  });
  it("rejects raw automation and forged or missing owner authority before mutation", async () => {
    const f = await fixture(), batch: EditorCommand = { type: "batch", commands: f.plan.commands as EditorCommand[] }, snapshot = structuredClone(f.project);
    expect(() => applyCommand(f.project, batch)).toThrow(/ORIGINAL_SOURCE_OWNER_RECOMPILE_REQUIRED/);
    expect(() => applyCommand(f.project, batch, { originalSourceOwnerRevisionProof: {} })).toThrow(/ORIGINAL_SOURCE_OWNER_RECOMPILE_REQUIRED/);
    await expect(applyProjectCommands("missing-project.edk", batch.commands)).rejects.toThrow(/ORIGINAL_SOURCE_OWNER_AUTHORITY_REQUIRED/);
    expect(f.project).toEqual(snapshot);
  });
  it("rejects drifted current project and changed sealed revision commands with the exact proof", async () => {
    const f = await fixture(), issued = await actualAuthority(f), drift = structuredClone(f.project);
    drift.name = "same revision, other live project";
    expect(() => applyCommand(drift, issued.batch, issued.context)).toThrow(/ORIGINAL_SOURCE_OWNER_RECOMPILE_REQUIRED/);
    const changed = structuredClone(issued.batch);
    if (changed.type !== "batch" || changed.commands[1].type !== "revise_original_motion_scene_graphic") throw new Error("control owner command missing");
    changed.commands[1].graphic.text = "變造字";
    expect(() => applyCommand(f.project, changed, issued.context)).toThrow(/ORIGINAL_SOURCE_OWNER_RECOMPILE_REQUIRED/);
  });
  it("rejects literal before-owner mismatch and scene geometry changes during preparation", async () => {
    const f = await fixture(), drift = structuredClone(f.project); drift.motionGraphics[0].text = "手動改掉原稿";
    await expect(prepareOriginalMotionSourceRevisionFile(drift, beforePath, afterPath, 1, { workspace: f.root, fontRoot })).rejects.toThrow(/before.*owner|owner.*before|live.*owner/i);
    const moved = structuredClone(f.after); moved.authoring.elements[0].xPixels++;
    await writeFile(join(f.root, afterPath), canonicalJson(moved) + "\n");
    await expect(prepareOriginalMotionSourceRevisionFile(f.project, beforePath, afterPath, 1, { workspace: f.root, fontRoot })).rejects.toThrow(/geometry|immutable|scope/i);
  });
  it("rejects changed actual after raw bytes independently rather than trusting the prepared manifest", async () => {
    const f = await fixture(), altered = structuredClone(f.after); altered.rights.declaration += " altered";
    await writeFile(join(f.root, afterPath), canonicalJson(altered) + "\n");
    await expect(verifyCurrentOriginalMotionEvidence(f.plan, f.project)).rejects.toThrow(/authored file and manifest differ/);
  });
  it("rejects wrong physical font pins and insufficient long-title reading hold at their own stages", async () => {
    const f = await fixture(), pin = structuredClone(f.after); pin.fontBindings[0].fontSha256 = "0".repeat(64);
    await writeFile(join(f.root, afterPath), canonicalJson(pin) + "\n");
    await expect(prepareOriginalMotionSourceRevisionFile(f.project, beforePath, afterPath, 1, { workspace: f.root, fontRoot })).rejects.toThrow(/font pins/);
    const unreadable = structuredClone(f.after), element = unreadable.authoring.elements[0];
    if (element.kind !== "text" || !element.motionV2) throw new Error("control motion missing");
    element.motionV2.sequence.staggerFrames = 4; // 8+5+2*12*4+24=133; valid sequence, then 170f failure below.
    element.motionV2.entrance.durationFrames = 45; // 45+5+96=146 <=150; reading hold must refuse 170.
    await writeFile(join(f.root, afterPath), canonicalJson(unreadable) + "\n");
    await expect(prepareOriginalMotionSourceRevisionFile(f.project, beforePath, afterPath, 1, { workspace: f.root, fontRoot })).rejects.toThrow(/reading hold|閱讀/);
  });
  it("rejects extra mutation and plan command drift under the same source manifests", async () => {
    const f = await fixture(), mixed = structuredClone(f.plan);
    mixed.commands.push({ type: "rename_project", name: "unbound" });
    expect(() => parseAutopilotPlan(mixed)).toThrow(/revision.*batch|flat|authored sources|fabricate|unsupported/i);
    const changed = structuredClone(f.plan);
    if (changed.commands[1].type !== "revise_original_motion_scene_graphic") throw new Error("control missing");
    changed.commands[1].graphic.text = "變造";
    expect(() => parseAutopilotPlan(changed)).toThrow(/hash|binding|differs/i);
    expect(f.project.revision).toBe(7);
  });
  it("honors cancellation before reading and refuses a single mutable file used as both versions", async () => {
    const f = await fixture(), abort = new AbortController(); abort.abort(new Error("control explicit cancellation"));
    await expect(prepareOriginalMotionSourceRevisionFile(f.project, beforePath, afterPath, 1, { workspace: f.root, fontRoot, signal: abort.signal })).rejects.toThrow("control explicit cancellation");
    await expect(prepareOriginalMotionSourceRevisionFile(f.project, beforePath, beforePath, 1, { workspace: f.root, fontRoot })).rejects.toThrow(/distinct immutable/);
    expect(sha256Canonical(f.project)).toBe(f.revision.evidence.project.sha256);
  });
});
