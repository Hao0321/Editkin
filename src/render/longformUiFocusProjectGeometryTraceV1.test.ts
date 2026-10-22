import {describe,it,expect} from "vitest";
import {LongformUiFocusProjectGeometryTraceV1} from "./longformUiFocusProjectGeometryTraceV1";
import type {LongformUiFocusGeometryWitnessV1} from "../domain/longformUiFocusProjectGeometryV1";
function logs(frame=0){return["fit","clock","layout","input","scaled","output","position"].flatMap(stage=>[
  `[showinfo@uif_${stage} @ abc] config in time_base: 1/30, frame_rate: 30/1`,
  `[showinfo@uif_${stage} @ abc] n: ${frame} pts: ${stage==='position'?6+frame:frame} pts_time:0 duration: 1 duration_time:0.033 fmt:rgba sar:1/1 s:640x360 i:P checksum:12345678 plane_checksum:[12345678]`]);}
describe("actual named FF geometry trace",()=>{
  it("joins complete per-frame stage PTS/dimensions to actual integer overlay placement",()=>{
    const rows:LongformUiFocusGeometryWitnessV1[]=[],trace=new LongformUiFocusProjectGeometryTraceV1(6,{numerator:1,denominator:30},"scale-rotate",row=>rows.push(row));
    for(const line of logs())trace.line(line);expect(rows).toHaveLength(0);
    trace.line("[overlay@uif_place @ abc] n:7.000000 t:0.200000 pos:nan x:3.750000 xi:2 y:-1.000000 yi:-2");
    expect(trace.finish().framesObserved).toBe(1);expect(rows[0].projectFrame).toBe(6);expect(rows[0].geometryPts).toBe(0);expect(rows[0].placement).toEqual({x:2,y:-2});
  });
  it("refuses unsupported/contradictory log format, timebase and missing output",()=>{
    const make=()=>new LongformUiFocusProjectGeometryTraceV1(6,{numerator:1,denominator:30},"scale-rotate",()=>{});
    expect(()=>make().line("[showinfo@uif_clock @ abc] config in time_base: 1/24")).toThrow("TIME_BASE");
    const trace=make();for(const line of logs())trace.line(line);expect(()=>trace.finish()).toThrow("INCOMPLETE");
    expect(()=>trace.line("[showinfo@uif_output @ abc] n:broken")).toThrow("IMAGE");
  });
  it("refuses reordered stage frames and a changed fitted raster",()=>{
    const trace=new LongformUiFocusProjectGeometryTraceV1(6,{numerator:1,denominator:30},"scale-rotate",()=>{});
    for(const line of logs())trace.line(line);
    expect(()=>trace.line(logs()[3])).toThrow("IMAGE_ORDER");
    expect(()=>trace.line(logs()[1].replace('640x360','639x360'))).toThrow("FIT_CHANGED");
  });

  it("uses an explicit base origin without treating local overlay n as a project frame",()=>{
    const rows:LongformUiFocusGeometryWitnessV1[]=[],trace=new LongformUiFocusProjectGeometryTraceV1(6,{numerator:1,denominator:30},"scale-rotate",row=>rows.push(row),6);
    for(const line of logs())trace.line(line);
    trace.line("[overlay@uif_place @ abc] n:1.000000 t:0.200000 pos:nan x:3.750000 xi:2 y:-1.000000 yi:-2");
    expect(trace.finish().framesObserved).toBe(1);expect(rows[0].projectFrame).toBe(6);
    expect(()=>new LongformUiFocusProjectGeometryTraceV1(6,{numerator:1,denominator:30},"scale-rotate",()=>{},7)).toThrow("CONFIG");
  });
});
