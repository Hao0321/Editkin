import { describe, expect, it } from "vitest";
import { createDemoProject } from "./demo";
import { migrateProject, validateProject } from "./editGraph";
import { DEFAULT_CLIP_LAYER, DEFAULT_COLOR } from "./types";

describe("EditGraph migrations", () => {
  it("upgrades schema v1 without losing clips", () => {
    const current = createDemoProject();
    const legacy = structuredClone(current) as unknown as Record<string, unknown>;
    legacy.schemaVersion = 1;
    delete legacy.captions;
    delete legacy.captionStyle;
    const migrated = validateProject(migrateProject(legacy));
    expect(migrated.schemaVersion).toBe(8);
    expect(migrated.compositions).toEqual([]);
    expect(migrated.tracks[0].clips[0].id).toBe("clip-demo");
    expect(migrated.captions).toEqual([]);
    expect(migrated.tracks[0].clips[0].color).toEqual(DEFAULT_COLOR);
    expect(migrated.director).toMatchObject({ reviewState: "draft", markers: [] });
    expect(migrated.tracks[0].clips[0].keyframes).toEqual([]);
    expect(migrated.tracks[0].clips[0].layer).toEqual(DEFAULT_CLIP_LAYER);
    expect(migrated.tracks[0].clips[0].expressions).toEqual({});
  });

  it("upgrades schema v2 with v3 clip defaults", () => {
    const legacy = structuredClone(createDemoProject()) as unknown as Record<string, unknown>;
    legacy.schemaVersion = 2;
    const tracks = legacy.tracks as Array<{ clips: Array<Record<string, unknown>> }>;
    delete tracks[0].clips[0].color;
    delete tracks[0].clips[0].keyframes;
    const migrated = validateProject(migrateProject(legacy));
    expect(migrated.schemaVersion).toBe(8);
    expect(migrated.tracks[0].clips[0].color.contrast).toBe(1);
  });

  it("adds v7 layer defaults without changing existing clip transforms", () => {
    const legacy = structuredClone(createDemoProject()) as unknown as Record<string, unknown>;
    legacy.schemaVersion = 6;
    const tracks = legacy.tracks as Array<{ clips: Array<Record<string, unknown>> }>;
    delete tracks[0].clips[0].layer;
    delete tracks[0].clips[0].expressions;
    const migrated = validateProject(migrateProject(legacy));
    expect(migrated.tracks[0].clips[0]).toMatchObject({ transform: { scale: 1, opacity: 1 }, layer: DEFAULT_CLIP_LAYER, expressions: {} });
  });

  it("adds grading state to transform-only v3 keyframes without changing their motion", () => {
    const legacy = structuredClone(createDemoProject()) as unknown as Record<string, unknown>;
    const tracks = legacy.tracks as Array<{ clips: Array<Record<string, unknown>> }>;
    tracks[0].clips[0].color = { ...tracks[0].clips[0].color as object, hue: 24 };
    tracks[0].clips[0].keyframes = [{ id: "legacy-keyframe", time: 2, transform: { x: 10, y: 0, scale: 1, rotation: 0, opacity: 1 }, easing: "linear" }];
    const migrated = validateProject(migrateProject(legacy));
    expect(migrated.tracks[0].clips[0].keyframes[0]).toMatchObject({ id: "legacy-keyframe", transform: { x: 10 }, color: { hue: 24 } });
  });

  it("adds Creator Pack caption defaults without changing legacy typography", () => {
    const legacy = structuredClone(createDemoProject()) as unknown as Record<string, unknown>;
    const style = legacy.captionStyle as Record<string, unknown>;
    for (const key of ["presetId", "bold", "italic", "shadow", "backgroundColor", "letterSpacing"]) delete style[key];
    style.fontFamily = "Legacy Font";
    const migrated = validateProject(migrateProject(legacy));
    expect(migrated.captionStyle).toMatchObject({ presetId: "clean_caption", fontFamily: "Legacy Font", bold: true, backgroundColor: "#00000000" });
    expect(migrated.captionStyle).toMatchObject({ translationFontFamily: "Noto Sans TC", translationFontSize: 36, translationColor: "#DCE8FF" });
  });

  it("normalizes legacy director-console drafts without losing their notes", () => {
    const legacy = structuredClone(createDemoProject()) as unknown as Record<string, unknown>;
    legacy.director = {
      reviewState: "rough_cut",
      markers: [{ time: 1.25, title: "舊版導演註記", note: "保留我" }],
    };
    const migrated = validateProject(migrateProject(legacy));
    expect(migrated.director).toMatchObject({
      schema: "editkin.director-console/v1",
      reviewState: "reviewing",
      markers: [{ id: "legacy-director-marker-1", title: "舊版導演註記", note: "保留我", kind: "note", status: "open" }],
    });
  });
});
