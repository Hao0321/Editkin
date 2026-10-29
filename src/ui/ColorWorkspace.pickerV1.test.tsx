import { DEFAULT_COLOR_MANAGEMENT } from "../domain/types";
import {it,expect,vi} from 'vitest';
import {isValidElement,type ReactElement,type ReactNode} from 'react';
import {createDemoProject} from '../domain/demo';
import {ColorWorkspace} from './ColorWorkspace';
import {GpuColorScopesV1} from './GpuColorScopesV1';
vi.mock('react',async original=>({...await original<typeof import('react')>(),useEffect:()=>{},useRef:(value:unknown)=>({current:value}),useState:(value:unknown)=>[value,()=>{}]}));
vi.mock('./i18n/interfacePreferences',async original=>({...await original<typeof import('./i18n/interfacePreferences')>(),useI18n:()=>({})}));
function all(n:ReactNode):ReactElement<Record<string,any>>[]{if(Array.isArray(n))return n.flatMap(all);if(!isValidElement(n))return[];const e=n as ReactElement<Record<string,any>>;return[e,...all(e.props.children)];}
function fixture(){const p=createDemoProject(),asset=p.assets[0],clip=p.tracks[0].clips[0];asset.color={interpretation:'rec709'};clip.keyframes=[];const input=vi.fn(),changed=vi.fn();const props={asset,clip,source:'own-fixture',playhead:0,colorManagement:{...DEFAULT_COLOR_MANAGEMENT,mode:'rec709' as const,outputTransform:'rec709_sdr' as const},onColorManagementChange:changed,onColorChange:changed,onInputColorSpaceChange:input,onAlphaModeChange:changed,onClose:()=>{}};return{p,asset,clip,props,input,changed};}
it('malformed HDR keeps a readable blocked workspace and allows explicit input correction',()=>{
  const s=fixture();s.asset.color={interpretation:'hlg'};const before=JSON.stringify(s.p),elements=all(ColorWorkspace(s.props));expect(elements.some(e=>e.type===GpuColorScopesV1)).toBe(false);const message=elements.find(e=>e.props['data-testid']==='color-scope-unavailable')!;expect(message.props.children).toContain('Input Transform');
  const selector=elements.find(e=>e.type==='select'&&e.props.value==='hlg')!;selector.props.onChange({target:{value:'rec709'}});expect(s.input).toHaveBeenCalledExactlyOnceWith('rec709');expect(JSON.stringify(s.p)).toBe(before);expect(s.changed).not.toHaveBeenCalled();
});
it('binds picker to owner/session/clip even when all grade values and source match',()=>{
  const s=fixture(),owner={};const key=(scope:any,clip=s.clip)=>all(ColorWorkspace({...s.props,clip,gradeEditScope:scope})).find(e=>e.type===GpuColorScopesV1)!.props.pickerOwnerKey;
  const a=key({owner,sessionId:1});expect(key({owner,sessionId:1})).toBe(a);expect(key({owner:{},sessionId:1})).not.toBe(a);expect(key({owner,sessionId:2})).not.toBe(a);expect(key({owner,sessionId:1},{...s.clip,id:'other'})).not.toBe(a);
});
it('rendering preview picker wiring is readonly and does not create project actions',()=>{
  const s=fixture(),before=JSON.stringify(s.p);all(ColorWorkspace(s.props));expect(JSON.stringify(s.p)).toBe(before);expect(s.changed).not.toHaveBeenCalled();expect(s.input).not.toHaveBeenCalled();
});
