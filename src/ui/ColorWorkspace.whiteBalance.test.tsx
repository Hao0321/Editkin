import {isValidElement,type ReactElement,type ReactNode} from "react";
import {describe,expect,it,vi} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";
import {createDemoProject} from "../domain/demo";
import {DEFAULT_COLOR} from "../domain/types";
import {ColorWorkspace} from "./ColorWorkspace";
// Component callbacks and rendered markup; not browser canvas/colorimetric validation.
vi.mock("react",async original=>({...await original<typeof import("react")>(),useEffect:()=>{},useRef:()=>({current:null}),useState:(initial:unknown)=>[initial,()=>{}]}));
type Element=ReactElement<Record<string,any>>;
function all(node:ReactNode):Element[]{if(Array.isArray(node))return node.flatMap(all);if(!isValidElement(node))return [];const e=node as Element;return [e,...all(e.props.children)];}
function setup(wb=false,hdr=false){const p=createDemoProject(),clip=p.tracks[0].clips[0],asset=p.assets[0];if(wb)clip.color.whiteBalanceRed=.5;if(hdr)asset.color={interpretation:"hlg",primaries:"bt2020",transfer:"arib-std-b67",matrix:"bt2020nc",range:"tv"};const changed=vi.fn();const element=ColorWorkspace({asset,clip,source:"fixture.mp4",playhead:0,colorManagement:p.colorManagement!,onColorManagementChange:()=>{},onColorChange:changed,onInputColorSpaceChange:()=>{},onAlphaModeChange:()=>{},onClose:()=>{}});return {element,changed};}
describe("linear WB controls and honest scopes",()=>{
 it("starts advanced controls collapsed and emits only changed stop field",()=>{const {element,changed}=setup();const elements=all(element);expect(elements.find(e=>e.type==="details")?.props.open).toBeUndefined();const slider=elements.find(e=>e.props['data-testid']==="grade-whiteBalanceGreen")!;slider.props.onChange({target:{value:".35"}});expect(changed).toHaveBeenLastCalledWith({whiteBalanceGreen:.35});expect(renderToStaticMarkup(element)).toContain("不是 Kelvin");});
 it("reset includes every DEFAULT_COLOR field without altering alpha",()=>{const {element,changed}=setup(true);all(element).find(e=>e.props.className==="grade-reset")!.props.onClick();expect(changed).toHaveBeenCalledWith(DEFAULT_COLOR);expect(changed.mock.calls[0][0]).not.toHaveProperty("opacity");});
 it.each([[true,false],[false,true]])("hides untrustworthy scopes for WB=%s HDR=%s",(wb,hdr)=>{const html=renderToStaticMarkup(setup(wb,hdr).element);expect(html).toContain("color-scope-unavailable");expect(html).not.toContain('class="scope-grid"');expect(html).not.toContain('class="color-source-preview"');});
 it("labels the unchanged browser scopes approximate",()=>{expect(renderToStaticMarkup(setup().element)).toContain("RGB Waveform（近似）");});
});
