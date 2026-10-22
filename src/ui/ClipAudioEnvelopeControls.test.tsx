import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { interfacePreferences } from "./i18n/interfacePreferences";
import { ClipAudioEnvelopeControls } from "./ClipAudioEnvelopeControls";
import { audioEnvelopeFixture } from "../domain/clipAudioEnvelope.fixture";
import { withClipVolumePoint } from "../domain/clipAudioEnvelope";
vi.mock("./i18n/interfacePreferences", async original => {
  const actual=await original<typeof import("./i18n/interfacePreferences")>();
  return {...actual,useI18n:()=>({...actual.interfacePreferences.getSnapshot(),t:actual.translateUi})};
});
afterEach(async()=>{await interfacePreferences.setLocale("zh-TW");});
describe("findable sound controls in both editor modes",()=>{
  it("provides two bounded fade fields and the add-point action in all five languages",async()=>{
    for(const locale of ["zh-TW","en","es","ja","ko"] as const){
      await interfacePreferences.setLocale(locale);const {clip}=audioEnvelopeFixture();
      const html=renderToStaticMarkup(<ClipAudioEnvelopeControls clip={clip} playhead={3} fps={30} onChange={()=>{}} />);
      expect(html).toContain('min="0" max="5" step="0.1"');expect(html).toContain('data-testid="add-clip-volume-point"');
      if(locale!=="zh-TW")expect(html).not.toMatch(/淡入|淡出|在播放頭加音量點/);
    }
  });
  it("disables edits for locked tracks and when the playhead is outside the clip, while keeping point removal accessible",()=>{
    const {clip}=audioEnvelopeFixture();clip.audioEnvelope=withClipVolumePoint(clip,{id:"point",time:1,db:6});
    const locked=renderToStaticMarkup(<ClipAudioEnvelopeControls clip={clip} playhead={3} fps={30} disabled onChange={()=>{}} />);
    expect(locked).toMatch(/data-testid="add-clip-volume-point" disabled/);expect(locked).toContain('aria-label="刪除音量點 1"');
    const outside=renderToStaticMarkup(<ClipAudioEnvelopeControls clip={clip} playhead={0} fps={30} onChange={()=>{}} />);
    expect(outside).toMatch(/data-testid="add-clip-volume-point" disabled/);
  });
});
