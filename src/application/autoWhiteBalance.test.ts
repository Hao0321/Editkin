import { describe, expect, it } from "vitest";
import { analyzeShotColor } from "../color/shotColorAnalysis";
import { measureReferenceWhiteBalanceFrame } from "./referenceWhiteBalance";
import { selectAutoWhiteBalanceCandidate } from "./autoWhiteBalance";
import { measureLinearWhiteBalanceReference } from "./linearWhiteBalanceReference";

function candidate(temperature: number, reference: number[], background: number[]) {
  const pixels = new Uint8Array(32 * 32 * 3);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) pixels.set(x < 8 && y < 8 ? reference : background, (y * 32 + x) * 3);
  const inputs = [0,1].map(i=>({sampleId:`kf-${i+1}`,timeSeconds:i,width:32,height:32,pixels}));
  const linear = temperature===0 ? [.29,.26,.23] : [.264212,.264212,.264212];
  return { whiteBalanceRed: temperature, whiteBalanceGreen:0, whiteBalanceBlue:0,
    frames: inputs.map(input=>measureLinearWhiteBalanceReference({...input,pixels:Float32Array.from(Array.from({length:1024},()=>[...linear,1]).flat()),roi:{x:0,y:0,width:.25,height:.25},basis:"linear-rec709",inputConvention:"rec709-oetf",reference:"caller-declared-neutral"})),
    outputReferences: inputs.map(input=>measureReferenceWhiteBalanceFrame({ ...input, roi: { x: 0, y: 0, width: .25, height: .25 }, transfer: "bt709-oetf", reference: "caller-declared-neutral" })),
    globalMeasurements: analyzeShotColor(inputs.map(input=>({ ...input, format: "rgb8", transfer: "bt709-oetf", primaries: "bt709", range: "full" }))) };
}

describe("reference white balance whole-frame clipping guards", () => {
  it("rejects newly clipped green highlights even when another channel was already clipped", () => {
    const base = candidate(0, [140, 135, 130], [255, 100, 100]);
    const changed = candidate(.25, [135, 135, 135], [255, 255, 100]);
    expect(base.globalMeasurements.frames[0].encodedEndpoints.anyHigh).toEqual(changed.globalMeasurements.frames[0].encodedEndpoints.anyHigh);
    const result = selectAutoWhiteBalanceCandidate([base, changed], {});
    expect(result.selectedIndex).toBe(0);
    expect(result.candidates[1].reasons.join(" ")).toMatch(/channel-high/);
  });
  it("rejects newly crushed green shadows even when another channel was already zero", () => {
    const result = selectAutoWhiteBalanceCandidate([
      candidate(0, [140, 135, 130], [0, 140, 140]), candidate(.25, [135, 135, 135], [0, 0, 140]),
    ], {});
    expect(result.selectedIndex).toBe(0);
    expect(result.candidates[1].reasons.join(" ")).toMatch(/channel-low/);
  });
  it("still accepts a neutral-reference improvement without clipping other channels", () => {
    expect(selectAutoWhiteBalanceCandidate([candidate(0, [140, 135, 130], [80, 140, 180]),
      candidate(.25, [135, 135, 135], [80, 140, 180])], {}).selectedIndex).toBe(1);
  });
});
