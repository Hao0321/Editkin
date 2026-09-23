import { describe, expect, it } from "vitest";
import { DEFAULT_COLOR } from "../domain/types";
import { buildOcioFragmentShader, ocioGradeUniformValues, type OcioGpuStage } from "./ocioGpu";

const stage = (stageName: "input" | "grade" | "output", key: string): OcioGpuStage => ({
  schema: "editkin.ocio-gpu-stage/v1",
  ocioVersion: "2.5.2",
  key,
  stage: stageName,
  functionName: `editkin_${stageName}_ocio`,
  cacheId: `${stageName}-cache`,
  shaderText: `vec4 editkin_${stageName}_ocio(vec4 value) { return value; }`,
  textures: [],
  uniforms: [],
});

describe("OCIO GPU shader assembly", () => {
  it("uses the generated input and output processors in one fragment program", () => {
    const shader = buildOcioFragmentShader(stage("input", "rec709"), stage("grade", "primary-tone"), stage("output", "rec709_sdr"));
    expect(shader).toContain("editkin_input_ocio(texture(editkin_source, editkin_uv))");
    expect(shader).toContain("editkin_grade_ocio(editkin_working)");
    expect(shader).toContain("editkin_output_ocio(editkin_working)");
    expect(shader).toContain("editkin_hue_rotate(editkin_working.rgb)");
    expect(shader.match(/#version 300 es/g)).toHaveLength(1);
  });

  it("maps editor controls to finite dynamic OCIO grading uniforms", () => {
    const uniforms = ocioGradeUniformValues({
      ...DEFAULT_COLOR,
      brightness: .08,
      contrast: 1.12,
      saturation: .9,
      hue: 18,
      exposure: .75,
      temperature: .3,
      tint: -.2,
      pivot: .55,
      shadows: .2,
      highlights: -.15,
      blacks: .1,
      whites: -.1,
    });
    const brightness = uniforms.editkin_grade_grading_primary_brightness as number[];
    expect(brightness[0]).toBeCloseTo(.0003562330158, 9);
    expect(brightness[1]).toBeCloseTo(.0002859740270, 9);
    expect(brightness[2]).toBeCloseTo(.0002645908565, 9);
    expect(uniforms.editkin_grade_grading_primary_pivot).toBeCloseTo(.71, 12);
    expect(uniforms.editkin_grade_grading_tone_blacksStart).toBeCloseTo(.4009804864, 9);
    expect(uniforms.editkin_grade_grading_tone_blacksWidth).toBeCloseTo(.4009804864, 9);
    expect(uniforms.editkin_grade_grading_tone_whitesStart).toBeCloseTo(.3994699498, 9);
    expect(uniforms.editkin_grade_grading_tone_whitesWidth).toBeCloseTo(.4943796854, 9);
    expect(uniforms.editkin_grade_grading_tone_shadowsM).toBe(1.1);
    expect(uniforms.editkin_grade_grading_tone_highlightsM).toBe(.925);
    expect(uniforms.editkin_grade_hue_radians).toBeCloseTo(Math.PI / 10);
    expect(Object.values(uniforms).flatMap((value) => Array.isArray(value) ? value : typeof value === "number" ? [value] : []).every(Number.isFinite)).toBe(true);
  });
});
