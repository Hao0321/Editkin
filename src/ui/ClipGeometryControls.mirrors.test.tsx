import { renderToStaticMarkup } from "react-dom/server";
import { afterEach,expect,it } from "vitest";
import { ClipGeometryControls } from "./ClipGeometryControls";
import { interfacePreferences } from "./i18n/interfacePreferences";
afterEach(async()=>{await interfacePreferences.setLocale("zh-TW");});
it("keeps mirror buttons beside rotation, pressed state and lock accessibility in all five languages",async()=>{
  for(const locale of ["zh-TW","en","es","ja","ko"] as const){await interfacePreferences.setLocale(locale);
    const markup=renderToStaticMarkup(<ClipGeometryControls rotation={0} flipX disabled onFlip={()=>{}} onCropChange={()=>{}} onRotationChange={()=>{}}/>);
    expect(markup).toMatch(/aria-pressed="true"[^>]*data-testid="clip-flip-horizontal"/);expect(markup).toMatch(/aria-pressed="false"[^>]*data-testid="clip-flip-vertical"/);
    expect(markup).toContain('data-testid="clip-rotate-right"');expect(markup.match(/disabled=""/g)).toHaveLength(8);
    if(locale!=="zh-TW")expect(markup).not.toMatch(/水平翻轉|垂直翻轉/);
  }
});
