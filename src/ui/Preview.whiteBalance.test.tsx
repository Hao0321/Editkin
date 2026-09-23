import {renderToStaticMarkup} from "react-dom/server";
import {describe,expect,it} from "vitest";
import {createDemoProject} from "../domain/demo";
import {DEFAULT_CLIP_LAYER} from "../domain/types";
import {Preview} from "./Preview";
function html(mode:"zero"|"static"|"keyframe"|"adjustment"|"nested",native=false,gpu=false){
 const project=createDemoProject(),clip=project.tracks[0].clips[0];
 if(mode==="static"||mode==="adjustment")clip.color.whiteBalanceRed=.5;
 if(mode==="adjustment")clip.layer={...DEFAULT_CLIP_LAYER,role:"adjustment"};
 if(mode==="keyframe")clip.keyframes=[{id:"wb",time:1,transform:{...clip.transform},color:{...clip.color,whiteBalanceBlue:1},easing:"linear"}];
 const nested=structuredClone(clip);nested.color.whiteBalanceGreen=.4;
 return renderToStaticMarkup(<Preview project={project} layers={[{clip,asset:project.assets[0],source:"fixture.mp4",...(mode==="nested"?{compositionAncestors:[{project,clip:nested,playhead:0}]}:{})}]} audioLayers={[]} projectWidth={project.width} projectHeight={project.height} projectFps={project.fps} projectDuration={3} playhead={0} captions={[]} captionStyle={project.captionStyle} playing={false} onPlayingChange={()=>{}} onPlayheadChange={()=>{}} nativeGpuPreview={native} gpuPreviewUrl={gpu?"fixture-native.png":undefined}/>);
}
describe("linear WB compatible-preview fail closed",()=>{
 it.each(["static","keyframe","adjustment","nested"] as const)("does not silently show uncorrected %s",mode=>{const result=html(mode);expect(result).toContain("linear-white-balance-preview-unavailable");expect(result).not.toContain('data-testid="preview-video"');});
 it("keeps zero-WB and verified supplied native paths intact",()=>{
  expect(html("zero")).toContain('data-testid="preview-video"');
  expect(html("static",true)).toContain('data-testid="native-gpu-surface"');
  expect(html("static",false,true)).toContain('data-testid="gpu-preview-frame"');
  expect(html("static",true)).not.toContain("linear-white-balance-preview-unavailable");
 });
});
