import { describe, expect, it } from "vitest";
import { GRADE_V2_LUT_GLSL, lut3dSamplerGlsl } from "./gradeV2Preview";

/** The ACES display-referred preview samples the export's inverse and SDR output tables with the grade table's sampler. */
describe("lut3dSamplerGlsl", () => {
  const body = (glsl: string) => glsl.slice(glsl.indexOf("float lutMax")).replace(/\s+/g, " ").trim();

  it("is the grade table's vf_lut3d tetrahedral texelFetch sampler under another name", () => {
    const grade = body(GRADE_V2_LUT_GLSL).replaceAll("editkin_grade_lut_size", "editkin_x_size").replaceAll("editkin_lut_at", "editkin_x_at");
    const generated = body(lut3dSamplerGlsl("editkin_x"));
    expect(generated).toBe(grade);
    const declarations = lut3dSamplerGlsl("editkin_x");
    expect(declarations).toContain("uniform highp sampler3D editkin_x_lut;");
    expect(declarations).toContain("uniform float editkin_x_size;");
    expect(declarations).toContain("vec3 editkin_x(vec3 rgb) {");
    expect(declarations).toContain("texelFetch(editkin_x_lut, index, 0)");
  });

  it("refuses names that are not plain GLSL identifiers", () => {
    expect(() => lut3dSamplerGlsl("Editkin")).toThrow(/invalid/);
    expect(() => lut3dSamplerGlsl("editkin x")).toThrow(/invalid/);
  });
});
