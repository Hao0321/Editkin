import { describe, expect, it } from "vitest";
import { createEmptyProject, migrateProject, validateProject } from "./editGraph";
import { applyCommand } from "./commands";
import { editorCommandSchema, projectSchema } from "./schema";
import type { MotionGraphic } from "./types";
import type { SpringGeometryTrack, SpringTargetEvent, SpringTargetTrack } from "./motionContinuity";
import { assertMotionGraphicV2Contract } from "./motionCompositionV2Contract";
import { assertContinuityVectorContract, assertContinuityVectorFrameRange, assertContinuityVectorLayout } from "./motionContinuityContract";
import { createMotionGraphic, legacyMotionGraphicSeed } from "../motion/composition";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import { sampleSpringGeometryTrack } from "../motion/springGeometryTrack";

const property = (position: number, events: readonly SpringTargetEvent[] = []): SpringTargetTrack => ({
  fps: 30, initialPosition: position, initialVelocity: 0, initialTarget: position,
  spring: { stiffness: 100, damping: 20, mass: 1 }, events,
});

function continuityPanel(): MotionGraphic {
  const graphic = createMotionGraphic("continuous-panel", "card", "", 0, 3, undefined,
    findMotionGraphicPreset("reel_native_panel").seed);
  const phase = { durationFrames: 1, offsetXPixels: 0, offsetYPixels: 0, scale: 1, opacity: 1, easing: { type: "linear" as const } };
  return {
    ...graphic, compositeLayer: "foreground", x: .1, y: .15, width: .5, fontSize: 8,
    cornerRadius: 0, outlineWidth: 0, shadowDepth: 0, backgroundColor: "#175CD3",
    motionV2: {
      sequence: { unit: "all", order: "forward", exitOrder: "forward", staggerFrames: 0 },
      entrance: { ...phase }, exit: { ...phase },
    },
    layoutV2: { safeArea: { top: .05, right: .05, bottom: .05, left: .05 }, maxLines: 1,
      minFontSize: 8, lineGap: 0, align: "left", widthMode: "fixed" },
    vectorV2: { schema: "editkin.motion-vector-continuity/v1", kind: "spring_panel", heightPixels: 180, revealFrames: 1,
      geometry: {
        localId: graphic.id, envelope: { x: 0, y: 0, width: 320, height: 180 },
        left: property(30, [{ frame: 30, target: 50 }]),
        top: property(40, [{ frame: 20, target: 30 }]),
        right: property(190, [{ frame: 15, target: 280 }, { frame: 60, target: 240 }]),
        bottom: property(110, [{ frame: 20, target: 140 }]),
        cornerRadius: property(12, [{ frame: 15, target: 8 }]),
      } },
  };
}

function geometry(graphic: MotionGraphic): SpringGeometryTrack {
  if (graphic.vectorV2?.kind !== "spring_panel") throw new Error("Expected the real continuity vector fixture");
  return graphic.vectorV2.geometry;
}

function projectWith(graphic = continuityPanel(), fps = 30) {
  const project = createEmptyProject("Saved continuity contract", { id: "continuity-project", width: 640, height: 360, fps });
  project.motionGraphics = [graphic];
  return project;
}

function staticGeometry(graphic: MotionGraphic) {
  const track = geometry(graphic);
  for (const key of ["left", "top", "right", "bottom", "cornerRadius"] as const) track[key] = { ...track[key], events: [] };
  return track;
}

describe("saved Motion continuity contract", () => {
  it("preserves the version, object identity and every target through real command application and project reopening", () => {
    const source = createEmptyProject("Saved continuity contract", { id: "continuity-project", width: 640, height: 360, fps: 30 });
    const graphic = continuityPanel();
    const command = editorCommandSchema.parse({ type: "add_motion_graphic", graphic });
    const applied = applyCommand(source, command);
    const saved = JSON.stringify(applied);
    const reopened = projectSchema.parse(JSON.parse(saved));

    expect(validateProject(reopened)).toBe(reopened);
    expect(reopened.motionGraphics[0]).toEqual(graphic);
    expect(geometry(reopened.motionGraphics[0])).toEqual(geometry(graphic));
    expect(reopened.motionGraphics[0].vectorV2?.schema).toBe("editkin.motion-vector-continuity/v1");
    expect(geometry(reopened.motionGraphics[0]).localId).toBe(reopened.motionGraphics[0].id);
    expect(source.motionGraphics).toEqual([]);
    expect(JSON.stringify(applied)).toBe(saved);
  });

  it.each(["editkin.motion-vector/v1", "editkin.motion-vector-stage/v1"])("rejects a spring panel hidden behind the old %s marker", marker => {
    const graphic = continuityPanel();
    const invalid = { ...graphic, vectorV2: { ...graphic.vectorV2, schema: marker } } as unknown as MotionGraphic;
    expect(projectSchema.safeParse(projectWith(invalid)).success).toBe(false);
    expect(() => editorCommandSchema.parse({ type: "add_motion_graphic", graphic: invalid })).toThrow();
    expect(() => validateProject(projectWith(invalid))).toThrow(/continuity version/);
  });

  it("rejects an old panel kind carrying the new marker instead of stripping unknown intent", () => {
    const graphic = continuityPanel();
    const invalid = { ...graphic, vectorV2: { schema: "editkin.motion-vector-continuity/v1", kind: "panel", heightPixels: 180, revealFrames: 1 } } as unknown as MotionGraphic;
    expect(projectSchema.safeParse(projectWith(invalid)).success).toBe(false);
    expect(() => editorCommandSchema.parse({ type: "add_motion_graphic", graphic: invalid })).toThrow();
    expect(() => assertMotionGraphicV2Contract(invalid, 30)).toThrow(/未知原生向量種類/);
    expect(() => validateProject(projectWith(invalid))).toThrow(/未知原生向量種類/);
  });

  it("rejects geometry attached to an old vector marker", () => {
    const graphic = continuityPanel();
    const invalid = { ...graphic, vectorV2: { ...graphic.vectorV2, schema: "editkin.motion-vector/v1", kind: "panel" } };
    expect(projectSchema.safeParse(projectWith(invalid as unknown as MotionGraphic)).success).toBe(false);
    expect(() => assertMotionGraphicV2Contract(invalid as unknown as MotionGraphic, 30)).toThrow(/未知原生向量幾何欄位/);
    expect(() => validateProject(projectWith(invalid as unknown as MotionGraphic))).toThrow(/未知原生向量幾何欄位/);
  });

  it("binds all property clocks to the project, including supported fractional fps", () => {
    const graphic = continuityPanel();
    geometry(graphic).right.fps = 24;
    expect(projectSchema.safeParse(projectWith(graphic)).success).toBe(false);
    expect(() => validateProject(projectWith(graphic))).toThrow(/same fps/);

    expect(() => validateProject(projectWith(continuityPanel(), 24))).toThrow(/fps must match the project/);
    const fractional = continuityPanel();
    for (const key of ["left", "top", "right", "bottom", "cornerRadius"] as const) geometry(fractional)[key].fps = 25.5;
    fractional.duration = 90 / 25.5;
    const project = projectWith(fractional, 25.5);
    expect(validateProject(projectSchema.parse(JSON.parse(JSON.stringify(project))))).toEqual(project);
  });

  it.each([{ duration: 3 + 1 / 60 }, { timelineStart: 1 / 60 }])("rejects a fractional authored duration or start instead of rounding it $duration $timelineStart", patch => {
    const graphic = { ...continuityPanel(), ...patch };
    expect(() => assertContinuityVectorContract(graphic, 30)).toThrow(/align to integer project frames/);
    expect(() => validateProject(projectWith(graphic))).toThrow(/align to integer project frames/);
  });

  it.each([.5, 241, Infinity, NaN])("rejects unsupported saved property fps %s", fps => {
    const graphic = continuityPanel();
    for (const key of ["left", "top", "right", "bottom", "cornerRadius"] as const) geometry(graphic)[key].fps = fps;
    expect(projectSchema.safeParse(projectWith(graphic)).success).toBe(false);
    expect(() => assertContinuityVectorContract(graphic, fps)).toThrow(/fps/);
  });

  it.each(["", " ", "x".repeat(81)])("rejects invalid stable local identity %j", localId => {
    const graphic = continuityPanel();
    geometry(graphic).localId = localId;
    expect(projectSchema.safeParse(projectWith(graphic)).success).toBe(false);
    expect(() => validateProject(projectWith(graphic))).toThrow(/localId/);
  });

  it("rejects a valid-looking local identity that points to another graphic", () => {
    const graphic = continuityPanel();
    geometry(graphic).localId = "different-panel";
    expect(() => validateProject(projectWith(graphic))).toThrow(/match its graphic identity/);
  });

  it("admits exactly 32 shared events and rejects a distributed 33rd event", () => {
    const graphic = continuityPanel(), track = staticGeometry(graphic);
    track.left.events = Array.from({ length: 16 }, (_, frame) => ({ frame, target: 30 }));
    track.right.events = Array.from({ length: 16 }, (_, frame) => ({ frame, target: 190 }));
    expect(projectSchema.safeParse(projectWith(graphic)).success).toBe(true);
    expect(validateProject(projectWith(graphic)).motionGraphics[0]).toEqual(graphic);

    track.cornerRadius.events = [{ frame: 0, target: 12 }];
    expect(projectSchema.safeParse(projectWith(graphic)).success).toBe(false);
    expect(() => validateProject(projectWith(graphic))).toThrow(/32 total target events/);
  });

  it("allows the final admitted frame and rejects an event at the excluded end frame", () => {
    const graphic = continuityPanel(), track = staticGeometry(graphic);
    track.right.events = [{ frame: 89, target: 190 }];
    expect(() => validateProject(projectWith(graphic))).not.toThrow();
    track.right.events = [{ frame: 90, target: 190 }];
    expect(() => validateProject(projectWith(graphic))).toThrow(/admitted frame range/);
  });

  it.each([
    { events: [{ frame: 12, target: 190 }, { frame: 12, target: 200 }] },
    { events: [{ frame: 12, target: 190 }, { frame: 11, target: 200 }] },
    { events: [{ frame: 1.5, target: 200 }] },
    { events: [{ frame: -1, target: 200 }] },
  ])("rejects duplicate, descending or noninteger event order $events", ({ events }) => {
    const graphic = continuityPanel();
    geometry(graphic).right.events = events;
    expect(projectSchema.safeParse(projectWith(graphic)).success).toBe(false);
    expect(() => validateProject(projectWith(graphic))).toThrow(/ascending.*integer frames/);
  });

  it.each([-1, 4097, Infinity, NaN])("rejects unsupported target coordinate %s", target => {
    const graphic = continuityPanel();
    geometry(graphic).right.events = [{ frame: 15, target }];
    expect(projectSchema.safeParse(projectWith(graphic)).success).toBe(false);
    expect(() => assertContinuityVectorContract(graphic, 30)).toThrow();
  });

  it("rejects initial velocity outside the saved project bound", () => {
    const graphic = continuityPanel();
    geometry(graphic).right.initialVelocity = 32769;
    expect(projectSchema.safeParse(projectWith(graphic)).success).toBe(false);
    expect(() => assertContinuityVectorContract(graphic, 30)).toThrow(/target\/velocity/);
  });

  it("keeps the admitted duration bounded independently of valid event targets", () => {
    const graphic = continuityPanel();
    staticGeometry(graphic);
    graphic.duration = 2 / 30;
    expect(() => validateProject(projectWith(graphic))).not.toThrow();
    graphic.duration = 1 / 30;
    expect(() => validateProject(projectWith(graphic))).toThrow(/2 to 1800 project frames/);
    graphic.duration = 60;
    expect(() => validateProject(projectWith(graphic))).not.toThrow();
    graphic.duration = 1801 / 30;
    expect(() => validateProject(projectWith(graphic))).toThrow(/2 to 1800 project frames/);
  });

  it("rejects intermediate envelope overshoot even when the first and last frames fit", () => {
    const graphic = continuityPanel(), track = staticGeometry(graphic);
    track.right = { ...property(190, [{ frame: 0, target: 280 }]), spring: { stiffness: 100, damping: 0, mass: 1 } };
    expect(() => sampleSpringGeometryTrack(track, 0)).not.toThrow();
    expect(() => sampleSpringGeometryTrack(track, 89)).not.toThrow();
    expect(() => sampleSpringGeometryTrack(track, 9)).toThrow(/fixed envelope/);
    expect(() => validateProject(projectWith(graphic))).toThrow(/fixed envelope/);
  });

  it("rejects intermediate edge inversion even when both authored targets and endpoint shapes fit", () => {
    const graphic = continuityPanel(), track = staticGeometry(graphic);
    graphic.duration = 2;
    track.left = { ...property(30, [{ frame: 0, target: 170 }]), spring: { stiffness: 100, damping: 0, mass: 1 } };
    track.cornerRadius = property(0);
    expect(() => sampleSpringGeometryTrack(track, 0)).not.toThrow();
    expect(() => sampleSpringGeometryTrack(track, 59)).not.toThrow();
    expect(() => assertContinuityVectorFrameRange(graphic, 30)).toThrow(/inverted or collapsed/);
    expect(() => validateProject(projectWith(graphic))).toThrow(/inverted or collapsed/);
  });

  it("rejects an intermediate radius overshoot rather than clamping its contour", () => {
    const graphic = continuityPanel(), track = staticGeometry(graphic);
    track.cornerRadius = { ...property(12, [{ frame: 0, target: 30 }]), spring: { stiffness: 100, damping: 0, mass: 1 } };
    expect(() => sampleSpringGeometryTrack(track, 0)).not.toThrow();
    expect(() => sampleSpringGeometryTrack(track, 89)).not.toThrow();
    expect(() => sampleSpringGeometryTrack(track, 9)).toThrow(/corner radius/);
    expect(() => validateProject(projectWith(graphic))).toThrow(/corner radius/);
  });

  it("requires the vector height to describe the exact fixed local envelope", () => {
    const graphic = continuityPanel();
    geometry(graphic).envelope.height = 181;
    expect(() => assertContinuityVectorContract(graphic, 30)).toThrow(/fixed local pixel envelope/);
    expect(() => validateProject(projectWith(graphic))).toThrow(/fixed local pixel envelope/);
  });

  it.each([{ width: .49 }, { x: .04 }, { x: .5 }, { y: .04 }, { y: .6 }])("rejects truncated or repositioned authored envelope %j", patch => {
    const graphic = { ...continuityPanel(), ...patch }, project = projectWith(graphic);
    expect(() => assertContinuityVectorLayout(project, graphic)).toThrow(/without truncation or repositioning/);
    expect(() => validateProject(project)).toThrow(/without truncation or repositioning/);
  });

  it("admits the exact foreground envelope and refuses background composition", () => {
    const graphic = continuityPanel(), project = projectWith(graphic);
    expect(() => assertContinuityVectorLayout(project, graphic)).not.toThrow();
    expect(validateProject(project)).toBe(project);
    graphic.compositeLayer = "background";
    expect(projectSchema.safeParse(project).success).toBe(false);
    expect(() => validateProject(project)).toThrow(/foreground composition/);
  });

  it("keeps old v1 titles and old v2 vectors readable without injecting a continuity marker", () => {
    const oldPanel = { ...continuityPanel(), id: "old-panel", vectorV2: { schema: "editkin.motion-vector/v1" as const,
      kind: "panel" as const, heightPixels: 180, revealFrames: 1 } };
    const project = projectWith(oldPanel);
    project.motionGraphics.push(createMotionGraphic("old-title", "title", "Existing title", 0, 3, undefined, legacyMotionGraphicSeed("title")));
    const oldSaved = { ...JSON.parse(JSON.stringify(project)), schemaVersion: 7 };
    const migrated = migrateProject(oldSaved);
    const reopened = projectSchema.parse(JSON.parse(JSON.stringify(migrated)));
    expect(validateProject(reopened)).toBe(reopened);
    expect(reopened.motionGraphics[0].vectorV2).toEqual(oldPanel.vectorV2);
    expect(reopened.motionGraphics[1].schema).toBe("hao.motion-composition/v1");
    expect(reopened.motionGraphics[1].vectorV2).toBeUndefined();
    expect(JSON.stringify(reopened)).not.toContain("editkin.motion-vector-continuity/v1");
  });
});
