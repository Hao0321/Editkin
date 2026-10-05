import { describe, expect, it } from "vitest";
import { applyCommand } from "./commands";
import type { EditorCommand } from "./commandTypes";
import { getClipSourceReplacementError } from "./clipSourceReplacement";
import { createEmptyProject, validateProject } from "./editGraph";
import { createHistory, dispatchCommand, dispatchCommandSafely, redo, undo } from "./history";
import { createClipMask } from "./masks";
import { editorCommandSchema } from "./schema";
import { DEFAULT_CLIP_LAYER, DEFAULT_COLOR, DEFAULT_TRANSFORM, DEFAULT_TRANSFORM_3D, type EditProject, type TemplateApplicationState } from "./types";
import { decodeProjectBytes, encodeProjectBytes } from "../application/projectCodec";
import { DEFAULT_REFERENCE_MOTION_STYLE } from "../motion/referenceMotionTemplates";
import { mesh3dSceneSchema } from "../motion/mesh3dScene";
import { renderReviewContentJson } from "../shared/renderReviewContent";
import { createProductAutoRotoRouteReceipt } from "../application/autoRotoProductContract";

type Replacement = Extract<EditorCommand, { type: "replace_clip_source" }>;
const command = (patch: Partial<Replacement> = {}): Replacement => ({
  type: "replace_clip_source", clipId: "selected", expectedAssetId: "source-a", assetId: "source-b", sourceStart: 1,
  ...patch,
});
function fixture(): EditProject {
  const project = createEmptyProject("Selected video replacement", { id: "replacement-project", width: 1920, height: 1080, fps: 30 });
  project.assets = [
    { id: "source-a", name: "Original.mp4", kind: "video", uri: "C:/owned/original.mp4", duration: 12,
      width: 1920, height: 1080, displayAspectRatio: 16 / 9, color: { interpretation: "rec709", primaries: "bt709", transfer: "bt709", matrix: "bt709", range: "tv" },
      rightsBasis: "creator_owned", provenance: "original-source", alphaMode: "opaque",
      derivatives: { sourceSha256: "a".repeat(64), proxyUri: "C:/cache/original-proxy.mp4", generatedAt: "2026-10-05T00:00:00Z" } },
    { id: "source-b", name: "New.mov", kind: "video", uri: "C:/owned/new.mov", duration: 8,
      width: 1080, height: 1920, displayAspectRatio: 9 / 16, color: { interpretation: "hlg", primaries: "bt2020", transfer: "arib-std-b67", matrix: "bt2020nc", range: "tv" },
      rightsBasis: "creator_owned", provenance: "new-source", alphaMode: "opaque",
      derivatives: { sourceSha256: "b".repeat(64), proxyUri: "C:/cache/new-proxy.mp4", generatedAt: "2026-10-05T01:00:00Z" } },
  ];
  const mask = createClipMask("manual-aperture", "rectangle");
  mask.keyframes = [{ frame: 30, time: 1, confidence: 1, status: "manual", points: structuredClone(mask.path) }];
  project.tracks[0].clips = [
    { id: "selected", assetId: "source-a", trackId: project.tracks[0].id, timelineStart: 2, sourceStart: 4, duration: 3, volume: .45,
      transform: { ...DEFAULT_TRANSFORM, x: 12, y: -8, scale: .82, rotation: 4 }, color: { ...DEFAULT_COLOR, saturation: 1.1 },
      keyframes: [{ id: "authored-pose", time: 1, transform: { ...DEFAULT_TRANSFORM, x: 24 }, color: { ...DEFAULT_COLOR }, easing: "ease_in_out" }],
      creative: { lookPresetId: "cinematic-warm", effectPresetIds: ["film-grain"], nativeEffectInstances: [
        { id: "authored-native", pluginId: "editkin.fixture", capabilityId: "gain", pluginVersion: "1.0.0", manifestSha256: "c".repeat(64),
          runtimeType: "native_effect", enabled: true, parameters: { gain: 1.05 } },
      ] }, masks: [mask], layer: { ...DEFAULT_CLIP_LAYER } },
    { id: "sibling", assetId: "source-a", trackId: project.tracks[0].id, timelineStart: 7, sourceStart: 0, duration: 1, volume: .2,
      transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [], layer: { ...DEFAULT_CLIP_LAYER } },
  ];
  return validateProject(project);
}
function independent(project: EditProject) {
  for (const clip of project.tracks[0].clips) {
    clip.transform = { ...DEFAULT_TRANSFORM }; clip.color = { ...DEFAULT_COLOR }; clip.keyframes = [];
    delete clip.creative; delete clip.masks;
  }
  project.assets[1].color = { interpretation: "rec709" };
  return validateProject(project);
}
function rejectWithoutChanges(project: EditProject, replacement: Replacement, reason: RegExp) {
  const before = structuredClone(project), history = createHistory(project);
  expect(getClipSourceReplacementError(project, replacement)).toMatch(reason);
  const result = dispatchCommandSafely(history, replacement);
  expect(result.error).toMatch(reason);
  expect(result.state).toBe(history);
  expect(project).toEqual(before);
}
function managedReference(project: EditProject, primary = "selected", manageSelected = true) {
  return applyCommand(project, { type: "upsert_reference_motion_instance", instance: {
    // Structural saved ownership fixture, not a compiled/evaluated artwork receipt.
    schema: "editkin.reference-motion-instance/v1", id: "saved-owner", authoringGeneration: 2, instanceRevision: 1,
    input: { templateId: "level_bridge", clipId: primary, startFrame: 60, durationFrames: 90, title: "Owned source", sources: [],
      intent: "shortform", purpose: "ownership control", evidenceRefs: ["fixture:source"], style: structuredClone(DEFAULT_REFERENCE_MOTION_STYLE) },
    frameFormat: { width: project.width, height: project.height, fps: project.fps },
    roles: [{ key: "source:0:clip", kind: "clip", id: primary, parentId: project.tracks[0].id },
      ...(primary === "selected" || !manageSelected ? [] : [{ key: "source:1:clip", kind: "clip" as const, id: "selected", parentId: project.tracks[0].id }])],
    primaryBefore: { layout: null }, appliedScopeSha256: "d".repeat(64), dependencies: { recipeVersion: "fixture:ownership", presetHashes: [], fonts: [] },
  } });
}
function templateOwnership(project: EditProject, generated = false) {
  const snapshot = { editorialProfile: project.editorialProfile, aestheticSystem: null, captionStyle: structuredClone(project.captionStyle),
    clips: generated ? [] : [{ clipId: "selected", creativePresent: true, lookPresetId: "cinematic-warm", effectPresetIds: ["film-grain"], transitionIn: null, transitionOut: null }] };
  const application: TemplateApplicationState = { schema: "editkin.template-application/v1", sessionId: "template-session", templateId: "movie-template",
    templateName: "Owned movie", format: "long", createdAt: "2026-10-05T00:00:00Z", before: structuredClone(snapshot), applied: structuredClone(snapshot),
    ...(generated ? { generatedClips: [{ clipId: "selected", trackId: project.tracks[0].id }] } : {}) };
  return applyCommand(project, { type: "set_template_application", application });
}

describe("selected video source replacement", () => {
  it("changes one source window while retaining the complete authored clip, shared original and each source's own metadata", () => {
    const project = fixture(), before = structuredClone(project), originalClip = project.tracks[0].clips[0];
    expect(getClipSourceReplacementError(project, command())).toBeUndefined();
    const next = applyCommand(project, command());
    expect(next.tracks[0].clips[0]).toEqual({ ...originalClip, assetId: "source-b", sourceStart: 1 });
    expect(next.tracks[0].clips[1]).toEqual(project.tracks[0].clips[1]);
    expect(next.assets).toEqual(before.assets);
    expect(next.assets[1].color?.interpretation).toBe("hlg");
    expect(next.assets[1].derivatives?.sourceSha256).toBe("b".repeat(64));
    expect(renderReviewContentJson(next)).not.toBe(renderReviewContentJson(project));
    expect(project).toEqual(before);
  });

  it("is one real Undo/Redo and preserves the new source selection through the actual project codec", () => {
    const project = fixture(), applied = dispatchCommand(createHistory(project), editorCommandSchema.parse(command()), "replace-selected");
    expect(applied.past).toEqual([project]);
    expect(applied.journal).toHaveLength(1);
    expect(undo(applied).present).toEqual(project);
    expect(redo(undo(applied)).present).toEqual(applied.present);
    const reopened = decodeProjectBytes(encodeProjectBytes(applied.present));
    expect(reopened.tracks).toEqual(applied.present.tracks);
    expect(reopened.assets).toEqual(applied.present.assets);
    expect(reopened.tracks[0].clips[0].id).toBe("selected");
    expect(getClipSourceReplacementError(reopened, command())).toMatch(/素材已變更/);
  });

  it("keeps a real floating-v2 card and admits its new upright DAR without resetting animation or padding it into another asset", () => {
    const project = independent(fixture()), clip = project.tracks[0].clips[0];
    clip.floatingFrame = { schema: "editkin.floating-video-frame/v2", style: "matte", aspect: "source", mediaFit: "contain",
      size: .45, yawDegrees: 6, pitchDegrees: -3, centerX: .5, centerY: .5, motion: { entranceFrames: 8, exitFrames: 5, travelY: .025 } };
    validateProject(project);
    const next = applyCommand(project, command({ sourceStart: 2 / 30 }));
    expect(next.tracks[0].clips[0].floatingFrame).toEqual(clip.floatingFrame);
    expect(next.assets[1].displayAspectRatio).toBe(9 / 16);
    expect(next.tracks[0].clips[0].sourceStart).toBe(2 / 30);
    const incompatible = structuredClone(project); incompatible.assets[1].color = { interpretation: "hlg" };
    rejectWithoutChanges(incompatible, command(), /浮空影片框.*Rec\.709/);
  });

  it("preserves an ordinary 2.5D clip pose and camera because they resolve the selected asset through the same clip identity", () => {
    const project = applyCommand(independent(fixture()), { type: "configure_scene_25d", enabled: true });
    project.tracks[0].clips[0].transform3d = { ...structuredClone(DEFAULT_TRANSFORM_3D), position: [.4, -.2, .6] };
    validateProject(project);
    expect(getClipSourceReplacementError(project, command())).toBeUndefined();
    const next = applyCommand(project, command());
    expect(next.scene25d).toEqual(project.scene25d);
    expect(next.tracks[0].clips[0].transform3d).toEqual(project.tracks[0].clips[0].transform3d);
    expect(next.tracks[0].clips[0].assetId).toBe("source-b");
  });

  it("accepts the exact final legal frame window but refuses a one-frame short source and non-frame or invalid in-points", () => {
    const project = fixture();
    expect(applyCommand(project, command({ sourceStart: 5 })).tracks[0].clips[0].duration).toBe(3);
    for (const sourceStart of [-1, .5 / 30, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER]) {
      rejectWithoutChanges(project, command({ sourceStart }), /入點/);
    }
    const short = structuredClone(project); short.assets[1].duration = 4 - 1 / 30;
    rejectWithoutChanges(short, command(), /長度不足/);
    expect(project.tracks[0].clips[1].timelineStart).toBe(7);
  });

  it("refuses stale, unchanged, absent, locked and incompatible sources with no partial graph or history mutation", () => {
    const project = fixture();
    rejectWithoutChanges(project, command({ expectedAssetId: "old-selection" }), /素材已變更/);
    rejectWithoutChanges(project, command({ assetId: "source-a" }), /另一份/);
    rejectWithoutChanges(project, command({ clipId: "missing" }), /不存在/);
    rejectWithoutChanges(project, command({ assetId: "missing" }), /已匯入的單檔影片/);
    const locked = structuredClone(project); locked.tracks[0].locked = true;
    rejectWithoutChanges(locked, command(), /未鎖定/);
    for (const kind of ["audio", "image"] as const) {
      const wrong = structuredClone(project); wrong.assets[1].kind = kind;
      rejectWithoutChanges(wrong, command(), /單檔影片/);
    }
    const composition = applyCommand(project, { type: "precompose_clips", compositionId: "nested", assetId: "composition-source", replacementClipId: "composition-clip",
      targetTrackId: project.tracks[0].id, name: "Real saved composition", clipIds: ["sibling"] });
    rejectWithoutChanges(composition, command({ assetId: "composition-source" }), /預合成/);
    const sequence = structuredClone(project); sequence.assets[1].imageSequence = {
      schema: "editkin.openexr-sequence/v1", format: "openexr", frameCount: 240, startFrame: 0, lastFrame: 239,
      timebase: { numerator: 1, denominator: 30 }, sequenceSha256: "e".repeat(64), manifestSha256: "f".repeat(64), previewUri: "C:/owned/sequence.mp4",
    };
    sequence.assets[1].kind = "image"; sequence.assets[1].uri = "C:/owned/sequence.json";
    sequence.assets[1].color = { interpretation: "linear_rec709" }; sequence.assets[1].alphaMode = "straight";
    validateProject(sequence);
    rejectWithoutChanges(sequence, command(), /影格序列/);
    const unprobed = structuredClone(project); delete unprobed.assets[1].width;
    rejectWithoutChanges(unprobed, command(), /展示尺寸/);
  });

  it("protects primary/generated saved-template source owners and movie-template snapshots rather than stamping a fresh scope hash", () => {
    for (const project of [managedReference(fixture()), managedReference(fixture(), "sibling"), templateOwnership(fixture()), templateOwnership(fixture(), true)]) {
      rejectWithoutChanges(project, command(), /模板管理/);
    }
    const retained = managedReference(fixture(), "sibling", false);
    // A different unowned clip using the same old asset remains independently editable.
    expect(getClipSourceReplacementError(retained, command())).toBeUndefined();
    expect(applyCommand(retained, command()).referenceMotionInstances).toEqual(retained.referenceMotionInstances);
  });

  it("refuses original-media tracking, disabled frozen masks, correction strokes and tracked mask observations without discarding authored analysis", () => {
    const tracked = fixture(); tracked.motionTracks = [{ id: "old-analysis", clipId: "selected", name: "Original subject", engine: "template_match",
      analysisFps: 12, initialRect: { x: .2, y: .2, width: .2, height: .2 }, points: [], lostRatio: 0, createdAt: "2026-10-05T00:00:00Z" }];
    validateProject(tracked); rejectWithoutChanges(tracked, command(), /追蹤或已烘焙遮罩/);
    const frozen = fixture(); frozen.tracks[0].clips[0].masks![0].enabled = false;
    frozen.tracks[0].clips[0].masks![0].frozenRange = { fromFrame: 0, toFrame: 60 };
    validateProject(frozen); rejectWithoutChanges(frozen, command(), /追蹤或已烘焙遮罩/);
    const corrected = fixture(); corrected.tracks[0].clips[0].masks![0].rotoCorrections = [{ id: "old-stroke", frame: 0, mode: "foreground", radius: .02, points: [{ x: .5, y: .5 }] }];
    validateProject(corrected); rejectWithoutChanges(corrected, command(), /追蹤或已烘焙遮罩/);
    const observed = fixture(); observed.tracks[0].clips[0].masks![0].keyframes[0].status = "tracked";
    validateProject(observed); rejectWithoutChanges(observed, command(), /追蹤或已烘焙遮罩/);
    const baked = fixture(), mask = createClipMask("stored-matte", "subject"), digest = "e".repeat(64);
    const artifactRoot = `C:/cache/auto-roto-product/${digest}`, frameCount = 36;
    // A complete structural product record exercises source-binding admission;
    // no file/pixel/analysis execution or artwork acceptance is claimed here.
    mask.matteSequence = { schema: "editkin.auto-roto-matte/v1", engine: "editkin-native-color-temporal-roto/v1",
      width: 16, height: 16, analysisFps: 12, frameCount, sequenceUri: `${artifactRoot}/matte-sequence.alpha8`,
      sequenceSha256: digest, sequenceBytes: 16 * 16 * frameCount, manifestUri: `${artifactRoot}/matte-manifest.json`,
      frameArtifactUris: Array.from({ length: frameCount }, (_, frame) => `${artifactRoot}/frame-${String(frame).padStart(6, "0")}.png`),
      meanBoundaryChatter: .02, regionMemoryRouting: { schema: "editkin.region-memory-routing/v1", requested: "fixed_baseline", executed: "fixed_baseline",
        candidateAttempted: false, deterministicFallback: false },
      alphaRefinement: { schema: "editkin.optical-alpha-refinement-aggregate/v1", engine: "editkin-self-authored-optical-alpha-refiner/v1",
        appliedFrames: frameCount, radius: 4, backgroundThreshold: .2, foregroundThreshold: .8, coarseWeight: .5, temporalStability: .5, temporalGate: .5,
        changedPixels: 10, fractionalPixels: 20, solvedPixels: 10, meanSolveConfidence: .8 },
      routeReceipt: createProductAutoRotoRouteReceipt(), frozen: true, qualityState: "diagnostic" };
    baked.tracks[0].clips[0].masks = [mask];
    validateProject(baked); rejectWithoutChanges(baked, command(), /追蹤或已烘焙遮罩/);
  });

  it("blocks the exact mesh material source binding while leaving unrelated disabled scene metadata unchanged", () => {
    const project = fixture();
    project.scene3d = mesh3dSceneSchema.parse({ schema: "editkin.mesh-scene/v1", enabled: false,
      background: { color: "#101010", gridColor: "#303030", spacing: 48, grid: false }, light: { direction: [0, -1, 1], ambient: .3, intensity: .8 },
      segments: [{ id: "mesh-segment", name: "Material binding", timelineStart: 2, duration: 3,
        camera: { position: [0, 1, 5], target: [0, 0, 0], verticalFovDegrees: 45, near: .1, far: 40 }, cameraKeyframes: [],
        objects: [{ id: "screen", name: "Video surface", geometry: { kind: "box", width: 2, height: 1, depth: .02 },
          material: { color: "#FFFFFF", unlit: true, clipId: "selected" }, pose: { position: [0, 0, 0], rotationDegrees: [0, 0, 0], scale: [1, 1, 1] }, keyframes: [] }] }],
    });
    validateProject(project); rejectWithoutChanges(project, command(), /3D 影片材質/);
    project.scene3d.segments[0].objects[0].material.clipId = "sibling";
    expect(getClipSourceReplacementError(project, command())).toBeUndefined();
    expect(applyCommand(project, command()).scene3d).toEqual(project.scene3d);
  });

  it("uses a strict narrow command and atomically rolls back replacement if a later batch command fails", () => {
    const valid = command();
    expect(editorCommandSchema.parse(valid)).toEqual(valid);
    for (const raw of [{ ...valid, sourceUri: "C:/forged.mp4" }, { ...valid, derivatives: { sourceSha256: "a".repeat(64) } },
      { ...valid, duration: 1 }, { ...valid, sourceStart: Number.POSITIVE_INFINITY }, { ...valid, expectedAssetId: " source-a " }]) {
      expect(editorCommandSchema.safeParse(raw).success).toBe(false);
    }
    const project = fixture(), before = structuredClone(project), history = createHistory(project);
    const result = dispatchCommandSafely(history, { type: "batch", commands: [valid, { type: "delete_motion_graphic", graphicId: "missing" }] });
    expect(result.error).toMatch(/missing/);
    expect(result.state).toBe(history);
    expect(project).toEqual(before);
  });
});
