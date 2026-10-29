import { describe,expect,it,vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ColorLutSlotV1 } from "./ColorLutSlotV1";
describe('LUT slot UI contract',()=>{
  it('shows a truthful unavailable state and disabled modification on older APIs',()=>{const html=renderToStaticMarkup(<ColorLutSlotV1 clipId="c" nodeId="n" node={{id:'n'}} space="rec709_display" editable={false} onAction={vi.fn()} onDraft={vi.fn()} onCommit={vi.fn()} onCancel={vi.fn()}/>);expect(html).toContain('尚未提供');expect(html).not.toContain('lut-apply');});
  it('keeps LUT strength reachable for readonly inspection and disables its mutation',()=>{const html=renderToStaticMarkup(<ColorLutSlotV1 clipId="c" nodeId="n" node={{id:'n',lut:{id:'lut:'+ 'a'.repeat(16),sha256:'a'.repeat(64),strength:.5}}} space="rec709_display" editable={false} onAction={vi.fn()} onDraft={vi.fn()} onCommit={vi.fn()} onCancel={vi.fn()}/>);expect(html).toContain('lut-strength');expect(html).toContain('disabled');expect(html).toContain('0.50');});
});
