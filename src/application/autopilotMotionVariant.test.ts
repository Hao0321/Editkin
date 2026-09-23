import {createHash} from 'node:crypto';
import {describe,expect,it} from 'vitest';
import {parseAutopilotPlan,autopilotPlanSha256,assertAutopilotProjectTimelineBinding} from './autopilotPlan';
import {createAutopilotV4Fixture} from './autopilotPlanFixture';
import {findMotionGraphicPreset} from '../creative/motionGraphicPresets';
import {createMotionGraphic} from '../motion/composition';

// Independent wire-format oracle: key ordering must not affect the registered-seed digest.
function ordered(value:any):any{return Array.isArray(value)?value.map(ordered):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,ordered(value[k])])):value;}
function fixture(){
  const base=createAutopilotV4Fixture(),preset=findMotionGraphicPreset('v2-word-cascade');
  const overrides={name:'完整姓名主標',x:.08,y:.06,width:.84,fontSize:84,fontFamily:'Noto Sans TC',fontWeight:850,outlineWidth:0,shadowDepth:0,cornerRadius:14,textColor:'#FFFFFF',backgroundColor:'#10151CD9',accentColor:'#00000000',
    motionV2:{sequence:{unit:'all',order:'forward',exitOrder:'forward',staggerFrames:0},entrance:{durationFrames:8,offsetXPixels:0,offsetYPixels:12,scale:1,opacity:0,easing:{type:'ease_out'}},exit:{durationFrames:6,offsetXPixels:0,offsetYPixels:0,scale:1,opacity:0,easing:{type:'ease_in'}}},
    layoutV2:{safeArea:{left:.06,right:.06,top:.05,bottom:.1},maxLines:2,minFontSize:76,lineGap:2,align:'center',widthMode:'fit_content'}};
  const presetVariant={schema:'editkin.motion-preset-variant/v1',basePresetSha256:createHash('sha256').update(JSON.stringify(ordered({id:preset.id,renderer:preset.renderer,seed:preset.seed}))).digest('hex'),reason:'Full names need a readable, content-sized two-line label away from the subject.',overrides};
  const event={id:'variant-title',presetId:preset.id,presetVariant,range:{startFrame:0,endFrame:90},kind:'title_card',purpose:'context',message:'盜版神杖\n對上正版爆刃',evidenceRefs:['material:opening']};
  const graphic={...createMotionGraphic(event.id,'title',event.message,0,3,undefined,preset.seed),...structuredClone(overrides)};
  return {base,preset,event,graphic,plan:{...base,editorial:{...base.editorial,graphics:[event]},commands:[...base.commands,{type:'add_motion_graphic',graphic}]}};
}
describe('explicit v4 motion-preset variants',()=>{
  it('accepts declared, bounded visual changes and keeps them in the plan hash and JSON roundtrip',()=>{
    const {plan}=fixture();const parsed=parseAutopilotPlan(plan);expect(parsed).toMatchObject({editorial:{graphics:[{presetVariant:{schema:'editkin.motion-preset-variant/v1'}}]}});
    expect(parseAutopilotPlan(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    expect(()=>assertAutopilotProjectTimelineBinding(parsed as any,30)).not.toThrow();
    const changed=structuredClone(plan);changed.editorial.graphics[0].presetVariant.reason+=' Deliberate revision.';
    expect(autopilotPlanSha256(parseAutopilotPlan(changed))).not.toBe(autopilotPlanSha256(parsed));
  });
  it('still rejects custom parameters falsely claiming an unchanged stock preset',()=>{
    const {plan}=fixture();delete (plan.editorial.graphics[0] as any).presetVariant;
    expect(()=>parseAutopilotPlan(plan)).toThrow(/未忠實解析 preset/);
  });
  it('rejects a different or stale registered-seed identity',()=>{
    const {plan}=fixture();plan.editorial.graphics[0].presetVariant.basePresetSha256='0'.repeat(64);
    expect(()=>parseAutopilotPlan(plan)).toThrow(/seed.*(hash|SHA)|seed.*不一致/i);
  });
  it.each(['fontSize','accentColor','motionV2'] as const)('rejects undeclared %s mutations in the resolved command',key=>{
    const {plan}=fixture();const g=(plan.commands.at(-1) as any).graphic;
    if(key==='fontSize')g.fontSize=85;else if(key==='accentColor')g.accentColor='#FF00FF';else g.motionV2.entrance.offsetYPixels=30;
    expect(plan.editorial.graphics[0].presetVariant.overrides.motionV2.entrance.offsetYPixels).toBe(12);
    expect(()=>parseAutopilotPlan(plan)).toThrow(/variant|變體/i);
  });
  it.each(['schema','kind','text','presetId','trackId','trackingMode','visualStyle','templateOwner','execute','uri'])('forbids the override key %s',key=>{
    const {plan}=fixture();(plan.editorial.graphics[0].presetVariant.overrides as any)[key]='untrusted';expect(()=>parseAutopilotPlan(plan)).toThrow();
  });
  it('rejects unsupported nested fields instead of silently dropping them',()=>{
    const {plan}=fixture();(plan.editorial.graphics[0].presetVariant.overrides.motionV2.entrance.easing as any).expression='arbitrary-code';expect(()=>parseAutopilotPlan(plan)).toThrow();
  });
  it.each([NaN,Infinity,-1,10000])('rejects invalid font size %s',fontSize=>{
    const {plan}=fixture();plan.editorial.graphics[0].presetVariant.overrides.fontSize=fontSize;expect(()=>parseAutopilotPlan(plan)).toThrow();
  });
  it('rejects empty overrides and missing motivation',()=>{
    const {plan}=fixture();(plan.editorial.graphics[0].presetVariant as any).overrides={};expect(()=>parseAutopilotPlan(plan)).toThrow();
    const second=fixture().plan;second.editorial.graphics[0].presetVariant.reason='';expect(()=>parseAutopilotPlan(second)).toThrow();
  });
  it('keeps duration/frame constraints even for a correctly declared variant',()=>{
    const {plan}=fixture();plan.editorial.graphics[0].presetVariant.overrides.motionV2.entrance.durationFrames=100;
    const g=(plan.commands.at(-1) as any).graphic;g.motionV2=structuredClone(plan.editorial.graphics[0].presetVariant.overrides.motionV2);
    expect(()=>{const parsed=parseAutopilotPlan(plan);assertAutopilotProjectTimelineBinding(parsed as any,30);}).toThrow(/時長|duration|entrance/i);
  });
});
