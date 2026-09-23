import {describe,it,expect} from 'vitest';
import {createDemoProject} from '../domain/demo';
import {buildGpuEngineVideoPreviewGraph,buildGpuVideoPreviewSource} from './gpuCompositor';
import type {MediaColorMetadata} from '../domain/types';
function project(color?:MediaColorMetadata){const p=createDemoProject();p.width=960;p.height=540;p.assets[0]!.width=960;p.assets[0]!.height=540;p.assets[0]!.uri='C:/fixture/not-decoded.mp4';p.assets[0]!.color=color;p.captions=[];p.motionGraphics=[];return p;}
describe('native video declared color admission',()=>{
  it.each([undefined,{interpretation:'auto'},{interpretation:'rec709'},{interpretation:'auto',transfer:'bt709',primaries:'bt709',matrix:'bt709',range:'tv'},{interpretation:'rec709',transfer:'bt709',primaries:'bt709',matrix:'bt709',range:'pc'}] as Array<MediaColorMetadata|undefined>)('retains compatible SDR control %j',color=>{const p=project(color);expect(buildGpuEngineVideoPreviewGraph(p,1)).toBeDefined();expect(buildGpuVideoPreviewSource(p,1)).toBeDefined();});
  it.each(['arib-std-b67','smpte2084','hlg','pq','log','slog3','unknown'])('rejects declared transfer %s instead of auto→709',transfer=>{const p=project({interpretation:'auto',transfer});expect(buildGpuEngineVideoPreviewGraph(p,1)).toBeUndefined();expect(buildGpuVideoPreviewSource(p,1)).toBeUndefined();});
  it.each([{primaries:'bt2020'},{primaries:'smpte432'},{matrix:'bt2020nc'},{matrix:'unknown'},{range:'unknown'},{interpretation:'hlg'},{interpretation:'log_unresolved'},{interpretation:'rec709',transfer:'arib-std-b67'}] as Partial<MediaColorMetadata>[])('rejects unhandled/conflicting metadata %j',color=>{const p=project({interpretation:'auto',...color});expect(buildGpuEngineVideoPreviewGraph(p,1)).toBeUndefined();expect(buildGpuVideoPreviewSource(p,1)).toBeUndefined();});
  it('does not change original metadata while admitting compatible auto',()=>{const p=project({interpretation:'auto',transfer:'bt709'}),before=JSON.stringify(p);expect(buildGpuEngineVideoPreviewGraph(p,1)).toBeDefined();expect(JSON.stringify(p)).toBe(before);});
});
