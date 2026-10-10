import { beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createEmptyProject, validateProject } from "../domain/editGraph";
import { applyCommand } from "../domain/commands";
import type { EditorCommand } from "../domain/commandTypes";
import { DEFAULT_COLOR, DEFAULT_COLOR_MANAGEMENT, DEFAULT_SCENE_25D, DEFAULT_TRANSFORM, type EditProject } from "../domain/types";
import { issueOriginalSourceOwnerRevisionProof } from "../domain/originalSourceOwnerRevision";
import { canonicalJson } from "../shared/canonicalJson";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { originalMotionAuthoringFileSchema, originalMotionTextProvider, prepareOriginalMotionSourceFile,
  readOriginalMotionAuthoringSource, type OriginalMotionAuthoringFile } from "../mcp/originalMotionSourceFile";
import { assertOriginalRevisionFile, prepareOriginalMotionSourceRevisionFile } from "../mcp/originalMotionSourceRevisionFile";
import { originalMotionSourceRevisionSetSchema, originalPaintedMediaSourceRevisionSetSchema,
  prepareOriginalPaintedMediaSourceRevisionEvidence, verifyOriginalPaintedMediaSourceRevisionEvidence,
  assertOriginalPaintedMediaSourceRevisionPlanBinding, originalPaintedMediaSourceRevisionVisibleProjection,
  originalPaintedMediaRevisionPreservedContext, assertOriginalPaintedMediaRevisionPreservedContext } from "./originalMotionSourceRevision";
import { originalMotionCueEvidenceReference } from "./originalMotionSourceEvidence";
import { createAutopilotV4Fixture } from "./autopilotPlanFixture";
import { sha256Canonical } from "./autopilotInvocationIdentity";
import { decodeProjectBytes, encodeProjectBytes } from "./projectCodec";

const fontRoot = resolve("public/fonts");
const beforePath = ".editkin/original-sources/paint-before.json", afterPath = ".editkin/original-sources/paint-after.json";
const revisionScope = "painted_authored_overlay_preserve_media" as const;
function payload(): OriginalMotionAuthoringFile {
  const face = bundledFontFaceSpec("EditkinFace-noto-sans-tc-700");
  return originalMotionAuthoringFileSchema.parse({ schema: "editkin.original-motion-authoring/v1", usage: "authored_overlay", audio: "preserve_source_audio", fps: 30,
    rights: { origin: "self_authored", medium: "native_vector_and_glyph", contentKind: "authored_illustration", realityProof: false,
      importedReferenceMedia: false, declaration: "Original source-control typography only; no assertion of synthetic media rights or reality proof" },
    authoring: { sceneId: "paint-owner", expectedRevision: 0, intent: "authored_overlay", reason: "原創影片標題的字型、配色與逐字節奏修改",
      startFrame: 0, durationFrames: 150, safeArea: { left: 20, right: 20, top: 20, bottom: 20 },
      style: { palette: { surface: "#FFFFFF", text: "#172033", accent: "#175CD3", muted: "#5B6678", separator: "#D8DEE8" },
        typography: { headingFamily: "Noto Sans TC", bodyFamily: "Noto Sans TC" }, animationSpeed: 1 },
      camera: { initial: { centerX: 320, centerY: 180, zoom: 1 }, dynamics: { stiffness: 120, damping: 24, mass: 1 } },
      elements: [{ id: "paint-title", kind: "text", text: "我的作品", typographyRole: "heading", fontWeight: 700,
        range: { startFrame: 0, endFrame: 150 }, xPixels: 60, yPixels: 100, widthPixels: 500, fontSize: 64, minFontSize: 32,
        maxLines: 1, lineGapPixels: 8, letterSpacingPixels: 0, colorRole: "text",
        paintV1: { schema: "editkin.motion-paint/v2", colorIntent: "display_rec709_sdr", clips: [],
          fill: { kind: "linear", start: { x: 0, y: 0 }, end: { x: 1, y: 0 },
            stops: [{ at: 0, color: "#175CD3" }, { at: 1, color: "#17203380" }] } } }],
      semanticCues: [0, 50, 100].map((frame, index) => ({ id: `paint-phase-${index}`, frame, purpose: "依語意讀完原創影片標題",
        graphicIds: ["paint-title"], evidenceRefs: [`brief:paint-${index}`],
        ...(index === 0 ? { focus: { centerX: 320, centerY: 180, zoom: 1 } } : {}) })) },
    fontBindings: [{ graphicId: "paint-title", faceId: face.faceId, fontSha256: face.sha256,
      manifestSha256: face.manifestSha256, parserVersion: "opentype.js@1.3.4" }] });
}
function mediaProject(): EditProject {
  const project = createEmptyProject("Painted saved media owner source control", { id: "painted-media-owner-control", width: 640, height: 360, fps: 30 });
  project.colorManagement = { ...DEFAULT_COLOR_MANAGEMENT, mode: "aces2" };
  // Actual typed metadata, deliberately not source-analysis or licensed media receipts.
  project.assets = [
    { id: "video-source", name: "Synthetic video metadata", kind: "video", uri: "C:/source-control/video.mp4", duration: 12,
      width: 1280, height: 720, displayAspectRatio: 16 / 9,
      color: { interpretation: "rec709", primaries: "bt709", transfer: "bt709", matrix: "bt709", range: "tv" },
      provenance: "synthetic-component-metadata-not-media-analysis", derivatives: { sourceSha256: "1".repeat(64), generatedAt: "2026-10-05T00:00:00Z" } },
    { id: "voice-source", name: "Synthetic audio metadata", kind: "audio", uri: "C:/source-control/voice.wav", duration: 12,
      provenance: "synthetic-component-metadata-not-media-analysis", derivatives: { sourceSha256: "2".repeat(64), generatedAt: "2026-10-05T00:00:00Z" } },
  ];
  project.tracks[0].clips = [{ id: "video-clip", assetId: "video-source", trackId: project.tracks[0].id,
    timelineStart: 0, sourceStart: .5, duration: 6, volume: .42,
    transform: { ...DEFAULT_TRANSFORM, x: 14, scale: .85 }, color: { ...DEFAULT_COLOR, saturation: 1.2 },
    keyframes: [{ id: "video-pose", time: 1, transform: { ...DEFAULT_TRANSFORM, x: 26 }, color: { ...DEFAULT_COLOR }, easing: "ease_out" }] }];
  project.tracks[1].clips = [{ id: "voice-clip", assetId: "voice-source", trackId: project.tracks[1].id,
    timelineStart: 0, sourceStart: .5, duration: 6, volume: .75, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] }];
  project.captions = [{ id: "kept-caption", text: "保留旁白字幕", start: 1, duration: 2 }];
  project.motionTracks = [{ id: "kept-tracking", clipId: "video-clip", name: "Synthetic tracking metadata", engine: "template_match",
    analysisFps: 12, initialRect: { x: .2, y: .2, width: .2, height: .2 }, points: [], lostRatio: 0, createdAt: "2026-10-05T00:00:00Z" }];
  const clip = { ...structuredClone(project.tracks[0].clips[0]), id: "nested-video-clip", trackId: "nested-video-track", duration: 2, sourceStart: 0, keyframes: [] };
  project.compositions = [{ schema: "editkin.composition/v1", id: "kept-composition", name: "Preserved unrelated composition", width: 640, height: 360,
    fps: 30, duration: 2, tracks: [{ id: "nested-video-track", name: "Nested video", kind: "video", locked: false, muted: false, clips: [clip] }],
    captions: [{ id: "nested-caption", text: "保留巢狀字幕", start: 0, duration: 1 }], captionStyle: structuredClone(project.captionStyle),
    motionTracks: [], motionGraphics: [], director: structuredClone(project.director), colorManagement: structuredClone(project.colorManagement), updatedAt: project.updatedAt }];
  return validateProject(project);
}
async function fixture() {
  // Real temporary path: macOS tmpdir() sits under the /var symlink and Windows runners report 8.3 short names.
  const root = await mkdtemp(join(await realpath(tmpdir()), "editkin-painted-owner-source-control-"));
  await mkdir(join(root, ".editkin", "original-sources"), { recursive: true });
  const before = payload(), after = structuredClone(before), face = bundledFontFaceSpec("EditkinFace-noto-sans-tc-500");
  after.authoring.expectedRevision = 7;
  const element = after.authoring.elements[0];
  if (element.kind !== "text" || element.paintV1?.fill.kind !== "linear") throw new Error("Actual painted control title missing");
  element.text = "用 Codex 做自己的剪輯效果"; element.fontWeight = 500; element.fontSize = 48; element.maxLines = 2;
  element.paintV1.fill.stops[0].color = "#E04D35"; element.paintV1.fill.stops[1].color = "#4C256E80";
  const phase = { durationFrames: 8, offsetXPixels: 0, offsetYPixels: 0, scale: 1, opacity: 1, easing: { type: "linear" as const } };
  element.motionV2 = { sequence: { unit: "character", order: "forward", exitOrder: "reverse", staggerFrames: 2 }, entrance: phase, exit: { ...phase, durationFrames: 5 } };
  after.fontBindings[0] = { graphicId: "paint-title", faceId: face.faceId, fontSha256: face.sha256,
    manifestSha256: face.manifestSha256, parserVersion: "opentype.js@1.3.4" };
  await writeFile(join(root, beforePath), canonicalJson(before) + "\n"); await writeFile(join(root, afterPath), canonicalJson(after) + "\n");
  const empty = mediaProject(), creation = await prepareOriginalMotionSourceFile(empty, beforePath, 0, { workspace: root, fontRoot });
  let project = applyCommand(empty, { type: "batch", commands: creation.prepared.preparation.commands });
  const other = structuredClone(before); other.authoring.sceneId = "other-owner"; other.authoring.expectedRevision = project.revision;
  other.authoring.elements[0].id = "other-title"; other.fontBindings[0].graphicId = "other-title";
  other.authoring.semanticCues.forEach((cue, index) => { cue.id = `other-phase-${index}`; cue.graphicIds = ["other-title"]; });
  await writeFile(join(root, ".editkin/original-sources/other-owner.json"), canonicalJson(other) + "\n");
  const otherCreation = await prepareOriginalMotionSourceFile(project, ".editkin/original-sources/other-owner.json", 0, { workspace: root, fontRoot });
  project = applyCommand(project, { type: "batch", commands: otherCreation.prepared.preparation.commands });
  // Current optional shapes must survive revision, not be invented by normalization.
  project.tracks[0].clips[0].layer = { enabled: true, blendMode: "normal" }; delete project.tracks[0].clips[0].expressions;
  delete project.tracks[1].clips[0].layer; delete project.tracks[1].clips[0].expressions;
  project.revision = 7; validateProject(project);
  const revision = await prepareOriginalMotionSourceRevisionFile(project, beforePath, afterPath, 1, { workspace: root, fontRoot, revisionScope });
  const base = createAutopilotV4Fixture();
  const commands: EditorCommand[] = [structuredClone(base.commands[0]), ...revision.preparation.commands];
  const editorial = { ...structuredClone(base.editorial), graphics: revision.preparation.editorialGraphics, transitions: [],
    narrative: { ...base.editorial.narrative, setupPayoffs: base.editorial.narrative.setupPayoffs.map(pair => ({ ...pair })), beats: base.editorial.narrative.beats.map((beat, index) => ({ ...beat,
      range: { startFrame: index * 50, endFrame: (index + 1) * 50 }, evidenceRefs: [originalMotionCueEvidenceReference(revision.evidence.sourceSha256, `paint-phase-${index}`)] })) } };
  const plan = { ...base, materialEvidence: { schema: "hao.editkin.material-intelligence/v1", receipts: [] },
    originalMotionEvidence: revision.sourceSet, commands, editorial };
  return { root, before, after, project, revision, commands, editorial, plan };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
let actual: Fixture;
beforeAll(async () => { actual = await fixture(); });
// Owned generated sources remain for the canonical peer and failure inspection.
function inputs(f: Fixture) { return { before: { authoring: f.before.authoring, rights: f.before.rights, authoringSource: f.revision.evidence.before.authoringSource! },
  after: { authoring: f.after.authoring, rights: f.after.rights, authoringSource: f.revision.evidence.after.authoringSource! } }; }
async function verifiedAuthority(f: Fixture) {
  // Real host file pins and physical recompilation precede the internal issuer;
  // this tests source components, not authenticated live audit or material rights.
  for (const [evidence, payload] of [[f.revision.evidence.before, f.before], [f.revision.evidence.after, f.after]] as const) {
    const loaded = await readOriginalMotionAuthoringSource(evidence.authoringSource!.sourcePath, f.root);
    expect(loaded.source).toEqual(evidence.authoringSource); assertOriginalRevisionFile(evidence, loaded.payload, revisionScope);
    expect(loaded.payload).toEqual(payload);
  }
  const provider = originalMotionTextProvider(fontRoot);
  try { await verifyOriginalPaintedMediaSourceRevisionEvidence(f.revision.sourceSet, f.project, f.commands, f.editorial, { prepareText: provider }); }
  finally { provider.dispose(); }
  const batch: EditorCommand = { type: "batch", commands: structuredClone(f.commands) };
  return { batch, context: { originalSourceOwnerRevisionProof: issueOriginalSourceOwnerRevisionProof(f.project, batch) } };
}

describe("explicit painted media owner source revision", () => {
  it("compiles actual immutable TC700/500 files and every scene frame without changing full media context", async () => {
    const f = actual, snapshot = structuredClone(f.project);
    expect(f.revision.sourceSet.schema).toBe("editkin.original-motion-source/v3");
    expect(f.revision.evidence).toMatchObject({ schema: "editkin.original-motion-source-revision-evidence/v2", revisionScope,
      before: { authoring: { expectedRevision: 0 } }, after: { authoring: { expectedRevision: 7 } } });
    expect(f.revision.evidence.after.graphicBindings[0].physicalFont?.faceId).toBe("EditkinFace-noto-sans-tc-500");
    expect(f.revision.preparation.preparedSafety).toMatchObject({ before: { framesChecked: 150, graphicFramesChecked: 150 },
      after: { framesChecked: 150, graphicFramesChecked: 150 } });
    expect(f.revision.evidence.scene).toEqual(f.project.motionScenes![0]);
    expect(f.revision.evidence.preservedContextSha256).toBe(sha256Canonical(originalPaintedMediaRevisionPreservedContext(f.project, "paint-owner")));
    expect(await readFile(join(f.root, beforePath), "utf8")).toBe(canonicalJson(f.before) + "\n"); expect(f.project).toEqual(snapshot);
    const output = process.env.EDITKIN_PAINTED_REVISION_PACKET;
    if (output) {
      const descriptorPath = ".editkin/original-sources/paint-revision.json";
      const descriptor = { schema: "editkin.original-motion-revision-source/v2", revisionScope, usage: "authored_overlay", audio: "preserve_source_audio",
        fps: f.project.fps, expectedRevision: f.project.revision, owner: { sceneId: f.revision.evidence.scene.id,
          sceneSha256: sha256Canonical(f.revision.evidence.scene), orderedGraphicsSha256: sha256Canonical(f.revision.evidence.expectedGraphics) },
        before: f.revision.evidence.before.authoringSource, after: f.revision.evidence.after.authoringSource,
        preservedContextSha256: f.revision.evidence.preservedContextSha256 };
      await writeFile(join(f.root, descriptorPath), canonicalJson(descriptor) + "\n");
      await writeFile(resolve(output), canonicalJson({ workspace: f.root, descriptor: "1=" + descriptorPath, descriptorPayload: descriptor, project: f.project,
        beforeSourcePayload: f.before, afterSourcePayload: f.after, packet: f.revision, plan: f.plan,
        runtimeFontEvidence: { before: f.revision.evidence.before.graphicBindings.map(binding => binding.physicalFont),
          after: f.revision.evidence.after.graphicBindings.map(binding => binding.physicalFont) },
        boundary: "Actual physical source component packet; media metadata is synthetic, material receipts deliberately empty. Not a validated full plan, fresh SDK, audit/apply, rendered pixels, installation or art/performance certification." }) + "\n");
    }
  });

  it("independently rechecks real files and physical source then applies one exact opaque-proof batch and reopens full media", async () => {
    const f = actual, snapshot = structuredClone(f.project), authority = await verifiedAuthority(f);
    const candidate = applyCommand(f.project, authority.batch, authority.context);
    assertOriginalPaintedMediaRevisionPreservedContext(f.project, candidate, "paint-owner");
    const reopened = decodeProjectBytes(encodeProjectBytes(candidate));
    for (const key of ["assets", "tracks", "captions", "captionStyle", "compositions", "motionTracks", "director", "colorManagement"] as const) {
      expect(candidate[key]).toStrictEqual(snapshot[key]); expect(reopened[key]).toStrictEqual(candidate[key]);
    }
    expect(candidate.motionScenes).toStrictEqual(snapshot.motionScenes);
    expect(candidate.motionGraphics[1]).toStrictEqual(snapshot.motionGraphics[1]);
    expect(reopened.motionGraphics).toStrictEqual(candidate.motionGraphics); expect(reopened.motionScenes).toStrictEqual(candidate.motionScenes);
    expect(candidate.motionGraphics[0]).toMatchObject({ id: "paint-title", text: "用 Codex 做自己的剪輯效果", fontWeight: 500,
      paintV1: { schema: "editkin.motion-paint/v2" }, motionV2: { sequence: { unit: "character", staggerFrames: 2 } } });
    expect(f.project).toStrictEqual(snapshot);
  });

  it("retains the old standalone/media-free and unpainted guards and rejects cross-version schemas", async () => {
    const f = actual;
    await expect(prepareOriginalMotionSourceRevisionFile(f.project, beforePath, afterPath, 1, { workspace: f.root, fontRoot })).rejects.toThrow(/media-free/);
    expect(() => originalMotionSourceRevisionSetSchema.parse(f.revision.sourceSet)).toThrow();
    const loaded = await readOriginalMotionAuthoringSource(beforePath, f.root);
    expect(() => assertOriginalRevisionFile(f.revision.evidence.before, loaded.payload)).toThrow(/payload\/rights\/usage/);
    expect(() => originalPaintedMediaSourceRevisionSetSchema.parse({ ...f.revision.sourceSet, arbitraryLegacyAlias: true })).toThrow();
  });

  it("requires actual overlapping typed video and preserves the flat ACES2/rec709 graphics bound", async () => {
    const f = actual;
    const absent = structuredClone(f.project); absent.tracks[0].clips = [];
    await expect(prepareOriginalPaintedMediaSourceRevisionEvidence(absent, inputs(f), 1)).rejects.toThrow(/actual saved video/);
    const outside = structuredClone(f.project); outside.tracks[0].clips[0].timelineStart = 7;
    await expect(prepareOriginalPaintedMediaSourceRevisionEvidence(outside, inputs(f), 1)).rejects.toThrow(/actual saved video/);
    const wrong = structuredClone(f.project); wrong.colorManagement = { ...DEFAULT_COLOR_MANAGEMENT };
    await expect(prepareOriginalPaintedMediaSourceRevisionEvidence(wrong, inputs(f), 1)).rejects.toThrow(/flat ACES2/);
    const depth = structuredClone(f.project); depth.scene25d = structuredClone(DEFAULT_SCENE_25D);
    await expect(prepareOriginalPaintedMediaSourceRevisionEvidence(depth, inputs(f), 1)).rejects.toThrow(/flat ACES2/);
    const tooMany = structuredClone(f.project); tooMany.motionGraphics.push(...[2, 3, 4].map(index => ({ ...structuredClone(f.project.motionGraphics[1]), id: `extra-${index}` })));
    await expect(prepareOriginalPaintedMediaSourceRevisionEvidence(tooMany, inputs(f), 1)).rejects.toThrow(/four project graphics/);
  });

  it("rejects floating video in either root or nested composition rather than claiming complete Long05 compatibility", async () => {
    const floating = { schema: "editkin.floating-video-frame/v2" as const, style: "matte" as const, aspect: "source" as const,
      mediaFit: "contain" as const, size: .45, yawDegrees: 6, pitchDegrees: -3, centerX: .5, centerY: .5,
      motion: { entranceFrames: 8, exitFrames: 5, travelY: .025 } };
    const root = structuredClone(actual.project); root.tracks[0].clips[0].floatingFrame = floating;
    await expect(prepareOriginalPaintedMediaSourceRevisionEvidence(root, inputs(actual), 1)).rejects.toThrow(/floating-video frames/);
    const nested = structuredClone(actual.project); nested.compositions[0].tracks[0].clips[0].floatingFrame = floating;
    await expect(prepareOriginalPaintedMediaSourceRevisionEvidence(nested, inputs(actual), 1)).rejects.toThrow(/floating-video frames/);
  });

  it("rejects raw, forged, cloned-proof, mixed and altered batches before any media mutation", async () => {
    const f = actual, batch: EditorCommand = { type: "batch", commands: structuredClone(f.commands) }, snapshot = structuredClone(f.project);
    expect(() => applyCommand(f.project, batch)).toThrow(/ORIGINAL_SOURCE_OWNER_RECOMPILE_REQUIRED/);
    expect(() => applyCommand(f.project, batch, { originalSourceOwnerRevisionProof: {} })).toThrow(/ORIGINAL_SOURCE_OWNER_RECOMPILE_REQUIRED/);
    const authority = await verifiedAuthority(f);
    expect(() => applyCommand(f.project, authority.batch, { originalSourceOwnerRevisionProof: structuredClone(authority.context.originalSourceOwnerRevisionProof) })).toThrow(/ORIGINAL_SOURCE_OWNER_RECOMPILE_REQUIRED/);
    const altered = structuredClone(authority.batch);
    if (altered.type !== "batch" || altered.commands[1].type !== "revise_original_motion_scene_graphic") throw new Error("Actual owner command missing");
    altered.commands[1].graphic.text = "變造標題";
    expect(() => applyCommand(f.project, altered, authority.context)).toThrow(/ORIGINAL_SOURCE_OWNER_RECOMPILE_REQUIRED/);
    const mixed: EditorCommand = { type: "batch", commands: [...f.commands, { type: "rename_project", name: "unbound" }] };
    expect(() => issueOriginalSourceOwnerRevisionProof(f.project, mixed)).toThrow(/EXACT_BATCH_REQUIRED/); expect(f.project).toEqual(snapshot);
  });

  it("binds complete live context and does not hide captions, director, optional shape or unrelated-owner drift", async () => {
    const f = actual, authority = await verifiedAuthority(f);
    const mutations: ((project: EditProject) => void)[] = [
      project => { project.captions[0].text = "變造字幕"; }, project => { project.assets[0].uri += ".changed"; },
      project => { project.compositions[0].name += " changed"; }, project => { project.motionTracks[0].lostRatio = .2; },
      project => { project.director.updatedAt = "2026-10-05T01:00:00Z"; }, project => { project.motionGraphics[1].text = "變造其他 owner"; },
      project => { project.tracks[0].clips[0].layer!.role = "content"; },
    ];
    for (const mutate of mutations) {
      const drift = structuredClone(f.project); mutate(drift);
      expect(() => assertOriginalPaintedMediaRevisionPreservedContext(f.project, drift, "paint-owner")).toThrow(/preserved full media/);
      expect(() => applyCommand(drift, authority.batch, authority.context)).toThrow(/ORIGINAL_SOURCE_OWNER_RECOMPILE_REQUIRED/);
    }
  });

  it("preserves geometry, camera, cues, rights, explicit paint alpha and topology in the versioned source pair", async () => {
    const f = actual;
    const mutations: ((input: ReturnType<typeof inputs>) => void)[] = [
      input => { input.after.authoring.elements[0].xPixels++; }, input => { input.after.authoring.camera.initial.zoom = 1.01; },
      input => { input.after.authoring.semanticCues[1].frame++; }, input => { input.after.rights.declaration += " changed"; },
      input => { const paint = input.after.authoring.elements[0].paintV1!; if (paint.fill.kind === "linear") paint.fill.stops[1].color = "#4C256E81"; },
      input => { const paint = input.after.authoring.elements[0].paintV1!; if (paint.fill.kind === "linear") paint.fill.end.x = .9; },
    ];
    for (const mutate of mutations) { const changed = structuredClone(inputs(f)); mutate(changed);
      await expect(prepareOriginalPaintedMediaSourceRevisionEvidence(f.project, changed, 1)).rejects.toThrow(/geometry|rights boundary|paint topology/); }
    const legacy = structuredClone(inputs(f)), paint = legacy.after.authoring.elements[0].paintV1!;
    legacy.after.authoring.elements[0].paintV1 = { schema: "editkin.motion-paint/v1", clips: paint.clips, fill: paint.fill };
    await expect(prepareOriginalPaintedMediaSourceRevisionEvidence(f.project, legacy, 1)).rejects.toThrow(/explicit authored_overlay display paint v2/);
  });

  it("rejects real raw-byte or font-pin changes at file verification rather than trusting a prepared manifest", async () => {
    const f = actual, changed = structuredClone(f.after); changed.fontBindings[0].fontSha256 = "0".repeat(64);
    try {
      await writeFile(join(f.root, afterPath), canonicalJson(changed) + "\n");
      await expect(prepareOriginalMotionSourceRevisionFile(f.project, beforePath, afterPath, 1,
        { workspace: f.root, fontRoot, revisionScope })).rejects.toThrow(/font pins/);
      const loaded = await readOriginalMotionAuthoringSource(afterPath, f.root);
      expect(loaded.source.sourceSha256).not.toBe(f.revision.evidence.after.authoringSource!.sourceSha256);
      expect(() => assertOriginalRevisionFile(f.revision.evidence.after, loaded.payload, revisionScope)).toThrow(/font pins/);
    } finally { await writeFile(join(f.root, afterPath), canonicalJson(f.after) + "\n"); }
  });

  it("keeps actual physical indexes and rejects plan drift without crediting preserved camera or admitting mixed media mutations", () => {
    const f = actual; expect(() => assertOriginalPaintedMediaSourceRevisionPlanBinding(f.revision.sourceSet, f.commands, f.editorial)).not.toThrow();
    const visible = originalPaintedMediaSourceRevisionVisibleProjection(f.revision.sourceSet, f.commands);
    expect(visible).toHaveLength(2); expect(visible[0].type).toBe("set_aesthetic_system"); expect(visible[1].type).toBe("add_motion_graphic");
    expect(visible.some(command => command.type === "add_motion_scene")).toBe(false);
    const altered = structuredClone(f.commands); if (altered[1].type !== "revise_original_motion_scene_graphic") throw new Error("Actual owner command missing");
    altered[1].graphic.text = "未重編";
    expect(() => assertOriginalPaintedMediaSourceRevisionPlanBinding(f.revision.sourceSet, altered, f.editorial)).toThrow(/command hash/);
    expect(() => assertOriginalPaintedMediaSourceRevisionPlanBinding(f.revision.sourceSet,
      [...f.commands, { type: "rename_project", name: "unbound" }], f.editorial)).toThrow(/flat complete owner replacement/);
    const tampered = { ...f.revision.sourceSet, sources: [{ ...f.revision.evidence, preservedContextSha256: "0".repeat(64) }] };
    expect(() => assertOriginalPaintedMediaSourceRevisionPlanBinding(
      originalPaintedMediaSourceRevisionSetSchema.parse(tampered), f.commands, f.editorial)).toThrow(/manifest hash/);
    // This ancillary integrity refusal is the manifest stage, not a claimed late context gate.
  });
});
