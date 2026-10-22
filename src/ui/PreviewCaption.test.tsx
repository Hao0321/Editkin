import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DEFAULT_CAPTION_STYLE, type CaptionCue, type CaptionStyle } from "../domain/types";
import { shortsCaptionStyle } from "../creative/shortsCaptionStyle";
import { PreviewCaption } from "./PreviewCaption";

// Real product JSX, server rendering only: markup and inline geometry, not browser pixels (the parity harness
// screenshots this markup in Edge against the FFmpeg/libass export).
const PORTRAIT = { width: 1080, height: 1920 };
const LANDSCAPE = { width: 1920, height: 1080 };

function render(style: CaptionStyle, text: string, canvas = PORTRAIT, translation?: CaptionCue["translation"]) {
  return renderToStaticMarkup(<PreviewCaption caption={{ id: "cue", text, start: 0, duration: 2, translation }} style={style}
    projectWidth={canvas.width} projectHeight={canvas.height} />);
}

/** Canvas pixels from a cqw length on a canvas of the given width. */
function pixels(value: string, width: number): number {
  return Number(/^([\d.]+)cqw$/.exec(value)?.[1]) * width / 100;
}

function layer(html: string, paint: string): string {
  const start = html.indexOf(`preview-caption-layer preview-caption-${paint}"`);
  expect(start, paint).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf("</div>", start));
}

function styleValue(markup: string, property: string): string {
  return new RegExp(`(?:^|[;"])${property}:([^;"]+)`).exec(markup)?.[1] ?? "";
}

describe("HTML caption preview draws what the export draws", () => {
  it("converts the Shorts ASS size to libass's em and keeps the export's word breaks", () => {
    const html = render(shortsCaptionStyle(PORTRAIT), "這碗湯頭真的很濃，喝完全身都暖起來");
    const fill = layer(html, "fill");
    expect(pixels(styleValue(fill, "font-size"), 1080)).toBeCloseTo(95 / 1.448, 6);
    expect(pixels(styleValue(fill, "line-height"), 1080)).toBeCloseTo(95, 6);
    expect(fill).toContain(">這碗湯頭真的很濃，\n喝完全身都暖起來</span>");
    // The last line box ends MarginV above the frame, between the 40 px side margins.
    expect(html).toContain("bottom:15.625%");
    expect(html).toContain("left:3.7037037037037033%;right:3.7037037037037033%");
    expect(html).toContain('data-caption-metrics="libass"');
  });

  it("stacks the soft shadow and the translucent rim under a sharp fill, like libass", () => {
    const html = render(shortsCaptionStyle(PORTRAIT), "樹上停滿獨角仙");
    expect(html.indexOf("preview-caption-shadow")).toBeLessThan(html.indexOf("preview-caption-rim"));
    expect(html.indexOf("preview-caption-rim")).toBeLessThan(html.indexOf("preview-caption-fill"));
    const shadow = layer(html, "shadow"), rim = layer(html, "rim"), fill = layer(html, "fill");
    // Shadow #00000099, 4 px down-right, \blur4 = Gaussian σ 3.40 px; the dilated shape includes the 3 px border.
    expect(Number(styleValue(shadow, "opacity"))).toBeCloseTo(0x99 / 255, 6);
    const shift = /translate\(([\d.]+cqw), ([\d.]+cqw)\)/.exec(shadow)!;
    expect(pixels(shift[1], 1080)).toBeCloseTo(4, 6);
    expect(pixels(shift[2], 1080)).toBeCloseTo(4, 6);
    expect(pixels(/blur\(([\d.]+cqw)\)/.exec(shadow)![1], 1080)).toBeCloseTo(4 * 2 / Math.sqrt(Math.log(256)), 6);
    expect(pixels(styleValue(shadow, "-webkit-text-stroke-width"), 1080)).toBeCloseTo(6, 6);
    // Rim #00000073 grown by Outline 3 with the same blur; the fill is sharp and white.
    expect(Number(styleValue(rim, "opacity"))).toBeCloseTo(0x73 / 255, 6);
    expect(rim).toContain("stroke-linejoin:round");
    expect(rim).toContain("filter:blur(");
    expect(fill).not.toContain("filter:");
    expect(fill).not.toContain("-webkit-text-stroke");
    expect(styleValue(fill, "color")).toBe("#FFFFFF");
    expect(shadow).toContain('aria-hidden="true"');
    expect(fill).not.toContain("aria-hidden");
  });

  it("keeps the long-form default exactly as exported: hard opaque outline, no shadow", () => {
    const html = render(DEFAULT_CAPTION_STYLE, "清楚可讀，才是重點", LANDSCAPE);
    expect(html).not.toContain("preview-caption-shadow");
    const rim = layer(html, "rim");
    expect(styleValue(rim, "opacity")).toBe("1");
    expect(rim).not.toContain("filter:");
    expect(pixels(styleValue(rim, "-webkit-text-stroke-width"), 1920)).toBeCloseTo(8, 6);
    expect(pixels(styleValue(layer(html, "fill"), "font-size"), 1920)).toBeCloseTo(54 / 1.448, 6);
    expect(html).toContain("bottom:6.666666666666667%");
  });

  it("draws a visible background as libass's per-line box with its shadow box", () => {
    const html = render({ ...DEFAULT_CAPTION_STYLE, backgroundColor: "#000000A6" }, "清楚可讀，才是重點", LANDSCAPE);
    expect(html).not.toContain("preview-caption-rim");
    const box = layer(html, "box"), shadowBox = layer(html, "shadow-box");
    expect(Number(styleValue(box, "opacity"))).toBeCloseTo(0xA6 / 255, 6);
    expect(box).toContain("background-color:#000000");
    expect(pixels(/box-shadow:0 0 0 ([\d.]+cqw)/.exec(box)![1], 1920)).toBeCloseTo(8, 6);
    expect(shadowBox).toMatch(/transform:translate\([\d.]+cqw, [\d.]+cqw\)/);
    expect(shadowBox).not.toContain("filter:");
  });

  it("shows the export's full-width stand-ins and the translation line in every layer", () => {
    const html = render(shortsCaptionStyle(PORTRAIT), "用 Editkin 剪 Shorts, 字幕一次到位", PORTRAIT, { text: "Rich, broth", language: "en" });
    expect(layer(html, "fill")).toContain(">用 Editkin 剪\nShorts， 字幕一次到位</span>");
    expect(html.split("Rich， broth").length - 1).toBe(3); // shadow, rim and fill copies
    const translation = /<span class="preview-caption-translation" lang="en" data-testid="preview-caption-translation"[^>]*>/.exec(html)![0];
    expect(pixels(styleValue(translation, "font-size"), 1080)).toBeCloseTo(58 / 1.448, 6);
    expect(render(shortsCaptionStyle(PORTRAIT), "字幕", PORTRAIT, { text: "  ", language: "en" })).not.toContain("preview-caption-translation");
  });

  it("follows alignment like libass and keeps an unbundled family at its typed size", () => {
    expect(render({ ...DEFAULT_CAPTION_STYLE, alignment: 8 }, "上方", LANDSCAPE)).toContain("top:6.666666666666667%;bottom:auto");
    expect(render({ ...DEFAULT_CAPTION_STYLE, alignment: 5 }, "中間", LANDSCAPE)).toContain("top:50%;bottom:auto;transform:translateY(-50%)");
    expect(render({ ...DEFAULT_CAPTION_STYLE, alignment: 1 }, "左邊", LANDSCAPE)).toContain("text-align:left");
    const custom = render({ ...DEFAULT_CAPTION_STYLE, fontFamily: "Some User Font" }, "自訂字型", LANDSCAPE);
    expect(custom).toContain('data-caption-metrics="unverified"');
    expect(pixels(styleValue(layer(custom, "fill"), "font-size"), 1920)).toBeCloseTo(54, 6);
  });
});
