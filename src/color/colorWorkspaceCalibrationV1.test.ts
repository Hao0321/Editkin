import { describe, expect, it } from "vitest";
import { measureColorWorkspaceCalibrationV1, type ColorWorkspaceCalibrationFrameV1 as Frame } from "./colorWorkspaceCalibrationV1";

function frame(values:number[],transfer:Frame["transfer"]="srgb"):Frame {
  return {width:values.length/4,height:1,data:new Uint8Array(values),transfer,primaries:"rec709-d65"};
}
const identity=()=>frame([0,0,0,255,11,128,243,255,255,255,255,255]);
describe("workspace frame-pair calibration preserves display conventions and strict evidence bounds",()=>{
  it.each(["srgb","bt1886"] as const)("measures exact %s identity without mutating either buffer",transfer=>{
    const a=identity(),b=identity();a.transfer=transfer;b.transfer=transfer;
    const before=[Array.from(a.data),Array.from(b.data)],r=measureColorWorkspaceCalibrationV1(a,b);
    expect(r.deltaE00).toMatchObject({p99:0,maximum:0,mean:0});expect(r.comparedPixels).toBe(3);expect(r.passesFixedFrameGate).toBe(true);
    expect([Array.from(a.data),Array.from(b.data)]).toEqual(before);
    expect(r.routeCalibrationComplete).toBe(false);expect(r.browserNativeParityMeasured).toBe(false);expect(r.sourceMediaMeasured).toBe(false);
  });
  it("decodes distinct sRGB and BT.1886 values to the same relative light",()=>{
    // 128/255 in ideal BT.1886 is ~121/255 sRGB; equal code values are different light.
    const reference=frame([128,128,128,255],"bt1886"),converted=frame([121,121,121,255]);
    expect(measureColorWorkspaceCalibrationV1(converted,reference).deltaE00.maximum).toBeLessThan(.3);
    expect(measureColorWorkspaceCalibrationV1(frame([128,128,128,255]),reference).deltaE00.maximum).toBeGreaterThan(2);
  });
  it("keeps the worst pixel even when the nearest-rank p99 excludes a one-percent outlier",()=>{
    const bytes=new Uint8Array(100*4);for(let i=3;i<bytes.length;i+=4)bytes[i]=255;
    const a:Frame={...identity(),width:100,data:bytes.slice()},b={...a,data:bytes.slice()};a.data[99*4]=255;
    const r=measureColorWorkspaceCalibrationV1(a,b);
    expect(r.deltaE00.p99).toBe(0);expect(r.deltaE00.maximum).toBeGreaterThan(5);expect(r.deltaE00.worstPixel).toEqual({x:99,y:0});expect(r.passesFixedFrameGate).toBe(false);
    const red=measureColorWorkspaceCalibrationV1(frame([255,0,0,255]),frame([0,0,0,255]));
    expect(r.deltaE00.mean).toBeCloseTo(red.deltaE00.maximum/100,12);
  });
  it("reports the row coordinate and accepts an offset clamped canvas view",()=>{
    const bytes=new Uint8ClampedArray([9,9,9,9,0,0,0,255,0,0,0,255,9,9,9,9]);
    const a:Frame={...identity(),width:1,height:2,data:bytes.subarray(4,12)},b={...a,data:a.data.slice()};a.data[4]=255;
    const r=measureColorWorkspaceCalibrationV1(a,b);expect(r.deltaE00.worstPixel).toEqual({x:0,y:1});expect(r.comparedPixels).toBe(2);
  });
  it("refuses geometry mismatches rather than resizing or comparing a subset",()=>{
    const a=frame([0,0,0,255,0,0,0,255]),b={...a,width:1,height:2};
    expect(()=>measureColorWorkspaceCalibrationV1(a,b)).toThrow("COLOR_CALIBRATION_GEOMETRY");
  });
  it.each(["hlg","pq","acescct","linear","rec709-oetf",undefined])("refuses unnormalized transfer %s",transfer=>{
    expect(()=>measureColorWorkspaceCalibrationV1({...identity(),transfer} as Frame,identity())).toThrow("COLOR_CALIBRATION_ENCODING");
  });
  it.each(["p3-d65","bt2020","aces-ap1",undefined])("refuses unnormalized primaries %s",primaries=>{
    expect(()=>measureColorWorkspaceCalibrationV1({...identity(),primaries} as Frame,identity())).toThrow("COLOR_CALIBRATION_ENCODING");
  });
  it.each([0,1,128,254])("refuses alpha %i instead of hiding difficult pixels",alpha=>{
    const a=identity();a.data[3]=alpha;
    expect(()=>measureColorWorkspaceCalibrationV1(a,identity())).toThrow("COLOR_CALIBRATION_OPAQUE_REQUIRED");
    expect(()=>measureColorWorkspaceCalibrationV1(identity(),a)).toThrow("COLOR_CALIBRATION_OPAQUE_REQUIRED");
  });
  it.each([0,-1,1.5,NaN,Infinity,4097])("refuses width %s before pixel traversal",width=>{
    expect(()=>measureColorWorkspaceCalibrationV1({...identity(),width},identity())).toThrow("COLOR_CALIBRATION_FRAME_BUDGET");
  });
  it("rejects missing/extra bytes, excessive pixels, shared and resizable storage",()=>{
    for(const data of [new Uint8Array(11),new Uint8Array(13),new Uint8Array(new SharedArrayBuffer(12)),new Uint8Array(Reflect.construct(ArrayBuffer,[12,{maxByteLength:24}]))])
      expect(()=>measureColorWorkspaceCalibrationV1({...identity(),data},identity())).toThrow("COLOR_CALIBRATION_FRAME_BUDGET");
    expect(()=>measureColorWorkspaceCalibrationV1({...identity(),width:641,height:360,data:new Uint8Array(641*360*4)},identity())).toThrow("COLOR_CALIBRATION_FRAME_BUDGET");
  });
});
