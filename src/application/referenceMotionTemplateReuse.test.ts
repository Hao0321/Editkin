import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createEmptyProject } from "../domain/editGraph";
import { applyCommand, type EditorCommand } from "../domain/commands";
import { createHistory, dispatchCommand, redo, undo } from "../domain/history";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type TimelineClip } from "../domain/types";
import { DEFAULT_REFERENCE_MOTION_STYLE, type ReferenceMotionTemplateId } from "../motion/referenceMotionTemplates";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { prepareGlyphRun, type PreparedGlyphRun } from "../typography/preparedGlyphRun";
import { canonicalJson } from "../shared/canonicalJson";
import { creativeAssetUri } from "../shared/creativeAssetUri";
import { verifyReferenceMotionPlan } from "../mcp/referenceMotionPlanVerification";
import { decodeProjectBytes, encodeProjectBytes, parseProject } from "./projectCodec";
import { normalizeReferenceMotionTemplateInput } from "./referenceMotionTemplates";
import { inspectReferenceMotionTemplateInstance, prepareReferenceMotionTemplateInstance } from "./referenceMotionTemplateInstances";
import { prepareReferenceMotionTemplateReuse, referenceMotionTemplateReuseRequestSchema,
  type ReferenceMotionTemplateReuseRequest } from "./referenceMotionTemplateReuse";

// These are graph controls, not file probes, license validation, artwork or
// installed-product acceptance. Two known pack identities are metadata only;
// the wide-source variant is explicitly synthetic. Every glyph is prepared
// from the actual bundled physical face; no fabricated glyph/layout provider.
const SOURCE_SHA = "7fa4eef66154a9bace04934a570a585d278e08eb6028d3e0b6e0faa0a45123a4";
const TARGET_SHA = "22504ab09dd2b572cd5f8b1582b2296bae51ed6d6cf0b4c78e8a43d2bf0c55a8";
const SYNTHETIC_GENERATED_AT = "2026-10-03T00:00:00.000Z"; // Schema-required fixture metadata, not an observed provenance receipt.
const physicalFaces = new Map<string, Uint8Array>();
async function physicalText(faceId: string, text: string): Promise<PreparedGlyphRun> {
  let bytes = physicalFaces.get(faceId);
  if (!bytes) {
    if (physicalFaces.size >= 8) throw new Error("Reuse physical face budget exceeded");
    bytes = new Uint8Array(await readFile(join(resolve("public/fonts"), bundledFontFaceSpec(faceId).fontFile)));
    physicalFaces.set(faceId, bytes);
  }
  return prepareGlyphRun(faceId, text, bytes);
}
function ids(label: string) {
  let next = 0;
  return (prefix: string, role?: string) => `${label}-${prefix}-${role?.replaceAll(":", "-")}-${next++}`;
}
function clip(project: EditProject, id: string): TimelineClip {
  const found = project.tracks.flatMap(track => track.clips).find(value => value.id === id);
  if (!found) throw new Error(`Control clip is absent: ${id}`);
  return found;
}
function graphFixture(templateId: ReferenceMotionTemplateId = "strike_reframe", wide = false) {
  const project = createEmptyProject("Synthetic saved-template reuse", {
    id: `reuse-${templateId}-${wide ? "wide" : "portrait"}`, width: 1080, height: 1920, fps: 30,
  });
  project.assets = [
    { id: "old-media", name: "Synthetic old four-second metadata", kind: "video",
      uri: creativeAssetUri("motion:14a654634790"), duration: 4, width: 1080, height: 1920,
      displayAspectRatio: 9 / 16, color: { interpretation: "rec709" }, license: "CC-BY-4.0",
      provenance: "Synthetic source control; no rights or actual media probe verification",
      derivatives: { sourceSha256: SOURCE_SHA, generatedAt: SYNTHETIC_GENERATED_AT } },
    { id: "new-media", name: "Synthetic new four-second metadata", kind: "video",
      uri: creativeAssetUri("motion:9597d63d7cfb"), duration: 4, width: wide ? 1920 : 1080, height: wide ? 1080 : 1920,
      displayAspectRatio: wide ? 16 / 9 : 9 / 16, color: { interpretation: "rec709" }, license: "CC-BY-4.0",
      provenance: "Synthetic geometry and source binding only; not media-content evidence",
      derivatives: { sourceSha256: TARGET_SHA, generatedAt: SYNTHETIC_GENERATED_AT } },
    { id: "old-secondary", name: "Synthetic old comparison source", kind: "video", uri: "D:/synthetic/reuse-old-secondary.mp4",
      duration: 4, width: 720, height: 1280, displayAspectRatio: 9 / 16, color: { interpretation: "rec709" },
      derivatives: { sourceSha256: "c".repeat(64), generatedAt: SYNTHETIC_GENERATED_AT } },
    { id: "new-secondary", name: "Synthetic new comparison source", kind: "video", uri: "D:/synthetic/reuse-new-secondary.mp4",
      duration: 4, width: 1920, height: 1080, displayAspectRatio: 16 / 9, color: { interpretation: "rec709" },
      derivatives: { sourceSha256: "d".repeat(64), generatedAt: SYNTHETIC_GENERATED_AT } },
    { id: "independent-audio", name: "Synthetic independent existing audio", kind: "audio", uri: "D:/synthetic/reuse-audio.wav", duration: 8 },
  ];
  const first = project.tracks.find(track => track.kind === "video")!;
  first.clips = [{ id: "old-clip", assetId: "old-media", trackId: first.id, timelineStart: 0, sourceStart: 0,
    duration: 4, volume: .37, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] }];
  project.tracks.push({ id: "new-video-track", name: "Independent target", kind: "video", muted: false, locked: false,
    clips: [{ id: "new-clip", assetId: "new-media", trackId: "new-video-track", timelineStart: 4, sourceStart: 0,
      duration: 4, volume: .19, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] }] });
  if (templateId === "strike_reframe") {
    // Each source has one legal picture representation. Never combine a
    // layout with floatingFrame, which actual project validation forbids.
    first.clips[0].layout = { crop: { x: 0, y: 0, width: 1, height: 1 },
      viewport: { x: .03, y: .04, width: .94, height: .92 } };
    clip(project, "new-clip").floatingFrame = { schema: "editkin.floating-video-frame/v2", style: "matte", size: .58,
      aspect: "source", mediaFit: "contain", yawDegrees: -12, pitchDegrees: 3,
      motion: { entranceFrames: 6, exitFrames: 6, travelY: .012 } };
  }
  const audio = project.tracks.find(track => track.kind === "audio")!;
  audio.clips = [{ id: "independent-audio-clip", assetId: "independent-audio", trackId: audio.id, timelineStart: 0, sourceStart: 0,
    duration: 8, volume: .23, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] }];
  project.captions = [{ id: "unrelated-caption", text: "KEEP", start: 1, duration: 1 }];
  const input = normalizeReferenceMotionTemplateInput({ templateId, clipId: "old-clip", startFrame: 0, durationFrames: 120,
    title: "NEW", previousText: "OLD", primaryLabel: "MAIN", kicker: "MOTION", graphicCadence: "brisk", purpose: "Synthetic old source story",
    evidenceRefs: ["synthetic:old-observed-content"],
    ...(templateId === "strike_reframe" ? { strikePresentation: "semantic_replace_v1" as const, strikeSurface: "source_overlay" as const } : {}),
    ...(templateId === "comparison_pair" ? { mediaPresentation: "source_soft_v2" as const } : {}),
    sources: templateId === "comparison_pair" ? [{ assetId: "old-secondary", sourceStart: 0, label: "OLD VIEW" }] : [],
    style: { ...structuredClone(DEFAULT_REFERENCE_MOTION_STYLE), typography: { headingFamily: "Noto Sans TC", bodyFamily: "Noto Sans TC" } },
  });
  return { project: parseProject(project), input };
}
async function savedFixture(templateId: ReferenceMotionTemplateId = "strike_reframe", wide = false) {
  const f = graphFixture(templateId, wide);
  const originalPacket = await prepareReferenceMotionTemplateInstance(f.project, f.input, ids("original"), { prepareText: physicalText });
  const current = decodeProjectBytes(encodeProjectBytes(applyCommand(f.project, { type: "batch", commands: originalPacket.commands })));
  expect((await inspectReferenceMotionTemplateInstance(current, originalPacket.instance.id)).status).toBe("CURRENT");
  const request: ReferenceMotionTemplateReuseRequest = {
    sourceInstanceId: originalPacket.instance.id, expectedInstanceRevision: originalPacket.instance.instanceRevision,
    expectedProjectRevision: current.revision, targetClipId: "new-clip", purpose: "Fresh synthetic target story",
    evidenceRefs: ["synthetic:new-observed-content"], sources: [],
  };
  return { ...f, originalPacket, current, request };
}
type Saved = Awaited<ReturnType<typeof savedFixture>>;
type Reused = Awaited<ReturnType<typeof prepareReferenceMotionTemplateReuse>>;
const prepare = (f: Saved, request: ReferenceMotionTemplateReuseRequest = f.request) =>
  prepareReferenceMotionTemplateReuse(f.current, request, ids("reused"), { prepareText: physicalText });
const environment = () => ({ ...process.env, EDITKIN_FONT_ROOT: resolve("public/fonts") });

/** Observes actual commands and the applied graph, independently of claimed
 * status/role labels. These strike/level fixtures do not own a target clip's
 * geometry, so every pre-existing clip, track and source must stay exact. */
function observeReuse(f: Saved, packet: Reused) {
  if (packet.instance.input.clipId === f.originalPacket.instance.input.clipId) throw new Error("OBSERVED_SAME_SOURCE");
  const beforeSource = clip(f.current, f.originalPacket.instance.input.clipId), target = clip(f.current, packet.instance.input.clipId);
  const oldAsset = f.current.assets.find(asset => asset.id === beforeSource.assetId)!, newAsset = f.current.assets.find(asset => asset.id === target.assetId)!;
  if (oldAsset.id === newAsset.id || oldAsset.uri === newAsset.uri
    || oldAsset.derivatives?.sourceSha256 === newAsset.derivatives?.sourceSha256) throw new Error("OBSERVED_SAME_CONTENT");
  if (!packet.instance.input.purpose.trim() || !packet.instance.input.evidenceRefs.length
    || packet.instance.input.evidenceRefs.some(ref => f.originalPacket.instance.input.evidenceRefs.includes(ref))) throw new Error("OBSERVED_MISSING_FRESH_EVIDENCE");
  const oldIds = new Set(f.originalPacket.instance.roles.map(role => role.id));
  if (packet.instance.id === f.originalPacket.instance.id || packet.instance.roles.some(role => oldIds.has(role.id))) throw new Error("OBSERVED_REUSED_ROLE_ID");
  const applied = applyCommand(f.current, { type: "batch", commands: packet.commands });
  const previousGraphics = new Set(f.current.motionGraphics.map(graphic => graphic.id));
  const previousInstances = new Set((f.current.referenceMotionInstances ?? []).map(instance => instance.id));
  const oldProjection = (project: EditProject) => canonicalJson({ assets: project.assets, tracks: project.tracks,
    captions: project.captions, captionStyle: project.captionStyle, motionTracks: project.motionTracks, motionScenes: project.motionScenes,
    compositions: project.compositions, director: project.director, width: project.width, height: project.height, fps: project.fps,
    scene3d: project.scene3d, scene25d: project.scene25d, colorManagement: project.colorManagement,
    graphics: project.motionGraphics.filter(graphic => previousGraphics.has(graphic.id)),
    instances: project.referenceMotionInstances?.filter(instance => previousInstances.has(instance.id)) });
  if (oldProjection(f.current) !== oldProjection(applied)) throw new Error("OBSERVED_OLD_GRAPH_MUTATION");
  if (packet.instance.input.startFrame !== Math.round(target.timelineStart * f.current.fps)
    || packet.instance.input.durationFrames !== Math.round(target.duration * f.current.fps)) throw new Error("OBSERVED_TARGET_WINDOW_MISMATCH");
  return applied;
}
async function rejectsWithoutCommit(f: Saved, request: ReferenceMotionTemplateReuseRequest, cause: RegExp) {
  const before = canonicalJson(f.current);
  await expect(prepare(f, request)).rejects.toThrow(cause);
  expect(canonicalJson(f.current)).toBe(before);
}
function metadata(commands: EditorCommand[]) {
  const last = commands.at(-1);
  if (!last || last.type !== "upsert_reference_motion_instance") throw new Error("Control needs actual final instance command");
  return last;
}

describe("CURRENT saved template reused on a different existing clip", () => {
  it("physically recompiles a four-second distinct source with fresh identities and preserves the entire old graph", async () => {
    const f = await savedFixture(), before = canonicalJson(f.current), packet = await prepare(f);
    expect(packet.status).toBe("PREPARED_NOT_APPLIED"); expect(packet.readOnly).toBe(true);
    expect(canonicalJson(f.current)).toBe(before);
    const applied = observeReuse(f, packet);
    expect(packet.instance.input).toMatchObject({ clipId: "new-clip", startFrame: 120, durationFrames: 120,
      graphicCadence: "brisk", strikePresentation: "semantic_replace_v1", strikeSurface: "source_overlay" });
    expect(packet.instance.input.style).toEqual(f.originalPacket.instance.input.style);
    expect(clip(applied, "old-clip").layout).toBeDefined(); expect(clip(applied, "old-clip").floatingFrame).toBeUndefined();
    expect(clip(applied, "new-clip").floatingFrame?.schema).toBe("editkin.floating-video-frame/v2");
    expect(clip(applied, "new-clip").layout).toBeUndefined();
    expect(packet.instance.input.purpose).toBe(f.request.purpose); expect(packet.instance.input.evidenceRefs).toEqual(f.request.evidenceRefs);
    expect(packet.reusedFrom).toEqual({ sourceInstanceId: f.originalPacket.instance.id, expectedInstanceRevision: 1,
      sourceScopeSha256: f.originalPacket.instance.appliedScopeSha256 });
    expect(packet.reuseBinding).toMatchObject({ sourceInstanceId: f.originalPacket.instance.id, targetClipId: "new-clip", targetAssetId: "new-media",
      sourceStartFrame: 0, startFrame: 120, durationFrames: 120, previousQaOrArtworkApprovalReusable: false,
      sourceRights: "new_source_validation_required" });
    expect(packet.layouts.some(layout => layout.physicalFont && layout.segments.length > 0)).toBe(true);
    expect(packet.layouts.filter(layout => layout.physicalFont).every(layout => layout.segments.every(segment => segment.outline !== undefined))).toBe(true);
    expect(packet.instance.dependencies.fonts.map(face => face.faceId)).toContain("EditkinFace-noto-sans-tc-900");
    expect((await inspectReferenceMotionTemplateInstance(applied, packet.instance.id)).status).toBe("CURRENT");
    expect((await inspectReferenceMotionTemplateInstance(applied, f.originalPacket.instance.id)).status).toBe("CURRENT");
    expect(packet.commands.some(command => command.type === "batch")).toBe(false);
  });
  it("derives a distinct DAR and exact nonzero source window from the existing target rather than copying old clocks", async () => {
    const f = await savedFixture("level_bridge", true), target = clip(f.current, "new-clip");
    target.sourceStart = 1; target.duration = 3;
    const packet = await prepare(f), applied = observeReuse(f, packet);
    expect(packet.instance.input.startFrame).toBe(120); expect(packet.instance.input.durationFrames).toBe(90);
    expect(packet.reuseBinding.sourceStartFrame).toBe(30);
    expect(clip(applied, "new-clip")).toEqual(target);
    expect(applied.assets.find(asset => asset.id === "new-media")?.displayAspectRatio).toBe(16 / 9);
    expect(f.current.assets.find(asset => asset.id === "old-media")?.displayAspectRatio).toBe(9 / 16);
    expect(packet.layouts.some(layout => layout.physicalFont?.faceId === "EditkinFace-noto-sans-tc-700")).toBe(true);
  });
  it("rebuilds actual comparison planes from the new DAR while preserving all old owned content and source clocks", async () => {
    const f = await savedFixture("comparison_pair", true), before = canonicalJson(f.current);
    const packet = await prepare(f, { ...f.request,
      sources: [{ assetId: "new-secondary", sourceStart: 0, label: "NEW VIEW" }] });
    expect(canonicalJson(f.current)).toBe(before);
    const applied = applyCommand(f.current, { type: "batch", commands: packet.commands });
    expect(packet.floatingMediaBindings).toHaveLength(2);
    for (const binding of packet.floatingMediaBindings!) {
      expect(binding.floatingFrame).toMatchObject({ schema: "editkin.floating-video-frame/v2", aspect: "source", mediaFit: "contain" });
      expect(binding.layout.mediaFit).toBe("contain"); expect(binding.layout.sourceFit.cropped).toBe(false);
      expect(binding.layout.sourceContentRect.width / binding.layout.sourceContentRect.height).toBeCloseTo(16 / 9, 8);
      const actualClip = clip(applied, binding.clipId);
      expect(actualClip.floatingFrame).toEqual(binding.floatingFrame);
      expect(actualClip.assetId).toBe(binding.assetId); expect(actualClip.sourceStart).toBe(binding.sourceStart);
      expect([actualClip.timelineStart, actualClip.duration]).toEqual([4, 4]);
    }
    const oldBinding = f.originalPacket.floatingMediaBindings![0];
    expect(oldBinding.layout.sourceContentRect.width / oldBinding.layout.sourceContentRect.height).toBeCloseTo(9 / 16, 8);
    expect(packet.floatingMediaBindings![0].layout.sourceContentRect).not.toEqual(oldBinding.layout.sourceContentRect);
    const oldRoleIds = new Set(f.originalPacket.instance.roles.map(role => role.id));
    expect(packet.instance.roles.every(role => !oldRoleIds.has(role.id))).toBe(true);
    for (const track of f.current.tracks) {
      for (const prior of track.clips.filter(row => row.id !== "new-clip")) expect(clip(applied, prior.id)).toEqual(prior);
      if (f.originalPacket.instance.roles.some(role => role.kind === "track" && role.id === track.id)) {
        expect(applied.tracks.find(row => row.id === track.id)).toEqual(track);
      }
    }
    expect(applied.assets).toEqual(f.current.assets); expect(applied.captions).toEqual(f.current.captions);
    expect(applied.motionGraphics.filter(graphic => f.current.motionGraphics.some(prior => prior.id === graphic.id))).toEqual(f.current.motionGraphics);
    expect(applied.referenceMotionInstances?.find(instance => instance.id === f.originalPacket.instance.id)).toEqual(f.current.referenceMotionInstances![0]);
    const sourceWindow = (project: EditProject) => { const source = clip(project, "new-clip"); return {
      assetId: source.assetId, trackId: source.trackId, timelineStart: source.timelineStart, sourceStart: source.sourceStart,
      duration: source.duration, volume: source.volume, transform: source.transform, color: source.color,
    }; };
    expect(sourceWindow(applied)).toEqual(sourceWindow(f.current));
    const clone = packet.floatingMediaBindings!.find(binding => binding.assetId === "new-secondary")!;
    expect(clip(applied, clone.clipId).volume).toBe(0);
    const reopened = decodeProjectBytes(encodeProjectBytes(applied));
    expect((await inspectReferenceMotionTemplateInstance(reopened, packet.instance.id)).status).toBe("CURRENT");
    expect((await inspectReferenceMotionTemplateInstance(reopened, f.originalPacket.instance.id)).status).toBe("CURRENT");
  });
  it("keeps both instances CURRENT through actual byte reopen and one atomic Undo/Redo", async () => {
    const f = await savedFixture(), packet = await prepare(f), batch: EditorCommand = { type: "batch", commands: packet.commands };
    const history = dispatchCommand(createHistory(f.current), batch, "reuse-command"), reopened = decodeProjectBytes(encodeProjectBytes(history.present));
    expect(history.past).toHaveLength(1); expect(reopened.referenceMotionInstances).toHaveLength(2);
    expect((await inspectReferenceMotionTemplateInstance(reopened, f.originalPacket.instance.id)).status).toBe("CURRENT");
    expect((await inspectReferenceMotionTemplateInstance(reopened, packet.instance.id)).status).toBe("CURRENT");
    expect(reopened.motionGraphics).toEqual(history.present.motionGraphics); expect(reopened.tracks).toEqual(f.current.tracks);
    const undone = undo(history);
    expect(undone.present.motionGraphics).toEqual(f.current.motionGraphics); expect(undone.present.referenceMotionInstances).toEqual(f.current.referenceMotionInstances);
    expect(undone.present.tracks).toEqual(f.current.tracks);
    const redone = decodeProjectBytes(encodeProjectBytes(redo(undone).present));
    expect(redone.referenceMotionInstances).toEqual(reopened.referenceMotionInstances); expect(redone.motionGraphics).toEqual(reopened.motionGraphics);
  });
  it("calibrates the graph observer against a genuine old-source/audio mutation command", async () => {
    const f = await savedFixture(), packet = await prepare(f);
    expect(() => observeReuse(f, packet)).not.toThrow();
    const changed = structuredClone(packet);
    changed.commands.unshift({ type: "set_clip_volume", clipId: "old-clip", volume: .01 });
    expect(() => observeReuse(f, changed)).toThrow("OBSERVED_OLD_GRAPH_MUTATION");
    expect(clip(f.current, "old-clip").volume).toBe(.37);
  });
  it("calibrates the identity observer against reused old role IDs in actual commands and metadata", async () => {
    const f = await savedFixture(), packet = await prepare(f), changed = structuredClone(packet);
    const oldId = f.originalPacket.instance.roles.find(role => role.key === "headline")!.id;
    const newRole = changed.instance.roles.find(role => role.key === "headline")!;
    const command = changed.commands.find(row => row.type === "add_motion_graphic" && row.graphic.id === newRole.id);
    if (!command || command.type !== "add_motion_graphic") throw new Error("Identity negative needs actual headline producer");
    command.graphic.id = oldId; newRole.id = oldId; metadata(changed.commands).instance = changed.instance;
    expect(() => observeReuse(f, changed)).toThrow("OBSERVED_REUSED_ROLE_ID");
    expect(() => observeReuse(f, packet)).not.toThrow();
  });
  it("calibrates fresh evidence and distinct-content observation without accepting claimed REVIEW status", async () => {
    const f = await savedFixture(), packet = await prepare(f), missing = structuredClone(packet);
    missing.instance.input.evidenceRefs = [...f.originalPacket.instance.input.evidenceRefs]; metadata(missing.commands).instance = missing.instance;
    expect(() => observeReuse(f, missing)).toThrow("OBSERVED_MISSING_FRESH_EVIDENCE");
    const same = structuredClone(packet); same.instance.input.clipId = "old-clip"; metadata(same.commands).instance = same.instance;
    expect(() => observeReuse(f, same)).toThrow("OBSERVED_SAME_SOURCE");
    expect(() => observeReuse(f, packet)).not.toThrow();
  });
  it("requires explicit nonempty fresh purpose, evidence and source selection at the actual request schema", async () => {
    const f = await savedFixture(), before = canonicalJson(f.current);
    const raw = { ...f.request };
    for (const key of ["purpose", "evidenceRefs", "sources"] as const) {
      const absent: Record<string, unknown> = { ...raw }; delete absent[key];
      await expect(async () => prepare(f, referenceMotionTemplateReuseRequestSchema.parse(absent))).rejects.toThrow(new RegExp(key));
    }
    for (const invalid of [{ ...raw, purpose: "  " }, { ...raw, evidenceRefs: [] }, { ...raw, evidenceRefs: [""] }]) {
      await expect(async () => prepare(f, referenceMotionTemplateReuseRequestSchema.parse(invalid))).rejects.toThrow(/purpose|evidenceRefs/);
    }
    await rejectsWithoutCommit(f, { ...f.request, evidenceRefs: [...f.originalPacket.instance.input.evidenceRefs] }, /fresh|evidence|證據/i);
    expect(canonicalJson(f.current)).toBe(before);
  });
  it("requires a full explicit new additional-slot selection rather than retaining old source references", async () => {
    const f = await savedFixture("comparison_pair");
    expect(f.originalPacket.instance.input.sources).toHaveLength(1);
    await rejectsWithoutCommit(f, { ...f.request, sources: [] }, /source|素材|slot/i);
    const oldReferences = canonicalJson(f.originalPacket.instance.input.sources);
    expect(canonicalJson(f.current.referenceMotionInstances![0].input.sources)).toBe(oldReferences);
  });
  it("blocks stale project/revision, missing origin and manually changed saved scope before generating commands", async () => {
    const f = await savedFixture();
    await rejectsWithoutCommit(f, { ...f.request, expectedProjectRevision: f.current.revision + 1 }, /revision|stale|current/i);
    await rejectsWithoutCommit(f, { ...f.request, expectedInstanceRevision: 2 }, /revision|stale|current/i);
    await rejectsWithoutCommit(f, { ...f.request, sourceInstanceId: "missing-instance" }, /missing|CURRENT|current|不存在/i);
    const dirty = { ...f, current: structuredClone(f.current) }; dirty.current.motionGraphics[0].x += .01;
    expect((await inspectReferenceMotionTemplateInstance(dirty.current, f.originalPacket.instance.id)).status).toBe("EDITED");
    await rejectsWithoutCommit(dirty, dirty.request, /EDITED|CURRENT|current|scope/i);
  });
  it("blocks a missing/same target and independently locked or muted target track", async () => {
    const f = await savedFixture();
    await rejectsWithoutCommit(f, { ...f.request, targetClipId: "missing-target" }, /target|clip|missing|片段/i);
    await rejectsWithoutCommit(f, { ...f.request, targetClipId: "old-clip" }, /target|different|same|clip|片段/i);
    for (const key of ["locked", "muted"] as const) {
      const blocked = { ...f, current: structuredClone(f.current) };
      blocked.current.tracks.find(track => track.id === "new-video-track")![key] = true;
      expect((await inspectReferenceMotionTemplateInstance(blocked.current, f.originalPacket.instance.id)).status).toBe("CURRENT");
      await rejectsWithoutCommit(blocked, blocked.request, /target|locked|muted|track|片段|軌/i);
    }
  });
  it("rejects fractional timeline, source and duration frames rather than rounding an unsafe target window", async () => {
    const f = await savedFixture();
    for (const key of ["timelineStart", "sourceStart", "duration"] as const) {
      const bad = { ...f, current: structuredClone(f.current) };
      const target = clip(bad.current, "new-clip");
      // Keep the window inside the four-second asset, so the fractional-frame
      // control reaches exactFrame instead of failing earlier source bounds.
      if (key === "sourceStart") target.duration -= 1 / 30;
      target[key] += key === "duration" ? -1 / 60 : 1 / 60;
      await rejectsWithoutCommit(bad, bad.request, /frame|window|整格|影格/i);
    }
  });
  it("rejects same asset, normalized source-path aliases and pinned byte-SHA aliases as cross-content reuse", async () => {
    const f = await savedFixture();
    const sameAsset = { ...f, current: structuredClone(f.current) }; clip(sameAsset.current, "new-clip").assetId = "old-media";
    await rejectsWithoutCommit(sameAsset, sameAsset.request, /different|same|distinct|alias|素材|來源/i);
    const samePath = { ...f, current: structuredClone(f.current) };
    samePath.current.assets.find(asset => asset.id === "new-media")!.uri = f.current.assets.find(asset => asset.id === "old-media")!.uri.toUpperCase().replaceAll("/", "\\");
    await rejectsWithoutCommit(samePath, samePath.request, /different|same|distinct|alias|素材|來源/i);
    const dotSegments = { ...f, current: structuredClone(f.current) };
    dotSegments.current.assets.find(asset => asset.id === "new-media")!.uri = f.current.assets.find(asset => asset.id === "old-media")!.uri
      .replace("/motion", "/temporary/../motion");
    await rejectsWithoutCommit(dotSegments, dotSegments.request, /different|same|distinct|alias|素材|來源/i);
    const sameBytes = { ...f, current: structuredClone(f.current) };
    sameBytes.current.assets.find(asset => asset.id === "new-media")!.derivatives = { sourceSha256: SOURCE_SHA, generatedAt: SYNTHETIC_GENERATED_AT };
    await rejectsWithoutCommit(sameBytes, sameBytes.request, /different|same|distinct|alias|SHA|素材|來源/i);
  });
  it("blocks existing Motion overlap and a colliding ID factory without altering original owners", async () => {
    const f = await savedFixture(), overlap = { ...f, current: structuredClone(f.current) };
    clip(overlap.current, "new-clip").timelineStart = 0;
    await rejectsWithoutCommit(overlap, overlap.request, /Motion|overlap|重疊/i);
    const before = canonicalJson(f.current);
    await expect(prepareReferenceMotionTemplateReuse(f.current, f.request, () => f.originalPacket.instance.id,
      { prepareText: physicalText })).rejects.toThrow(/collid|identity|invalid/i);
    expect(canonicalJson(f.current)).toBe(before);
  });
  it("blocks short target or out-of-source windows and genuine physical copy overflow without committing", async () => {
    const f = await savedFixture(), short = { ...f, current: structuredClone(f.current) };
    clip(short.current, "new-clip").duration = 3;
    await rejectsWithoutCommit(short, short.request, /short|range|duration|閱讀|停留|範圍/i);
    const outside = { ...f, current: structuredClone(f.current) }; clip(outside.current, "new-clip").sourceStart = 1;
    await rejectsWithoutCommit(outside, outside.request, /source|range|window|length|長度|來源|時長/i);
    const over = await savedFixture("comparison_pair"), before = canonicalJson(over.current);
    const overflowRequest: ReferenceMotionTemplateReuseRequest = { ...over.request,
      sources: [{ assetId: "new-secondary", sourceStart: 0, label: "一二三四五六七八九十一二三四五六七八九十" }] };
    let preparedLabel = false;
    await expect(prepareReferenceMotionTemplateReuse(over.current, overflowRequest, ids("overflow-target"), {
      prepareText: async (faceId, text) => {
        const run = await physicalText(faceId, text);
        if (text === overflowRequest.sources[0].label) preparedLabel = true;
        return run;
      },
    })).rejects.toThrow(/實體 glyph|safe-area|auto-fit/);
    // Twenty real Han glyphs cannot fit the unchanged one-line comparison
    // slot at its actual 34px font floor. Their read time still fits four
    // seconds; this is physical geometry, not an early short-window rejection.
    expect(preparedLabel).toBe(true); expect(canonicalJson(over.current)).toBe(before);
  });
  it("requires real available glyphs and honours cancellation during genuine font preparation", async () => {
    const latin = graphFixture("comparison_pair"); latin.input.title = "FOCUS";
    latin.input.style.typography = { headingFamily: "Bebas Neue", bodyFamily: "Bebas Neue" };
    const old = await prepareReferenceMotionTemplateInstance(latin.project, latin.input, ids("latin-source"), { prepareText: physicalText });
    const current = applyCommand(latin.project, { type: "batch", commands: old.commands });
    const before = canonicalJson(current), request: ReferenceMotionTemplateReuseRequest = {
      sourceInstanceId: old.instance.id, expectedInstanceRevision: 1, expectedProjectRevision: current.revision,
      targetClipId: "new-clip", purpose: "Fresh glyph target", evidenceRefs: ["synthetic:latin-target"],
      sources: [{ assetId: "new-secondary", sourceStart: 0, label: "字" }],
    };
    // The actual newly selected slot label asks the real Latin-only physical
    // face for Han ink. The provider receives unmodified production text.
    await expect(prepareReferenceMotionTemplateReuse(current, request, ids("missing-glyph"),
      { prepareText: physicalText })).rejects.toThrow(/MISSING_GLYPH|no exact glyph/);
    expect(canonicalJson(current)).toBe(before);
    const f = await savedFixture(), untouched = canonicalJson(f.current), controller = new AbortController();
    await expect(prepareReferenceMotionTemplateReuse(f.current, f.request, ids("cancelled"), { signal: controller.signal,
      prepareText: async (faceId, text) => { const run = await physicalText(faceId, text); controller.abort(); return run; },
    })).rejects.toThrow(/cancel|abort/i);
    expect(canonicalJson(f.current)).toBe(untouched);
  });
  it("rejects request or current target drift during physical preparation without adding new graph state", async () => {
    for (const mutation of ["request", "project"] as const) {
      const f = await savedFixture(), originalGraphics = structuredClone(f.current.motionGraphics), originalInstances = structuredClone(f.current.referenceMotionInstances);
      let changed = false;
      await expect(prepareReferenceMotionTemplateReuse(f.current, f.request, ids(`drift-${mutation}`), { prepareText: async (faceId, text) => {
        const run = await physicalText(faceId, text);
        if (!changed) { changed = true; if (mutation === "request") f.request.purpose = "Changed mid preparation"; else clip(f.current, "new-clip").volume = .11; }
        return run;
      } })).rejects.toThrow(/changed|drift|generation|current/i);
      expect(changed).toBe(true); expect(f.current.motionGraphics).toEqual(originalGraphics); expect(f.current.referenceMotionInstances).toEqual(originalInstances);
    }
  });
  it("uses the real v4 reuse-origin recompile and rejects origin, palette and caller-data tampering", async () => {
    const f = await savedFixture(), packet = await prepare(f), before = canonicalJson(f.current);
    const verified = await verifyReferenceMotionPlan(packet.planDeclaration, f.current, packet.commands, environment());
    expect(verified.instanceCount).toBe(1); expect([...verified.indexes]).toEqual(packet.planDeclaration.instances[0].commandIndexes);
    const wrongOrigin = structuredClone(packet.planDeclaration);
    wrongOrigin.instances[0].reuseOrigin.sourceScopeSha256 = "0".repeat(64);
    await expect(verifyReferenceMotionPlan(wrongOrigin, f.current, packet.commands, environment())).rejects.toThrow(/scope|origin/i);
    const wrongRevision = structuredClone(packet.planDeclaration); wrongRevision.instances[0].reuseOrigin.expectedInstanceRevision++;
    await expect(verifyReferenceMotionPlan(wrongRevision, f.current, packet.commands, environment())).rejects.toThrow(/revision|current|stale/i);
    const palette = structuredClone(packet.commands); metadata(palette).instance.input.style.palette.accent = "#0B3B95";
    await expect(verifyReferenceMotionPlan(packet.planDeclaration, f.current, palette, environment())).rejects.toThrow(/independently recompiled/);
    const caller = structuredClone(packet.commands), headline = caller.find(command => command.type === "add_motion_graphic" && command.graphic.text === "NEW");
    if (!headline || headline.type !== "add_motion_graphic") throw new Error("V4 tamper needs actual new headline command");
    headline.graphic.x += .05;
    await expect(verifyReferenceMotionPlan(packet.planDeclaration, f.current, caller, environment())).rejects.toThrow(/independently recompiled/);
    const oldMutation: EditorCommand[] = [{ type: "set_clip_volume", clipId: "old-clip", volume: .01 }, ...structuredClone(packet.commands)];
    // A source-audio edit is outside this create producer and cannot earn reuse
    // graph preservation. The observer rejects it even if ordinary v4 permits
    // independently declared audio work elsewhere in a broader plan.
    expect(() => observeReuse(f, { ...packet, commands: oldMutation })).toThrow("OBSERVED_OLD_GRAPH_MUTATION");
    expect(canonicalJson(f.current)).toBe(before);
  }, 30000);
});
