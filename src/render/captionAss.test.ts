import { describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { masterAudioFilter, writeAssContent } from "./ffmpeg";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import { createMotionGraphic } from "../motion/composition";
import { motionGraphicV2LayoutReceipt } from "../motion/compositionV2";
import { buildAssFilter } from "./captionAss";

describe("ASS caption output", () => {
  it("keeps authored RGB colors in the compositing input's color space and range", () => {
    const project = createDemoProject();
    project.captionStyle.color = "#FFFFFF";
    project.captionStyle.backgroundColor = "#000000";
    const ass = writeAssContent(project, project.captionStyle);
    expect(ass.split("\n").filter(line => line.startsWith("YCbCr Matrix:"))).toEqual(["YCbCr Matrix: None"]);
    expect(ass.indexOf("YCbCr Matrix: None")).toBeLessThan(ass.indexOf("[V4+ Styles]"));
    expect(ass).toContain("&H00FFFFFF");
    expect(ass).toContain("&H00000000");
    expect(project.captionStyle.color).toBe("#FFFFFF");
    expect(project.captionStyle.backgroundColor).toBe("#000000");
  });
  it("preserves v1 fade timing while honoring graphic and translated-text alpha", () => {
    const project=createDemoProject();
    const graphic=createMotionGraphic("legacy","title","走走",0,3);
    graphic.textColor="#FFFFFF33";graphic.backgroundColor="#11223380";graphic.accentColor="#44556640";
    project.motionGraphics=[graphic];
    project.captions=[{id:"bilingual",start:0,duration:3,text:"原文",translation:{text:"Translation",language:"en"}}];
    project.captionStyle.translationColor="#FFFFFF33";
    const ass=writeAssContent(project,project.captionStyle);
    expect(ass).toContain("\\1c&HFFFFFF&\\1a&HCC&");
    expect(ass).toContain("\\3c&H332211&\\3a&H7F&");
    expect(ass).toContain("\\4c&H665544&\\4a&HBF&");
    expect(ass).toContain("\\fad(160,140)");
    expect(ass).not.toMatch(/\\[134]?c&H[0-9A-F]{8}&/);
  });
  it("writes independent v2 text, outline, shadow and panel alpha overrides", () => {
    const project=createDemoProject();
    const graphic=createMotionGraphic("alpha","title","透明",0,3,undefined,findMotionGraphicPreset("v2-word-cascade").seed);
    graphic.backgroundColor="#00000000";graphic.textColor="#FFFFFF33";graphic.accentColor="#11223380";
    project.motionGraphics=[graphic];
    const ass=writeAssContent(project,project.captionStyle);
    expect(ass).toContain("\\1c&H000000&\\1a&HFF&");
    expect(ass).toContain("\\1c&HFFFFFF&\\1a&HCC&");
    expect(ass).toContain("\\3c&H332211&\\3a&H7F&");
    expect(ass).toContain("\\4c&H332211&\\4a&H7F&");
    expect(ass).not.toMatch(/\\[134]?c&H[0-9A-F]{8}&/);
  });
  it("isolates v1 and v2 motion outlines from opaque subtitle boxes", () => {
    const project = createDemoProject();
    project.captionStyle.backgroundColor = "#000000";
    project.captions = [{id:"speech",text:"白字黑底",start:0,duration:3}];
    project.motionGraphics = [createMotionGraphic("card","card","卡片",0,3),createMotionGraphic("motion","title","主標",0,3,undefined,findMotionGraphicPreset("v2-word-cascade").seed)];
    const ass=writeAssContent(project,project.captionStyle);
    const lines=ass.split("\n");
    expect(lines.find(line=>line.startsWith("Style: Default,"))?.split(",")[15]).toBe("3");
    expect(lines.find(line=>line.startsWith("Style: Motion,"))?.split(",")[15]).toBe("1");
    expect(lines.filter(line=>/^Dialogue: [12],/.test(line)).every(line=>line.split(",")[3]==="Motion")).toBe(true);
    expect(lines.find(line=>line.startsWith("Dialogue: 0,"))?.split(",")[3]).toBe("Default");
  });
  it("escapes Windows paths for both filtergraph and option parsing without shell quoting", () => {
    const filter = buildAssFilter("C:\\字幕's [one],two;.ass", "C:\\fonts [one],two");
    expect(filter).toContain("C" + "\\".repeat(2) + ":/");
    expect(filter).toContain("字幕" + "\\".repeat(3) + "'s");
    expect(filter).toContain("\\[one\\]\\,two\\;.ass");
    expect(filter).toContain(":fontsdir=C");
    expect(filter).not.toContain("filename='");
    expect(filter).toMatch(/:wrap_unicode=1$/);
  });
  it.each([["#000000", 3], ["#000000FF", 3], ["#000000A6", 3], ["#00000000", 1]] as const)("preserves %s background opacity", (backgroundColor, borderStyle) => {
    const project = createDemoProject();
    project.captionStyle.backgroundColor = backgroundColor;
    const ass = writeAssContent(project, project.captionStyle);
    expect(ass).toContain(`,${borderStyle},${project.captionStyle.outlineWidth},${project.captionStyle.shadow},${project.captionStyle.alignment},40,40,${project.captionStyle.marginV},1`);
  });

  it("uses the requested translucent background as the actual libass box color", () => {
    const project = createDemoProject();
    project.captionStyle.backgroundColor = "#000000B3";
    project.captionStyle.outlineColor = "#000000";
    const styleLine = writeAssContent(project, project.captionStyle).split("\n").find(line => line.startsWith("Style: Default,"))!;
    const fields = styleLine.split(",");
    expect(fields[5]).toBe("&H4C000000");
    expect(fields[6]).toBe("&H4C000000");
    expect(fields[15]).toBe("3");
  });

  it("delegates Unicode wrapping to libass without shrinking or changing editable text", () => {
    const project = createDemoProject();
    project.width = 360; project.height = 640;
    project.captionStyle.fontSize = 54;
    project.captions = [{id: "wrap", start: 0, duration: 2, text: "第一秒就說清楚關鍵結果！"}];
    const before = JSON.stringify(project);
    const ass = writeAssContent(project, project.captionStyle);
    expect(ass).toContain("PlayResX: 360");
    expect(ass).toContain("WrapStyle: 0");
    expect(ass).toContain(",54,");
    expect(ass).toContain(project.captions[0].text);
    expect(JSON.stringify(project)).toBe(before);
    expect(buildAssFilter("C:/owned/file.ass", "C:/owned/fonts")).toMatch(/^subtitles=filename=.*:fontsdir=.*:wrap_unicode=1$/);
    expect(buildAssFilter("C:/owned/file.ass")).not.toContain("fontsdir");
  });
  it("burns editable original and translated lines with their own typography and a real translucent box style", () => {
    const project = createDemoProject();
    project.captions.push({
      id: "bilingual", text: "大家好", start: 1, duration: 2,
      translation: { text: "Hello everyone", language: "en" },
    });
    project.captionStyle.backgroundColor = "#000000A6";
    project.captionStyle.translationFontFamily = "Bebas Neue";
    project.captionStyle.translationFontSize = 32;
    project.captionStyle.translationColor = "#FF66CC";
    const ass = writeAssContent(project, project.captionStyle);
    expect(ass).toContain(",3,4,1,2,40,40,72,1");
    expect(ass).toContain("大家好\\N{\\fnEditkinFace bebas-neue 400\\fs32");
    expect(ass).toContain("Hello everyone");
    expect(ass).toContain("\\1c&HCC66FF&\\1a&H00&");
  });

  it("keeps tracked labels opaque between samples and clamps them inside the frame", () => {
    const project = createDemoProject();
    project.motionTracks.push({
      id: "track-right", clipId: "clip-demo", name: "Right subject", engine: "test", analysisFps: 15,
      initialRect: { x: 0.9, y: 0.2, width: 0.15, height: 0.2 }, lostRatio: 0, createdAt: "2026-08-24T00:00:00Z",
      points: [
        { frame: 0, time: 0, rect: { x: 0.9, y: 0.2, width: 0.15, height: 0.2 }, confidence: 1, status: "tracked" },
        { frame: 1, time: 1 / 15, rect: { x: 0.89, y: 0.2, width: 0.15, height: 0.2 }, confidence: 1, status: "tracked" },
      ],
    });
    project.motionGraphics.push({
      schema: "hao.motion-composition/v1", id: "tracked-label", name: "Tracked label", kind: "tag", text: "正版",
      timelineStart: 0, duration: 1, x: 0.65, y: 0.22, width: 0.25, fontSize: 42,
      textColor: "#FFFFFF", backgroundColor: "#101827F5", accentColor: "#7CFF4F", animation: "spring_soft",
      trackId: "track-right", offsetX: 0.025, offsetY: -0.055,
    });

    const trackedEvents = writeAssContent(project, project.captionStyle).split("\n").filter((line) => line.includes("正版"));
    expect(trackedEvents).toHaveLength(2);
    expect(trackedEvents.every((line) => !line.includes("\\fad"))).toBe(true);
    expect(trackedEvents.every((line) => line.includes("\\pos(1400,"))).toBe(true);
  });

  it("drives formal v2 ASS events from the same layout/frame receipt as DOM preview", () => {
    const project = createDemoProject();
    const preset = findMotionGraphicPreset("v2-word-cascade");
    const graphic = createMotionGraphic("formal-v2", "title", "ONE TWO THREE", 0, 3, undefined, preset.seed);
    project.motionGraphics.push(graphic);
    const layout = motionGraphicV2LayoutReceipt(project, graphic);
    const ass = writeAssContent(project, project.captionStyle);
    expect(ass).toContain(`MotionCompositionV2Receipt: ${graphic.id},${layout.receiptId},90`);
    expect(ass).toContain("\\p1\\bord0\\shad0");
    expect(ass).toContain("ONE");
    expect(ass).toContain("TWO");
    expect(ass).toContain("THREE");
    expect(ass).not.toContain("\\fad(180,140)");
  });
});

describe("master audio output", () => {
  it("normalizes the final mix with AAC transcode true-peak headroom", () => {
    expect(masterAudioFilter("[premaster]", 12)).toBe(
      "[premaster]loudnorm=I=-18:LRA=11:TP=-3,atrim=duration=12[aout]",
    );
  });
});
