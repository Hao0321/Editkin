import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import { lstat, mkdir, mkdtemp, readdir, readFile, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { createDemoProject } from "../domain/demo";
import { captureWholeGradeCubeV1 } from "../domain/wholeGradeCubeSnapshotV1";
import { serializeCube3d, parseCubeFile } from "../color/cubeLut";
import type { EditProject } from "../domain/types";
const calls=vi.hoisted(()=>({run:vi.fn()}));
vi.mock("./wholeGradeCubeExportV1",()=>({exportWholeGradeCubeV1:calls.run}));
import { exportWholeGradeCubeV2, wholeGradeCubeSha256V2, type WholeGradeCubeSourceV2, type WholeGradeCubeRuntimeV2 } from "./wholeGradeCubeExportV2";
import { exportWholeGradeCubeFilesV2 } from "./wholeGradeCubeFilesV2";

let text="",root="";const pin="a".repeat(64),owner={};
beforeAll(async()=>{
  const values=new Float32Array(65**3*3);for(let i=0;i<65**3;i++)for(let c=0;c<3;c++)values[i*3+c]=Math.floor(i/65**c)%65/64;
  text=serializeCube3d(values,65,"Private author asset name");root=await mkdtemp(join(tmpdir(),"editkin-whole-grade-v2-unit-"));
});
function reference(project:EditProject,clipId:string,playhead:number,options?:{readback?:string}) {
  const snapshot=captureWholeGradeCubeV1(project,clipId,playhead);
  return {text,size:65,snapshot,quality:{size:65,holdouts:512,channels:1536,maximumCodeError:1.5,meanCodeError:.2,limitCodeError:2,scope:"fixed512off-grid-atlas-controls-only"},
    receipt:{snapshotSha256:wholeGradeCubeSha256V2(JSON.stringify(snapshot)),resources:[{path:"C:/private/secret.cube",bytes:186,sha256:"b".repeat(64)}],
      ...(options?.readback?{readback:{schema:"editkin.whole-grade-rgba16-readback/v2",pixelFormat:"gbrap16le",pixels:275470,transportBytes:2203760,colourBytes:1652820,alphaOpaque:true,colourSha256:pin,transportSha256:pin}}:{}),
      child:{pid:123,closed:true,code:0,executableBefore:{sha256:pin},executableAfter:{sha256:pin}},args:["private-path"],filters:["private-path"]}};
}
beforeEach(()=>{calls.run.mockReset().mockImplementation(async(p:EditProject,c:string,t:number,options?:{readback?:string})=>reference(p,c,t,options));});
function source():WholeGradeCubeSourceV2 {
  const project=createDemoProject(),clip=project.tracks[0].clips[0];project.assets[0].name="Private author asset name";
  project.assets[0].color={interpretation:"rec709"};return {project,clipId:clip.id,playhead:0,scope:{owner,sessionId:1}};
}
const runtime=():WholeGradeCubeRuntimeV2=>({ffmpegPath:resolve("fixture-ffmpeg.exe"),ffmpegSha256:pin,workRoot:join(root,"jobs")});
async function clean(path:string) {
  if(!path.startsWith(root+sep)&&path!==root)throw Error("unit cleanup boundary");
  const stat=await lstat(path);if(stat.isSymbolicLink())throw Error("unexpected unit cleanup link");
  if(stat.isDirectory()){for(const name of await readdir(path))await clean(join(path,name));await rmdir(path);}else await unlink(path);
}
afterAll(async()=>{if(!resolve(root).startsWith(resolve(tmpdir())+sep)||!basename(root).startsWith("editkin-whole-grade-v2-unit-"))throw Error("unit root boundary");await clean(root);});
describe("whole-grade V2 source-only route and sampled recipe binding",()=>{
  it("keeps65/512/2, imports the cube, redacts public metadata and leaves its source unchanged",async()=>{
    const s=source(),before=JSON.stringify(s.project),r=await exportWholeGradeCubeV2(s,runtime());
    expect(calls.run).toHaveBeenCalledTimes(1);expect(calls.run.mock.lastCall![3].size).toBe(65);expect(calls.run.mock.lastCall![3].readback).toBeUndefined();
    expect(parseCubeFile(r.text)).toMatchObject({kind:"3d",size:65});expect(r.receipt.quality).toMatchObject({holdouts:512,limitCodeError:2});
    expect(r.text).not.toContain("Private author");expect(JSON.stringify(r.receipt)).not.toMatch(/private-path|private\/secret|Private author/);
    expect(r.receipt.resources).toEqual([{bytes:186,sha256:"b".repeat(64)}]);expect(JSON.stringify(s.project)).toBe(before);
    expect(r.receipt.measured.nativeProcessorParity).toBe(false);
  });
  it("refuses the historical legacy recipe before any child, preserving its actual old look",async()=>{
    const s=source(),c=s.project.tracks[0].clips[0];c.creative={lookPresetId:"clean_neutral",effectPresetIds:[]};c.color.exposure=.1;
    const before=JSON.stringify(s.project);await expect(exportWholeGradeCubeV2(s,runtime())).rejects.toThrow("WHOLE_GRADE_V2_LEGACY_LOOK");
    expect(calls.run).not.toHaveBeenCalled();expect(JSON.stringify(s.project)).toBe(before);
  });
  it("opts only the ACES high16 route into opaque RGBA readback",async()=>{
    const s=source();s.project.colorManagement!.mode="aces2";
    const r=await exportWholeGradeCubeV2(s,runtime());expect(calls.run.mock.lastCall![3].readback).toBe("rgba16-v2");
    expect(r.receipt.readback).toMatchObject({schema:"editkin.whole-grade-rgba16-readback/v2",alphaOpaque:true});
  });
  it.each(["hlg","pq","apple_log","sony_slog3_cine","log_unresolved","linear_rec709"] as const)("refuses %s input before child startup",async input=>{
    const s=source();s.project.assets[0].color={interpretation:input};s.project.colorManagement!.mode="aces2";
    await expect(exportWholeGradeCubeV2(s,runtime())).rejects.toThrow("WHOLE_GRADE_V2_INPUT");expect(calls.run).not.toHaveBeenCalled();
  });
  it.each(["rec2100_hlg_1000","rec2100_pq_1000"] as const)("refuses %s output",async output=>{
    const s=source();s.project.colorManagement!.outputTransform=output;
    await expect(exportWholeGradeCubeV2(s,runtime())).rejects.toThrow("WHOLE_GRADE_V2_OUTPUT");expect(calls.run).not.toHaveBeenCalled();
  });
  it("refuses spatial fields and explicit sampling-policy overrides",async()=>{
    const s=source();s.project.tracks[0].clips[0].gradeV2={schema:"editkin.color-grade/v2",nodes:[{id:"n"}]};
    Object.assign(s.project.tracks[0].clips[0].gradeV2.nodes![0],{windowMaskId:"mask"});
    await expect(exportWholeGradeCubeV2(s,runtime())).rejects.toThrow("WHOLE_GRADE_V2_SPATIAL_NODE");
    await expect(exportWholeGradeCubeV2(source(),{...runtime(),size:129} as WholeGradeCubeRuntimeV2)).rejects.toThrow("WHOLE_GRADE_V2_POLICY");expect(calls.run).not.toHaveBeenCalled();
  });
  it("checks owner and session identity before any work",async()=>{
    for(const scope of [{owner:{},sessionId:1},{owner,sessionId:2}]) {
      const s=source();await expect(exportWholeGradeCubeV2(s,{...runtime(),current:()=>({...s,scope})})).rejects.toThrow("WHOLE_GRADE_V2_STALE");
    }expect(calls.run).not.toHaveBeenCalled();
  });
  it("captures the sampled colour, then rejects source/revision/selection changes during the child",async()=>{
    for(const mutate of [(s:WholeGradeCubeSourceV2)=>{s.project.revision++;},(s:WholeGradeCubeSourceV2)=>{s.project.assets[0].uri+="-changed";},
      (s:WholeGradeCubeSourceV2)=>{s.playhead+=.5;},(s:WholeGradeCubeSourceV2)=>{s.project.tracks[0].clips[0].color.exposure=.2;}]) {
      const s=source();calls.run.mockImplementationOnce(async(p:EditProject,c:string,t:number)=>{const before=reference(p,c,t);mutate(s);expect(p.tracks[0].clips[0].color.exposure).toBe(0);return before;});
      await expect(exportWholeGradeCubeV2(s,runtime())).rejects.toThrow("WHOLE_GRADE_V2_STALE");
    }
  });
  it("honours pre-cancellation and cancellation immediately after child closure",async()=>{
    const controller=new AbortController();controller.abort(Error("stop"));await expect(exportWholeGradeCubeV2(source(),{...runtime(),signal:controller.signal})).rejects.toThrow("stop");expect(calls.run).not.toHaveBeenCalled();
    const later=new AbortController();calls.run.mockImplementationOnce(async(p:EditProject,c:string,t:number)=>{const r=reference(p,c,t);later.abort(Error("later stop"));return r;});
    await expect(exportWholeGradeCubeV2(source(),{...runtime(),signal:later.signal})).rejects.toThrow("later stop");
  });
  it("does not accept changed gate counts, tool pins or incomplete children",async()=>{
    for(const patch of [(r:ReturnType<typeof reference>)=>{r.quality.maximumCodeError=2.1;},(r:ReturnType<typeof reference>)=>{r.quality.holdouts=511;},
      (r:ReturnType<typeof reference>)=>{r.receipt.child.closed=false;},(r:ReturnType<typeof reference>)=>{r.receipt.child.executableAfter.sha256="c".repeat(64);}]) {
      calls.run.mockImplementationOnce(async(p:EditProject,c:string,t:number)=>{const r=reference(p,c,t);patch(r);return r;});
      await expect(exportWholeGradeCubeV2(source(),runtime())).rejects.toThrow("WHOLE_GRADE_V2_REFERENCE");
    }
  });
  it("surfaces an unrepresentable grade as a quality refusal without removing the gate",async()=>{
    calls.run.mockRejectedValueOnce(Object.assign(Error("reference quality"),{quality:{size:65,holdouts:512,limitCodeError:2,maximumCodeError:7.03}}));
    await expect(exportWholeGradeCubeV2(source(),runtime())).rejects.toMatchObject({code:"WHOLE_GRADE_V2_QUALITY",quality:{size:65,holdouts:512,limitCodeError:2,maximumCodeError:7.03}});
  });
});
describe("exclusive cube and receipt file pair",()=>{
  it("refuses slash-spelled UNC paths before any network or producer access",async()=>{
    await expect(exportWholeGradeCubeFilesV2(source(),runtime(),{outputDirectory:"//example.invalid/share/grade"})).rejects.toThrow("WHOLE_GRADE_V2_OUTPUT_PATH");
    expect(calls.run).not.toHaveBeenCalled();
  });
  it("writes both files side by side, verifies their hashes and keeps private diagnostics out",async()=>{
    const target=join(root,"complete"),r=await exportWholeGradeCubeFilesV2(source(),runtime(),{outputDirectory:target});
    expect(r.completePairVerified).toBe(true);expect(r.filesystemTransactionAtomic).toBe(false);
    expect(await readdir(target)).toEqual(["grade.cube","grade.receipt.json"]);
    for(const f of r.files)expect(wholeGradeCubeSha256V2(await readFile(f.path))).toBe(f.sha256);
    const receipt=JSON.parse(await readFile(join(target,"grade.receipt.json"),"utf8"));expect(receipt.cube.fileName).toBe("grade.cube");expect(JSON.stringify(receipt)).not.toMatch(/private-path|Private author/);
  });
  it("refuses an existing output directory before running the expensive producer",async()=>{
    const target=join(root,"existing");await mkdir(target);await writeFile(join(target,"author.txt"),"author bytes");
    await expect(exportWholeGradeCubeFilesV2(source(),runtime(),{outputDirectory:target})).rejects.toThrow("WHOLE_GRADE_V2_OUTPUT_EXISTS");
    expect(await readFile(join(target,"author.txt"),"utf8")).toBe("author bytes");expect(calls.run).not.toHaveBeenCalled();
  });
  it("preserves an incomplete bundle on cancellation instead of reporting a complete pair",async()=>{
    const target=join(root,"cancelled"),controller=new AbortController();
    await expect(exportWholeGradeCubeFilesV2(source(),{...runtime(),signal:controller.signal},{outputDirectory:target,onPhase:p=>{if(p==="cube_written")controller.abort();}}))
      .rejects.toMatchObject({message:expect.stringContaining("WHOLE_GRADE_V2_INCOMPLETE_OUTPUT"),completePairVerified:false,partialOutputPreserved:true});
    expect(await readdir(target)).toEqual(["grade.cube"]);
  });
  it("detects a foreign write while retaining its bytes",async()=>{
    const target=join(root,"foreign");await expect(exportWholeGradeCubeFilesV2(source(),runtime(),{outputDirectory:target,
      onPhase:async p=>{if(p==="cube_written")await writeFile(join(target,"grade.cube"),"external fixture change");}})).rejects.toThrow("WHOLE_GRADE_V2_INCOMPLETE_OUTPUT");
    expect(await readFile(join(target,"grade.cube"),"utf8")).toBe("external fixture change");
  });
  it("rechecks source context during publication",async()=>{
    const s=source(),target=join(root,"stale");await expect(exportWholeGradeCubeFilesV2(s,runtime(),{outputDirectory:target,onPhase:p=>{if(p==="directory_created")s.project.revision++;}})).rejects.toThrow("WHOLE_GRADE_V2_INCOMPLETE_OUTPUT");
    expect(await readdir(target)).toEqual([]);
  });
  it("refuses output parent junctions and Windows alternate streams",async()=>{
    const plain=join(root,"ordinary"),link=join(root,"alias");await mkdir(plain);await symlink(plain,link,process.platform==="win32"?"junction":"dir");
    try{await expect(exportWholeGradeCubeFilesV2(source(),runtime(),{outputDirectory:join(link,"target")})).rejects.toThrow("WHOLE_GRADE_V2_DIRECTORY_REPARSE");}
    finally{await unlink(link);}
    expect(await readdir(plain)).toEqual([]);expect(calls.run).not.toHaveBeenCalled();
    if(process.platform==="win32")await expect(exportWholeGradeCubeFilesV2(source(),runtime(),{outputDirectory:join(root,"target:ads")})).rejects.toThrow("WHOLE_GRADE_V2_OUTPUT_PATH");
    expect(relative(root,plain)).toBe("ordinary");
  });
});
