import {renderToStaticMarkup} from "react-dom/server";
import {describe,it,expect,vi} from "vitest";
vi.mock("./OcioGpuMedia",()=>({default:()=> <div data-testid="ocio-display-route"/>}));
import {Preview} from "./Preview";
import {validateProject} from "../domain/editGraph";
import {createDemoProject} from "../domain/demo";
import {activeMediaLayers} from "../application/previewMedia";
import {DEFAULT_COLOR_MANAGEMENT} from "../domain/types";
import {CURRENT_MEDIA_PREVIEW_RECIPE} from "../application/mediaDerivativeColor";
function fixture(transfer:string,aces=true,proxy=true,layout=false,native=false){
 const project=createDemoProject(),asset=project.assets[0]!,clip=project.tracks[0]!.clips[0]!;
 asset.color={interpretation:"auto",primaries:transfer==="bt709"?"bt709":"bt2020",matrix:transfer==="bt709"?"bt709":"bt2020nc",transfer,range:"tv"};
 asset.derivatives={sourceSha256:"a".repeat(64),generatedAt:new Date(0).toISOString(),proxyUri:"fixture-proxy.mp4",thumbnailUri:"fixture-thumbnail.jpg",previewRecipe:CURRENT_MEDIA_PREVIEW_RECIPE,proxyColorContract:"editkin.browser-display-proxy/v1",proxyColor:{interpretation:"rec709",primaries:"bt709",transfer:"bt709",matrix:"bt709",range:"tv"}};
 project.colorManagement={...DEFAULT_COLOR_MANAGEMENT,mode:aces?"aces2":"rec709"};
 if(layout)clip.layout={crop:{x:0,y:0,width:1,height:1},viewport:{x:.1,y:.1,width:.8,height:.8}};
 validateProject(project);const sourceBefore=JSON.stringify(asset.color),layers=activeMediaLayers(project,0,proxy?{[asset.id]:"fixture-proxy.mp4",[`${asset.id}:proxy`]:"fixture-proxy.mp4"}:{},"video");
 const html=renderToStaticMarkup(<Preview project={project} layers={layers} audioLayers={[]} projectWidth={project.width} projectHeight={project.height} projectFps={project.fps} projectDuration={12} playhead={0} captions={[]} captionStyle={project.captionStyle} playing={false} onPlayingChange={()=>{}} onPlayheadChange={()=>{}} nativeGpuPreview={native}/>);
 expect(JSON.stringify(asset.color)).toBe(sourceBefore);return{html,layers,project};
}
describe("HDR display proxy cannot be reused as scene input for ACES",()=>{
 it.each(["arib-std-b67","smpte2084"])("blocks actual bound %s proxy before ordinary/layout OCIO route",transfer=>{for(const layout of [false,true]){const {html,layers}=fixture(transfer,true,true,layout);expect(layers[0]!.displayProxy).toBe(true);expect(layers[0]!.asset.color?.transfer).toBe("bt709");expect(html).toContain("hdr-display-proxy-aces-unavailable");expect(html).not.toContain("ocio-display-route");}});
 it("keeps SDR ACES, ordinary HDR SDR compatibility, original path and verified native branch untouched",()=>{
  expect(fixture("bt709").html).toContain("ocio-display-route");
  expect(fixture("arib-std-b67",false).html).toContain('data-testid="preview-video"');
  expect(fixture("arib-std-b67",true,false).html).toContain("ocio-display-route");
  expect(fixture("arib-std-b67",true,true,false,true).html).toContain("native-gpu-surface");
 });
});

describe("Preview recipe freshness notice",()=>{
 it("keeps an old proxy visible and places a passive update notice outside the picture",()=>{
  const {project,layers}=fixture("arib-std-b67",false);delete project.assets[0]!.derivatives!.previewRecipe;delete layers[0]!.asset.derivatives!.previewRecipe;
  const html=renderToStaticMarkup(<Preview project={project} layers={layers} audioLayers={[]} projectWidth={project.width} projectHeight={project.height} projectFps={project.fps} projectDuration={12} playhead={0} captions={[]} captionStyle={project.captionStyle} playing={false} onPlayingChange={()=>{}} onPlayheadChange={()=>{}}/>);
  expect(html).toContain('data-testid="preview-update-notice"');expect(html).toContain('data-testid="preview-video"');expect(html).toContain("請在桌面版更新");
  expect(html.indexOf('data-testid="preview-update-notice"')).toBeLessThan(html.indexOf('class="preview-stage'));
 });
 it("does not show a stale-proxy action for the current recipe or either native surface",()=>{
  expect(fixture("arib-std-b67").html).not.toContain("preview-update-notice");
  const stale=fixture("arib-std-b67");delete stale.project.assets[0]!.derivatives!.previewRecipe;delete stale.layers[0]!.asset.derivatives!.previewRecipe;
  for(const props of [{nativeGpuPreview:true},{gpuPreviewUrl:"native-frame.png"}]){
   const html=renderToStaticMarkup(<Preview project={stale.project} layers={stale.layers} audioLayers={[]} projectWidth={stale.project.width} projectHeight={stale.project.height} projectFps={stale.project.fps} projectDuration={12} playhead={0} captions={[]} captionStyle={stale.project.captionStyle} playing={false} onPlayingChange={()=>{}} onPlayheadChange={()=>{}} {...props}/>);
   expect(html).not.toContain("preview-update-notice");
  }
 });
});
