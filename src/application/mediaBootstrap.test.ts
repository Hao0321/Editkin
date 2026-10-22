import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyCommand } from "../domain/commands";
import { createEmptyProject, findClip, validateProject } from "../domain/editGraph";
import { editorCommandSchema } from "../domain/schema";
import { DEFAULT_CLIP_LAYER, DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject } from "../domain/types";
import type { MediaProbe } from "../render/ffmpegContracts";
import { sha256Canonical } from "./autopilotInvocationIdentity";
import { prepareMediaBootstrap, type MediaBootstrapRequest, type MediaBootstrapRuntime } from "./mediaBootstrap";
import { planTimelineAssetInsert } from "./timelinePlacement";

// These are synthetic bytes with an explicit injected probe, never an actual media/decode claim.
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(async root => {
  const target = resolve(root);
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("editkin-media-bootstrap-")) throw new Error("Refusing cleanup outside this test's owned temporary roots");
  await rm(target, { recursive: true, force: true });
})); });
const now = () => new Date("2026-10-03T00:00:00.000Z");
const knownProbe: MediaProbe = { duration: 8, width: 540, height: 960, encodedWidth: 540, encodedHeight: 960,
  sampleAspectRatio: 1, displayAspectRatio: 9 / 16, hasVideo: true, hasAudio: true,
  colorPrimaries: "bt709", colorTransfer: "bt709", colorMatrix: "bt709", colorRange: "tv" };

async function fixture(fps = 30) {
  const root = await mkdtemp(join(tmpdir(), "editkin-media-bootstrap-")); roots.push(root);
  const sourcePath = join(root, "owned-source.bin"), bytes = Buffer.from("neutral bootstrap synthetic byte identity\n");
  await writeFile(sourcePath, bytes);
  const project = createEmptyProject("Source ingress", { id: "ingress-current", width: 1080, height: 1920, fps });
  const request: MediaBootstrapRequest = { sourcePath, assetId: "ingress-asset", clipId: "ingress-clip", trackId: "video-main",
    timelineStartFrame: 0, sourceStartFrame: 120, durationFrames: 120,
    rights: { provenance: "task-owned synthetic fixture", rightsBasis: "caller original declaration", distributionScope: "private preview" } };
  const runtime: MediaBootstrapRuntime = { workspaceRoot: root, readCurrentProject: async () => structuredClone(project) };
  return { root, sourcePath, bytes, project, request, runtime };
}

function applyPrepared(project: EditProject, commands: Awaited<ReturnType<typeof prepareMediaBootstrap>>["commands"]) {
  return commands.reduce((draft, command) => applyCommand(draft, command), project);
}

describe("high-level read-only ordinary media bootstrap", () => {
  it("repairs the actual missing-generatedAt shape through the typed producer while the original raw command stays invalid", async () => {
    const f = await fixture(), before = structuredClone(f.project), digest = createHash("sha256").update(f.bytes).digest("hex");
    const result = await prepareMediaBootstrap(f.project, f.request, f.runtime, { inspect: async () => knownProbe, now });
    expect(result.status).toBe("PREPARED_NOT_APPLIED"); expect(result.readOnly).toBe(true);
    expect(result.commands.map(command => command.type)).toEqual(["import_asset", "add_clip"]);
    for (const command of result.commands) expect(editorCommandSchema.safeParse(command).success).toBe(true);
    expect(result.binding.project).toEqual({ id: before.id, revision: before.revision, sha256: sha256Canonical(before) });
    expect(result.binding.source).toEqual({ path: await realpath(f.sourcePath), bytes: f.bytes.length, sha256: digest });
    const edited = applyPrepared(f.project, result.commands), asset = edited.assets[0], clip = findClip(edited, f.request.clipId);
    expect(asset).toMatchObject({ duration: 8, width: 540, height: 960, displayAspectRatio: 9 / 16,
      derivatives: { sourceSha256: digest, generatedAt: now().toISOString() }, provenance: f.request.rights!.provenance });
    expect(asset.redistributable).toBeUndefined();
    expect(result.rights).toEqual({ state: "CALLER_DECLARED_NOT_VERIFIED", declaration: f.request.rights });
    expect(clip).toMatchObject({ sourceStart: 4, duration: 4, timelineStart: 0, volume: 1,
      transform: DEFAULT_TRANSFORM, color: DEFAULT_COLOR, keyframes: [] });
    expect(f.project).toEqual(before);
    const rawMissingDate = { type: "import_asset", asset: { ...asset, derivatives: { sourceSha256: digest } } };
    expect(editorCommandSchema.safeParse(rawMissingDate).success).toBe(false);
    validateProject(edited);
  });

  it("checks a source window before collision while the omitted legacy planner still uses full source duration", async () => {
    const f = await fixture();
    f.project.assets.push({ id: "existing", name: "Existing", kind: "video", uri: "existing.bin", duration: 8 });
    f.project.tracks[0].clips.push({ id: "touching", assetId: "existing", trackId: "video-main", timelineStart: 4,
      sourceStart: 0, duration: 4, volume: .4, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [],
      layer: { ...DEFAULT_CLIP_LAYER }, expressions: {} });
    const before = structuredClone(f.project);
    const result = await prepareMediaBootstrap(f.project, f.request, f.runtime, { inspect: async () => knownProbe, now });
    expect(result.binding.actualTrackId).toBe("video-main");
    const edited = applyPrepared(f.project, result.commands);
    expect(findClip(edited, "touching")).toEqual(findClip(before, "touching"));
    expect(findClip(edited, f.request.clipId)).toMatchObject({ sourceStart: 4, duration: 4, trackId: "video-main" });
    const imported = applyCommand(before, result.commands[0]);
    const windowed = planTimelineAssetInsert(imported, f.request.assetId, "video-main", 0, "desktop-window", () => "unused", { sourceStart: 4, duration: 4 });
    expect(windowed.newLayer).toBe(false);
    const legacy = planTimelineAssetInsert(imported, f.request.assetId, "video-main", 0, "desktop-full", () => "legacy-layer");
    expect(legacy.newLayer).toBe(true);
    expect(findClip(applyCommand(imported, legacy.command), "desktop-full")).toMatchObject({ sourceStart: 0, duration: 8 });
    expect(f.project).toEqual(before);
  });

  it("retains fractional project clocks and explicit audio windows without assuming a source frame rate", async () => {
    const fps = 30_000 / 1_001, f = await fixture(fps);
    f.project.tracks[1].muted = true;
    const request = { ...f.request, trackId: "audio-main", timelineStartFrame: 237, sourceStartFrame: 90, durationFrames: 120 };
    const probe: MediaProbe = { duration: 8.008, hasVideo: false, hasAudio: true };
    const result = await prepareMediaBootstrap(f.project, request, f.runtime, { inspect: async () => probe, now });
    const edited = applyPrepared(f.project, result.commands), clip = findClip(edited, request.clipId);
    expect(edited.fps).toBe(fps); expect(clip.sourceStart).toBe(90 / fps);
    expect(clip.duration).toBe(120 / fps); expect(clip.timelineStart).toBe(237 / fps);
    expect(edited.tracks[1].muted).toBe(true); expect(edited.assets[0].kind).toBe("audio");
    expect(result.binding.sourceWindow.fps).toBe(fps); expect(result.probe).toEqual(probe);
  });

  it("flattens a real collision layer and keeps deterministic IDs, source trims and target mute", async () => {
    const f = await fixture(); f.project.tracks[0].muted = true;
    f.project.assets.push({ id: "existing", name: "Old", kind: "video", uri: "old.bin", duration: 8 });
    f.project.tracks[0].clips.push({ id: "old", assetId: "existing", trackId: "video-main", timelineStart: 1,
      sourceStart: 0, duration: 2, volume: .5, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] });
    const first = await prepareMediaBootstrap(f.project, f.request, f.runtime, { inspect: async () => knownProbe, now });
    const second = await prepareMediaBootstrap(f.project, f.request, f.runtime, { inspect: async () => knownProbe, now });
    expect(first.commands).toEqual(second.commands);
    expect(first.commands.map(command => command.type)).toEqual(["import_asset", "add_track", "add_clip"]);
    const edited = applyPrepared(f.project, first.commands);
    expect(edited.tracks.at(-1)).toMatchObject({ id: first.binding.actualTrackId, muted: true, kind: "video" });
    expect(findClip(edited, f.request.clipId)).toMatchObject({ sourceStart: 4, duration: 4 });
  });

  it("rejects forbidden nested command/visual/rights-authority carriers before any probe", async () => {
    const f = await fixture(), inspect = vi.fn(async () => knownProbe);
    for (const extra of [{ clip: {} }, { commands: [] }, { transform: DEFAULT_TRANSFORM }, { color: DEFAULT_COLOR },
      { motion: {} }, { rights: { ...f.request.rights!, verified: true } }]) {
      await expect(prepareMediaBootstrap(f.project, { ...f.request, ...extra }, f.runtime, { inspect, now })).rejects.toThrow();
    }
    expect(inspect).not.toHaveBeenCalled();
  });

  it("rejects invalid/inexact frame clocks, source overflow, locked tracks and incompatible targets with no graph changes", async () => {
    const f = await fixture(), before = structuredClone(f.project);
    for (const patch of [{ sourceStartFrame: -1 }, { timelineStartFrame: .5 }, { durationFrames: 0 },
      { durationFrames: NaN }, { timelineStartFrame: Number.MAX_SAFE_INTEGER }, { durationFrames: 121 },
      { trackId: "audio-main" }, { trackId: "caption-main" }, { trackId: "deleted" }]) {
      await expect(prepareMediaBootstrap(f.project, { ...f.request, ...patch }, f.runtime, { inspect: async () => knownProbe, now })).rejects.toThrow();
    }
    f.project.tracks[0].locked = true;
    await expect(prepareMediaBootstrap(f.project, f.request, f.runtime, { inspect: async () => knownProbe, now })).rejects.toThrow(/鎖定/);
    f.project.tracks[0].locked = false;
    expect(f.project).toEqual(before);
    const imported = applyCommand(f.project, { type: "import_asset", asset: { id: "window", name: "Window", kind: "video", uri: "window.bin", duration: 8 } });
    expect(() => planTimelineAssetInsert(imported, "window", "video-main", 0, "bad-window", () => "unused", { sourceStart: .01, duration: 4 })).toThrow(/整數/);
  });

  it("rejects nonregular, outside, network and multi-file sources before ordinary probing", async () => {
    const f = await fixture(), outside = await fixture(), inspect = vi.fn(async () => knownProbe);
    const empty = join(f.root, "empty.bin"), manifest = join(f.root, "sequence.json");
    await writeFile(empty, ""); await writeFile(manifest, "{}");
    for (const path of [f.root, empty, join(f.root, "missing.bin"), outside.sourcePath, manifest]) {
      await expect(prepareMediaBootstrap(f.project, { ...f.request, sourcePath: path }, f.runtime, { inspect, now })).rejects.toThrow();
    }
    expect(inspect).not.toHaveBeenCalled();
    const alias = join(f.root, "outside-alias");
    await symlink(outside.root, alias, process.platform === "win32" ? "junction" : "dir");
    await expect(prepareMediaBootstrap(f.project, { ...f.request, sourcePath: join(alias, "owned-source.bin") }, f.runtime, { inspect, now })).rejects.toThrow(/workspace/);
    if (process.platform === "win32") {
      await expect(prepareMediaBootstrap(f.project, { ...f.request, sourcePath: "\\\\untrusted-host\\share\\source.mp4" }, f.runtime, { inspect, now })).rejects.toThrow(/網路共用/);
    }
    expect(inspect).not.toHaveBeenCalled();
  });

  it("detects actual source byte drift during the controlled probe and project epoch drift at final readback", async () => {
    const f = await fixture(), before = structuredClone(f.project);
    await expect(prepareMediaBootstrap(f.project, f.request, f.runtime, { inspect: async () => {
      await writeFile(f.sourcePath, Buffer.from("changed actual fixture bytes")); return knownProbe;
    }, now })).rejects.toThrow(/來源.*改變/);
    expect(f.project).toEqual(before);
    await writeFile(f.sourcePath, f.bytes);
    await expect(prepareMediaBootstrap(f.project, f.request, { ...f.runtime,
      readCurrentProject: async () => ({ ...structuredClone(f.project), revision: f.project.revision + 1 }) },
    { inspect: async () => knownProbe, now })).rejects.toThrow(/專案.*改變/);
    expect(f.project).toEqual(before);
    await expect(prepareMediaBootstrap(f.project, f.request, { ...f.runtime, readCurrentProject: async () => {
      await writeFile(f.sourcePath, Buffer.from("source changed during final project read")); return structuredClone(f.project);
    } }, { inspect: async () => knownProbe, now })).rejects.toThrow(/來源.*改變/);
    expect(f.project).toEqual(before);
  });

  it("rejects hash/probe failure and cancellation instead of returning a partial preparation", async () => {
    const f = await fixture(), inspect = vi.fn(async () => knownProbe);
    await expect(prepareMediaBootstrap(f.project, f.request, f.runtime, { inspect, hashFile: async () => "not-a-hash", now })).rejects.toThrow(/SHA-256/);
    expect(inspect).not.toHaveBeenCalled();
    await expect(prepareMediaBootstrap(f.project, f.request, f.runtime, { inspect: async () => { throw new Error("actual controlled probe failure"); }, now })).rejects.toThrow(/probe failure/);
    const controller = new AbortController(); controller.abort(new Error("owned cancelled"));
    await expect(prepareMediaBootstrap(f.project, f.request, { ...f.runtime, signal: controller.signal }, { inspect, now })).rejects.toThrow(/cancelled/);
    expect(inspect).not.toHaveBeenCalled();
  });

  it("does not invent square pixels, silently accept a multi-file packet or reuse duplicate IDs", async () => {
    const f = await fixture();
    const unknownSar = { ...knownProbe, sampleAspectRatio: undefined, displayAspectRatio: undefined };
    const result = await prepareMediaBootstrap(f.project, f.request, f.runtime, { inspect: async () => unknownSar, now });
    const edited = applyPrepared(f.project, result.commands);
    expect(edited.assets[0].displayAspectRatio).toBeUndefined(); expect(result.warnings.some(value => value.includes("SAR"))).toBe(true);
    expect(edited.assets[0].color?.interpretation).toBe("auto");
    const declared = await prepareMediaBootstrap(f.project, { ...f.request, sourceColorInterpretation: "rec709" }, f.runtime, { inspect: async () => knownProbe, now });
    expect(applyPrepared(f.project, declared.commands).assets[0].color).toMatchObject({ interpretation: "rec709", primaries: "bt709" });
    expect(declared.binding.sourceColorInterpretation).toEqual({ value: "rec709", declaration: "CALLER_SOURCE_INTERPRETATION_NOT_COLOR_VERIFIED" });
    await expect(prepareMediaBootstrap(f.project, { ...f.request, sourceColorInterpretation: "srgb" as "auto" }, f.runtime,
      { inspect: async () => knownProbe, now })).rejects.toThrow();
    const duplicate = { ...f.runtime, readCurrentProject: async () => structuredClone(edited) };
    await expect(prepareMediaBootstrap(edited, f.request, duplicate, { inspect: async () => knownProbe, now })).rejects.toThrow(/ID 已存在/);
    const badProbe = { ...knownProbe, displayAspectRatio: 0 };
    await expect(prepareMediaBootstrap(f.project, f.request, f.runtime, { inspect: async () => badProbe, now })).rejects.toThrow(/展示比例/);
    const sequence: MediaProbe = { ...knownProbe, imageSequence: { schema: "editkin.openexr-sequence/v1", format: "openexr",
      frameCount: 240, startFrame: 0, lastFrame: 239, timebase: { numerator: 1, denominator: 30 },
      sequenceSha256: "a".repeat(64), manifestSha256: "b".repeat(64), previewUri: "unobserved.png" } };
    await expect(prepareMediaBootstrap(f.project, f.request, f.runtime, { inspect: async () => sequence, now })).rejects.toThrow(/單檔/);
  });
});
