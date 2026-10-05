import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createEmptyProject } from "../domain/editGraph";
import { applyCommand } from "../domain/commands";
import { createHistory, dispatchCommand, redo, undo } from "../domain/history";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject } from "../domain/types";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { prepareGlyphRun } from "../typography/preparedGlyphRun";
import { DEFAULT_REFERENCE_MOTION_STYLE, type ReferenceMotionTemplateInput } from "../motion/referenceMotionTemplates";
import { canonicalJson } from "../shared/canonicalJson";
import { decodeProjectBytes, encodeProjectBytes } from "./projectCodec";
import { inspectReferenceMotionTemplateInstance, prepareReferenceMotionTemplateInstance } from "./referenceMotionTemplateInstances";
import { prepareReferenceMotionMediaRelink } from "./referenceMotionMediaRelink";

// Pure graph controls use explicit synthetic media metadata, never fake physical
// source verification. The saved compiler and glyph bytes below are production.
const faces = new Map<string, Uint8Array>();
async function physicalText(faceId: string, text: string) {
  let bytes = faces.get(faceId);
  if (!bytes) {
    if (faces.size >= 8) throw new Error("Unexpected physical face count in the bounded relocation fixture");
    bytes = new Uint8Array(await readFile(join(resolve("public/fonts"), bundledFontFaceSpec(faceId).fontFile)));
    faces.set(faceId, bytes);
  }
  return prepareGlyphRun(faceId, text, bytes);
}
const SHA = "2".repeat(64), RELOCATED = "D:/portable-workspace/same-byte-source.mp4";
function ids() { let next = 0; return (prefix: string, role?: string) => `${prefix}-${role?.replaceAll(":", "-")}-${next++}`; }
const makeId = ids();
function ordinary() {
  const project = createEmptyProject("Synthetic same-byte relocation", { id: "relink-project", width: 1080, height: 1920, fps: 30 });
  project.assets = Array.from({ length: 3 }, (_, index) => ({ id: `asset-${index}`, name: `Synthetic source ${index}`, kind: "video" as const,
    uri: `D:/old-workspace/source-${index}.mp4`, duration: 32, width: index === 0 ? 1280 : 720, height: index === 0 ? 720 : 1280,
    displayAspectRatio: index === 0 ? 16 / 9 : 9 / 16, color: { interpretation: "rec709" as const },
    provenance: "Synthetic graph metadata; no source-file, rights, art or render assertion",
    derivatives: { sourceSha256: String(index + 1).repeat(64), generatedAt: "2026-10-03T00:00:00.000Z",
      proxyUri: `D:/old-cache/source-${index}.mp4`, thumbnailUri: `D:/old-cache/source-${index}.png` } }));
  project.tracks[0].clips = project.assets.map((asset, index) => ({ id: `primary-${index}`, assetId: asset.id,
    trackId: project.tracks[0].id, timelineStart: index * 8, sourceStart: index + 2, duration: 8, volume: .37 + index * .1,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] }));
  project.captions.push({ id: "unrelated-caption", text: "KEEP", start: 22, duration: 1 });
  return project;
}
function input(templateId: ReferenceMotionTemplateInput["templateId"], index: number): ReferenceMotionTemplateInput {
  return { templateId, clipId: `primary-${index}`, startFrame: index * 240, durationFrames: 240,
    title: "FOCUS", previousText: "OLD", kicker: "MOTION", subtitle: "READ FIRST", primaryLabel: "MAIN",
    sources: templateId === "comparison_pair" ? [{ assetId: "asset-1", sourceStart: 3, label: "SECOND" }] : [],
    ...(templateId === "comparison_pair" ? { mediaPresentation: "source_soft_v2" as const } : {}),
    intent: "standalone_showcase", purpose: "Synthetic saved source relocation; no media or product art assertion", evidenceRefs: ["synthetic:relink"],
    style: { ...structuredClone(DEFAULT_REFERENCE_MOTION_STYLE), typography: { headingFamily: "Bebas Neue", bodyFamily: "Bebas Neue" } } };
}
let savedBaseline: Promise<EditProject> | undefined;
async function saved(): Promise<EditProject> {
  savedBaseline ??= (async () => {
    let project = ordinary();
    for (const [template, index] of [["comparison_pair", 0], ["strike_reframe", 1], ["level_bridge", 2]] as const) {
      const prepared = await prepareReferenceMotionTemplateInstance(project, input(template, index), makeId, { prepareText: physicalText });
      project = applyCommand(project, { type: "batch", commands: prepared.commands });
    }
    // Exercise the same byte codec as saved files, including normalized defaults.
    return decodeProjectBytes(encodeProjectBytes(project));
  })();
  return structuredClone(await savedBaseline);
}
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
function visualAndClocks(project: EditProject) {
  return { tracks: project.tracks, compositions: project.compositions, captions: project.captions, captionStyle: project.captionStyle,
    motionGraphics: project.motionGraphics, motionTracks: project.motionTracks, motionScenes: project.motionScenes,
    width: project.width, height: project.height, fps: project.fps, scene3d: project.scene3d, scene25d: project.scene25d };
}
afterEach(() => vi.restoreAllMocks());

describe("explicit saved same-byte media relocation graph producer", () => {
  it("atomically rebinds both a secondary and a primary saved scope without changing physical glyphs, role IDs or clocks", async () => {
    const project = await saved(), before = canonicalJson(project), prepared = await prepareReferenceMotionMediaRelink(project, "asset-1", RELOCATED, SHA);
    expect(canonicalJson(project)).toBe(before);
    expect(prepared).toMatchObject({ status: "PREPARED_NOT_APPLIED", readOnly: true,
      sourceGeneration: { projectId: project.id, projectRevision: project.revision, projectSha256: digest(project) },
      binding: { assetId: "asset-1", previousUri: project.assets[1].uri, sourceUri: RELOCATED, expectedSourceSha256: SHA } });
    expect(prepared.commands[0]).toEqual({ type: "relink_asset_source", assetId: "asset-1", sourceUri: RELOCATED, expectedSourceSha256: SHA });
    expect(prepared.commands).toHaveLength(3);
    expect(prepared.commands.every(command => command.type === "relink_asset_source" || command.type === "upsert_reference_motion_instance")).toBe(true);
    expect(prepared.affectedInstances.map(row => row.instanceId)).toEqual(project.referenceMotionInstances!.slice(0, 2).map(instance => instance.id));
    const history = dispatchCommand(createHistory(project), { type: "batch", commands: prepared.commands });
    expect(history.past).toHaveLength(1);
    expect(visualAndClocks(history.present)).toEqual(visualAndClocks(project));
    expect(history.present.assets[1].uri).toBe(RELOCATED);
    expect(history.present.assets[1].derivatives?.sourceSha256).toBe(SHA);
    expect(history.present.assets[1].derivatives?.proxyUri).toBeUndefined();
    expect(history.present.assets[1].derivatives?.thumbnailUri).toBeUndefined();
    for (const row of prepared.affectedInstances) {
      expect(row.after.instanceRevision).toBe(row.expectedInstanceRevision + 1);
      expect(row.after.appliedScopeSha256).not.toBe(row.before.appliedScopeSha256);
      expect({ ...row.after, instanceRevision: row.before.instanceRevision, appliedScopeSha256: row.before.appliedScopeSha256 }).toEqual(row.before);
      expect((await inspectReferenceMotionTemplateInstance(history.present, row.instanceId)).status).toBe("CURRENT");
    }
    expect(history.present.referenceMotionInstances![2]).toEqual(project.referenceMotionInstances![2]);
    expect(history.present.assets[0]).toEqual(project.assets[0]); expect(history.present.assets[2]).toEqual(project.assets[2]);
    const secondary = history.present.tracks.flatMap(track => track.clips).find(clip => clip.id === project.referenceMotionInstances![0].roles.find(role => role.key === "source:1:clip")!.id)!;
    expect(secondary.volume).toBe(0);
    expect(history.present.tracks.flatMap(track => track.clips).find(clip => clip.id === "primary-1")!.volume).toBeCloseTo(.47);
    const reopened = decodeProjectBytes(encodeProjectBytes(history.present));
    expect(reopened.assets[1].uri).toBe(RELOCATED);
    expect(visualAndClocks(reopened)).toEqual(visualAndClocks(project));
    for (const instance of reopened.referenceMotionInstances!) expect((await inspectReferenceMotionTemplateInstance(reopened, instance.id)).status).toBe("CURRENT");
    expect(undo(history).present).toEqual(project);
    expect(redo(undo(history)).present).toEqual(history.present);
    const committed = canonicalJson(history.present);
    expect(() => applyCommand(history.present, { type: "batch", commands: prepared.commands })).toThrow(/revision is stale/);
    expect(canonicalJson(history.present)).toBe(committed);
  });

  it("keeps URI in the saved scope and refuses to legitimize a manual URI edit", async () => {
    const project = await saved(); project.assets[1].uri = "D:/manual-unverified/source.mp4";
    const before = canonicalJson(project);
    expect((await inspectReferenceMotionTemplateInstance(project, project.referenceMotionInstances![0].id)).status).toBe("EDITED");
    await expect(prepareReferenceMotionMediaRelink(project, "asset-1", RELOCATED, SHA)).rejects.toThrow(/EDITED/);
    expect(canonicalJson(project)).toBe(before);
  });

  it("rejects manually edited managed graphics, missing roles and changed recipe dependencies before returning any batch", async () => {
    for (const cause of ["edited", "missing", "missing-primary", "environment"] as const) {
      const project = await saved(), instance = project.referenceMotionInstances![1];
      if (cause === "edited") project.motionGraphics.find(graphic => graphic.id === instance.roles.find(role => role.kind === "graphic")!.id)!.name = "MANUAL";
      else if (cause === "missing") project.motionGraphics = project.motionGraphics.filter(graphic => graphic.id !== instance.roles.find(role => role.kind === "graphic")!.id);
      else if (cause === "missing-primary") project.tracks[0].clips = project.tracks[0].clips.filter(clip => clip.id !== instance.input.clipId);
      else instance.dependencies.recipeVersion = "unverified-recipe";
      const before = canonicalJson(project);
      await expect(prepareReferenceMotionMediaRelink(project, "asset-1", RELOCATED, SHA)).rejects.toThrow(cause === "environment" ? /ENVIRONMENT_CHANGED/ : cause === "missing" || cause === "missing-primary" ? /MISSING/ : /EDITED/);
      expect(canonicalJson(project)).toBe(before);
    }
  });

  it("returns a real no-op for the current URI without revising saved metadata or adding Undo commands", async () => {
    const project = await saved(), before = canonicalJson(project);
    const prepared = await prepareReferenceMotionMediaRelink(project, "asset-1", project.assets[1].uri, SHA);
    expect(prepared.status).toBe("UNCHANGED"); expect(prepared.commands).toEqual([]);
    expect(prepared.affectedInstances.every(row => canonicalJson(row.before) === canonicalJson(row.after))).toBe(true);
    expect(canonicalJson(project)).toBe(before);
  });

  it("rejects an external clip added to a generated source track rather than refreshing its ownership hash", async () => {
    const project = await saved(), instance = project.referenceMotionInstances![0];
    const trackRole = instance.roles.find(role => role.key === "source:1:track")!;
    const track = project.tracks.find(value => value.id === trackRole.id)!;
    track.clips.push({ ...structuredClone(project.tracks[0].clips.find(clip => clip.id === "primary-2")!),
      id: "external-clip", trackId: track.id, timelineStart: 24, sourceStart: 1, duration: 1 });
    const before = canonicalJson(project);
    await expect(prepareReferenceMotionMediaRelink(project, "asset-1", RELOCATED, SHA)).rejects.toThrow(/EDITED/);
    expect(canonicalJson(project)).toBe(before);
  });

  it("rejects an unknown or different pinned source and an unsupported virtual/image asset", async () => {
    const missing = ordinary(); delete missing.assets[1].derivatives;
    await expect(prepareReferenceMotionMediaRelink(missing, "asset-1", RELOCATED, SHA)).rejects.toThrow(/pinned source/);
    const project = ordinary(), before = canonicalJson(project);
    await expect(prepareReferenceMotionMediaRelink(project, "asset-1", RELOCATED, "f".repeat(64))).rejects.toThrow(/pinned source/);
    await expect(prepareReferenceMotionMediaRelink(project, "asset-1", RELOCATED, "not-a-sha")).rejects.toThrow(/previously pinned/);
    for (const uri of ["relative/source.mp4", "https://example.invalid/source.mp4", "\\\\remote\\share\\source.mp4"]) {
      await expect(prepareReferenceMotionMediaRelink(project, "asset-1", uri, SHA)).rejects.toThrow(/absolute local/);
    }
    expect(canonicalJson(project)).toBe(before);
    const virtual = ordinary(); virtual.assets[1].uri = "creative://synthetic";
    await expect(prepareReferenceMotionMediaRelink(virtual, "asset-1", RELOCATED, SHA)).rejects.toThrow(/single-file video\/audio/);
    const image = ordinary(); image.tracks[0].clips = image.tracks[0].clips.filter(clip => clip.assetId !== "asset-1"); image.assets[1].kind = "image";
    await expect(prepareReferenceMotionMediaRelink(image, "asset-1", "D:/portable-workspace/source.png", SHA)).rejects.toThrow(/single-file video\/audio/);
  });

  it("supports an ordinary audio URI relocation with its volume, clocks and rights unchanged", async () => {
    const project = createEmptyProject("Synthetic audio relocation", { fps: 30 });
    project.assets = [{ id: "audio", kind: "audio", name: "Synthetic audio metadata", uri: "D:/old/source.wav", duration: 12,
      provenance: "Synthetic graph fixture", rightsBasis: "Test metadata only", derivatives: { sourceSha256: SHA, generatedAt: "2026-10-03T00:00:00.000Z" } }];
    project.tracks[1].clips = [{ id: "audio-clip", assetId: "audio", trackId: project.tracks[1].id, timelineStart: 1, sourceStart: 2,
      duration: 8, volume: .42, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] }];
    const normalized = decodeProjectBytes(encodeProjectBytes(project));
    const prepared = await prepareReferenceMotionMediaRelink(normalized, "audio", "D:/portable-workspace/source.wav", SHA);
    expect(prepared.affectedInstances).toEqual([]); expect(prepared.commands).toHaveLength(1);
    const applied = applyCommand(normalized, { type: "batch", commands: prepared.commands });
    expect(applied.tracks).toEqual(normalized.tracks);
    expect({ ...applied.assets[0], uri: normalized.assets[0].uri }).toEqual(normalized.assets[0]);
  });

  it("detects project mutation while the actual asynchronous canonical SHA is being computed", async () => {
    const project = await saved(), originalDigest = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(async (algorithm, bytes) => {
      const result = await originalDigest(algorithm, bytes); project.name = "A later content owner"; return result;
    });
    await expect(prepareReferenceMotionMediaRelink(project, "asset-1", RELOCATED, SHA)).rejects.toThrow(/project changed during preparation/);
    expect(project.assets[1].uri).not.toBe(RELOCATED);
    expect(project.referenceMotionInstances!.every(instance => instance.instanceRevision === 1)).toBe(true);
  });

  it("does not use relocation to refresh a manually edited no-op target", async () => {
    const project = await saved(); project.assets[1].uri = RELOCATED;
    await expect(prepareReferenceMotionMediaRelink(project, "asset-1", RELOCATED, SHA)).rejects.toThrow(/EDITED/);
  });
});
