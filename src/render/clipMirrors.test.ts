import { describe,expect,it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { buildEngineRenderGraph } from "./engineGraph";
import { buildGpuEnginePreviewGraph,buildGpuRenderGraph,buildGpuVideoPreviewSource } from "./gpuCompositor";
import { composedTransformExpressions } from "./ffmpegExpressions";
import { clipMirrorFilters } from "../domain/clipMirrors";
describe("mirrors are preserved through shared render admission",()=>{
  it("projects fixed signed axes for the base and every keyframe, without altering numeric poses",()=>{
    const project=createDemoProject(),clip=project.tracks[0].clips[0];clip.transform.flipX=true;
    clip.keyframes=[{id:"pose",time:2,transform:{...clip.transform,scale:.6,x:12},color:{...clip.color},easing:"linear"}];
    const node=buildEngineRenderGraph(project).nodes.find(item=>item.id==="transform:clip-demo")!;
    expect(node).toMatchObject({scaleX:-1,scaleY:1,keyframes:[{scaleX:-.6,scaleY:.6,x:12}]});
    const expressions=composedTransformExpressions(project,clip,"t",project.fps);expect(clipMirrorFilters(expressions)).toEqual(["hflip"]);expect(expressions.scale).toContain("0.6");
  });
  it("uses the typed GPU reflection route and declines scalar-only or direct-video bypasses",()=>{
    const project=createDemoProject();project.assets[0].kind="image";project.assets[0].uri="D:/owned/pattern.png";project.tracks[0].clips[0].volume=0;
    project.tracks[0].clips[0].transform.flipY=true;
    expect(buildGpuRenderGraph(project,1)).toBeUndefined();expect(buildGpuEnginePreviewGraph(project,1)?.graph.nodes).toContainEqual(expect.objectContaining({kind:"transform2d",scaleX:1,scaleY:-1}));
    project.assets[0].kind="video";project.assets[0].width=project.width;project.assets[0].height=project.height;expect(buildGpuVideoPreviewSource(project,1)).toBeUndefined();
  });
  it("reflects inherited translation and reverses child rotation in FFmpeg expressions",()=>{
    const project=createDemoProject(),parent=project.tracks[0].clips[0];parent.transform.flipX=true;parent.layer={role:"controller",enabled:true,blendMode:"normal"};
    const child=structuredClone(parent);child.id="child";child.transform={x:20,y:10,scale:1,rotation:17,opacity:1};child.layer={role:"content",enabled:true,blendMode:"normal",parentClipId:parent.id};project.tracks[0].clips.push(child);
    const result=composedTransformExpressions(project,child,"t",project.fps);expect(result.flipX).toBe(true);expect(result.x).toContain("-(20)");expect(result.rotation).toBe("-(17)");
    expect(clipMirrorFilters(result)).toEqual(["hflip"]);
  });
});
