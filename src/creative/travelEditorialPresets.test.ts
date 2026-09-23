import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createEmptyProject} from '../domain/editGraph';
import {createMotionGraphic} from '../motion/composition';
import {motionGraphicV2FrameReceipt,motionGraphicV2LayoutReceipt} from '../motion/compositionV2';
import {resolveBundledFontFace} from '../typography/fontFaces';
import {writeAssContent} from '../render/captionAss';
import {TRAVEL_EDITORIAL_PRESETS} from './travelEditorialPresets';
import {findMotionGraphicPreset} from './motionGraphicPresets';

const make=(id:string,text:string)=>createMotionGraphic(id,'title',text,1,3,undefined,findMotionGraphicPreset(id).seed);
describe('travel editorial candidates: structural controls, not art approval',()=>{
 it('binds actual registry seeds without generic-kind or private seed substitution',()=>{
  for(const preset of TRAVEL_EDITORIAL_PRESETS){expect(findMotionGraphicPreset(preset.id)).toEqual(preset);const graphic=make(preset.id,'勝興散步');expect(graphic.presetId).toBe(preset.id);expect(graphic.schema).toBe('hao.motion-composition/v2');expect(graphic.motionV2).toEqual(preset.seed.motionV2);expect(graphic.backgroundColor).toBe('#00000000');expect(graphic.motionV2?.sequence.unit).toBe('all');}
 });
 for(const width of [720,1080])for(const text of ['勝興散步','火車雞蛋糕'])it(`keeps ${text} on one readable line at ${width}`,()=>{
  const project=createEmptyProject('layout',{width,height:width*16/9,fps:30}),g=make('travel_editorial_hero',text),layout=motionGraphicV2LayoutReceipt(project,g);
  expect(layout.lineCount).toBe(1);expect(layout.unitCount).toBe(1);expect(layout.fontSize).toBeGreaterThanOrEqual(64);expect(layout.segments.map(s=>s.text).join('')).toBe(text);
  for(const s of layout.segments){expect(s.x).toBeGreaterThanOrEqual(layout.safeRect.x);expect(s.x+s.width).toBeLessThanOrEqual(layout.safeRect.x+layout.safeRect.width+.001);expect(s.y+s.height).toBeLessThanOrEqual(layout.safeRect.y+layout.safeRect.height+.001);}
 });
 it('keeps visible eyebrow glyph bounds clear of hero through every animation frame',()=>{
  const project=createEmptyProject('layout',{width:720,height:1280,fps:30}),hero=make('travel_editorial_hero','火車雞蛋糕'),eyebrow=make('travel_editorial_eyebrow','苗栗・三義');
  const h=motionGraphicV2LayoutReceipt(project,hero),e=motionGraphicV2LayoutReceipt(project,eyebrow);
  for(let frame=29;frame<=120;frame++){
   const hf=motionGraphicV2FrameReceipt(project,hero,frame,h),ef=motionGraphicV2FrameReceipt(project,eyebrow,frame,e);
   if(frame<30||frame>=120){expect(hf.visible).toBe(false);expect(ef.visible).toBe(false);continue;}
   for(const state of [...hf.segments,...ef.segments]){expect(state.opacity).toBeGreaterThanOrEqual(0);expect(state.opacity).toBeLessThanOrEqual(1);expect(state.scale).toBe(1);}
   if(!hf.segments.some(s=>s.opacity>.001)||!ef.segments.some(s=>s.opacity>.001))continue;
   const heroTop=Math.min(...h.segments.map((s,i)=>s.y+hf.segments[i].translateYPixels));
   const eyebrowBottom=Math.max(...e.segments.map((s,i)=>s.y+s.height+ef.segments[i].translateYPixels));
   expect(eyebrowBottom).toBeLessThan(heroTop);
  }
 });
 it('rejects an overlong sentence instead of shrinking below the declared readable floor',()=>{
  const project=createEmptyProject('layout',{width:720,height:1280,fps:30});
  for(const id of ['travel_editorial_hero','travel_editorial_eyebrow'])expect(()=>motionGraphicV2LayoutReceipt(project,make(id,'這是一段非常非常長而且不應該被縮小到看不清楚的旅行文章標題'))).toThrow(/auto-fit/);
 });
 it('rejects a clip shorter than its entrance and exit phase budget',()=>{
  const project=createEmptyProject('layout',{width:720,height:1280,fps:30}),g=make('travel_editorial_hero','勝興散步');g.duration=.1;expect(()=>motionGraphicV2LayoutReceipt(project,g)).toThrow();
 });
 it('uses real exact static weight outlines and emits their aliases, not Thin/system substitution',()=>{
  const manifest=JSON.parse(readFileSync('public/fonts/editkin-open-fonts.json','utf8'));
  const project=createEmptyProject('font',{width:720,height:1280,fps:30});
  for(const [id,weight] of [['travel_editorial_hero',750],['travel_editorial_eyebrow',500]] as const){
   const g=make(id,'勝興散步'),resolved=resolveBundledFontFace(g.fontFamily!,g.fontWeight!)!;expect(resolved.weightSubstituted).toBe(false);expect(resolved.fontWeight).toBe(weight);
   const face=manifest.fonts.flatMap((f:any)=>f.faces).find((f:any)=>f.id===resolved.faceId);expect(face).toBeTruthy();const bytes=readFileSync(`public/fonts/${resolved.fontFile}`);expect(createHash('sha256').update(bytes).digest('hex')).toBe(face.sha256);
   let os2=-1;for(let n=0;n<bytes.readUInt16BE(4);n++){const at=12+16*n;if(bytes.toString('ascii',at,at+4)==='OS/2')os2=bytes.readUInt32BE(at+8);}expect(os2).toBeGreaterThan(0);expect(bytes.readUInt16BE(os2+4)).toBe(weight);
   project.motionGraphics=[g];expect(writeAssContent(project,project.captionStyle,{bundledFaces:true})).toContain(`\\fn${resolved.fontFamily}`);
  }
 });
});
