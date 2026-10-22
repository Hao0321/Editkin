import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "./catalog";
import {
  generateAnyMotionFrame, generateMotionFrame, generateTransitionFrame, itemFrameTime, motionFrameCount, motionFrameRate, motionFrameTime, transitionFrameTime,
} from "./frames";
import { resolveMotionLibraryParams } from "./params";
import { defineTextMotion, type TextMotionItem, type TransitionMotionItem } from "./types";

describe("frame clock", () => {
  it("parses frame rates into rationals", () => {
    expect(motionFrameRate(30)).toMatchObject({ numerator: 30, denominator: 1, text: "30/1" });
    expect(motionFrameRate(30000 / 1001)).toMatchObject({ numerator: 30000, denominator: 1001, text: "30000/1001" });
    expect(motionFrameRate(23.976)).toMatchObject({ numerator: 2997, denominator: 125 });
    expect(motionFrameRate({ numerator: 60000, denominator: 1001 }).value).toBeCloseTo(59.94, 2);
    expect(() => motionFrameRate(0.5)).toThrow();
    expect(() => motionFrameRate(300)).toThrow();
  });
  it("counts and times frames from t = i / fps", () => {
    const fps = motionFrameRate(30);
    expect(motionFrameCount(3, fps)).toBe(90);
    expect(motionFrameCount(0.45, fps)).toBe(14);
    expect(motionFrameCount(0.01, fps)).toBe(1);
    expect(motionFrameTime(45, fps)).toBe(1.5);
    expect(motionFrameCount(4, motionFrameRate(30000 / 1001))).toBe(120);
    expect(() => motionFrameTime(-1, fps)).toThrow();
    expect(() => motionFrameCount(0, fps)).toThrow();
  });
  it("transitions use the endpoint clock: first frame t = 0, last frame exactly t = duration", () => {
    const fps = motionFrameRate(30), frames = motionFrameCount(0.5, fps);
    expect(frames).toBe(15);
    expect(transitionFrameTime(0, frames, 0.5)).toBe(0);
    expect(transitionFrameTime(7, frames, 0.5)).toBe(0.25);
    expect(transitionFrameTime(14, frames, 0.5)).toBe(0.5);
    expect(transitionFrameTime(0, 1, 0.3)).toBe(0.3);
    expect(itemFrameTime("transition", 14, frames, fps, 0.5)).toBe(0.5);
    expect(itemFrameTime("text", 14, frames, fps, 0.5)).toBeCloseTo(14 / 30, 12);
    expect(() => transitionFrameTime(15, 15, 0.5)).toThrow();
  });
});

describe("checked frame generation", () => {
  const size = { width: 1080, height: 1920 };
  it("returns SVG documents and transition pairs", () => {
    const t01 = getMotionLibraryItem("T01") as TextMotionItem;
    expect(generateMotionFrame(t01, t01.defaultParams, 1, size)).toMatch(/^<svg [^]*<\/svg>$/);
    const x01 = getMotionLibraryItem("X01") as TransitionMotionItem;
    const frame = generateTransitionFrame(x01, resolveMotionLibraryParams(x01), 0.2, size);
    expect(frame.matte).toMatch(/^<svg /);
    expect(frame.overlay).toMatch(/^<svg /);
    expect(generateAnyMotionFrame(getMotionLibraryItem("B01"), getMotionLibraryItem("B01").defaultParams, 0, size)).toHaveProperty("svg");
  });
  it("rejects malformed generator output, bad sizes and times", () => {
    const t01 = getMotionLibraryItem("T01") as TextMotionItem;
    const broken = { ...t01, generate: defineTextMotion("T01", () => "<svg><text>x</text></svg>").generate } as TextMotionItem;
    expect(() => generateMotionFrame(broken, t01.defaultParams, 0, size)).toThrow(/invalid frame SVG|forbidden/);
    const text = { ...t01, generate: defineTextMotion("T01", () => `<svg xmlns="http://www.w3.org/2000/svg"><text>x</text></svg>`).generate } as TextMotionItem;
    expect(() => generateMotionFrame(text, t01.defaultParams, 0, size)).toThrow(/forbidden/);
    expect(() => generateMotionFrame(t01, t01.defaultParams, -1, size)).toThrow();
    expect(() => generateMotionFrame(t01, t01.defaultParams, Number.NaN, size)).toThrow();
    expect(() => generateMotionFrame(t01, t01.defaultParams, 0, { width: 8, height: 8 })).toThrow();
  });
});
