import { isValidElement, type ReactNode } from 'react';
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { ClipContextMenu } from './ClipContextMenu';

const hooks=vi.hoisted(()=>({effect:undefined as undefined|(()=>void|(()=>void)),ref:{current:null as any}}));
vi.mock('react',async original=>({...await original<typeof import('react')>(),useRef:()=>hooks.ref,useEffect:(effect:()=>void)=>{hooks.effect=effect;}}));
vi.mock('react-dom',()=>({createPortal:(tree:ReactNode)=>tree}));
vi.mock('./i18n/interfacePreferences',async original=>({...await original<typeof import('./i18n/interfacePreferences')>(),useI18n:()=>({})}));
type Props=Record<string,any> & {children?:ReactNode};
function nodes(tree:ReactNode):Props[]{
  if(Array.isArray(tree))return tree.flatMap(nodes);
  return isValidElement<Props>(tree)?[tree.props,...nodes(tree.props.children)]:[];
}
// Normalize the boolean capture form to match browser EventTarget removal semantics.
class UiEvents extends EventTarget {
  override addEventListener(type:string,listener:EventListenerOrEventListenerObject|null,options?:AddEventListenerOptions|boolean){super.addEventListener(type,listener,typeof options==='boolean'?{capture:options}:options);}
  override removeEventListener(type:string,listener:EventListenerOrEventListenerObject|null,options?:EventListenerOptions|boolean){super.removeEventListener(type,listener,typeof options==='boolean'?{capture:options}:options);}
}
let doc:EventTarget,host:EventTarget,dispose:void|(()=>void);
beforeEach(()=>{doc=new UiEvents();host=new UiEvents();vi.stubGlobal('document',Object.assign(doc,{body:{}}));
  vi.stubGlobal('window',Object.assign(host,{innerWidth:1280,innerHeight:720}));hooks.ref.current=null;});
afterEach(()=>{if(typeof dispose==='function')dispose();dispose=undefined;vi.unstubAllGlobals();});
describe('clip context menu focus and dismissal',()=>{
  it('keeps the popup in view and consumes Escape before timeline shortcuts',()=>{
    const close=vi.fn(),focus=vi.fn();
    const tree=ClipContextMenu({target:{clipId:'A',x:1260,y:700},disabled:false,onClose:close,onFreezeFrame:vi.fn()});
    const menu=nodes(tree).find(props=>props.role==='menu')!;
    expect(menu.style.left).toBeLessThan(1260);expect(menu.style.top).toBeLessThan(700);
    hooks.ref.current={querySelector:()=>({focus}),contains:()=>false};dispose=hooks.effect?.();expect(focus).toHaveBeenCalledTimes(1);
    const escape=new Event('keydown',{cancelable:true});Object.defineProperty(escape,'key',{value:'Escape'});
    const stop=vi.spyOn(escape,'stopPropagation');doc.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true);expect(stop).toHaveBeenCalledTimes(1);expect(close).toHaveBeenCalledTimes(1);
  });
  it('dismisses before starting media work and exposes the busy/locked disabled state',()=>{
    const order:string[]=[];
    const tree=ClipContextMenu({target:{clipId:'A',x:100,y:100},disabled:true,onClose:()=>order.push('close'),onFreezeFrame:id=>order.push(id)});
    const item=nodes(tree).find(props=>props.role==='menuitem')!;expect(item.disabled).toBe(true);
    item.onClick();expect(order).toEqual(['close','A']);
    hooks.ref.current={querySelector:()=>null,contains:()=>false};dispose=hooks.effect?.();doc.dispatchEvent(new Event('pointerdown'));
    expect(order).toEqual(['close','A','close']);
    if(typeof dispose==='function')dispose();dispose=undefined;doc.dispatchEvent(new Event('pointerdown'));expect(order).toHaveLength(3);
  });
});
