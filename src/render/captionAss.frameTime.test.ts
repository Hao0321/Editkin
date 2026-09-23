import {describe,it,expect} from 'vitest';
import {assMotionFrameTime,writeAssContent} from './captionAss';
import {createEmptyProject} from '../domain/editGraph';
import {createMotionGraphic} from '../motion/composition';
import {findMotionGraphicPreset} from '../creative/motionGraphicPresets';
const parse=(text:string)=>{const [h,m,s]=text.split(':').map(Number);return h*3600+m*60+s;};
describe('ASS samples select the authored integer motion frame',()=>{
 for(const fps of [1,23.976,24,25,29.97,30,50,59.94,60,100])it(`has no gaps, double states or one-frame delays at ${fps} fps`,()=>{
  for(const offset of [0,37,100000])for(let n=offset;n<offset+fps*3;n++){
   const start=parse(assMotionFrameTime(n,fps)),end=parse(assMotionFrameTime(n+1,fps)),time=n/fps;
   expect(start).toBeLessThanOrEqual(time+1e-9);expect(end).toBeGreaterThan(time+1e-9);expect(end).toBeGreaterThan(start);
  }
 });
 it('does not pretend centisecond events support more than 100 states per second',()=>{
  for(const fps of [0,NaN,101,120,240])expect(()=>assMotionFrameTime(0,fps)).toThrow();
  const p=createEmptyProject('high-fps',{width:1920,height:1080,fps:120});p.motionGraphics=[createMotionGraphic('g','title','TEXT',0,3,undefined,findMotionGraphicPreset('v2-word-cascade').seed)];
  expect(()=>writeAssContent(p,p.captionStyle)).toThrow(/100 fps/);
 });
 it('removes the last-frame panel instead of holding the previous fade sample',()=>{
  const p=createEmptyProject('last-frame'),g=createMotionGraphic('g','title','TEXT',0,3,undefined,findMotionGraphicPreset('v2-word-cascade').seed);p.motionGraphics=[g];
  const active=writeAssContent(p,p.captionStyle).split('\n').filter(s=>s.startsWith('Dialogue:')).filter(s=>{const parts=s.split(',');return parse(parts[1])<=89/30&&parse(parts[2])>89/30;});
  expect(active).toHaveLength(0);
 });
});
