import { describe, expect, it } from "vitest";
import { applyCommand } from "../domain/commands";
import { createEmptyProject } from "../domain/editGraph";
import { editorCommandSchema } from "../domain/schema";
import { DEFAULT_CLIP_LAYER, DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type TimelineClip } from "../domain/types";
import { buildRenderPlan } from "../render/planner";
import { motionGraphicV2FrameReceipt } from "../motion/compositionV2";
import { assertAutopilotProjectTimelineBinding, type CurrentAutopilotPlan } from "./autopilotPlan";
import { createAutopilotV4Fixture } from "./autopilotPlanFixture";
import { compileMusicVideoDraft, type MusicVideoDraftRequest } from "./musicVideoDraftCompiler";
import { prepareMusicVideoDraftReadOnly, type PrepareMusicVideoDraftInput } from "../mcp/musicVideoTools";

function fixture(): EditProject {
  const project = createEmptyProject("Music video", { id: "mv-test", fps: 30, width: 1920, height: 1080 });
  project.assets.push(
    { id: "song", name: "Original song", kind: "audio", uri: "song.wav", duration: 10 },
    { id: "wide", name: "Wide", kind: "video", uri: "wide.mp4", duration: 10 },
    { id: "detail", name: "Detail", kind: "video", uri: "detail.mp4", duration: 10 },
    { id: "payoff", name: "Payoff", kind: "video", uri: "payoff.mp4", duration: 10 },
  );
  const songClip: TimelineClip = { id: "music-bed", assetId: "song", trackId: "audio-main", timelineStart: 0, sourceStart: 0, duration: 8, volume: 1,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [], layer: { ...DEFAULT_CLIP_LAYER }, expressions: {} };
  return applyCommand(project, { type: "add_clip", clip: songClip });
}

function request(): MusicVideoDraftRequest {
  return {
    styleId: "afterglow", musicClipId: "music-bed", targetTrackId: "video-main",
    beatTimes: [0, 2, 4, 6],
    candidates: [
      { shotId: "payoff", assetId: "payoff", sourceStart: 1, sourceEnd: 8, salience: .95, storyOrder: 30 },
      { shotId: "wide", assetId: "wide", sourceStart: 0, sourceEnd: 8, salience: .8, storyOrder: 10 },
      { shotId: "detail", assetId: "detail", sourceStart: 1, sourceEnd: 8, salience: .9, storyOrder: 20 },
    ],
    lyricCues: [
      { id: "one", text: "夜を越えて", start: .5, end: 1.5, evidenceRef: "lyrics:source:line-1" },
      { id: "two", text: "君へ", start: 2.5, end: 3, evidenceRef: "lyrics:source:line-2" },
    ],
    cameraSafeShotIds: ["wide"],
    transitionCues: [{ boundaryIndex: 1, fromShotId: "wide", toShotId: "detail", style: "soft", evidenceRefs: ["shot:wide:end", "shot:detail:start"] }],
    clipIds: ["mv-wide", "mv-detail", "mv-payoff"],
  };
}

describe("music video draft compiler", () => {
  it("builds editable frame-aligned imagery, muted sources, uninterrupted music, and two lyric tempos", () => {
    const project = fixture();
    const before = JSON.stringify(project);
    const draft = compileMusicVideoDraft(project, request());
    expect(JSON.stringify(project)).toBe(before);
    expect(draft.status).toBe("DRAFT_COMMAND_CANDIDATE");
    expect(draft.directApplyAllowed).toBe(false);
    expect(draft.selections.map(item => item.shotId)).toEqual(["wide", "detail", "payoff"]);
    expect(draft.commands.filter(command => command.type === "add_clip").map(command => command.clip.volume)).toEqual([0, 0, 0]);
    expect(draft.commands.filter(command => command.type === "set_clip_creative")).toHaveLength(3);
    expect(draft.transitions.map(item => item.presetId)).toEqual(["cine_short_fade_through_base"]);
    expect(draft.commands.filter(command => command.type === "add_keyframe")).toHaveLength(2);
    const graphics = draft.commands.filter(command => command.type === "add_motion_graphic").map(command => command.graphic);
    expect(graphics.map(graphic => graphic.presetId)).toEqual(["mv_afterglow_lyric", "mv_afterglow_lyric_fast"]);
    for (const command of draft.commands) expect(() => editorCommandSchema.parse(command)).not.toThrow();
    const updated = applyCommand(project, { type: "batch", commands: draft.commands });
    const plan = buildRenderPlan(updated, uri => uri);
    expect(updated.tracks.find(track => track.id === "video-main")!.clips).toHaveLength(3);
    expect(updated.tracks.find(track => track.id === "audio-main")!.clips[0].volume).toBe(1);
    expect(plan.audioClips.filter(item => item.clip.volume > 0).map(item => item.clip.assetId)).toEqual(["song"]);
    expect(updated.motionGraphics).toHaveLength(2);
    for (const graphic of updated.motionGraphics) {
      const sample = motionGraphicV2FrameReceipt(updated, graphic, Math.round((graphic.timelineStart + graphic.duration / 2) * updated.fps));
      expect(sample.visible).toBe(true);
    }
    expect(draft.guarantees.pairwiseTransitions).toBe(false);
    expect(draft.guarantees.humanArtApproval).toBe(false);
  });

  it("keeps lyric editorial timing bound to the exact native frame range", () => {
    const draft = compileMusicVideoDraft(fixture(), request());
    const base = createAutopilotV4Fixture();
    const plan = { ...base, commands: draft.commands, editorial: { ...base.editorial, graphics: draft.editorialGraphics } } as unknown as CurrentAutopilotPlan;
    expect(() => assertAutopilotProjectTimelineBinding(plan, 30)).not.toThrow();
    const wrong = structuredClone(plan);
    wrong.editorial.graphics[0].range.endFrame += 1;
    expect(() => assertAutopilotProjectTimelineBinding(wrong, 30)).toThrow(/MV 歌詞/);
  });

  it("blocks missing music, unsupported shot sets, and ungrounded transitions", () => {
    const noMusic = fixture();
    noMusic.tracks.find(track => track.id === "audio-main")!.muted = true;
    expect(() => compileMusicVideoDraft(noMusic, request())).toThrow(/歌曲聲軌/);
    const shortSong = fixture();
    shortSong.tracks.find(track => track.id === "audio-main")!.clips[0].duration = 3;
    expect(() => compileMusicVideoDraft(shortSong, request())).toThrow(/歌曲聲軌/);
    const tooFew = request();
    tooFew.candidates = tooFew.candidates.slice(0, 1);
    expect(() => compileMusicVideoDraft(fixture(), tooFew)).toThrow(/沒有足夠/);
    const badCut = request();
    badCut.transitionCues = [{ boundaryIndex: 1, fromShotId: "payoff", toShotId: "detail", style: "axis_left", evidenceRefs: ["shot:a", "shot:b"] }];
    expect(() => compileMusicVideoDraft(fixture(), badCut)).toThrow(/兩側證據/);
  });

  it("blocks lyric overlap, subtitle collision and a pre-existing timeline conflict", () => {
    const overlap = request();
    overlap.lyricCues = [
      { id: "one", text: "夜を越えて", start: .5, end: 1.5, evidenceRef: "lyrics:1" },
      { id: "two", text: "君へ", start: 1, end: 2, evidenceRef: "lyrics:2" },
    ];
    expect(() => compileMusicVideoDraft(fixture(), overlap)).toThrow(/不重疊/);
    const withCaption = fixture();
    withCaption.captions.push({ id: "spoken", text: "Dialogue", start: .7, duration: 1 });
    expect(() => compileMusicVideoDraft(withCaption, request())).toThrow(/既有字幕重疊/);
    const occupied = fixture();
    const clip = { ...occupied.tracks.find(track => track.id === "audio-main")!.clips[0], id: "existing-video", assetId: "wide", trackId: "video-main", volume: 0 };
    occupied.tracks.find(track => track.id === "video-main")!.clips.push(clip);
    expect(() => compileMusicVideoDraft(occupied, request())).toThrow(/重疊/);
  });

  it("MCP prepare path reads project without writing it", async () => {
    const project = fixture();
    const before = JSON.stringify(project);
    const input = { projectPath: "fixture.editkin", ...request() } as unknown as PrepareMusicVideoDraftInput;
    const result = await prepareMusicVideoDraftReadOnly(input, { readProject: async () => project });
    expect(result.mutationPerformed).toBe(false);
    expect(JSON.stringify(project)).toBe(before);
  });
});
