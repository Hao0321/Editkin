import { describe, expect, it } from "vitest";
import { MOTION_DESIGN_V3_PRESETS } from "../creative/motionDesignV3Presets";
import { createEmptyProject, validateProject } from "../domain/editGraph";
import type { MotionGraphic } from "../domain/types";
import { motionGraphicV3Frame } from "../motion/compositionV3";
import { writeAssContent } from "./captionAss";

function projectWith(presetId: string, overrides: Partial<MotionGraphic> = {}) {
  const project = createEmptyProject("v3 ass", { id: "v3-ass", width: 1920, height: 1080, fps: 30 });
  const preset = MOTION_DESIGN_V3_PRESETS.find(item => item.id === presetId)!;
  const graphic = { ...preset.seed, id: "g1", timelineStart: 2, duration: 3, ...overrides } as MotionGraphic;
  project.motionGraphics = [graphic];
  return { project: validateProject(project), graphic };
}

const motionEvents = (ass: string) => ass.split("\n").filter(line => line.startsWith("Dialogue:") && line.includes(",Motion,"));

describe("Motion Design v3 ASS export", () => {
  it("emits bounding-box drawings, measured faces and per-frame runs merged across identical frames", () => {
    const { project } = projectWith("v3_lower_third_bar");
    const ass = writeAssContent(project, project.captionStyle);
    expect(ass).toContain("; MotionDesignV3: g1,lower_third_bar,90");
    const events = motionEvents(ass);
    expect(events.some(line => /\\p1.*\}m 0 0 /u.test(line))).toBe(true);
    expect(events.some(line => line.includes("\\fnEditkinFace noto-sans-tc 800"))).toBe(true);
    // Holding frames collapse into one event per element instead of one per frame.
    const nameEvents = events.filter(line => line.endsWith("王小明") || line.includes("}王小明"));
    expect(nameEvents.length).toBeGreaterThan(3);
    expect(nameEvents.length).toBeLessThan(60);
    for (const line of events) expect(Number(line.slice("Dialogue: ".length).split(",")[0])).toBeGreaterThanOrEqual(10);
  });

  it("starts on the graphic's first frame boundary and covers every frame up to its end", () => {
    const { project } = projectWith("v3_tag_live");
    const times = motionEvents(writeAssContent(project, project.captionStyle)).map(line => line.split(",").slice(1, 3));
    const seconds = (value: string) => { const [h, m, s] = value.split(":"); return Number(h) * 3600 + Number(m) * 60 + Number(s); };
    expect(Math.min(...times.map(([start]) => seconds(start)))).toBeGreaterThanOrEqual(2);
    expect(Math.max(...times.map(([, end]) => seconds(end)))).toBeLessThanOrEqual(5);
  });

  it("maps op blur sigma to libass \\blur and keeps clips on the canvas grid", () => {
    const { project, graphic } = projectWith("v3_title_reveal_panel");
    const frame = motionGraphicV3Frame(project, graphic, 60 + 40);
    const shadow = frame.ops.find(op => op.id === "panel:shadow")!;
    const ass = writeAssContent(project, project.captionStyle);
    expect(ass).toContain(`\\blur${Math.round(shadow.blur! * Math.sqrt(2 * Math.LN2) * 100) / 100}`);
    expect(motionEvents(ass).some(line => /\\clip\([\d.]+,[\d.]+,[\d.]+,[\d.]+\)/u.test(line))).toBe(true);
  });

  it("keeps commas and figures intact and neutralises ASS markup characters in copy", () => {
    const { project } = projectWith("v3_stat_counter", { text: "1,280\n{本週}\\新增" });
    const ass = writeAssContent(project, project.captionStyle);
    expect(ass).toContain("}1,280");
    expect(ass).toContain("｛本週｝＼新增");
    expect(ass).not.toMatch(/\{本週\}/u);
  });

  it("refuses to render v3 with unverified substitute fonts", () => {
    const { project } = projectWith("v3_quote");
    expect(() => writeAssContent(project, project.captionStyle, { bundledFaces: false })).toThrow(/內建字型/u);
  });

  it("gives later graphics a higher band of layers", () => {
    const { project } = projectWith("v3_tag_live");
    project.motionGraphics = [project.motionGraphics[0], { ...project.motionGraphics[0], id: "g2", timelineStart: 2.5 }];
    const lines = writeAssContent(validateProject(project), project.captionStyle).split("\n");
    const band = (id: string) => {
      const from = lines.findIndex(line => line.startsWith(`; MotionDesignV3: ${id},`));
      const to = lines.findIndex((line, index) => index > from && line.startsWith("; MotionDesignV3:"));
      return lines.slice(from + 1, to < 0 ? undefined : to).filter(line => line.startsWith("Dialogue:")).map(line => Number(line.split(",")[0].replace("Dialogue: ", "")));
    };
    expect(Math.min(...band("g1"))).toBeGreaterThanOrEqual(10);
    expect(Math.max(...band("g1"))).toBeLessThan(Math.min(...band("g2")));
  });
});
