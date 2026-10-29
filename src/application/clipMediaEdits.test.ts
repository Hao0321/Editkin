import { describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { applyCommand } from "../domain/commands";
import { createHistory, dispatchCommand, undo } from "../domain/history";
import { projectSchema } from "../domain/schema";
import type { MediaAsset } from "../domain/types";
import { planFreezeFrame } from "./freezeFrame";
import { planClipRetime, resolveRetimeWindow } from "./clipRetime";

function fixture() {
  const project = createDemoProject(), base = structuredClone(project.tracks[0].clips[0]);
  project.tracks[0].clips = [0,4,8].map((start,index) => ({ ...structuredClone(base), id: ['A','B','C'][index], timelineStart: start, sourceStart: start, duration: 4 }));
  project.motionTracks = []; project.motionGraphics = []; delete project.referenceMotionInstances; project.templateApplication = undefined;
  project.captions = [{ id: "owned", start: 1, duration: 2, text: "owned" }, { id: "later", start: 5, duration: 1, text: "later" }];
  project.director.markers = [{ id: "mark", time: 8, title: "cut", kind: "note", note: "", status: "open", createdAt: "2026-10-11T00:00:00.000Z" }];
  return project;
}
const still: MediaAsset = { id: 'still', kind: 'image', name: 'Still', uri: 'D:/owned/still.png', duration: 2, width: 1920, height: 1080 };
const retimed = (duration: number): MediaAsset => ({ id: 'retimed', kind: 'video', name: 'Retimed', uri: 'D:/owned/retimed.mp4', duration, width: 1920, height: 1080 });

describe('rendered clip media edits', () => {
  it('inserts a two-second still, splits source continuously and ripples clips/captions/markers in one Undo', () => {
    const project = fixture(), before = structuredClone(project);
    const plan = planFreezeFrame(project, 'A', 2, still, { still: 'hold', right: 'right' });
    const history = dispatchCommand(createHistory(project), plan.command);
    expect(history.present.tracks[0].clips.map(clip => [clip.id,clip.timelineStart,clip.duration,clip.sourceStart])).toEqual([
      ['A',0,2,0], ['hold',2,2,0], ['right',4,2,2], ['B',6,4,4], ['C',10,4,8],
    ]);
    expect(history.present.captions.map(caption => [caption.start,caption.duration])).toEqual([[1,4],[7,1]]);
    expect(history.present.director.markers[0].time).toBe(10);
    expect(history.past).toHaveLength(1);
    expect(undo(history).present).toEqual(before);
    expect(project).toEqual(before);
  });
  // 2026-10-23 (P6/P7 pack): the still copies the clip's expressions, so it must store pre-expression values; storing
  // the displayed opacity 0.5 of `value * 0.5` made the still play at 0.25.
  it("stores the still clip's pre-expression transform, so its expression runs once", () => {
    const project = fixture();
    project.tracks[0].clips[0].expressions = { opacity: 'hao.expression/v1:value * 0.5' };
    const next = applyCommand(project, planFreezeFrame(project, 'A', 2, still, { still: 'hold', right: 'right' }).command);
    const hold = next.tracks[0].clips.find(clip => clip.id === 'hold')!;
    expect(hold.transform.opacity).toBe(1);
    expect(hold.expressions?.opacity).toBe('hao.expression/v1:value * 0.5');
  });
  it('freezes at a clip start without creating a zero-duration split and refuses an end-frame or locked target', () => {
    const project = fixture();
    const next = applyCommand(project, planFreezeFrame(project, 'B', 4, still, {still:'hold',right:'unused'}).command);
    expect(next.tracks[0].clips.map(clip => clip.id)).toEqual(['A','hold','B','C']);
    expect(() => planFreezeFrame(project, 'A', 4, still, {still:'hold',right:'right'})).toThrow('播放頭');
    project.tracks[0].locked = true;
    expect(() => planFreezeFrame(project, 'A', 2, still, {still:'hold',right:'right'})).toThrow('鎖定');
  });
  it('retimes source and duration atomically, closes the main-track gap and scales owned captions in one Undo', () => {
    const project = fixture(), original = project.tracks[0].clips[0].assetId;
    const plan = planClipRetime(project, 'A', original, retimed(2), 2);
    const history = dispatchCommand(createHistory(project), plan.command);
    expect(history.present.tracks[0].clips.map(clip => [clip.id,clip.timelineStart,clip.duration])).toEqual([['A',0,2],['B',2,4],['C',6,4]]);
    expect(history.present.captions.map(caption => [caption.start,caption.duration])).toEqual([[0.5,1],[3,1]]);
    expect(history.present.director.markers[0].time).toBe(6);
    expect(history.present.tracks[0].clips[0].assetId).toBe('retimed');
    expect(history.past).toHaveLength(1);
    expect(undo(history).present).toEqual(project);
  });
  it('slowdown opens room for following content, while locked or stale source refuses the whole asset import', () => {
    const project = fixture(), original = project.tracks[0].clips[0].assetId;
    expect(applyCommand(project, planClipRetime(project, 'A', original, retimed(8), 8).command).tracks[0].clips.map(clip => clip.timelineStart)).toEqual([0,8,12]);
    const before = structuredClone(project); project.tracks[0].locked = true;
    expect(() => planClipRetime(project, 'A', original, retimed(2), 2)).toThrow('鎖定');
    expect(project.assets).toEqual(before.assets);
    project.tracks[0].locked = false;
    expect(() => planClipRetime(project, 'A', 'stale', retimed(2), 2)).toThrow('來源');
    expect(project).toEqual(before);
  });
  it('absolute presets resolve a trimmed reverse derivative back to its original source window', () => {
    const project = fixture(), original = project.assets.find(asset => asset.id === project.tracks[0].clips[0].assetId)!;
    const asset = { ...retimed(2), clipRetime: {schema:'editkin.clip-retime/v1' as const,sourceAssetId:original.id,sourceStart:2,sourceDuration:4,rate:2,reverse:true} };
    project.assets.push(asset); Object.assign(project.tracks[0].clips[0], {assetId:asset.id,sourceStart:0.5,duration:1});
    const resolved = resolveRetimeWindow(project, 'A', 0.5, false);
    expect(resolved).toMatchObject({asset:{id:original.id},sourceStart:3,sourceDuration:2,duration:4,rate:0.5,reverse:false});
    expect(projectSchema.parse(project).assets.find(item => item.id === asset.id)?.clipRetime).toEqual(asset.clipRetime);
    expect(() => resolveRetimeWindow(project,'A',4.1,false)).toThrow('0.25');
  });
  it('rejects tracked clips instead of silently applying stale motion data', () => {
    const project = fixture();
    project.motionTracks = [{ id:'tracking',clipId:'A' } as typeof project.motionTracks[number]];
    expect(() => planFreezeFrame(project,'A',2,still,{still:'hold',right:'right'})).toThrow('追蹤');
    expect(() => planClipRetime(project,'A',project.tracks[0].clips[0].assetId,retimed(2),2)).toThrow('追蹤');
  });
  it('does not count the rounded final output frame as additional original media when changing an absolute preset', () => {
    for(const reverse of [false,true]) {
      const project=fixture(),original=project.tracks[0].clips[0].assetId,sourceDuration=17/30;
      const asset={...retimed(12/30),clipRetime:{schema:'editkin.clip-retime/v1' as const,sourceAssetId:original,sourceStart:0,sourceDuration,rate:1.5,reverse}};
      project.assets.push(asset);Object.assign(project.tracks[0].clips[0],{assetId:asset.id,sourceStart:0,duration:12/30});
      const changed=resolveRetimeWindow(project,'A',1,!reverse);
      expect(changed.sourceStart).toBe(0);expect(changed.sourceDuration).toBeCloseTo(sourceDuration,10);expect(changed.duration).toBe(sourceDuration);
    }
  });
  it('keeps a minimum one-frame owned caption inside a clip compressed to one frame, with one Undo', () => {
    const project=fixture();project.tracks[0].clips[0].duration=2/30;
    project.captions=[{id:'last-frame',text:'last frame',start:1/30,duration:1/30}];
    const before=structuredClone(project),plan=planClipRetime(project,'A',project.tracks[0].clips[0].assetId,retimed(1/30),1/30);
    const history=dispatchCommand(createHistory(project),plan.command);
    expect(history.present.captions[0]).toMatchObject({start:0,duration:1/30});expect(undo(history).present).toEqual(before);
  });
});
