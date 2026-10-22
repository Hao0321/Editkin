import { describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "./catalog";
import { MOTION_PALETTES, resolveMotionPalette } from "./palettes";
import { canonicalJson, resolveMotionLibraryParams } from "./params";
import { MotionLibraryParamsError, type TextMotionItem, type TransitionMotionItem } from "./types";

describe("palettes", () => {
  it("defines Hao's five themes and the eleven measured reference themes exactly", () => {
    const card = { bg: "#15191F", ink: "#121214", paper: "#F5F1E6" };
    expect(MOTION_PALETTES).toEqual({
      hao_impact: { bg: "#121216", ink: "#121216", paper: "#F3EFE6", accent: "#FF5A4E", accent2: "#FFB03A" },
      swiss_blue: { bg: "#F4F4F0", ink: "#111316", paper: "#FFFFFF", accent: "#2457F5", accent2: "#9DB4FF" },
      travel_note: { bg: "#FBF3E4", ink: "#2B2118", paper: "#FFFDF7", accent: "#E86A3A", accent2: "#3B8C7E" },
      tech_spec: { bg: "#0E1116", ink: "#0E1116", paper: "#E8EDF2", accent: "#2ED3C0", accent2: "#B39DFF" },
      esports_hud: { bg: "#0B0B12", ink: "#0B0B12", paper: "#EAF6FF", accent: "#39FF88", accent2: "#FF2E88" },
      ref_lime: { ...card, accent: "#C7FF3E", accent2: "#435A08" },
      ref_coral: { ...card, accent: "#FF7054", accent2: "#7C2E1E" },
      ref_violet: { ...card, accent: "#9C7EFF", accent2: "#46339A" },
      ref_teal: { ...card, accent: "#2DDAC4", accent2: "#016B63" },
      ref_gold: { ...card, accent: "#FFC93D", accent2: "#7C5501" },
      ref_red: { ...card, accent: "#FD4E4B", accent2: "#7A1E1E" },
      ref_yellow: { ...card, accent: "#FECB2C", accent2: "#845400" },
      ref_aqua: { ...card, accent: "#1AD4C4", accent2: "#016B65" },
      ref_lavender: { ...card, accent: "#B895FF", accent2: "#4A3A99" },
      ref_orange: { ...card, accent: "#FE8A3E", accent2: "#7A3A0E" },
      ref_pink: { ...card, accent: "#FD4F89", accent2: "#7A1F3B" },
    });
    for (const palette of Object.values(MOTION_PALETTES)) expect(Object.isFrozen(palette)).toBe(true);
    expect(resolveMotionPalette({ theme: "ref_lime" }, MOTION_PALETTES.hao_impact)).toEqual(MOTION_PALETTES.ref_lime);
  });
  it("overrides any single role, switches themes and normalises hex", () => {
    const base = MOTION_PALETTES.hao_impact;
    expect(resolveMotionPalette({ accent: "#00ff00" }, base)).toEqual({ ...base, accent: "#00FF00" });
    expect(resolveMotionPalette({ theme: "swiss_blue", ink: "#000000" }, base)).toEqual({ ...MOTION_PALETTES.swiss_blue, ink: "#000000" });
    expect(resolveMotionPalette(undefined, base)).toEqual(base);
    for (const role of ["bg", "ink", "paper", "accent", "accent2"] as const) {
      expect(resolveMotionPalette({ [role]: "#123456" }, base)[role]).toBe("#123456");
    }
    expect(() => resolveMotionPalette({ accent: "red" }, base)).toThrow();
    expect(() => resolveMotionPalette({ accent: "#12345" }, base)).toThrow();
    expect(() => resolveMotionPalette({ highlight: "#123456" } as never, base)).toThrow();
    expect(() => resolveMotionPalette({ theme: "neon" } as never, base)).toThrow();
  });
});

describe("resolveMotionLibraryParams", () => {
  const t01 = getMotionLibraryItem("T01") as TextMotionItem;
  const x01 = getMotionLibraryItem("X01") as TransitionMotionItem;
  it("merges partial input over the item defaults and freezes the result", () => {
    const params = resolveMotionLibraryParams(t01, { palette: { accent: "#00ff00" }, lines: ["衝刺"], energy: "hype", seed: 42 });
    expect(params).toEqual({ ...t01.defaultParams, palette: { ...t01.defaultParams.palette, accent: "#00FF00" }, lines: ["衝刺"], energy: "hype", seed: 42 });
    expect(Object.isFrozen(params)).toBe(true);
    expect(Object.isFrozen(params.palette)).toBe(true);
    expect(Object.isFrozen(params.lines)).toBe(true);
    expect(resolveMotionLibraryParams(t01)).toEqual(t01.defaultParams);
    expect(resolveMotionLibraryParams(t01, { palette: { theme: "tech_spec" } }).palette).toEqual(MOTION_PALETTES.tech_spec);
  });
  it("text plates default to none and accept the palette plate roles", () => {
    expect(resolveMotionLibraryParams(t01).plate).toBe("none");
    for (const plate of ["none", "bg", "accent", "paper"] as const) expect(resolveMotionLibraryParams(t01, { plate }).plate).toBe(plate);
    expect(() => resolveMotionLibraryParams(t01, { plate: "accent2" })).toThrow(MotionLibraryParamsError);
    expect(() => resolveMotionLibraryParams(x01, { plate: "bg" })).toThrow(MotionLibraryParamsError);
  });
  it("rejects invalid or unknown input with the item id", () => {
    const bad: unknown[] = [
      { lines: [] }, { lines: ["一", "二", "三", "四", "五"] }, { lines: [""] }, { lines: ["   "] },
      { lines: [`上${String.fromCharCode(10)}下`] }, { lines: ["字".repeat(49)] },
      { durationSeconds: 0.1 }, { durationSeconds: 31 }, { energy: "loud" }, { seed: -1 }, { seed: 1.5 }, { font: "comic" },
      { unknown: 1 }, { palette: { accent: "#GG0000" } },
    ];
    for (const input of bad) {
      expect(() => resolveMotionLibraryParams(t01, input), JSON.stringify(input)).toThrow(MotionLibraryParamsError);
    }
    try { resolveMotionLibraryParams(t01, { seed: -1 }); } catch (error) {
      expect((error as MotionLibraryParamsError).itemId).toBe("T01");
      expect((error as MotionLibraryParamsError).issues[0]).toMatch(/^seed:/);
    }
  });
  it("validates transition durations and directions against the item", () => {
    expect(resolveMotionLibraryParams(x01, { direction: "bottom_to_top", durationSeconds: 2 }).direction).toBe("bottom_to_top");
    expect(() => resolveMotionLibraryParams(x01, { durationSeconds: 0.1 })).toThrow(MotionLibraryParamsError);
    expect(() => resolveMotionLibraryParams(x01, { durationSeconds: 2.5 })).toThrow(MotionLibraryParamsError);
    const unimplemented = getMotionLibraryItem("X09") as TransitionMotionItem;
    expect(() => resolveMotionLibraryParams(unimplemented, { direction: "left_to_right" })).toThrow(/does not support/);
  });
  it("background speed 0.25–2 and density 0.5–2, both snapped to quarter steps", () => {
    const b01 = getMotionLibraryItem("B01");
    expect(resolveMotionLibraryParams(b01, { speed: 0.25, density: 0.5 })).toMatchObject({ speed: 0.25, density: 0.5 });
    expect(resolveMotionLibraryParams(b01, { speed: 2, density: 2 })).toMatchObject({ speed: 2, density: 2 });
    expect(resolveMotionLibraryParams(b01, { speed: 1.3, density: 1.4 })).toMatchObject({ speed: 1.25, density: 1.5 });
    expect(resolveMotionLibraryParams(b01, { speed: 0.3, density: 1.9 })).toMatchObject({ speed: 0.25, density: 2 });
    expect(resolveMotionLibraryParams(b01, { speed: 0.62 })).toMatchObject({ speed: 0.5 });
    for (const input of [{ speed: 0.2 }, { speed: 2.1 }, { speed: 4 }, { speed: 0 }, { density: 0.4 }, { density: 2.1 }, { density: 0 }]) {
      expect(() => resolveMotionLibraryParams(b01, input), JSON.stringify(input)).toThrow(MotionLibraryParamsError);
    }
  });
});

describe("canonicalJson", () => {
  it("sorts keys at every depth and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 2, y: 1 }], c: undefined }, e: -0 })).toBe(`{"a":{"d":[1,{"y":1,"z":2}]},"b":1,"e":0}`);
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
  });
});
