import { afterEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { createDemoProject } from "../domain/demo";
import { dispatchCommand, undo } from "../domain/history";
import { createProjectSession } from "../application/projectSession";
import { useClipMediaEdits } from "./useClipMediaEdits";
import type { HaoDesktopApi } from "./types";

const hooks=vi.hoisted(()=>({refs:[] as {current:unknown}[],states:[] as unknown[],refIndex:0,stateIndex:0}));
vi.mock('react',()=>({
  useRef:(value:unknown)=>hooks.refs[hooks.refIndex++]??(hooks.refs[hooks.refIndex-1]={current:value}),
  useState:(value:unknown)=>{const index=hooks.stateIndex++;if(!(index in hooks.states))hooks.states[index]=value;
    return [hooks.states[index],(next:unknown)=>{hooks.states[index]=next;}];},
}));
afterEach(()=>{vi.unstubAllGlobals();});
function setup(generate?:()=>Promise<unknown>){
  hooks.refs.length=hooks.states.length=0;
  vi.stubGlobal('crypto',webcrypto);
  const project=createDemoProject(),base=project.tracks[0].clips[0];base.duration=4;project.captions=[];project.motionGraphics=[];
  const session=createProjectSession(project),status=vi.fn(),pause=vi.fn(),urls=vi.fn();
  const api=generate?{generateClipMediaDerivative:vi.fn(generate)} as unknown as HaoDesktopApi:undefined;
  const render=()=>{hooks.refIndex=hooks.stateIndex=0;return useClipMediaEdits({api,projectSession:session,getPlayhead:()=>2,onPause:pause,onStatus:status,onRuntimeUrls:urls,
    onCommand:command=>session.setHistory(dispatchCommand(session.getSnapshot().history,command))});};
  return {project,clipId:base.id,session,status,pause,urls,api,render};
}
const generated={asset:{id:'still',kind:'image' as const,name:'Still',uri:'D:/owned/still.png',duration:2,width:960,height:540},
  duration:2,sha256:'a'.repeat(64),sourceSha256:'b'.repeat(64),receiptPath:'D:/owned/receipt.json',previewUrl:'blob:owned'};
describe('asynchronous clip media ownership',()=>{
  it('commits the completed derivative once and publishes the same source preview URL; Undo restores the original project',async()=>{
    const fixture=setup(async()=>generated);
    expect(await fixture.render().freeze(fixture.clipId)).toBe(true);
    expect(fixture.pause).toHaveBeenCalledTimes(1);expect(fixture.urls).toHaveBeenCalledWith({still:'blob:owned'});
    expect(fixture.session.getSnapshot().history.past).toHaveLength(1);
    expect(undo(fixture.session.getSnapshot().history).present).toEqual(fixture.project);
    expect(fixture.render().busy).toBe(false);
  });
  it('deduplicates clicks and discards a completed render after the live content changes',async()=>{
    let resolve!:(value:typeof generated)=>void;const gate=new Promise<typeof generated>(accept=>{resolve=accept;});
    const fixture=setup(()=>gate),first=fixture.render().freeze(fixture.clipId);
    expect(fixture.render().busy).toBe(true);
    expect(await fixture.render().freeze(fixture.clipId)).toBe(false);
    fixture.session.setHistory(dispatchCommand(fixture.session.getSnapshot().history,{type:'rename_project',name:'Changed while rendering'}));
    resolve(generated);expect(await first).toBe(false);
    expect(fixture.api?.generateClipMediaDerivative).toHaveBeenCalledTimes(1);
    expect(fixture.session.getSnapshot().history.present.assets.some(asset=>asset.id==='still')).toBe(false);
    expect(fixture.session.getSnapshot().history.past).toHaveLength(1);expect(fixture.urls).not.toHaveBeenCalled();
  });
  it('reports the missing engine before changing or pausing a project',async()=>{
    const fixture=setup();expect(await fixture.render().freeze(fixture.clipId)).toBe(false);
    expect(fixture.status).toHaveBeenLastCalledWith('這個操作需要桌面版的本機媒體引擎。');
    expect(fixture.session.getSnapshot().history.past).toHaveLength(0);expect(fixture.pause).not.toHaveBeenCalled();
  });
});
