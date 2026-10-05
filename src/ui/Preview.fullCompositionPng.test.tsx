import {renderToStaticMarkup} from "react-dom/server";
import {describe,it,expect} from "vitest";
import {createDemoProject} from "../domain/demo";
import {Preview} from "./Preview";
describe("complete decoded PNG typography ownership",()=>{
  const render=(full:boolean,baked:readonly string[],pending=false)=>{
    const project=createDemoProject();project.motionGraphics=[];
    project.captions=[{id:"old",text:"舊影格字幕",start:0,duration:1},{id:"future",text:"尚未顯示的字幕",start:2,duration:1}];
    return renderToStaticMarkup(<Preview project={project} layers={[]} audioLayers={[]}
      projectWidth={project.width} projectHeight={project.height} projectDuration={3} projectFps={project.fps}
      playhead={pending?2:.5} captions={project.captions} captionStyle={project.captionStyle}
      gpuPreviewUrl="blob:complete-owned-frame" gpuPreviewFullComposition={full} gpuPreviewAdmission="engine-video-frame"
      nativeGpuPresentedFrame={15} nativeGpuFrameUpdating={pending} bakedCaptionIds={baked}
      playing={false} onPlayingChange={()=>undefined} onPlayheadChange={()=>undefined}/>);
  };
  it("does not turn a legacy PNG into a complete baked frame",()=>{expect(render(false,["old"])).toContain("舊影格字幕");});
  it("suppresses only the exact current baked caption without HWND presentation",()=>{const html=render(true,["old"]);expect(html).not.toContain("舊影格字幕");expect(html).toContain('data-testid="gpu-preview-frame"');expect(html).not.toContain('data-testid="native-gpu-surface"');expect(render(true,["other"])).toContain("舊影格字幕");});
  it("keeps the actual PNG clock during a newer seek and avoids future DOM typography",()=>{const html=render(true,["old"],true);expect(html).not.toContain("尚未顯示的字幕");expect(html).not.toContain("舊影格字幕");expect(html).toContain("blob:complete-owned-frame");});
});
