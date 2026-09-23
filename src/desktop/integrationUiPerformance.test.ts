import {describe,it,expect} from "vitest";
import {createPerformanceSeries,installIntegrationUiPerformance} from "./integrationUiPerformance";
describe("integration-only bounded performance measurement",()=>{
 it("does not install without explicit native true",()=>{expect(()=>installIntegrationUiPerformance(false)()).not.toThrow();expect(()=>installIntegrationUiPerformance(undefined as unknown as boolean)()).not.toThrow();});
 it("records no invented zero/PASS without observations",()=>{expect(createPerformanceSeries().summary()).toEqual({n:0,p95:null,max:null});});
 it("bounds samples to200, reports actual p95/max and resets",()=>{const ring=createPerformanceSeries();for(let i=1;i<=250;i++)ring.add(i);expect(ring.summary()).toEqual({n:200,p95:240,max:250});ring.reset();expect(ring.summary().n).toBe(0);});
 it("rejects invalid limits and ignores invalid timings",()=>{expect(()=>createPerformanceSeries(201)).toThrow();const ring=createPerformanceSeries();for(const value of [NaN,Infinity,-1])ring.add(value);expect(ring.summary().n).toBe(0);ring.add(0);expect(ring.summary()).toEqual({n:1,p95:0,max:0});});
});
