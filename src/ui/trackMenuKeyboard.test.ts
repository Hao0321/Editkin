import {describe,it,expect,vi} from 'vitest';
import {activateTrackMenuItem} from './trackMenuKeyboard';
describe('track menu activation',()=>{
  it.each(['Enter',' '])('activates %s once and stops editor/default handling',key=>{
    const e={key,repeat:false,preventDefault:vi.fn(),stopPropagation:vi.fn()},item={disabled:false,click:vi.fn()};
    expect(activateTrackMenuItem(e,item)).toBe(true);expect(item.click).toHaveBeenCalledOnce();expect(e.preventDefault).toHaveBeenCalledOnce();expect(e.stopPropagation).toHaveBeenCalledOnce();
  });
  it('does not repeat or activate disabled, missing, or unrelated targets',()=>{
    const item={disabled:false,click:vi.fn()},e={key:'Enter',repeat:true,preventDefault:vi.fn(),stopPropagation:vi.fn()};
    activateTrackMenuItem(e,item);activateTrackMenuItem({...e,repeat:false},{...item,disabled:true});activateTrackMenuItem({...e,repeat:false},null);
    expect(activateTrackMenuItem({...e,key:'ArrowDown',repeat:false},item)).toBe(false);expect(item.click).not.toHaveBeenCalled();
  });
});
