import {describe,it,expect,vi} from "vitest";
import type {ReactElement} from "react";
const hooks=vi.hoisted(()=>({values:[] as unknown[],index:0}));
vi.mock("react",async original=>({...await original<typeof import("react")>(),useState:(initial:unknown)=>{const i=hooks.index++;if(!(i in hooks.values))hooks.values[i]=initial;return[hooks.values[i],(next:unknown)=>{hooks.values[i]=typeof next==="function"?(next as (old:unknown)=>unknown)(hooks.values[i]):next;}];},useEffect:()=>{},useRef:(current:unknown)=>({current})}));
vi.mock("../desktop/useNativeAudioPreviewPlayback",()=>({useNativeAudioPreviewPlayback:()=>({mode:"compatible"})}));
import {Preview} from "./Preview";
import {createDemoProject} from "../domain/demo";
import {CURRENT_MEDIA_PREVIEW_RECIPE} from "../application/mediaDerivativeColor";
function nodes(value:unknown):ReactElement<Record<string,any>>[]{if(Array.isArray(value))return value.flatMap(nodes);if(!value||typeof value!=="object"||!("props"in value))return[];const element=value as ReactElement<Record<string,any>>;return[element,...nodes(element.props.children)];}
describe("ordinary preview decode errors (actual handlers, explicit hook-state harness)",()=>{
 it("does not treat an audio-only MOV decode as a video frame and prepares an absent proxy once",()=>{
  hooks.values=[];const project=createDemoProject(),clip=project.tracks[0]!.clips[0]!,asset=project.assets[0]!,rebuild=vi.fn(async()=>{}),pause=vi.fn();delete asset.derivatives;
  const props={layers:[{clip,asset,source:"camera.mov"}],audioLayers:[],projectWidth:project.width,projectHeight:project.height,playhead:0,projectDuration:12,projectFps:project.fps,captions:[],captionStyle:project.captionStyle,project,playing:true,onPlayingChange:pause,onPlayheadChange:()=>{},onRebuildPreview:rebuild};
  const render=()=>{hooks.index=0;return nodes(Preview(props));};const video=render().find(n=>n.type==="video")!;
  video.props.onLoadedData({currentTarget:{readyState:4,videoWidth:0,videoHeight:0}});
  video.props.onLoadedData({currentTarget:{readyState:4,videoWidth:0,videoHeight:0}});
  expect(rebuild).toHaveBeenCalledExactlyOnceWith(asset.id);expect(pause).toHaveBeenCalledWith(false);
  expect(render().some(n=>n.props["data-testid"]==="preview-media-error")).toBe(true);
  video.props.onLoadedData({currentTarget:{readyState:4,videoWidth:1080,videoHeight:1920}});
  expect(render().some(n=>n.props["data-testid"]==="preview-media-error")).toBe(false);
 });
 it("shows a recoverable named error after failed video decode and clears on decoded data",()=>{hooks.values=[];const project=createDemoProject(),clip=project.tracks[0]!.clips[0]!,asset=project.assets[0]!;const props={layers:[{clip,asset,source:"fixture.mp4"}],audioLayers:[],projectWidth:project.width,projectHeight:project.height,playhead:0,projectDuration:12,projectFps:project.fps,captions:[],captionStyle:project.captionStyle,project,playing:false,onPlayingChange:()=>{},onPlayheadChange:()=>{}};const render=()=>{hooks.index=0;return nodes(Preview(props));};const video=render().find(n=>n.type==="video")!;expect(video).toBeTruthy();video.props.onError({currentTarget:{error:{code:3,message:"decode fixture"}}});const failed=render(),panel=failed.find(n=>n.props["data-testid"]==="preview-media-error");expect(panel).toBeTruthy();expect(JSON.stringify(panel)).toContain(asset.name);expect(JSON.stringify(panel)).toContain("decode fixture");expect(failed.some(n=>n.type==="button"&&n.props.children==="重新載入預覽")).toBe(true);video.props.onLoadedData({currentTarget:{videoWidth:1920,videoHeight:1080}});expect(render().some(n=>n.props["data-testid"]==="preview-media-error")).toBe(false);});
 it("updates one stale visible proxy only on click, disables parallel work and disappears when current",()=>{
  hooks.values=[];const project=createDemoProject(),clip=project.tracks[0]!.clips[0]!,asset=project.assets[0]!,rebuild=vi.fn(async()=>{});
  asset.derivatives={sourceSha256:"a".repeat(64),proxyUri:"D:/old/proxy.mp4",thumbnailUri:"D:/old/thumbnail.jpg",generatedAt:"2026-08-31T00:00:00Z",proxyColorContract:"editkin.browser-display-proxy/v1",proxyColor:{interpretation:"rec709",primaries:"bt709",transfer:"bt709",matrix:"bt709",range:"tv"}};
  const props:any={layers:[{clip,asset,source:"fixture.mp4"},{clip:{...clip,id:"same-asset-second-clip"},asset,source:"fixture.mp4"}],audioLayers:[],projectWidth:project.width,projectHeight:project.height,playhead:0,projectDuration:12,projectFps:project.fps,captions:[],captionStyle:project.captionStyle,project,playing:false,onPlayingChange:()=>{},onPlayheadChange:()=>{},onRebuildPreview:rebuild};
  const render=()=>{hooks.index=0;return nodes(Preview(props));};let tree=render(),notice=tree.find(n=>n.props["data-testid"]==="preview-update-notice")!;
  expect(notice).toBeTruthy();expect(JSON.stringify(notice)).toContain("1 份舊預覽");expect(rebuild).not.toHaveBeenCalled();
  let button=tree.find(n=>n.type==="button"&&n.props.children==="更新預覽")!;button.props.onClick();expect(rebuild).toHaveBeenCalledTimes(1);expect(rebuild).toHaveBeenCalledWith(asset.id);
  props.previewRepair={assetId:asset.id,sessionId:1,operationId:1,phase:"preparing",message:"正在準備"};tree=render();button=tree.find(n=>n.type==="button"&&n.props.children==="更新中…")!;expect(button.props.disabled).toBe(true);
  asset.derivatives.previewRecipe=CURRENT_MEDIA_PREVIEW_RECIPE;expect(render().some(n=>n.props["data-testid"]==="preview-update-notice")).toBe(false);
 });
});
