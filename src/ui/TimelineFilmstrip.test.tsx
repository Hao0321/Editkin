import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TimelineFilmstrip } from "./TimelineFilmstrip";
import { resolveMainTrackDrop } from "./timelineMainTrackDrop";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type TimelineClip } from "../domain/types";

describe("background filmstrip and main-track pointer admission",()=>{
  it("omits unavailable derivatives and clips below 80px, while tiling the real thumbnail without loading work",()=>{
    expect(renderToStaticMarkup(<TimelineFilmstrip width={300} />)).toBe("");
    expect(renderToStaticMarkup(<TimelineFilmstrip width={79.99} url="owned-thumbnail.png" />)).toBe("");
    const at80=renderToStaticMarkup(<TimelineFilmstrip width={80} url="owned-thumbnail.png" />);
    expect(at80.match(/<img /g)).toHaveLength(1); expect(at80).toContain('aria-hidden="true"');
    expect(renderToStaticMarkup(<TimelineFilmstrip width={220} url="owned-thumbnail.png" />).match(/<img /g)).toHaveLength(3);
  });
  it("previews a nearest boundary for insert and the exact frame for Ctrl overwrite, and refuses a locked lane",()=>{
    const track=createEmptyProject().tracks[0];
    const clip:TimelineClip={id:"one",assetId:"owned",trackId:track.id,timelineStart:0,sourceStart:0,duration:4,volume:1,transform:{...DEFAULT_TRANSFORM},color:{...DEFAULT_COLOR},keyframes:[]};
    track.clips=[clip,{...clip,id:"two",timelineStart:4}];
    const insert=resolveMainTrackDrop(track,5.4,1,30,false),overwrite=resolveMainTrackDrop(track,5.4,1,30,true);
    expect(insert.mode).toBe("insert");expect(insert.result.start).toBe(4);expect(insert.result.allowed).toBe(true);expect(insert.result.newLayer).toBe(false);
    expect(overwrite.mode).toBe("overwrite");expect(overwrite.result.start).toBe(5.4);
    track.locked=true;expect(resolveMainTrackDrop(track,5.4,1,30,true).result.allowed).toBe(false);
  });
});
