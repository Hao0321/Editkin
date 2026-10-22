import { describe, expect, it } from "vitest";
import { colorGradeNodeV2Schema } from "../domain/colorGradeV2Schema";
import type { ColorGradeNodeV2, ColorGradeV2 } from "../domain/visualTypes";
import { applyColorGradeV2Rgb } from "./gradeV2";
import type { GradeWorkingSpace, Vec3 } from "./gradeV2Color";
import { compileSecondaryHslKeyV1, secondaryHslKeyWeightV1 } from "./secondaryHslV1";
import { boundedEyedropperWorkingRgbV1, eyedropperPrefixGradeV1, neutralBalanceNodeForWorkingRgbV1, projectOriginalSampleThroughPrefixV1, seedQualifierFromWorkingRgbV1 } from "./eyedropperActionsV1";

const widths = { hueHalfWidthDegrees: 12, hueSoftnessDegrees: 5, saturationRadius: .08, lightnessRadius: .08, bandSoftness: .02 };
const samples: Vec3[] = [[.25,.4,.55],[.9,.3,.1],[1,0,0],[0,1,0],[0,0,1],[.001,.8,.2]];
const weights = { rec709_display: [.2126,.7152,.0722], acescct: [.2722287168,.6740817658,.0536895174] };
describe("eyedropper working-code actions", () => {
  for (const space of ["rec709_display", "acescct"] as const) {
    it.each(samples.map(rgb => [rgb]))(`${space} solves bounded neutral gain/offset for %j`, rgb => {
      const target = rgb.reduce((sum, v, i) => sum + v * weights[space][i], 0), node = neutralBalanceNodeForWorkingRgbV1(rgb, space, "balance", "Balance")!;
      expect(colorGradeNodeV2Schema.parse(node)).toEqual(node);
      const out = applyColorGradeV2Rgb({ schema: "editkin.color-grade/v2", nodes: [node] }, space, rgb);
      for (let i=0;i<3;i++) expect(out[i]).toBeCloseTo(target, 12);
      for (const value of Object.values(node.gain!)) expect(value).toBeGreaterThanOrEqual(-1);
      for (const value of Object.values(node.gain!)) expect(value).toBeLessThanOrEqual(2);
    });
    it.each([0,.1,.5,1])(`${space} returns no edit for already neutral code %s`, v => {
      expect(neutralBalanceNodeForWorkingRgbV1([v,v,v], space, "balance", "Balance")).toBeUndefined();
    });
  }
  it("handles absent channels with offset BEFORE gain, and rejects the wrong-order oracle", () => {
    const rgb: Vec3=[0,0,1], node=neutralBalanceNodeForWorkingRgbV1(rgb,"rec709_display","balance","Balance")!, t=.0722;
    expect(node.gain!.r).toBe(2); expect(node.offset!.r).toBeCloseTo(t/3,14);
    expect((rgb[0]+node.offset!.r!)*(1+node.gain!.r!)).toBeCloseTo(t,14);
    expect(Math.abs(rgb[0]*(1+node.gain!.r!)+node.offset!.r!-t)).toBeGreaterThan(.04);
  });
  it("preserves code luma over a fixed 729-point grid without mutating inputs", () => {
    for(let r=0;r<9;r++)for(let g=0;g<9;g++)for(let b=0;b<9;b++){
      const rgb:Vec3=[r/8,g/8,b/8], old=[...rgb], n=neutralBalanceNodeForWorkingRgbV1(rgb,"rec709_display","balance","Balance");
      expect(rgb).toEqual(old); if(!n)continue;
      const target=(.2126*r+.7152*g+.0722*b)/8, out=applyColorGradeV2Rgb({schema:"editkin.color-grade/v2",nodes:[n]},"rec709_display",rgb);
      for(const value of out)expect(Math.abs(value-target)).toBeLessThan(2e-12);
    }
  });
  const malformed:Array<[number[],string]>=[[[],"EYEDROPPER_SAMPLE"],[[0,1],"EYEDROPPER_SAMPLE"],[[0,0,0,1],"EYEDROPPER_SAMPLE"],[[NaN,0,0],"EYEDROPPER_SAMPLE"],[[Infinity,0,0],"EYEDROPPER_SAMPLE"],[[-.001,0,0],"EYEDROPPER_RANGE"],[[1.001,0,0],"EYEDROPPER_RANGE"]];
  it.each(malformed)("refuses invalid/unrepresentable working RGB %j with %s", (rgb,code) => {
    expect(()=>boundedEyedropperWorkingRgbV1(rgb)).toThrow(code);
  });
  it.each([[.8,.1,.11],[.1,.8,.2],[.1,.2,.8],[.5,.5,.5],[0,0,0],[1,1,1]] as Vec3[])("seeds a selector covering the exact working sample %j", (...rgb) => {
    const next=seedQualifierFromWorkingRgbV1({id:"selected",offset:{g:.04}},rgb,widths), s=next.secondaryHslV1!;
    expect(secondaryHslKeyWeightV1(rgb as Vec3,compileSecondaryHslKeyV1(s.qualifier,s.cleanup,s.inverted))).toBe(1);
    if(rgb.every(v=>v===rgb[0]))expect(s.qualifier.hue).toBeUndefined();
  });
  it("keeps inside controls, outside, cleanup and whole-node bypass while starting the new selection", () => {
    const node:ColorGradeNodeV2={id:"selected",enabled:false,label:"Kept",mix:.3,gain:{b:.2},secondaryHslV1:{schema:"editkin.secondary-hsl/v1",selectorSpace:"working_rgb_code",enabled:false,inverted:true,qualifier:{hue:{centerDegrees:10,halfWidthDegrees:2}},cleanup:{blackPoint:.3,whitePoint:.8},outside:{offset:{r:.1}}}};
    const old=structuredClone(node), next=seedQualifierFromWorkingRgbV1(node,[.2,.4,.6],widths);
    expect(node).toEqual(old);expect(next.enabled).toBe(false);expect(next.gain).toEqual(old.gain);expect(next.mix).toBe(.3);
    expect(next.secondaryHslV1).toMatchObject({enabled:true,inverted:false,cleanup:old.secondaryHslV1!.cleanup,outside:old.secondaryHslV1!.outside});
  });
  it("requires explicit finite selector widths instead of inventing defaults", () => {
    expect(()=>seedQualifierFromWorkingRgbV1({id:"n"},[.2,.4,.6],{} as typeof widths)).toThrow();
    expect(()=>seedQualifierFromWorkingRgbV1({id:"n"},[.2,.4,.6],{...widths,hueHalfWidthDegrees:181})).toThrow();
    expect(()=>seedQualifierFromWorkingRgbV1({id:"n"},[.2,.4,.6],{...widths,bandSoftness:NaN})).toThrow();
  });
  it("computes from original source through ONLY nodes preceding the selected node", () => {
    const grade:ColorGradeV2={schema:"editkin.color-grade/v2",nodes:[{id:"prior",offset:{r:.04,g:-.01,b:.02}},{id:"selected",offset:{g:.4}},{id:"after",gamma:{b:1}}],look:{id:"unavailable_test_look",strength:1},finishing:{grain:{amount:.5}}};
    const before=structuredClone(grade), prefix=eyedropperPrefixGradeV1(grade,"selected"), rgb=projectOriginalSampleThroughPrefixV1([96,124,144],prefix);
    expect(rgb).toEqual([96/255+.04,124/255-.01,144/255+.02]);expect(prefix).not.toHaveProperty("look");expect(prefix).not.toHaveProperty("finishing");
    expect(prefix.nodes).toHaveLength(1);expect(grade).toEqual(before);expect(()=>eyedropperPrefixGradeV1(grade,"missing")).toThrow(/EYEDROPPER_NODE/);
  });
  it("does not guess a spatial window or bypass a missing prefix LUT", () => {
    expect(()=>eyedropperPrefixGradeV1({schema:"editkin.color-grade/v2",nodes:[{id:"a",windowMaskId:"missing"}]} as unknown as ColorGradeV2)).toThrow();
    const sha="a".repeat(64), prefix:ColorGradeV2={schema:"editkin.color-grade/v2",nodes:[{id:"a",lut:{id:`lut:${sha.slice(0,16)}`,sha256:sha,strength:1}}]};
    expect(()=>projectOriginalSampleThroughPrefixV1([96,124,144],prefix)).toThrow();
  });
});
