import { describe, expect, it } from "vitest";
import { createEmptyProject, validateProject } from "../domain/editGraph";
import { DEFAULT_CLIP_LAYER, DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject } from "../domain/types";
import { decodeProjectBytes, encodeProjectBytes, parseProject } from "./projectCodec";

type LayerShape = "omitted" | "role_omitted";
function fixture(schemaVersion: 9 | 10, shape: LayerShape): EditProject {
  const project = createEmptyProject("Current optional layer codec", { id: `optional-layer-${schemaVersion}-${shape}`, width: 1280, height: 720, fps: 30 });
  project.schemaVersion = schemaVersion;
  project.assets = [
    { id: "camera-source", name: "Author camera", kind: "video", uri: "C:/codec-fixture/camera.mp4", duration: 12, width: 1280, height: 720,
      displayAspectRatio: 16 / 9, color: { interpretation: "rec709", primaries: "bt709", transfer: "bt709", matrix: "bt709", range: "tv" },
      provenance: "synthetic-codec-fixture", derivatives: { sourceSha256: "1".repeat(64), generatedAt: "2026-10-05T00:00:00Z" } },
    { id: "voice-source", name: "Author voice", kind: "audio", uri: "C:/codec-fixture/voice.wav", duration: 12,
      provenance: "synthetic-codec-fixture", derivatives: { sourceSha256: "2".repeat(64), generatedAt: "2026-10-05T00:00:00Z" } },
  ];
  project.tracks[0].clips = [{ id: "camera-clip", assetId: "camera-source", trackId: project.tracks[0].id,
    timelineStart: 1, sourceStart: .5, duration: 4, volume: .42,
    transform: { ...DEFAULT_TRANSFORM, x: 14, scale: .85 }, color: { ...DEFAULT_COLOR, saturation: 1.2 },
    keyframes: [{ id: "camera-pose", time: 1, transform: { ...DEFAULT_TRANSFORM, x: 26 }, color: { ...DEFAULT_COLOR }, easing: "ease_out" }],
    ...(shape === "role_omitted" ? { layer: { enabled: true, blendMode: "normal" as const } } : {}),
  }];
  project.tracks[1].clips = [{ id: "voice-clip", assetId: "voice-source", trackId: project.tracks[1].id,
    timelineStart: 1, sourceStart: .5, duration: 4, volume: .75,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [],
  }];
  return validateProject(project);
}

describe("current project optional layer shape through actual byte codec", () => {
  it.each([9, 10] as const)("preserves omitted layer/expressions and full tracks/assets for schema %s", schemaVersion => {
    const project = fixture(schemaVersion, "omitted"), before = structuredClone(project);
    const reopened = decodeProjectBytes(encodeProjectBytes(project));
    expect(reopened.schemaVersion).toBe(schemaVersion);
    expect(reopened.tracks).toStrictEqual(before.tracks); expect(reopened.assets).toStrictEqual(before.assets);
    for (const track of reopened.tracks) for (const clip of track.clips) {
      expect(Object.hasOwn(clip, "layer")).toBe(false); expect(Object.hasOwn(clip, "expressions")).toBe(false);
    }
    expect(project).toStrictEqual(before);
  });

  it.each([9, 10] as const)("preserves declared enabled/blendMode without inventing a role for schema %s", schemaVersion => {
    const project = fixture(schemaVersion, "role_omitted"), before = structuredClone(project);
    const reopened = decodeProjectBytes(encodeProjectBytes(project));
    expect(reopened.tracks).toStrictEqual(before.tracks); expect(reopened.assets).toStrictEqual(before.assets);
    expect(reopened.tracks[0].clips[0].layer).toStrictEqual({ enabled: true, blendMode: "normal" });
    expect(Object.hasOwn(reopened.tracks[0].clips[0].layer!, "role")).toBe(false);
    expect(Object.hasOwn(reopened.tracks[1].clips[0], "layer")).toBe(false);
    expect(project).toStrictEqual(before);
  });

  it("retains genuine older schema defaults for an omitted layer", () => {
    const current = fixture(9, "omitted"), legacy = { ...structuredClone(current), schemaVersion: 6 };
    const migrated = parseProject(legacy), expectedTracks = structuredClone(current.tracks);
    for (const track of expectedTracks) for (const clip of track.clips) {
      clip.layer = { ...DEFAULT_CLIP_LAYER }; clip.expressions = {};
    }
    expect(migrated.schemaVersion).toBe(9);
    expect(migrated.tracks).toStrictEqual(expectedTracks); expect(migrated.assets).toStrictEqual(current.assets);
    expect(Object.hasOwn(legacy.tracks[0].clips[0], "layer")).toBe(false);
  });

  it("retains genuine older schema role defaults without replacing declared layer values", () => {
    const current = fixture(9, "role_omitted"), legacy = { ...structuredClone(current), schemaVersion: 8 };
    legacy.tracks[0].clips[0].layer = { enabled: false, blendMode: "screen" };
    const migrated = parseProject(legacy), expectedTracks = structuredClone(legacy.tracks);
    for (const track of expectedTracks) for (const clip of track.clips) {
      clip.layer = { ...DEFAULT_CLIP_LAYER, ...clip.layer }; clip.expressions = {};
    }
    expect(migrated.schemaVersion).toBe(9);
    expect(migrated.tracks).toStrictEqual(expectedTracks); expect(migrated.assets).toStrictEqual(current.assets);
    expect(migrated.tracks[0].clips[0].layer).toStrictEqual({ enabled: false, blendMode: "screen", role: "content" });
  });

  it.each([9, 10] as const)("does not normalize real manually changed clip/asset fields away for schema %s", schemaVersion => {
    const original = fixture(schemaVersion, "role_omitted"), after = structuredClone(original);
    after.tracks[0].clips[0].layer = { enabled: false, blendMode: "screen" };
    after.tracks[0].clips[0].volume = .31;
    after.assets[0].provenance = "different-author-declaration";
    after.assets[0].derivatives!.sourceSha256 = "3".repeat(64);
    const reopened = decodeProjectBytes(encodeProjectBytes(after));
    expect(reopened.tracks).toStrictEqual(after.tracks); expect(reopened.assets).toStrictEqual(after.assets);
    expect(reopened.tracks).not.toStrictEqual(original.tracks); expect(reopened.assets).not.toStrictEqual(original.assets);
    expect(Object.hasOwn(reopened.tracks[0].clips[0].layer!, "role")).toBe(false);
    expect(original.tracks[0].clips[0].layer).toStrictEqual({ enabled: true, blendMode: "normal" });
    expect(original.assets[0].derivatives!.sourceSha256).toBe("1".repeat(64));
  });
});
