import { isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type MediaAsset, type TimelineClip } from "../domain/types";
import { interfacePreferences } from "./i18n/interfacePreferences";
import { ClipSpeedControls } from "./ClipSpeedControls";

vi.mock("./i18n/interfacePreferences", async importOriginal => {
  const actual = await importOriginal<typeof import("./i18n/interfacePreferences")>();
  return { ...actual, useI18n: () => ({ ...actual.interfacePreferences.getSnapshot(), t: actual.translateUi }) };
});
type Props = Record<string, any> & { children?: ReactNode };
function elements(node: ReactNode, out: Props[] = []): Props[] {
  if (Array.isArray(node)) node.forEach(child => elements(child, out));
  else if (isValidElement<Props>(node)) { out.push(node.props); elements(node.props.children, out); }
  return out;
}
const byId = (tree: ReactNode, id: string) => elements(tree).find(props => props['data-testid'] === id)!;

const clip:TimelineClip={id:'clip',trackId:'video-main',assetId:'media',timelineStart:1,sourceStart:0,duration:4,volume:1,
  transform:{...DEFAULT_TRANSFORM},color:{...DEFAULT_COLOR},keyframes:[]};
const asset:MediaAsset={id:'media',kind:'video',name:'clip',uri:'D:/owned/clip.mp4',duration:4};
afterEach(async()=>{await interfacePreferences.setLocale('zh-TW');});
describe('absolute speed controls',()=>{
  it('uses the four prescribed presets and passes absolute rate and reverse separately',()=>{
    const retime=vi.fn(),freeze=vi.fn();
    const tree=ClipSpeedControls({clip,asset:{...asset,clipRetime:{schema:'editkin.clip-retime/v1',sourceAssetId:'original',sourceStart:0,sourceDuration:8,rate:2,reverse:false}},
      playhead:2,onRetime:retime,onFreezeFrame:freeze});
    expect(byId(tree,'clip-speed-2')['aria-pressed']).toBe(true);
    byId(tree,'clip-speed-0.5').onClick();expect(retime).toHaveBeenLastCalledWith(.5,false);
    expect(byId(tree,'clip-reverse')['aria-pressed']).toBe(false);
    byId(tree,'clip-reverse').onClick();expect(retime).toHaveBeenLastCalledWith(2,true);
    byId(tree,'clip-freeze-frame').onClick();expect(freeze).toHaveBeenCalledTimes(1);
    const html=renderToStaticMarkup(tree);
    expect(html).not.toContain('type="checkbox"');
    expect(byId(tree,'clip-reverse').type).toBe('button');
    expect(elements(tree).find(props=>props.role==='group')?.className).toBe('timeline-tool-toggle');
    expect(byId(tree,'clip-freeze-frame').className).toBe('clip-speed-freeze');
    for(const value of ['0.5×','1×','1.5×','2×']) expect(html).toContain(value);
  });
  it('blocks repeated busy edits and freezes outside the chosen clip; image media has no speed controls',()=>{
    const retime=vi.fn();
    const busy=ClipSpeedControls({clip,asset,busy:true,onRetime:retime,onFreezeFrame:()=>{},playhead:2});
    expect(elements(busy).filter(props=>props['data-testid']?.startsWith('clip-speed-')&&props['data-testid']!=='clip-speed-controls').every(props=>props.disabled)).toBe(true);
    expect(byId(busy,'clip-reverse').disabled).toBe(true);expect(byId(busy,'clip-freeze-frame').disabled).toBe(true);
    const outside=ClipSpeedControls({clip,asset,onRetime:retime,onFreezeFrame:()=>{},playhead:6});
    expect(byId(outside,'clip-freeze-frame').disabled).toBe(true);
    expect(ClipSpeedControls({clip,asset:{...asset,kind:'image'},onRetime:retime})).toBeNull();
  });
  it('renders the actual generated speed and freeze catalogue in all five languages',async()=>{
    for(const [locale,speed,freeze] of [['zh-TW','片段速度','定格 2 秒'],['en','Clip speed','Freeze for 2 seconds'],['es','Velocidad del clip','Congelar 2 segundos'],['ja','クリップの速度','2秒間フリーズ'],['ko','클립 속도','2초 정지']] as const){
      await interfacePreferences.setLocale(locale);
      const tree=ClipSpeedControls({clip,asset,playhead:2,onRetime:()=>{},onFreezeFrame:()=>{}});
      expect(elements(tree).find(props=>props.role==='group')?.['aria-label']).toBe(speed);
      expect(byId(tree,'clip-freeze-frame').children).toBe(freeze);
    }
  });
});
