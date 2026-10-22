import { DEFAULT_COLOR_MANAGEMENT } from "./types";
import { describe,expect,it } from "vitest";
import { setNodeColorLutV1,sameLutPanelContextV1 } from "./colorLutPanelEditsV1";
import { createDemoProject } from "./demo";
import { createProjectSession } from "../application/projectSession";
import { dispatchCommand,undo } from "./history";
import { validateProject } from "./editGraph";
const entry={id:'lut:'+ 'a'.repeat(16),sha256:'a'.repeat(64),name:'Own',kind:'3d' as const,size:2,bytes:60,path:'luts/'+ 'a'.repeat(64)+'.cube',license:'CC0',provenance:'Own',rightsBasis:'owner-authored',inputSpace:'rec709_display' as const,importedAt:'2026-10-14'};
describe('LUT node edits and live async admission',()=>{
  it('changes only one LUT field with one Undo and persists literal JSON',()=>{
    const p=createDemoProject(),clip=p.tracks[0].clips[0];clip.gradeV2={schema:'editkin.color-grade/v2',nodes:[{id:'n',contrast:1.2},{id:'other',saturation:.7}],look:{id:'hfl2_vlog_soft_film'},finishing:{vignette:{amount:.1}}};const session=createProjectSession(p),before=session.getSnapshot();
    const grade=setNodeColorLutV1(clip.gradeV2,'n',entry,'rec709_display',.5);expect(clip.gradeV2.nodes![0].lut).toBeUndefined();
    const state=dispatchCommand(before.history,{type:'set_clip_grade_v2',clipId:clip.id,grade});expect(state.past.length).toBe(1);expect(undo(state).present).toEqual(p);expect(validateProject(JSON.parse(JSON.stringify(state.present)))).toEqual(state.present);
    expect(grade.nodes![0]).toEqual({...clip.gradeV2.nodes![0],lut:{id:entry.id,sha256:entry.sha256,strength:.5}});expect(grade.nodes![1]).toEqual(clip.gradeV2.nodes![1]);expect(grade.look).toEqual(clip.gradeV2.look);expect(grade.finishing).toEqual(clip.gradeV2.finishing);
    expect(setNodeColorLutV1(grade,'n',undefined,'rec709_display').nodes![0]).toEqual(clip.gradeV2.nodes![0]);
  });
  it('refuses wrong space, invalid identity and out-of-range strength',()=>{
    const grade={schema:'editkin.color-grade/v2' as const,nodes:[{id:'n'}]};expect(()=>setNodeColorLutV1(grade,'n',entry,'acescct')).toThrow(/色彩空間/);expect(()=>setNodeColorLutV1(grade,'n',{...entry,sha256:'b'.repeat(64)},'rec709_display')).toThrow();expect(()=>setNodeColorLutV1(grade,'n',entry,'rec709_display',2)).toThrow();
  });
  it('rejects same-ID project replacement before React props have updated',()=>{
    const p=createDemoProject(),session=createProjectSession(p),ctx={clipId:p.tracks[0].clips[0].id,nodeId:'n',grade:undefined,space:'rec709_display' as const,editable:true,scope:{owner:session,sessionId:session.getSnapshot().sessionId}};
    expect(sameLutPanelContextV1(ctx,ctx)).toBe(true);session.replaceProject(structuredClone(p));expect(sameLutPanelContextV1(ctx,ctx)).toBe(false);
  });
  it('rejects live grade/lock/space changes and accepts locked read-only metadata',()=>{
    const p=createDemoProject(),session=createProjectSession(p),ctx={clipId:p.tracks[0].clips[0].id,nodeId:'n',grade:undefined,space:'rec709_display' as const,editable:true,scope:{owner:session,sessionId:session.getSnapshot().sessionId}};
    p.tracks[0].locked=true;expect(sameLutPanelContextV1(ctx,ctx)).toBe(false);expect(sameLutPanelContextV1(ctx,{...ctx,readOnly:true})).toBe(true);p.tracks[0].locked=false;p.tracks[0].clips[0].gradeV2={schema:'editkin.color-grade/v2'};expect(sameLutPanelContextV1(ctx,ctx)).toBe(false);
    delete p.tracks[0].clips[0].gradeV2;p.colorManagement={...DEFAULT_COLOR_MANAGEMENT,mode:'aces2',outputTransform:'rec709_sdr'};expect(sameLutPanelContextV1(ctx,ctx)).toBe(false);
  });
});
