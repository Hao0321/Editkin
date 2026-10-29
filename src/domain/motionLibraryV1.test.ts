import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decodeProjectBytes, encodeProjectBytes } from "../application/projectCodec";
import { MOTION_LIBRARY_CATALOG, getMotionLibraryItem } from "../motionLibrary/catalog";
import { motionFrameCount, motionFrameRate } from "../motionLibrary/frames";
import { resolveMotionLibraryParams } from "../motionLibrary/params";
import { MOTION_LIBRARY_CACHE_SCHEMA, MOTION_LIBRARY_ENCODE_PROFILE, motionLibraryCacheKey } from "../motionLibrary/render/renderItem";
import { applyCommand, type EditorCommand } from "./commands";
import { buildEngineRenderGraph } from "../render/engineGraph";
import { timelineTransitionNativeDeclineV1, TIMELINE_TRANSITION_NATIVE_MATTE_DECLINED } from "../render/timelineTransitionNativeV1";
import { createHistory, dispatchCommand, redo, undo } from "./history";
import { MOTION_LIBRARY_REFUSAL_CODES_V1, MotionLibraryRefusalV1, type MotionLibraryRefusalCodeV1 } from "./motionLibraryFieldsV1";
import { fixtureClipField, fixtureTransitionField, motionLibraryFixtureProject, plainClip } from "./motionLibraryV1.fixture";
import {
  MOTION_LIBRARY_CACHE_SCHEMA_V1, MOTION_LIBRARY_ENCODE_PROFILE_V1, motionLibraryCacheKeyV1, motionLibraryFieldStatusV1, motionLibraryFrameCountV1,
  motionLibraryFrameRateV1, motionLibraryItemKindV1, sha256HexV1,
} from "./motionLibraryV1";
import { editorCommandSchema } from "./schema";
import type { EditProject, TimelineClip } from "./types";

const exercised = new Set<MotionLibraryRefusalCodeV1>();
const overlayClips = (project: EditProject) => project.tracks.find(track => track.id === "overlay")!.clips;
function refusal(action: () => unknown): string {
  try { action(); } catch (error) {
    const code = error instanceof MotionLibraryRefusalV1 ? error.code : (error as Error).message.split(":")[0];
    if ((MOTION_LIBRARY_REFUSAL_CODES_V1 as readonly string[]).includes(code)) exercised.add(code as MotionLibraryRefusalCodeV1);
    return code;
  }
  return "ADMITTED";
}

function withText(project: EditProject, itemId = "T01", input: unknown = {}, clipId = "title", start = 0.5) {
  const { field, asset, frameCount } = fixtureClipField(project, itemId, input);
  const clip: TimelineClip = { ...plainClip(clipId, asset.id, "overlay", start, 0, frameCount / project.fps), motionLibrary: field };
  return { field, asset, clip, command: { type: "add_motion_library_clip", asset, clip } as EditorCommand };
}

function withMatte(project: EditProject, windowFrames = 12, overlay = true) {
  const { field, matte, overlay: overlayAsset } = fixtureTransitionField(project, windowFrames, "X01", overlay);
  const commands: EditorCommand[] = [{ type: "import_asset", asset: matte }, ...(overlayAsset ? [{ type: "import_asset", asset: overlayAsset } as EditorCommand] : []),
    { type: "set_timeline_transition", transition: { schema: "editkin.timeline-transition/v1", id: "cut", trackId: "video-main", fromClipId: "a", toClipId: "b",
      beforeFrames: windowFrames / 2, afterFrames: windowFrames / 2, kernel: "matte", motionLibrary: field } }];
  return { field, matte, overlayAsset, commands, project: applyCommand(project, { type: "batch", commands }) };
}

describe("synchronous SHA-256 and the renderer's cache key", () => {
  it("equals node:crypto on boundary lengths, CJK and long input", () => {
    for (const text of ["", "a", "abc", "x".repeat(55), "x".repeat(56), "x".repeat(63), "x".repeat(64), "x".repeat(65), "爆發・未來→光", "y".repeat(10_000)]) {
      expect(sha256HexV1(text)).toBe(createHash("sha256").update(text, "utf8").digest("hex"));
    }
  });
  it("pins the renderer constants and reproduces motionLibraryCacheKey for every kind, size and rate", () => {
    expect(MOTION_LIBRARY_CACHE_SCHEMA_V1).toBe(MOTION_LIBRARY_CACHE_SCHEMA);
    expect(MOTION_LIBRARY_ENCODE_PROFILE_V1).toBe(MOTION_LIBRARY_ENCODE_PROFILE);
    for (const [itemId, size, fps] of [["T01", { width: 1080, height: 1920 }, 30], ["X09", { width: 1920, height: 1080 }, 29.97002997002997], ["B02", { width: 1080, height: 1080 }, 24]] as const) {
      const item = getMotionLibraryItem(itemId), params = resolveMotionLibraryParams(item, {});
      expect(motionLibraryCacheKeyV1({ itemId, itemRevision: item.revision ?? 1, kind: item.kind, params, ...size, fps }))
        .toBe(motionLibraryCacheKey({ itemId, itemRevision: item.revision ?? 1, kind: item.kind, params, size, fps: motionFrameRate(fps), preview: false }));
    }
  });
  it("mirrors the motion library frame clock without importing it", () => {
    for (const fps of [1, 12, 23.976023976023978, 24, 25, 29.97002997002997, 30, 48, 50, 59.94005994005994, 60, 119.88011988011988, 120, 240]) {
      const mine = motionLibraryFrameRateV1(fps), theirs = motionFrameRate(fps);
      expect(mine.text).toBe(theirs.text);
      for (const seconds of [0.2, 0.5, 1.001, 2.4, 3, 30]) expect(motionLibraryFrameCountV1(seconds, mine)).toBe(motionFrameCount(seconds, theirs));
    }
  });
  it("pins the item id ranges to the catalog", () => {
    for (const item of MOTION_LIBRARY_CATALOG) expect(motionLibraryItemKindV1(item.id)).toBe(item.kind);
    for (const id of ["T00", "T81", "X00", "X41", "B41", "Q01", "t01", "T1"]) expect(motionLibraryItemKindV1(id)).toBeUndefined();
  });
});

describe("motion library clip field", () => {
  it("adds asset and clip as one Undo step, validates, survives save and reopen, and Undo/Redo restore exactly", () => {
    const base = motionLibraryFixtureProject(), { command, asset, field } = withText(base);
    const history = dispatchCommand(createHistory(base), command, "add-title");
    expect(history.past).toHaveLength(1);
    const added = history.present;
    expect(added.assets.find(candidate => candidate.id === asset.id)).toEqual(asset);
    expect(overlayClips(added)[0]).toMatchObject({ id: "title", assetId: asset.id, motionLibrary: field });
    const reopened = decodeProjectBytes(encodeProjectBytes(added));
    expect(overlayClips(reopened)[0].motionLibrary).toEqual(field);
    expect(encodeProjectBytes(reopened)).toEqual(encodeProjectBytes(added));
    const undone = undo(history);
    expect(undone.present.assets.some(candidate => candidate.id === asset.id)).toBe(false);
    expect(overlayClips(undone.present)).toEqual([]);
    expect(overlayClips(redo(undone).present)[0].motionLibrary).toEqual(field);
  });

  it("reuses an already registered render (its derivatives may differ) and refuses a different file under the same id", () => {
    const base = motionLibraryFixtureProject(), first = withText(base);
    let project = applyCommand(base, first.command);
    project = applyCommand(project, { type: "set_asset_derivatives", assetId: first.asset.id, derivatives: { sourceSha256: "a".repeat(64), generatedAt: "2026-10-22T00:00:00.000Z" } });
    const second = withText(project, "T01", {}, "title-2", 3.5);
    expect(refusal(() => applyCommand(project, second.command))).toBe("ADMITTED");
    const conflict = { ...second.asset, uri: second.asset.uri.replace(".mov", ".matte.mov") };
    expect(refusal(() => applyCommand(project, { type: "add_motion_library_clip", asset: conflict, clip: second.clip }))).toBe("MOTION_LIBRARY_ASSET_CONFLICT");
  });

  it("update swaps render and field in one step, guarded by the expected binding", () => {
    const base = motionLibraryFixtureProject(), first = withText(base);
    const project = applyCommand(base, first.command);
    const next = fixtureClipField(project, "T01", { lines: ["出發"], durationSeconds: 2 });
    const update: EditorCommand = { type: "update_motion_library_clip", clipId: "title", expected: { assetId: first.asset.id, cacheKey: first.field.cacheKey },
      asset: next.asset, motionLibrary: next.field, sourceStart: 0, duration: 2 };
    const updated = applyCommand(project, update);
    expect(overlayClips(updated)[0]).toMatchObject({ assetId: next.asset.id, duration: 2, motionLibrary: next.field });
    expect(refusal(() => applyCommand(updated, update))).toBe("MOTION_LIBRARY_UPDATE_STALE");
    expect(refusal(() => applyCommand(project, { ...update, duration: undefined }))).not.toBe("ADMITTED"); // a 3 s clip cannot outlast a 2 s render
    expect(refusal(() => applyCommand(project, { ...update, clipId: "a" }))).toBe("MOTION_LIBRARY_CLIP_FIELD_REQUIRED");
    const background = fixtureClipField(project, "B02");
    expect(refusal(() => applyCommand(project, { ...update, asset: background.asset, motionLibrary: background.field }))).toBe("MOTION_LIBRARY_KIND_MISMATCH");
  });

  it("gives every clip refusal a stable code", () => {
    const base = motionLibraryFixtureProject(), ok = withText(base);
    const project = applyCommand(base, ok.command);
    const add = (mutate: (value: { asset: typeof ok.asset; clip: TimelineClip }) => void) => {
      const value = structuredClone({ asset: ok.asset, clip: ok.clip });
      mutate(value);
      return refusal(() => applyCommand(base, { type: "add_motion_library_clip", asset: value.asset, clip: value.clip }));
    };
    expect(add(() => undefined)).toBe("ADMITTED");
    expect(add(value => { value.clip.motionLibrary!.cacheKey = "Z".repeat(64); })).toBe("MOTION_LIBRARY_FIELD_INVALID");
    expect(add(value => { value.clip.motionLibrary!.itemId = "B55"; value.clip.motionLibrary!.kind = "background"; })).toBe("MOTION_LIBRARY_ITEM_UNKNOWN");
    expect(add(value => { value.clip.motionLibrary!.itemId = "X01"; })).toBe("MOTION_LIBRARY_KIND_MISMATCH");
    expect(add(value => { delete value.clip.motionLibrary!.params.plate; })).toBe("MOTION_LIBRARY_PARAMS_INVALID");
    expect(add(value => { (value.clip.motionLibrary!.params.palette as Record<string, string>).accent = "#fd4e4b"; })).toBe("MOTION_LIBRARY_PARAMS_INVALID");
    expect(add(value => { value.clip.motionLibrary!.params.lines = ["改了字卻沒重算"]; })).toBe("MOTION_LIBRARY_CACHE_KEY_MISMATCH");
    expect(add(value => { value.clip.motionLibrary!.itemRevision += 1; })).toBe("MOTION_LIBRARY_CACHE_KEY_MISMATCH");
    expect(add(value => { value.clip.motionLibrary!.engineVersion = "editkin.motion-library-engine/1.0.0"; })).toBe("MOTION_LIBRARY_ENGINE_VERSION_STALE");
    expect(add(value => { delete value.clip.motionLibrary; })).toBe("MOTION_LIBRARY_CLIP_FIELD_REQUIRED");
    expect(add(value => { value.clip.assetId = "footage"; })).toBe("MOTION_LIBRARY_ASSET_BINDING_MISMATCH");
    expect(add(value => { value.asset.uri = value.asset.uri.replace("/T01/", "/T02/"); })).toBe("MOTION_LIBRARY_ASSET_BINDING_MISMATCH");
    expect(add(value => { value.asset.kind = "image"; })).toBe("MOTION_LIBRARY_ASSET_NOT_VIDEO");
    expect(add(value => { value.asset.width = 1920; })).toBe("MOTION_LIBRARY_ASSET_DIMENSIONS_MISMATCH");
    expect(add(value => { value.asset.duration = 3.5; })).toBe("MOTION_LIBRARY_ASSET_FRAME_COUNT_MISMATCH");
    expect(add(value => { value.asset.alphaMode = "opaque"; })).toBe("MOTION_LIBRARY_ASSET_ALPHA_MISMATCH");
    expect(add(value => { value.asset.color = { interpretation: "hlg" }; })).toBe("MOTION_LIBRARY_ASSET_COLOR_MISMATCH");
    expect(add(value => { value.clip.layer = { enabled: true, blendMode: "normal", role: "adjustment" }; })).toBe("MOTION_LIBRARY_LAYER_ROLE_REFUSED");
    const withAudio = applyCommand(base, { type: "add_track", track: { id: "sound", name: "Sound", kind: "audio", locked: false, muted: false, clips: [] } });
    expect(refusal(() => applyCommand(withAudio, { type: "add_motion_library_clip", asset: ok.asset, clip: { ...ok.clip, trackId: "sound" } }))).toBe("MOTION_LIBRARY_TRACK_INVALID");
    // The plain add_clip fast path validates the field too, and an asset swap or a resolution change cannot orphan it.
    const imported = applyCommand(base, { type: "import_asset", asset: ok.asset });
    const forged = structuredClone(ok.clip); forged.motionLibrary!.params.seed = 2;
    expect(refusal(() => applyCommand(imported, { type: "add_clip", clip: forged }))).toBe("MOTION_LIBRARY_CACHE_KEY_MISMATCH");
    expect(refusal(() => applyCommand(imported, { type: "add_clip", clip: { ...ok.clip, trackId: "overlay" } }))).toBe("ADMITTED");
    expect(refusal(() => applyCommand(project, { type: "set_project_resolution", width: 1920, height: 1080 }))).toBe("MOTION_LIBRARY_ASSET_DIMENSIONS_MISMATCH");
    expect(refusal(() => applyCommand(project, { type: "replace_clip_source", clipId: "title", expectedAssetId: ok.asset.id, assetId: "footage", sourceStart: 0 }))).not.toBe("ADMITTED");
  });

  it("keeps a field rendered by an older engine valid but reports it stale", () => {
    const base = motionLibraryFixtureProject(), ok = withText(base);
    const old = { ...structuredClone(ok.clip), motionLibrary: { ...structuredClone(ok.field), engineVersion: "editkin.motion-library-engine/1.2.0", cacheKey: "b".repeat(64) } };
    const asset = { ...ok.asset, id: "old-render", uri: ok.asset.uri.replace(ok.field.cacheKey, "b".repeat(64)) };
    const project = applyCommand(base, { type: "batch", commands: [{ type: "import_asset", asset }, { type: "add_clip", clip: { ...old, assetId: asset.id } }] });
    expect(motionLibraryFieldStatusV1(overlayClips(project)[0].motionLibrary!)).toBe("stale_engine");
    expect(overlayClips(decodeProjectBytes(encodeProjectBytes(project)))[0].motionLibrary).toEqual(overlayClips(project)[0].motionLibrary);
    expect(motionLibraryFieldStatusV1(ok.field)).toBe("current");
  });

  it("parses through the shared command schema", () => {
    const base = motionLibraryFixtureProject(), { command } = withText(base);
    expect(editorCommandSchema.parse(command)).toEqual(command);
    expect(editorCommandSchema.safeParse({ ...command, extra: true }).success).toBe(false);
  });
});

describe("matte timeline transitions", () => {
  it("validate, save and reopen, and decline the native graph with a stable reason", () => {
    const { project, field } = withMatte(motionLibraryFixtureProject());
    expect(project.timelineTransitions?.[0]).toMatchObject({ kernel: "matte", motionLibrary: field });
    const reopened = decodeProjectBytes(encodeProjectBytes(project));
    expect(reopened.timelineTransitions).toEqual(project.timelineTransitions);
    expect(timelineTransitionNativeDeclineV1(project)).toBe(TIMELINE_TRANSITION_NATIVE_MATTE_DECLINED);
    expect(() => buildEngineRenderGraph(project, { nativeTimelineTransitionVersion: 1 })).toThrow(TIMELINE_TRANSITION_NATIVE_MATTE_DECLINED);
    expect(timelineTransitionNativeDeclineV1(motionLibraryFixtureProject())).toBeUndefined();
  });

  it("gives every transition refusal a stable code", () => {
    const base = motionLibraryFixtureProject(), ok = withMatte(base);
    const set = (mutate: (transition: NonNullable<EditProject["timelineTransitions"]>[number]) => void, project = ok.project) => {
      const transition = structuredClone(ok.project.timelineTransitions![0]);
      mutate(transition);
      return refusal(() => applyCommand(project, { type: "set_timeline_transition", transition }));
    };
    expect(set(() => undefined)).toBe("ADMITTED");
    expect(set(transition => { delete transition.motionLibrary; })).toBe("TIMELINE_TRANSITION_FIELDS_INVALID");
    expect(set(transition => { transition.kernel = "dissolve"; })).toBe("TIMELINE_TRANSITION_FIELDS_INVALID");
    expect(set(transition => { transition.motionLibrary!.itemId = "T01"; })).toBe("MOTION_LIBRARY_KIND_MISMATCH");
    expect(set(transition => { transition.motionLibrary!.itemId = "X55"; })).toBe("MOTION_LIBRARY_ITEM_UNKNOWN");
    expect(set(transition => { transition.motionLibrary!.params.seed = -1; })).toBe("MOTION_LIBRARY_PARAMS_INVALID");
    expect(set(transition => { transition.beforeFrames += 2; })).toBe("MOTION_LIBRARY_TRANSITION_DURATION_MISMATCH");
    expect(set(transition => { transition.motionLibrary!.params.seed = 9; })).toBe("MOTION_LIBRARY_CACHE_KEY_MISMATCH");
    expect(set(transition => { transition.motionLibrary!.matteAssetId = "footage"; })).toBe("MOTION_LIBRARY_ASSET_BINDING_MISMATCH");
    expect(set(transition => { transition.motionLibrary!.overlayAssetId = transition.motionLibrary!.matteAssetId; })).toBe("TIMELINE_TRANSITION_FIELDS_INVALID");
    expect(set(transition => { transition.motionLibrary!.matteAssetId = "nowhere"; })).toBe("MOTION_LIBRARY_ASSET_MISSING");
    const swapped = applyCommand(base, { type: "batch", commands: [{ type: "import_asset", asset: { ...ok.matte, alphaMode: "opaque" } }, { type: "import_asset", asset: ok.overlayAsset! }] });
    expect(set(() => undefined, swapped)).toBe("MOTION_LIBRARY_ASSET_ALPHA_MISMATCH");
    // A matte asset in use cannot be deleted; the transition itself can.
    expect(refusal(() => applyCommand(ok.project, { type: "delete_asset", assetId: ok.matte.id }))).toBe("MOTION_LIBRARY_ASSET_MISSING");
    expect(refusal(() => applyCommand(ok.project, { type: "delete_timeline_transition", transitionId: "cut" }))).toBe("ADMITTED");
    // Without an overlay the overlay id is simply absent.
    expect(refusal(() => withMatte(base, 12, false))).toBe("ADMITTED");
  });

  it("exercises every refusal code at least once", () => {
    expect([...MOTION_LIBRARY_REFUSAL_CODES_V1].filter(code => !exercised.has(code))).toEqual([]);
  });
});
