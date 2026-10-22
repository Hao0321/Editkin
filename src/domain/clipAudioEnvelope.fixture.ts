import { createEmptyProject } from "./editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type TimelineClip } from "./types";
import { parseProject } from "../application/projectCodec";
export function audioEnvelopeFixture() {
  const project = parseProject(createEmptyProject("Owned sound curve", { id:"owned-sound-curve",width:320,height:180,fps:30 }));
  project.assets = [{id:"tone",name:"Owned tone",kind:"audio",uri:"owned-tone.wav",duration:20}];
  const clip: TimelineClip = {id:"sound",assetId:"tone",trackId:"audio-main",timelineStart:1,sourceStart:2,duration:12,volume:.4,
    transform:{...DEFAULT_TRANSFORM},color:{...DEFAULT_COLOR},keyframes:[]};
  project.tracks[1].clips = [clip];
  return {project,clip};
}
