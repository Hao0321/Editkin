import { describe, expect, it } from "vitest";
import { connectionFieldGeometry, type ConnectionField } from "./connectionField";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import { createMotionGraphic } from "./composition";
import { createEmptyProject, validateProject } from "../domain/editGraph";
import { motionGraphicV2FrameReceipt, motionGraphicV2LayoutReceipt } from "./compositionV2";
import { motionVectorPaths } from "./vectorGeometry";
import { motionVectorV2Schema } from "../domain/schema";

const field: ConnectionField = { schema: "editkin.motion-vector/v1", kind: "connection_field", heightPixels: 400,
  revealFrames: 1, seed: 32021, points: 32, dotRadiusPixels: 3.5, lineWidthPixels: 1.1,
  burstFrames: 18, gatherStartFrame: 80, gatherFrames: 18, connectStartFrame: 160, connectFrames: 18 };

describe("deterministic native connection field", () => {
  it("can seek in any order and has exact holds between the three finite changes", () => {
    const sample = (frame: number) => connectionFieldGeometry(field, 470, 400, frame);
    const beforeSeek = sample(44); sample(230); sample(3);
    expect(sample(44)).toEqual(beforeSeek);
    for (const [start, end] of [[18, 79], [98, 159], [178, 239]]) {
      for (let frame = start; frame <= end; frame++) expect(sample(frame)).toEqual(sample(start));
    }
    expect(sample(17)).not.toEqual(sample(18)); expect(sample(97)).not.toEqual(sample(98));
    expect(sample(159).edges).toHaveLength(0); expect(sample(178).edges.length).toBeGreaterThan(32);
    expect(connectionFieldGeometry({ ...field, seed: 2 }, 470, 400, 44)).not.toEqual(beforeSeek);
  });
  it("shares original vector contours across preview and output, and bounds invalid scene schedules", () => {
    const preset = findMotionGraphicPreset("reel_connection_field"), project = createEmptyProject("Connection", { width: 540, height: 960, fps: 30 });
    const graphic = createMotionGraphic("connection", "card", "", 0, 8, undefined, preset.seed); graphic.vectorV2 = field;
    const layout = motionGraphicV2LayoutReceipt(project, graphic), frame = motionGraphicV2FrameReceipt(project, graphic, 190, layout);
    const paths = motionVectorPaths(graphic, layout, frame);
    expect(paths.every(path => path.ass && path.svg)).toBe(true);
    for (const point of connectionFieldGeometry(field, layout.box.width, layout.box.height, 190).points) {
      expect(point.x - point.radius).toBeGreaterThan(0); expect(point.x + point.radius).toBeLessThan(layout.box.width);
      expect(point.y - point.radius).toBeGreaterThan(0); expect(point.y + point.radius).toBeLessThan(layout.box.height);
    }
    project.motionGraphics.push(graphic);
    expect(() => validateProject(project)).not.toThrow();
    const malformed = structuredClone(project); (malformed.motionGraphics[0].vectorV2 as ConnectionField).connectStartFrame = 90;
    expect(() => validateProject(malformed)).toThrow(/交接/);
  });
  it("keeps three editable group colors through strict serialization and both render paths", () => {
    const colors: [string, string, string] = ["#DE3559", "#00AF9F", "#F4C83C"];
    const value = motionVectorV2Schema.parse(JSON.parse(JSON.stringify({ ...field, groupColors: colors })));
    const project = createEmptyProject("Color", { width: 540, height: 960, fps: 30 });
    const graphic = createMotionGraphic("color", "card", "", 0, 8, undefined, findMotionGraphicPreset("reel_connection_field").seed); graphic.vectorV2 = value;
    const layout = motionGraphicV2LayoutReceipt(project, graphic), frame = motionGraphicV2FrameReceipt(project, graphic, 190, layout);
    const paths = motionVectorPaths(graphic, layout, frame);
    expect(paths.filter(path => colors.includes(path.color)).map(path => path.color)).toEqual([...colors].reverse());
    expect(paths.filter(path => colors.includes(path.color)).every(path => path.ass.includes("b ") && path.svg.includes("C "))).toBe(true);
    expect(() => motionVectorV2Schema.parse({ ...field, groupColors: ["red", "#00AF9F", "#F4C83C"] })).toThrow();
    expect(() => motionVectorV2Schema.parse({ ...field, groupColors: colors.slice(0, 2) })).toThrow();
  });
});
