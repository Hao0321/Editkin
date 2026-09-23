import {describe,expect,it} from "vitest";
import {createDemoProject} from "../domain/demo";
import {DEFAULT_CLIP_LAYER} from "../domain/types";
import {assertStaticSourceWhiteBalance as assert} from "./linearWhiteBalanceSupport";
describe("static source WB admission independent guard",()=>{
 it("accepts static source gain and zero precomposition",()=>{const p=createDemoProject(),c=p.tracks[0].clips[0];expect(()=>assert(c,{...p.assets[0],compositionId:"nested"})).not.toThrow();c.color.whiteBalanceBlue=.4;expect(()=>assert(c,p.assets[0])).not.toThrow();});
 it.each(["adjustment","controller"] as const)("rejects nonzero gain on %s without mutation",role=>{const p=createDemoProject(),c=p.tracks[0].clips[0];c.color.whiteBalanceBlue=.4;c.layer={...DEFAULT_CLIP_LAYER,role};const original=JSON.stringify(c);expect(()=>assert(c,p.assets[0])).toThrow();expect(JSON.stringify(c)).toBe(original);});
 it("rejects initially-zero animated gain and nonzero precomposition asset",()=>{const p=createDemoProject(),c=p.tracks[0].clips[0];c.keyframes=[{id:"wb",time:1,easing:"linear",transform:{...c.transform},color:{...c.color,whiteBalanceGreen:.4}}];expect(()=>assert(c,p.assets[0])).toThrow(/動畫/);c.keyframes=[];c.color.whiteBalanceRed=.2;expect(()=>assert(c,{...p.assets[0],compositionId:"nested"})).toThrow(/原始素材域/);});
});
