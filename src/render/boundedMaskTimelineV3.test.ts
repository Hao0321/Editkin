import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { boundedMaskTimelineExpressionV3 } from "./boundedMaskTimelineV3";
import { combinedMaskAlphaExpression } from "./maskFilters";
import { compileClipAlphaPlan } from "../domain/clipAlphaPlan";
import { createEmptyProject } from "../domain/editGraph";
import { createClipMask } from "../domain/masks";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type TimelineClip } from "../domain/types";

const n = (value: number) => value.toFixed(5).replace(/0+$/, "").replace(/\.$/, "") || "0";
describe("bounded v3 mask timeline expression", () => {
  it("uses the existing nearest-time/tie boundary with logarithmic expression depth", () => {
    expect(boundedMaskTimelineExpressionV3([0,1/30,2/30], i=>String(i),n))
      .toBe("if(lt(T\\,0.05)\\,if(lt(T\\,0.01667)\\,0\\,1)\\,2)");
    expect(boundedMaskTimelineExpressionV3([0],()=>"255",n)).toBe("255");
    for (const times of [[],[0,0],[1,0],[0,NaN],Array.from({length:1801},(_,i)=>i/30)]) {
      expect(()=>boundedMaskTimelineExpressionV3(times,()=>"0",n)).toThrow();
    }
  });
  it("executes all 1800 frames in the bundled FFmpeg parser without recursion failure or frame loss", async () => {
    const ff=resolve("vendor/ffmpeg/win32-x64/ffmpeg.exe"),root=await mkdtemp(join(tmpdir(),"editkin-mask-v3-"));
    const before=createHash("sha256").update(await readFile(ff)).digest("hex");
    const expression=boundedMaskTimelineExpressionV3(Array.from({length:1800},(_,i)=>i/30),i=>String(i%256),n);
    const filter=join(root,"bounded.filter"),receipt=join(root,"RESULT.json");
    await writeFile(filter,`[0:v]format=gray,geq=lum='${expression}'[o]`,{flag:"wx"});
    const args=["-v","error","-nostdin","-f","lavfi","-i","color=black:s=16x16:r=30:d=60","-filter_complex_script",filter,
      "-map","[o]","-frames:v","1800","-pix_fmt","gray","-f","rawvideo","-"];
    const result=spawnSync(ff,args,{windowsHide:true,timeout:15000,maxBuffer:2*1024*1024});
    await writeFile(join(root,"stderr.log"),result.stderr,{flag:"wx"});
    expect(result.status,result.stderr.toString()).toBe(0);expect(result.error).toBeUndefined();expect(result.stdout.length).toBe(1800*16*16);
    for(let frame=0;frame<1800;frame++)expect([...result.stdout.subarray(frame*256,(frame+1)*256)].every(value=>value===frame%256)).toBe(true);
    expect(createHash("sha256").update(await readFile(ff)).digest("hex")).toBe(before);
    await writeFile(receipt,JSON.stringify({status:"PASS",frames:1800,everyPixelMeasured:true,ffmpegSha256:before,args,exitCode:result.status}),{flag:"wx"});
  },20_000);
  it("selects the new traversal only for the explicit marker and leaves the original static expression exact", () => {
    const project=createEmptyProject("Mask expression",{id:"mask-expression",width:160,height:240,fps:30});
    const mask=createClipMask("window","polygon");mask.feather=0;mask.expansion=0;
    const clip:TimelineClip={id:"main",trackId:project.tracks[0].id,assetId:"source",timelineStart:0,sourceStart:0,duration:2,volume:1,
      transform:{...DEFAULT_TRANSFORM},color:{...DEFAULT_COLOR},keyframes:[],masks:[mask],
      layout:{crop:{x:0,y:0,width:1,height:1},viewport:{x:0,y:0,width:1,height:1}}};
    const legacyPlan=compileClipAlphaPlan(project,clip),legacy=combinedMaskAlphaExpression(legacyPlan,160,240);
    mask.fixedWindowV3={schema:"editkin.fixed-template-window/v3"};
    const explicitPlan=compileClipAlphaPlan(project,clip),operation=explicitPlan.operations[0];
    expect(operation.source==="vector"&&operation.fixedWindowV3).toBe(true);
    expect(combinedMaskAlphaExpression(explicitPlan,160,240)).toContain("if(lt(T");
    delete mask.fixedWindowV3;
    expect(compileClipAlphaPlan(project,clip)).toEqual(legacyPlan);
    expect(combinedMaskAlphaExpression(compileClipAlphaPlan(project,clip),160,240)).toBe(legacy);
  });
});
