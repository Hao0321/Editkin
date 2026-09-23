import {describe,it,expect} from 'vitest';
import {createEmptyProject} from '../domain/editGraph';
import {projectSchema} from '../domain/schema';
import {applyCommand} from '../domain/commands';
import {createMotionGraphic} from './composition';
import {motionGraphicV2LayoutReceipt} from './compositionV2';
import {findMotionGraphicPreset} from '../creative/motionGraphicPresets';
import {bundledFontAssMetrics} from '../typography/fontEmMetrics';
import {cssFontFamily} from '../typography/fontFaces';
import {writeAssContent} from '../render/captionAss';

const make=(text='最後這一下')=>createMotionGraphic('title','title',text,0,3,undefined,findMotionGraphicPreset('v2-word-cascade').seed);
describe('v2 physical typography and content-width contract',()=>{
 it('converts the physical Sans em and baseline instead of shrinking it to Windows height',()=>{
  const m=bundledFontAssMetrics('Noto Sans TC',850,72,90.4);
  expect(m.fontSize).toBeCloseTo(104.256,6);expect(m.topOffset).toBeCloseTo(-6.928,6);
  expect(bundledFontAssMetrics('Bebas Neue',400,100,120)).toEqual({fontSize:130,topOffset:-5});
 });
 it('does not apply a guessed metric to an unknown font',()=>expect(()=>bundledFontAssMetrics('Unknown Font',800,72,90)).toThrow(/缺少已驗證/));
 it('rejects a v2 output with an unverified legacy font root',()=>{
  const p=createEmptyProject('font-root');p.motionGraphics=[make()];expect(()=>writeAssContent(p,p.captionStyle,{bundledFaces:false})).toThrow(/已驗證/);
 });
 it('quotes physical aliases for CSS without changing the raw ASS identity',()=>{
  expect(cssFontFamily('EditkinFace noto-sans-tc 850')).toBe('"EditkinFace noto-sans-tc 850"');
  expect(cssFontFamily('A"B\\C\nD')).toBe('"A\\"B\\\\C D"');expect(cssFontFamily(undefined)).toBeUndefined();
 });
 for(const align of ['left','center','right'] as const)it(`hugs text while preserving ${align} slot alignment and fixed-width compatibility`,()=>{
  const p=createEmptyProject('fit',{width:1080,height:1920,fps:30}),g=make();g.layoutV2!.align=align;
  const fixed=motionGraphicV2LayoutReceipt(p,g);g.layoutV2!.widthMode='fit_content';const fit=motionGraphicV2LayoutReceipt(p,g);
  expect(fixed.box.width).toBe(820.8);expect(fit.box.width).toBe(402);expect(fit.fontSize).toBe(fixed.fontSize);
  expect(fit.box.x).toBeCloseTo(fixed.box.x+(fixed.box.width-fit.box.width)*({left:0,center:.5,right:1}[align]),6);
  expect(fit.segments.map(s=>s.text).join('')).toBe(g.text);expect(fit.receiptId).not.toBe(fixed.receiptId);
  expect(fit.box.x+fit.box.width).toBeLessThanOrEqual(fit.safeRect.x+fit.safeRect.width);
 });
 it('reflows multiline text and roundtrips the optional field through the real command/schema without mutating the original',()=>{
  const p=createEmptyProject('fit',{width:1080,height:1920,fps:30});p.motionGraphics=[make('盜版神杖\n對上正版爆刃')];const old=JSON.stringify(p);
  const changed=applyCommand(p,{type:'update_motion_graphic',graphicId:'title',patch:{layoutV2:{...p.motionGraphics[0].layoutV2!,widthMode:'fit_content'}}});
  const saved=projectSchema.parse(JSON.parse(JSON.stringify(changed)));const layout=motionGraphicV2LayoutReceipt(saved,saved.motionGraphics[0]);
  expect(layout.lineCount).toBe(2);expect(layout.box.width).toBe(474);expect(JSON.stringify(p)).toBe(old);
 });
 it('rejects malformed width mode and impossible content fit',()=>{
  const p=createEmptyProject('fit',{width:320,height:180,fps:30}),g=make('這是一段無法放入此窄框的標題');
  p.motionGraphics=[g];expect(()=>projectSchema.parse({...p,motionGraphics:[{...g,layoutV2:{...g.layoutV2,widthMode:'expand'}}]})).toThrow();
  g.width=.1;g.layoutV2={...g.layoutV2!,widthMode:'fit_content',minFontSize:72};expect(()=>motionGraphicV2LayoutReceipt(p,g)).toThrow(/auto-fit/);
 });
 it('draws rounded panel contours and no accidental glyph outline',()=>{
  const p=createEmptyProject('panel'),g=make();g.cornerRadius=18;g.shadowDepth=0;p.motionGraphics=[g];
  const ass=writeAssContent(p,p.captionStyle),lines=ass.split('\n');
  expect(lines.some(s=>s.startsWith('Dialogue: 1,')&&s.includes(' b '))).toBe(true);
  expect(lines.filter(s=>s.startsWith('Dialogue: 2,')).every(s=>s.includes('\\bord0\\shad0'))).toBe(true);
  expect(ass).toContain('\\fs104.26');expect(ass).toContain('\\q2');
 });
});
