import { describe, expect, it } from "vitest";
import { migrateProject } from "./editGraph";
import { parseProject } from "../application/projectCodec";
import { audioEnvelopeFixture } from "./clipAudioEnvelope.fixture";
import { applyCommand } from "./commands";
import { createHistory, dispatchCommand, undo } from "./history";
import { editorCommandSchema } from "./schema";
import { TRACK_LOCKED_MESSAGE } from "./trackLock";
import { clipAudioGainAt, clipVolumePointDbAt, withClipAudioFades, withClipVolumePoint, withoutClipVolumePoint, shiftedClipAudioEnvelope } from "./clipAudioEnvelope";

const serializeProject = (value: unknown) => JSON.stringify(value);
describe("authored sound is a persistent, source-window-preserving single edit", () => {
  it("round-trips schema 9 and 10 with authored fades and points, with one exact Undo", () => {
    for(const schema of [9,10] as const){
      const {project,clip}=audioEnvelopeFixture(); project.schemaVersion=schema;
      clip.audioEnvelope=withClipAudioFades(clip,1,2);
      const envelope=withClipVolumePoint(clip,{id:"point",time:4,db:6});
      const history=dispatchCommand(createHistory(project),{type:"set_clip_audio_envelope",clipId:clip.id,envelope});
      expect(history.past).toHaveLength(1);expect(undo(history).present).toEqual(project);
      const reopened=parseProject(JSON.parse(serializeProject(history.present)));
      expect(reopened.tracks[1].clips[0].audioEnvelope).toEqual(envelope);
    }
  });
  it("keeps old project and migration shapes free of invented audio fields", () => {
    const {project}=audioEnvelopeFixture();const raw=JSON.parse(serializeProject(project));
    expect(parseProject(raw).tracks[1].clips[0]).not.toHaveProperty("audioEnvelope");
    for(const schemaVersion of [1,8,9]){const migrated=migrateProject({...structuredClone(raw),schemaVersion});
      expect(migrated.tracks[1].clips[0]).not.toHaveProperty("audioEnvelope");}
  });
  it("rejects locked tracks and malformed command envelopes without changing any project bytes", () => {
    const {project,clip}=audioEnvelopeFixture();project.tracks[1].locked=true;const before=serializeProject(project);
    expect(()=>applyCommand(project,{type:"set_clip_audio_envelope",clipId:clip.id,envelope:withClipAudioFades(clip,1,1)})).toThrow(TRACK_LOCKED_MESSAGE);
    expect(serializeProject(project)).toBe(before);
    for(const envelope of [{schema:"wrong"},{schema:"editkin.clip-audio-envelope/v1",fades:{in:5,out:5,duration:1,offset:0}},
      {schema:"editkin.clip-audio-envelope/v1",volume:{offset:0,points:[{id:"x",time:0,db:7}]}},
      {schema:"editkin.clip-audio-envelope/v1",volume:{offset:0,points:[{id:"x",time:1,db:0},{id:"x",time:0,db:0}]}}])
      expect(editorCommandSchema.safeParse({type:"set_clip_audio_envelope",clipId:clip.id,envelope}).success).toBe(false);
  });
  it("retains gain against the same source samples after trim, split and head extension", () => {
    const {project,clip}=audioEnvelopeFixture();clip.audioEnvelope=withClipAudioFades(clip,2,2);
    clip.audioEnvelope=withClipVolumePoint(clip,{id:"low",time:0,db:-12});clip.audioEnvelope=withClipVolumePoint(clip,{id:"high",time:6,db:6});
    const original=structuredClone(clip);
    const trimmed=applyCommand(project,{type:"trim_clip_start",clipId:clip.id,seconds:.5}).tracks[1].clips[0];
    for(const time of [0,.2,1,3,8,10.8])expect(clipAudioGainAt(trimmed,time)).toBeCloseTo(clipAudioGainAt(original,time+.5),10);
    const split=applyCommand(project,{type:"split_clip",clipId:clip.id,at:4,newClipId:"right"}).tracks[1].clips;
    for(const part of split)for(const time of [0,Math.min(.4,part.duration/2),part.duration-1/30])
      expect(clipAudioGainAt(part,time)).toBeCloseTo(clipAudioGainAt(original,time+part.sourceStart-original.sourceStart),10);
    const extended=applyCommand(project,{type:"extend_clip",clipId:clip.id,edge:"start",seconds:.5}).tracks[1].clips[0];
    for(const time of [0,1,2,6,11])expect(clipAudioGainAt(extended,time+.5)).toBeCloseTo(clipAudioGainAt(original,time),10);
  });
  it("holds endpoints, interpolates dB, replaces the point at the same time and removes the final optional field", () => {
    const {clip}=audioEnvelopeFixture();clip.audioEnvelope=withClipVolumePoint(clip,{id:"a",time:1,db:-30});
    clip.audioEnvelope=withClipVolumePoint(clip,{id:"b",time:3,db:6});
    expect(clipVolumePointDbAt(clip,0)).toBe(-30);expect(clipVolumePointDbAt(clip,2)).toBe(-12);expect(clipVolumePointDbAt(clip,10)).toBe(6);
    clip.audioEnvelope=withClipVolumePoint(clip,{id:"new",time:3,db:3});expect(clip.audioEnvelope.volume!.points.map(p=>p.id)).toEqual(["a","b"]);
    clip.audioEnvelope=shiftedClipAudioEnvelope(clip,1);clip.audioEnvelope=withClipVolumePoint(clip,{id:"next",time:2,db:0});
    expect(clip.audioEnvelope.volume!.points).toHaveLength(2);expect(clip.audioEnvelope.volume!.points[1].time).toBe(3);
    clip.audioEnvelope=withoutClipVolumePoint(clip,"a");expect(withoutClipVolumePoint(clip,"b")).toBeUndefined();
  });
});
