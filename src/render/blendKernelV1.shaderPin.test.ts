import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BLEND_KERNEL_WGSL_SOFT_LIGHT_V1, BLEND_MODES_V1, RETIRED_PEGTOP_SOFT_LIGHT_WGSL, sceneLinearBlendV1, w3cBlendV1 } from "./blendKernelV1";

/**
 * Native shader pins (P1/P2). The native image compositor family is measured on the GPU by the parity harness; the
 * resident video shaders (windows_video.rs) and the scene-linear video shader cannot run headlessly here, so their
 * blend text is pinned to the kernel's WGSL and the formulas are re-evaluated in JS.
 */
const source = (path: string) => readFileSync(resolve(fileURLToPath(new URL("../../spikes/gpu-compositor/src/", import.meta.url)), path), "utf8");
const count = (text: string, needle: string) => text.split(needle).length - 1;

describe("native blend shaders follow blend kernel v1", () => {
  it.each([["compositor.wgsl", 1], ["compositor_float_input.wgsl", 1], ["compositor_packed.wgsl", 1], ["windows_video.rs", 2]] as const)(
    "%s evaluates W3C soft light and no Pegtop formula", (file, expected) => {
      const text = source(file);
      expect(count(text, BLEND_KERNEL_WGSL_SOFT_LIGHT_V1)).toBe(expected);
      expect(text).not.toContain(RETIRED_PEGTOP_SOFT_LIGHT_WGSL);
    });

  it("the scene-linear video shader and the CPU compositor carry the scene-linear rule", () => {
    const scene = source("scene_linear_video.wgsl");
    expect(scene).toContain("return mixed + (backdrop - b);");
    expect(scene).toContain("if mode == 3u { return backdrop * clamp(source, vec3<f32>(0.0), vec3<f32>(1.0)); }");
    expect(scene).not.toContain(RETIRED_PEGTOP_SOFT_LIGHT_WGSL);
    const cpu = source("main.rs");
    expect(cpu).toContain("fn w3c_soft_light(backdrop: f32, source: f32) -> f32");
    expect(cpu).toContain("fn scene_linear_blend(backdrop: f32, source: f32, mode: BlendMode) -> f32");
    expect(cpu).not.toMatch(/\(1\.0 - 2\.0 \* source\[channel\]\) \* backdrop\[channel\] \* backdrop\[channel\]/);
  });

  it("the pinned WGSL soft light equals the JS W3C reference", () => {
    // Direct JS transcription of BLEND_KERNEL_WGSL_SOFT_LIGHT_V1 (component-wise select).
    const wgsl = (backdrop: number, s: number) => {
      const d = backdrop <= 0.25 ? ((16 * backdrop - 12) * backdrop + 4) * backdrop : Math.sqrt(Math.max(backdrop, 0));
      return s <= 0.5 ? backdrop - (1 - 2 * s) * backdrop * (1 - backdrop) : backdrop + (2 * s - 1) * (d - backdrop);
    };
    for (let b = 0; b <= 1; b += 1 / 32) for (let s = 0; s <= 1; s += 1 / 32) expect(wgsl(b, s)).toBeCloseTo(w3cBlendV1("soft_light", b, s), 12);
  });

  it("the scene-linear rule keeps every identity for out-of-range backdrops", () => {
    for (const b of [-0.01, 0, 0.18, 1, 4, 96]) {
      expect(sceneLinearBlendV1("screen", b, 0)).toBeCloseTo(b, 12);
      expect(sceneLinearBlendV1("multiply", b, 1)).toBeCloseTo(b, 12);
      expect(sceneLinearBlendV1("multiply", b, 96)).toBeCloseTo(b, 12);
      expect(sceneLinearBlendV1("overlay", b, 0.5)).toBeCloseTo(Math.max(0, Math.min(1, b)) + (b - Math.max(0, Math.min(1, b))), 12);
      expect(sceneLinearBlendV1("lighten", b, Math.min(b, 0))).toBeCloseTo(b, 12);
    }
    for (const mode of BLEND_MODES_V1) for (const b of [0, 0.25, 0.6, 1]) for (const s of [0, 0.3, 1]) {
      if (mode === "add" || mode === "multiply" || mode === "normal") continue;
      // Inside [0, 1] the rule is exactly W3C.
      expect(sceneLinearBlendV1(mode, b, s)).toBeCloseTo(w3cBlendV1(mode, b, s), 12);
    }
  });
});
