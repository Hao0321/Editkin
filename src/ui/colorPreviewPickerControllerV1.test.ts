import {it,expect,vi,afterEach} from 'vitest';
import {createPreviewPickerControllerV1,type PreviewPickerStateV1} from './colorPreviewPickerControllerV1';
const identity={pipelineKey:'pipeline',primaryKey:'primary'};
afterEach(()=>vi.unstubAllGlobals());
function setup(){
  const reads:any[]=[],root=new EventTarget() as EventTarget&{querySelector:()=>any};let split:Canvas|undefined;
  class Canvas extends EventTarget{width=64;height=36;isConnected=true;dataset:Record<string,string>={gradeStatus:'ready'};tabIndex=-1;focus=vi.fn();getBoundingClientRect(){return{left:0,top:0,width:128,height:72};}getContext(){return{clearRect:vi.fn(),drawImage:(...args:any[])=>reads.push(args),getImageData:(_x:number,_y:number,w:number,h:number)=>({data:new Uint8ClampedArray(Array.from({length:w*h},()=>[80,100,120,255]).flat())})};}}
  vi.stubGlobal('HTMLCanvasElement',Canvas);vi.stubGlobal('getComputedStyle',()=>({borderLeftWidth:'0',borderRightWidth:'0',borderTopWidth:'0',borderBottomWidth:'0',paddingLeft:'0',paddingRight:'0',paddingTop:'0',paddingBottom:'0'}));vi.stubGlobal('document',{createElement:()=>new Canvas()});root.querySelector=()=>split;
  const canvas=new Canvas(),source=Object.assign(new EventTarget(),{tagName:'IMG',complete:true,naturalWidth:64}),states:PreviewPickerStateV1[]=[],control=createPreviewPickerControllerV1(()=>root as any,v=>states.push(v));control.setContext('one',identity);control.receive(canvas as any,source as any,identity);const detach=control.attach();
  const pointer=(x:number,y:number,target:Canvas=canvas)=>{const e=new Event('pointerdown',{cancelable:true});Object.defineProperties(e,{target:{value:target},button:{value:0},clientX:{value:x},clientY:{value:y}});root.dispatchEvent(e);};
  const key=(key:string,target:Canvas=canvas)=>{const e=new Event('keydown',{cancelable:true});Object.defineProperties(e,{target:{value:target},key:{value:key},shiftKey:{value:false}});root.dispatchEvent(e);return e;};
  return{canvas,source,control,states,reads,pointer,key,detach,setSplit:()=>{split=new Canvas();split.dataset={comparisonStatus:'ready',comparisonBoundary:'32'};return split;}};
}
it('reads at the mapped native pixel and uses only a bounded crop',()=>{
  const s=setup();s.control.setSide(9);s.control.arm();s.pointer(20,20);expect(s.control.state().sample).toMatchObject({x:10,y:10,rgb:[80,100,120],patchWidth:9,patchHeight:9,basis:'graded-preview'});expect(s.reads[0].slice(1)).toEqual([6,6,9,9,0,0,9,9]);expect(s.canvas.focus).toHaveBeenCalled();s.detach();
});
it('invalidates old owner/primary/time and refuses a late callback',()=>{
  const s=setup();s.control.arm();s.pointer(20,20);s.control.setContext('two',{...identity,primaryKey:'changed'});expect(s.control.state()).toMatchObject({ready:false,armed:false,sample:undefined});s.control.receive(s.canvas as any,s.source as any,identity);expect(s.control.state().ready).toBe(false);s.detach();
});
it('clears samples on media seeking/play and requires a fresh producer callback',()=>{
  const s=setup();s.control.arm();s.pointer(20,20);s.source.dispatchEvent(new Event('seeking'));expect(s.control.state()).toMatchObject({ready:false,armed:false,sample:undefined});s.control.arm();s.pointer(20,20);expect(s.reads).toHaveLength(1);s.detach();
});
it('handles keyboard pixel moves and Escape without project callbacks or full-image reads',()=>{
  const s=setup();s.control.arm();s.key('Enter');expect(s.control.state().sample).toMatchObject({x:32,y:18});s.key('ArrowRight');expect(s.control.state().sample?.x).toBe(33);expect(s.key('Escape').defaultPrevented).toBe(true);expect(s.control.state().armed).toBe(false);const count=s.reads.length;s.key('Enter');expect(s.reads).toHaveLength(count);s.detach();
});
it('labels comparison sides, clips averaging to one side and rejects the divider',()=>{
  const s=setup(),split=s.setSplit();s.control.setSide(9);s.control.arm();s.pointer(62,20,split);expect(s.control.state().sample).toMatchObject({x:31,basis:'decoded-source-preview',patchWidth:5});s.pointer(64,20,split);expect(s.control.state().sample).toBeUndefined();expect(s.control.state().notice).toContain('分割線');s.pointer(68,20,split);expect(s.control.state().sample).toMatchObject({x:34,basis:'graded-preview',patchWidth:6});s.detach();
});
it('comparison presentation changes clear old readouts but can reuse the same bound frame',()=>{
  const s=setup();s.control.arm();s.pointer(20,20);s.control.setContext('split-position',identity);expect(s.control.state()).toMatchObject({ready:true,armed:false,sample:undefined});s.control.arm();s.key('Enter');expect(s.control.state().sample).toBeDefined();s.detach();
});
it('keyboard cursor crosses the rejected split divider instead of getting stuck',()=>{
  const s=setup(),split=s.setSplit();s.control.arm();s.key('Enter',split);expect(s.control.state().sample).toBeUndefined();s.key('ArrowLeft',split);expect(s.control.state().sample).toMatchObject({x:31,basis:'decoded-source-preview'});s.key('ArrowRight',split);expect(s.control.state().sample).toBeUndefined();s.key('ArrowRight',split);expect(s.control.state().sample).toMatchObject({x:33,basis:'graded-preview'});s.detach();
});
it('unready/failed GPU, changed media clock and disposal retain no sample',()=>{
  const s=setup();s.canvas.dataset.gradeStatus='error';s.control.arm();expect(s.control.state().armed).toBe(false);s.control.clear();expect(s.control.state().sample).toBeUndefined();
  const video=Object.assign(new EventTarget(),{tagName:'VIDEO',paused:true,seeking:false,readyState:4,currentTime:1.4});s.canvas.dataset.gradeStatus='ready';s.control.setContext('video',{...identity,sourceTime:1.4});s.control.receive(s.canvas as any,video as any,{...identity,sourceTime:1.4});expect(s.control.state().ready).toBe(true);video.currentTime=0;expect(s.control.state().ready).toBe(false);s.detach();expect(s.control.state().ready).toBe(false);
});
