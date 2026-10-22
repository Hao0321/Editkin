import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { colorLutLibraryLocationV1 } from "./colorLutLibraryLocationV1";
let owned: string | undefined;
afterEach(async()=>{if(owned)await rm(owned,{recursive:true,force:true});owned=undefined});
describe("native/MCP personal LUT location",()=>{
  it("keeps the original default when no profile root exists",()=>{expect(colorLutLibraryLocationV1(process.cwd(),{})).toBe(join(process.cwd(),'.personal-packs','hao-color-luts'))});
  it("uses the writable personal visual sibling rather than installation music resources",()=>{
    const cwd=join(tmpdir(),'owned-location-without-legacy'),visual=join(tmpdir(),'own-profile','personal-packs','hao-visual-library');
    expect(colorLutLibraryLocationV1(cwd,{EDITKIN_PERSONAL_VISUAL_ROOT:visual})).toBe(join(tmpdir(),'own-profile','personal-packs','hao-color-luts'));
  });
  it("respects explicit local root and refuses relative/UNC overrides",()=>{
    expect(colorLutLibraryLocationV1(process.cwd(),{EDITKIN_COLOR_LUT_ROOT:join(tmpdir(),'explicit-lut')})).toBe(join(tmpdir(),'explicit-lut'));
    expect(()=>colorLutLibraryLocationV1(process.cwd(),{EDITKIN_COLOR_LUT_ROOT:'relative'})).toThrow(/絕對/);
    expect(()=>colorLutLibraryLocationV1(process.cwd(),{EDITKIN_COLOR_LUT_ROOT:'//server/share'})).toThrow(/絕對/);
  });
  it("refuses silent legacy library relocation and leaves its bytes untouched",async()=>{
    owned=await mkdtemp(join(tmpdir(),'editkin-lut-location-'));const legacy=join(owned,'.personal-packs','hao-color-luts');await mkdir(legacy,{recursive:true});const file=join(legacy,'editkin-color-luts.json');await writeFile(file,'{"owned":"legacy"}');
    expect(()=>colorLutLibraryLocationV1(owned!,{EDITKIN_PERSONAL_VISUAL_ROOT:join(owned!,'profile','hao-visual-library')})).toThrow(/舊 LUT/);
    expect(colorLutLibraryLocationV1(owned,{EDITKIN_COLOR_LUT_ROOT:legacy})).toBe(legacy);
    expect(await readFile(file,'utf8')).toBe('{"owned":"legacy"}');
  });
});
