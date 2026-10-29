import { describe, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_CAPTION_STYLE, type CaptionStyle } from "../domain/types";
import { shortsCaptionStyle } from "../creative/shortsCaptionStyle";
import { bundledFontAssLineMetrics, bundledFontAssMetrics } from "../typography/fontEmMetrics";
import { assColor } from "./assText";
import { writeAssContent } from "./captionAss";
import { buildEngineRenderGraph } from "./engineGraph";
import {
  LIBASS_BLUR_SIGMA_PER_UNIT, captionDisplayText, captionFaceLayout, captionPreviewText, captionRenderModel, captionShadowColor,
} from "./captionLayout";

const PORTRAIT = { width: 1080, height: 1920 };
const LANDSCAPE = { width: 1920, height: 1080 };

function exported(style: CaptionStyle, canvas: { width: number; height: number }, text: string) {
  const project = createEmptyProject("layout", { ...canvas, fps: 30 });
  project.captionStyle = style;
  project.captions = [{ id: "cue", text, start: 0, duration: 1 }];
  const lines = writeAssContent(project, style).split("\n");
  const fields = lines.find((line) => line.startsWith("Style: Default,"))!.slice("Style: ".length).split(",");
  const dialogue = lines.find((line) => line.startsWith("Dialogue:"))!;
  return {
    fontSize: Number(fields[2]), backColour: fields[6], borderStyle: Number(fields[15]), outline: Number(fields[16]),
    shadow: Number(fields[17]), marginL: Number(fields[19]), marginR: Number(fields[20]), marginV: Number(fields[21]),
    blur: Number(/\\blur([\d.]+)/.exec(dialogue)?.[1] ?? 0), text: dialogue.slice(dialogue.indexOf("}") + 1).replaceAll("\\N", "\n"),
  };
}

describe("caption layout shared by the ASS export and both previews", () => {
  it("draws the ASS Fontsize at the em libass uses, the inverse of the motion-graphic conversion", () => {
    // Noto Sans TC's OS/2 win ascent + descent is 1.448 em: ASS 95 is a 65.6 px em (about 62 px CJK ink), not 95 px.
    const noto = captionFaceLayout("Noto Sans TC", true, 95);
    expect(noto).toMatchObject({ family: "EditkinFace noto-sans-tc 800", weight: 800, metrics: "libass" });
    expect(noto.emSize).toBeCloseTo(95 / 1.448, 9);
    expect(noto.lineHeight).toBeCloseTo(95, 9);
    expect(noto.ascent).toBeCloseTo(95 * 1160 / 1448, 9);
    const kai = captionFaceLayout("LXGW WenKai TC", true, 86);
    expect(kai.emSize).toBeCloseTo(86 / 1.317, 9);
    expect(kai.lineHeight).toBeCloseTo(86, 9);
    for (const [family, size] of [["Noto Sans TC", 95], ["LXGW WenKai TC", 86], ["Noto Sans TC", 54], ["Noto Serif TC", 56], ["Bebas Neue", 88]] as const) {
      const face = captionFaceLayout(family, true, size);
      expect(bundledFontAssMetrics(family, face.requestedWeight, face.emSize, face.lineHeight).fontSize).toBeCloseTo(size, 9);
    }
    // Bebas Neue's hhea box (900 + 300) is shorter than its win box (950 + 350): libass stacks its lines closer.
    expect(captionFaceLayout("Bebas Neue", false, 88).lineHeight).toBeCloseTo(88 * 1200 / 1300, 9);
  });

  it("never guesses the proportions of a family without verified metrics", () => {
    expect(captionFaceLayout("Some User Font", true, 60)).toMatchObject({ family: "Some User Font", emSize: 60, metrics: "unverified" });
    expect(bundledFontAssLineMetrics("Some User Font", 800, 60)).toBeUndefined();
    expect(bundledFontAssLineMetrics("Noto Sans TC", 800, 0)).toBeUndefined();
  });

  it.each([
    ["Shorts clean", shortsCaptionStyle(PORTRAIT), PORTRAIT],
    ["Shorts handbook", shortsCaptionStyle(PORTRAIT, "travel"), PORTRAIT],
    ["Shorts gaming", shortsCaptionStyle(PORTRAIT, "gaming"), PORTRAIT],
    ["long-form default", DEFAULT_CAPTION_STYLE, LANDSCAPE],
    ["boxed", { ...DEFAULT_CAPTION_STYLE, backgroundColor: "#000000A6" }, LANDSCAPE],
    ["boxed with a soft shadow request", { ...DEFAULT_CAPTION_STYLE, backgroundColor: "#000000B3", shadowColor: "#00000099", shadowBlur: 3 }, LANDSCAPE],
    ["over-strong blur", { ...DEFAULT_CAPTION_STYLE, shadowColor: "#FF000080", shadowBlur: 40 }, LANDSCAPE],
    ["blur without an outline", { ...DEFAULT_CAPTION_STYLE, outlineWidth: 0, shadowColor: "#000000", shadowBlur: 5 }, LANDSCAPE],
  ] as const)("describes exactly what the ASS writer tells libass: %s", (_name, style, canvas) => {
    const text = "這碗湯頭真的很濃，喝完全身都暖起來, OK";
    const ass = exported(style, canvas, text);
    const model = captionRenderModel(style);
    expect(ass.fontSize).toBe(style.fontSize);
    expect(ass.borderStyle).toBe(model.box ? 3 : 1);
    expect(ass.outline).toBe(model.box ? model.box.padding : model.borderWidth);
    expect(ass.backColour).toBe(assColor(captionShadowColor(style)));
    expect(model.shadow !== undefined).toBe(ass.shadow > 0 && !ass.backColour.startsWith("&HFF"));
    expect([ass.marginL, ass.marginR, ass.marginV]).toEqual([model.sideMargin, model.sideMargin, model.marginV]);
    expect(ass.blur).toBeCloseTo(model.edgeBlurSigma / LIBASS_BLUR_SIGMA_PER_UNIT, 2);
    // The export's lines and glyphs are the previews' lines and glyphs.
    expect(ass.text).toBe(captionDisplayText(text, style));
    expect(captionPreviewText(text, style, canvas.width)).toBe(ass.text);
  });

  it("measures libass blur as a Gaussian of 0.849 σ per unit", () => {
    expect(captionRenderModel(shortsCaptionStyle(PORTRAIT)).edgeBlurSigma).toBeCloseTo(3.397, 3);
    expect(captionRenderModel(shortsCaptionStyle(PORTRAIT, "gaming")).edgeBlurSigma).toBeCloseTo(0.849, 3);
    expect(captionRenderModel(DEFAULT_CAPTION_STYLE)).toMatchObject({ edgeBlurSigma: 0, shadow: undefined, borderWidth: 4 });
  });

  it("wraps an over-wide long-form caption for the previews exactly where libass wraps it", () => {
    const text = "這是一段很長的字幕，用來測試橫式長片在超過畫面寬度的時候，輸出端會自動換行，預覽端也一定要在同一個地方換行才對";
    expect(exported(DEFAULT_CAPTION_STYLE, LANDSCAPE, text).text).toBe(text); // the export leaves wrapping to libass
    expect(captionPreviewText(text, DEFAULT_CAPTION_STYLE, LANDSCAPE.width)).toBe(
      "這是一段很長的字幕，用來測試橫式長片在超過畫面寬度的時候\n，輸出端會自動換行，預覽端也一定要在同一個地方換行才對");
  });

  it("sends the native preview the previews' lines and the export's shadow colour and blur", () => {
    const project = createEmptyProject("graph", { ...PORTRAIT, fps: 30 });
    project.captionStyle = shortsCaptionStyle(project);
    project.captions = [{ id: "cue", text: "用 Editkin 剪 Shorts, 字幕一次到位", start: 0, duration: 1 }];
    const node = buildEngineRenderGraph(project).nodes.find((candidate) => candidate.kind === "caption")!;
    // `text` stays the authored cue so a native renderer that predates `lines` keeps drawing it unchanged.
    expect(node).toMatchObject({ text: "用 Editkin 剪 Shorts, 字幕一次到位", lines: ["用 Editkin 剪", "Shorts， 字幕一次到位"],
      fontSize: 95, shadow: 4, shadowColor: "#00000099", shadowBlur: 4 });
    const legacy = createEmptyProject("legacy", { ...LANDSCAPE, fps: 30 });
    legacy.captions = [{ id: "cue", text: "這是一段很長的字幕，用來測試橫式長片在超過畫面寬度的時候，輸出端會自動換行，預覽端也一定要在同一個地方換行才對", start: 0, duration: 1 }];
    const legacyNode = buildEngineRenderGraph(legacy).nodes.find((candidate) => candidate.kind === "caption")!;
    expect(legacyNode.lines).toEqual(captionPreviewText(legacy.captions[0].text, legacy.captionStyle, LANDSCAPE.width).split("\n"));
    expect(legacyNode.lines).toHaveLength(2);
    expect("shadowColor" in legacyNode || "shadowBlur" in legacyNode).toBe(false);
  });
});
