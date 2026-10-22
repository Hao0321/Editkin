import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { audioEnvelopeFixture } from "../domain/clipAudioEnvelope.fixture";
import { clipAudioGainAt, withClipAudioFades, withClipVolumePoint, shiftedClipAudioEnvelope } from "../domain/clipAudioEnvelope";
import { buildClipAudioGainAutomation } from "./clipAudioAutomation";
import { compileNativeAudioProjectPlan } from "./nativeAudioProjectPlan";
import { clipAudioEnvelopeFilter } from "../render/clipAudioEnvelopeFilters";

describe("authored native sample automation and export admission", () => {
  it("keeps every audible sample within 1 dB, including fractional boundaries, trims and 16 volume points", () => {
    for(const shifted of [0,.500011,1.833343]){
      const {clip}=audioEnvelopeFixture();clip.timelineStart=.233337;clip.audioEnvelope=withClipAudioFades(clip,5,5);
      for(let i=0;i<16;i++)clip.audioEnvelope=withClipVolumePoint(clip,{id:`p${i}`,time:i*.77+.000011,db:i%2?-30:6});
      if(shifted){clip.audioEnvelope=shiftedClipAudioEnvelope(clip,shifted);clip.duration-=shifted;}
      const points=buildClipAudioGainAutomation(clip);expect(points.length).toBeLessThanOrEqual(64);
      let index=0,worst=0;const begin=Math.round(clip.timelineStart*48000),length=Math.round(clip.duration*48000);
      for(let sample=0;sample<length;sample++){
        while(index+1<points.length-1&&points[index+1].sample<begin+sample)index++;
        const a=points[index],b=points[index+1],db=a.valueDb+(b.valueDb-a.valueDb)*(begin+sample-a.sample)/(b.sample-a.sample);
        const expected=clipAudioGainAt(clip,sample/48000);
        if(expected>1e-7)worst=Math.max(worst,Math.abs(db-20*Math.log10(expected)));
      }
      expect(worst).toBeLessThanOrEqual(1);
    }
  },15000);
  it("puts authored fades in the native catalog, keeps absolute sample clocks and includes constant gain exactly once", async () => {
    const {project,clip}=audioEnvelopeFixture();project.assets[0].uri=resolve("owned-tone.wav");clip.audioEnvelope=withClipAudioFades(clip,1,2);
    clip.audioEnvelope=withClipVolumePoint(clip,{id:"high",time:3,db:6});
    const result=await compileNativeAudioProjectPlan(project,{generation:1,timelineStartSeconds:2,silentMediaRoot:resolve("cache"),
      resolveSource:async asset=>({path:asset.uri,bytes:1024,sha256:"a".repeat(64),hasAudio:true})});
    const source=result.plan.sources[0];expect(source.gainAutomation?.points[0]).toEqual({sample:48000,value:-144,interpolation:"linear"});
    const plateau=source.gainAutomation!.points.find(p=>p.sample===4*48000)!;
    expect(plateau.value).toBeCloseTo(20*Math.log10(clip.volume)+6,7);
  });
  it("leaves legacy filter strings empty, authors afade at zero offset, and uses sample-accurate aeval after a trim", () => {
    const {clip}=audioEnvelopeFixture();expect(clipAudioEnvelopeFilter(clip)).toBe("");
    clip.audioEnvelope=withClipAudioFades(clip,1,2);expect(clipAudioEnvelopeFilter(clip)).toBe(",afade=t=in:st=0:d=1:curve=tri,afade=t=out:st=10:d=2:curve=tri");
    clip.audioEnvelope=shiftedClipAudioEnvelope(clip,.5);const filter=clipAudioEnvelopeFilter(clip);
    expect(filter).toContain("aeval=");expect(filter).toContain("n/s+0.5");expect(filter).not.toContain("n/sr");expect(filter).not.toContain("volume=");
  });
});
