import { describe, expect, it } from "vitest";
import {
  aboutPivot, circleBezierPathD, circlePathD, createSvgDocument, el, emptySvg, escapeAttribute, fe, fmt, g, outlinedAttrs, path, pathData,
  polygon, polygonPathD, rect, rectPathD, roundRect, tf, transform,
} from "./document";
import { flattenPathD } from "./pathOps";

describe("fmt", () => {
  it("prints at most three decimals without exponent, trailing zeros or signed zero", () => {
    expect(fmt(1)).toBe("1");
    expect(fmt(100)).toBe("100");
    expect(fmt(1.5)).toBe("1.5");
    expect(fmt(1.23456)).toBe("1.235");
    expect(fmt(0.1 + 0.2)).toBe("0.3");
    expect(fmt(-0.0004)).toBe("0");
    expect(fmt(-0)).toBe("0");
    expect(fmt(-12.3456, 2)).toBe("-12.35");
    expect(fmt(2.5, 0)).toBe("3");
    expect(fmt(123456.789)).toBe("123456.789");
  });
  it("refuses values that would corrupt a frame", () => {
    expect(() => fmt(Number.NaN)).toThrow(RangeError);
    expect(() => fmt(Infinity)).toThrow(RangeError);
    expect(() => fmt(1e9)).toThrow(RangeError);
    expect(() => fmt(1, 4)).toThrow(RangeError);
  });
});

describe("element builders", () => {
  it("escapes attribute values and formats numbers", () => {
    expect(escapeAttribute(`a"b<c>&'`)).toBe("a&quot;b&lt;c&gt;&amp;&#39;");
    expect(rect(0.12345, 2, 10, 5, { fill: "#FF0000", "data-x": `"><script>` }))
      .toBe(`<rect x="0.123" y="2" width="10" height="5" fill="#FF0000" data-x="&quot;&gt;&lt;script&gt;"/>`);
  });
  it("only produces whitelisted elements and self-contained references", () => {
    expect(() => el("text", {}, "x")).toThrow(/not allowed/);
    expect(() => el("image")).toThrow(/not allowed/);
    expect(() => el("script")).toThrow(/not allowed/);
    expect(() => rect(0, 0, 1, 1, { onload: "x" })).toThrow(/not allowed/);
    expect(() => rect(0, 0, 1, 1, { fill: "url(http://example.com/a.svg#p)" })).toThrow(/same document/);
    expect(() => rect(0, 0, 1, 1, { fill: "url(#a) url(file:///x)" })).toThrow(/same document/);
    expect(rect(0, 0, 1, 1, { fill: "url(#grad1)" })).toContain(`fill="url(#grad1)"`);
    expect(() => el("g", { href: "https://x" })).toThrow(/href/);
    expect(() => rect(0, 0, 1, 1, { style: "fill:red" })).toThrow(/style/);
    expect(rect(0, 0, 1, 1, { style: "mix-blend-mode:screen" })).toContain("mix-blend-mode:screen");
  });
  it("drops empty geometry and empty groups", () => {
    expect(rect(0, 0, 0, 10)).toBe("");
    expect(roundRect(0, 0, 10, -1, 2)).toBe("");
    expect(path("")).toBe("");
    expect(polygon([[0, 0], [1, 1]])).toBe("");
    expect(g({ opacity: 0.5 })).toBe("");
    expect(g(undefined, "", false, null)).toBe("");
  });
  it("clamps rounded-rect radii and builds transforms", () => {
    expect(roundRect(0, 0, 10, 4, 9)).toContain(`rx="2" ry="2"`);
    expect(transform(tf.translate(10, 20), false, tf.rotate(45, 5, 5), tf.scale(2), tf.scale(1, 0.5)))
      .toBe("translate(10 20) rotate(45 5 5) scale(2) scale(1 0.5)");
    expect(aboutPivot(10, 10, {})).toBeUndefined();
    expect(aboutPivot(10, 10, { scale: 2 })).toBe("translate(10 10) scale(2) translate(-10 -10)");
  });
  it("builds path data, polygons, rectangles and circles", () => {
    expect(pathData().M(0, 0).L(1.23456, 2).Q(1, 1, 2, 2).C(0, 0, 1, 1, 2, 2).Z().toString()).toBe("M0 0L1.235 2Q1 1 2 2C0 0 1 1 2 2Z");
    expect(polygonPathD([[0, 0], [10, 0], [10, 10]])).toBe("M0 0L10 0L10 10Z");
    expect(rectPathD(1, 2, 3, 4)).toBe("M1 2H4V6H1Z");
    expect(circlePathD(5, 5, 2)).toBe("M3 5a2 2 0 1 0 4 0a2 2 0 1 0 -4 0Z");
  });
  it("outlined text puts the stroke behind the fill", () => {
    expect(outlinedAttrs("#FFF", "#000", 4)).toMatchObject({ "paint-order": "stroke", stroke: "#000", "stroke-width": 4 });
    expect(outlinedAttrs("none", "#000", 4)["paint-order"]).toBeUndefined();
  });
});

describe("SvgDocument", () => {
  const size = { width: 64, height: 32 };
  const build = () => {
    const doc = createSvgDocument(size, { background: "#121216" });
    const grad = doc.linearGradient({ x1: 0, y1: 0, x2: 64, y2: 0, stops: [{ offset: 0, color: "#000000" }, { offset: 1, color: "#FFFFFF", opacity: 0.5 }] });
    const blur = doc.filter([fe.blur({ stdDeviation: 2 })], { x: 0, y: 0, width: 64, height: 32 });
    const mask = doc.mask(rect(0, 0, 32, 32, { fill: "#FFFFFF" }));
    const clip = doc.clipPath(rect(0, 0, 10, 10));
    return doc.render(rect(0, 0, 64, 32, { fill: grad, filter: blur, mask, "clip-path": clip }));
  };
  it("is a self-contained, deterministic SVG 1.1 document with stable ids", () => {
    const first = build(), second = build();
    expect(first).toBe(second);
    expect(first.startsWith(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32" viewBox="0 0 64 32">`)).toBe(true);
    expect(first).toContain(`<linearGradient id="mlg1"`);
    expect(first).toContain(`<filter id="mfx2" color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse"`);
    expect(first).toContain(`<mask id="mmask3"`);
    expect(first).toContain(`<clipPath id="mclip4"`);
    expect(first).toContain(`<rect x="0" y="0" width="64" height="32" fill="#121216"/>`);
    expect(first.endsWith("</svg>")).toBe(true);
    expect(first).not.toMatch(/<text|<image|<script|xlink|http:\/\/(?!www\.w3\.org)/);
  });
  it("validates sizes and id prefixes", () => {
    expect(() => createSvgDocument({ width: 10, height: 10 })).toThrow();
    expect(() => createSvgDocument({ width: 100.5, height: 100 })).toThrow();
    expect(() => createSvgDocument(size, { idPrefix: "9x" })).toThrow();
    expect(createSvgDocument(size, { idPrefix: "ov" }).id("clip")).toBe("ovclip1");
    expect(emptySvg(size)).toBe(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32" viewBox="0 0 64 32"></svg>`);
  });
  it("emits every allowed filter primitive", () => {
    const markup = [
      fe.blur({ stdDeviation: [1, 2], in: "SourceGraphic", result: "b" }),
      fe.offset({ dx: 1, dy: 2, in: "b", result: "o" }),
      fe.colorMatrix({ type: "matrix", values: Array.from({ length: 20 }, (_, index) => (index % 6 === 0 ? 1 : 0)) }),
      fe.colorMatrix({ type: "saturate", values: 0.5 }),
      fe.morphology({ operator: "dilate", radius: 2 }),
      fe.turbulence({ baseFrequency: 0.05, numOctaves: 2, seed: 7, result: "n" }),
      fe.displacementMap({ in: "SourceGraphic", in2: "n", scale: 4 }),
      fe.flood({ color: "#FF0000", opacity: 0.5, result: "f" }),
      fe.composite({ in: "f", in2: "SourceAlpha", operator: "in" }),
      fe.merge(["o", "SourceGraphic"]),
    ].join("");
    expect(markup).toContain(`<feGaussianBlur in="SourceGraphic" stdDeviation="1 2" result="b"/>`);
    expect(markup).toContain(`<feTurbulence type="fractalNoise" baseFrequency="0.05" numOctaves="2" seed="7" result="n"/>`);
    expect(markup).toContain(`<feMerge><feMergeNode in="o"/><feMergeNode in="SourceGraphic"/></feMerge>`);
    expect(() => fe.colorMatrix({ type: "matrix", values: [1, 2] })).toThrow();
    expect(() => fe.turbulence({ baseFrequency: 0.1, seed: 1.5 })).toThrow();
  });
});

describe("circleBezierPathD", () => {
  it("draws an absolute cubic circle that flattenPathD accepts, starting at the right", () => {
    const d = circleBezierPathD(100, 50, 40);
    expect(d.startsWith("M140 50C")).toBe(true);
    expect(d.match(/C/g)).toHaveLength(4);
    expect(d).not.toMatch(/[a-z]|A/);
    const [ring] = flattenPathD(d, { segmentLength: 1 });
    let twice = 0;
    for (let index = 0; index < ring.length; index += 1) {
      const [x1, y1] = ring[index], [x2, y2] = ring[(index + 1) % ring.length];
      twice += x1 * y2 - x2 * y1;
    }
    expect(Math.abs(twice / 2) / (Math.PI * 40 * 40)).toBeCloseTo(1, 3);
    for (const [x, y] of ring) expect(Math.abs(Math.hypot(x - 100, y - 50) - 40)).toBeLessThan(0.04);
    expect([circleBezierPathD(0, 0, 0), circleBezierPathD(0, 0, -1)]).toEqual(["", ""]);
  });
});
