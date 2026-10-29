import { describe, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_CAPTION_STYLE } from "../domain/types";
import { shortsCaptionStyle } from "../creative/shortsCaptionStyle";
import { assMotionFrameTime, writeAssContent } from "./captionAss";

function shortsAss(profile: "auto" | "gaming" | "travel" = "auto") {
  const project = createEmptyProject("shorts", { width: 1080, height: 1920, fps: 30 });
  project.captions = [{ id: "cue", start: 1, duration: 2, text: "這碗湯頭真的很濃", translation: { text: "Rich broth", language: "en" } }];
  project.captionStyle = shortsCaptionStyle(project, profile);
  const lines = writeAssContent(project, project.captionStyle).split("\n");
  return { style: project.captionStyle, defaultStyle: lines.find((line) => line.startsWith("Style: Default,"))!.split(","), dialogue: lines.find((line) => line.startsWith("Dialogue:"))! };
}

describe("Shorts caption ASS output (roadmap 1.7)", () => {
  it("draws a soft dark drop shadow without a box and keeps the fill sharp", () => {
    const { defaultStyle, dialogue } = shortsAss();
    // Fontsize, Primary, Outline, Back(shadow) colours; BorderStyle, Outline, Shadow, Alignment, MarginV.
    expect(defaultStyle[2]).toBe("95");
    expect(defaultStyle[3]).toBe("&H00FFFFFF");
    expect(defaultStyle[5]).toBe("&H8C000000");
    expect(defaultStyle[6]).toBe("&H66000000");
    expect([defaultStyle[15], defaultStyle[16], defaultStyle[17], defaultStyle[18], defaultStyle[21]]).toEqual(["1", "3", "4", "2", "300"]);
    expect(dialogue).toContain("\\blur4}");
    expect(dialogue).toContain("這碗湯頭真的很濃");
  });

  it("gives gaming a green edge and the handbook theme its Kai face", () => {
    const gaming = shortsAss("gaming");
    expect(gaming.defaultStyle[5]).toBe("&H00B0C93F");
    expect(gaming.dialogue).toContain("\\blur1}");
    const travel = shortsAss("travel");
    expect(travel.defaultStyle[1]).toBe("EditkinFace lxgw-wenkai-tc 700");
  });

  it("leaves the legacy and boxed caption output unchanged", () => {
    const project = createEmptyProject("legacy", { width: 1920, height: 1080, fps: 30 });
    project.captions = [{ id: "cue", start: 0, duration: 1, text: "字幕" }];
    const legacy = writeAssContent(project, DEFAULT_CAPTION_STYLE).split("\n");
    expect(legacy.find((line) => line.startsWith("Style: Default,"))!.split(",")[6]).toBe("&HFF000000");
    expect(legacy.find((line) => line.startsWith("Dialogue:"))).not.toContain("\\blur");
    const boxed = writeAssContent(project, { ...DEFAULT_CAPTION_STYLE, backgroundColor: "#000000B3", shadowColor: "#00000099", shadowBlur: 3 }).split("\n");
    expect(boxed.find((line) => line.startsWith("Style: Default,"))!.split(",")[6]).toBe("&H4C000000");
    expect(boxed.find((line) => line.startsWith("Dialogue:"))).not.toContain("\\blur");
  });

  it("breaks a long Shorts caption into whole-word lines of at most 11 characters; legacy captions keep libass wrapping", () => {
    const text = "今天帶大家來看觀音山遊客中心門口這棵樹上停滿的獨角仙";
    const project = createEmptyProject("wrap", { width: 1080, height: 1920, fps: 30 });
    project.captions = [{ id: "cue", start: 0, duration: 3, text }];
    project.captionStyle = shortsCaptionStyle(project);
    const dialogue = writeAssContent(project, project.captionStyle).split("\n").find((line) => line.startsWith("Dialogue:"))!;
    const lines = dialogue.slice(dialogue.indexOf("}") + 1).split("\\N");
    expect(lines).toEqual(["今天帶大家來看觀音山", "遊客中心門口這棵", "樹上停滿的獨角仙"]);
    expect(lines.every((line) => [...line].length <= 11 && [...line].length >= 2)).toBe(true);
    const legacy = writeAssContent(project, DEFAULT_CAPTION_STYLE).split("\n").find((line) => line.startsWith("Dialogue:"))!;
    expect(legacy).not.toContain("\\N");
    expect(legacy.endsWith(text)).toBe(true);
  });

  it("keeps the 1 ms early frame margin for ASS motion timing", () => {
    expect(assMotionFrameTime(111, 30)).toBe("0:00:03.69");
    expect(assMotionFrameTime(0, 30)).toBe("0:00:00.00");
  });
});
