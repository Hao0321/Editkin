import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const mock=vi.hoisted(()=>({invoke:vi.fn(),listen:vi.fn(async()=>()=>{}),convert:vi.fn((x:string)=>x)}));
vi.mock('@tauri-apps/api/core',()=>({invoke:mock.invoke,convertFileSrc:mock.convert,Channel:class{onmessage:unknown}}));
vi.mock('@tauri-apps/api/event',()=>({listen:mock.listen}));
vi.mock('@tauri-apps/api/webview',()=>({getCurrentWebview:()=>({setZoom:vi.fn()})}));
beforeEach(()=>{vi.resetModules();mock.invoke.mockReset();vi.stubGlobal('window',{__TAURI_INTERNALS__:{}});vi.stubGlobal('document',{documentElement:{lang:'ja'}});mock.invoke.mockResolvedValue(undefined)});
afterEach(()=>{vi.unstubAllGlobals();vi.resetModules()});
describe("actual Tauri LUT bridge",()=>{
  it("sends list/picker/import metadata and only ID/hash/space for binary reads",async()=>{
    await import('./tauriBridge');const api=window.haoDesktop!;
    await api.listColorLutsV1!();expect(mock.invoke).toHaveBeenCalledWith('list_color_luts_v1',{offset:0,limit:100});
    mock.invoke.mockResolvedValueOnce({selectionId:'native-selected',suggestedName:'Own LUT'});expect(await api.pickColorLutV1!()).toEqual({selectionId:'native-selected',suggestedName:'Own LUT'});expect(mock.invoke).toHaveBeenCalledWith('pick_color_lut_v1',{uiLocale:'ja'});
    const request={selectionId:'native-selected',name:'Own',license:'CC0-1.0',provenance:'Own fixture',rightsBasis:'owner-authored',inputSpace:'rec709_display' as const};await api.importColorLutV1!(request);expect(mock.invoke).toHaveBeenCalledWith('import_color_lut_v1',{request});
    const bytes=new TextEncoder().encode('\ufeffLUT_1D_SIZE 2\n0 0 0\n1 1 1\n'),ref={id:'lut:'+ 'a'.repeat(16),sha256:'a'.repeat(64)};mock.invoke.mockResolvedValueOnce(bytes.buffer);
    expect(await api.readColorLutV1!(ref,'rec709_display')).toBe('\ufeffLUT_1D_SIZE 2\n0 0 0\n1 1 1\n');expect(mock.invoke).toHaveBeenCalledWith('read_color_lut_v1',{...ref,inputSpace:'rec709_display'});
  });
  it("propagates a native import refusal without pretending it succeeded",async()=>{
    await import('./tauriBridge');mock.invoke.mockRejectedValueOnce(new Error('請重新選擇 LUT 檔案。'));
    await expect(window.haoDesktop!.importColorLutV1!({selectionId:'stale',name:'x',license:'CC0',provenance:'own',rightsBasis:'owner-authored',inputSpace:'rec709_display'})).rejects.toThrow(/重新選擇/);
  });
});
