import { describe, expect, it, vi } from "vitest";
import { audioEnvelopeFixture } from "../domain/clipAudioEnvelope.fixture";
import { shiftedClipAudioEnvelope, withClipAudioFades, withClipVolumePoint } from "../domain/clipAudioEnvelope";
import { buildRenderPlan } from "./planner";
import { buildStreamAudioMixV1, STREAM_AUDIO_MAX_CLIPS_V1 } from "./streamAudioMixV1";
import { captureLegacyAudioCommandV1, stabilizeLegacySidechainEofV1 } from "./streamAudioMixV1.fixture";

describe("streaming audio graph admission and legacy parity", () => {
  it.each(["silence", "music", "voice", "ducked", "envelope", "trimmed"])("preserves the actual legacy %s audio policy with the explicit EOF adapter", async variant => {
    const { project, clip } = audioEnvelopeFixture(); clip.duration = 2; clip.sourceStart = .25; clip.timelineStart = .3;
    if (variant === "silence") clip.volume = 0;
    if (variant === "music") project.assets[0].role = "background-music";
    if (["ducked", "envelope", "trimmed"].includes(variant)) {
      project.assets.push({ ...project.assets[0], id: "music", uri: "music.wav", role: "background-music" });
      project.tracks.push({ ...project.tracks[1], id: "music-track", name: "Owned music", clips: [{ ...structuredClone(clip), id: "music-clip", trackId: "music-track", assetId: "music", timelineStart: 0, sourceStart: 0, volume: .2 }] });
    }
    if (["envelope", "trimmed"].includes(variant)) {
      clip.audioEnvelope = withClipAudioFades(clip, .2, .4);
      for (const [id, time, db] of [["a", 0, -30], ["b", 1, 6], ["c", 2, -12]] as const)
        clip.audioEnvelope = withClipVolumePoint(clip, { id, time, db });
      if (variant === "trimmed") clip.audioEnvelope = shiftedClipAudioEnvelope(clip, .3);
    }
    const plan = buildRenderPlan(project, path => path), probe = async () => ({ hasAudio: true });
    const command = await captureLegacyAudioCommandV1(project, plan, probe);
    const audio = await buildStreamAudioMixV1(project, plan, { inputOffset: 0, probe });
    const index = command.indexOf("-filter_complex");
    expect(audio.inputArgs).toEqual(command.slice(4, index));
    expect(audio.filterComplex).toBe(stabilizeLegacySidechainEofV1(command[index + 1], plan.duration));
    expect(audio.codecArgs).toEqual(["-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2"]);
    const shifted = await buildStreamAudioMixV1(project, plan, { inputOffset: 1, probe });
    expect(shifted.filterComplex.replace(/\[(\d+):a\]/g, (_all, index) => `[${Number(index) - 1}:a]`)).toBe(audio.filterComplex);
  });
  it("probes a repeated path once and skips only an actually absent audio stream", async () => {
    const { project, clip } = audioEnvelopeFixture(); project.tracks[1].clips.push({ ...clip, id: "repeat", timelineStart: 13 });
    const probe = vi.fn(async () => ({ hasAudio: false }));
    const result = await buildStreamAudioMixV1(project, buildRenderPlan(project, path => path), { inputOffset: 1, probe });
    expect(probe).toHaveBeenCalledTimes(1); expect(result.sourceCount).toBe(0); expect(result.inputArgs.filter(x => x === "-i")).toHaveLength(1);
  });
  it("refuses source/argument budgets and invalid clocks rather than dropping clips", async () => {
    const { project, clip } = audioEnvelopeFixture(), plan = buildRenderPlan(project, path => path), probe = async () => ({ hasAudio: true });
    await expect(buildStreamAudioMixV1(project, { ...plan, audioClips: Array(STREAM_AUDIO_MAX_CLIPS_V1 + 1).fill(plan.audioClips[0]) }, { inputOffset: 1, probe })).rejects.toThrow("SOURCE_BUDGET");
    await expect(buildStreamAudioMixV1(project, { ...plan, audioClips: [{ clip, assetPath: "x".repeat(13_000) }] }, { inputOffset: 1, probe })).rejects.toThrow("ARGUMENT_BUDGET");
    await expect(buildStreamAudioMixV1(project, { ...plan, duration: NaN }, { inputOffset: 1, probe })).rejects.toThrow("REQUEST_INVALID");
    await expect(buildStreamAudioMixV1(project, { ...plan, audioClips: [{ clip: { ...clip, timelineStart: -1 }, assetPath: "audio.wav" }] }, { inputOffset: 1, probe })).rejects.toThrow("CLIP_INVALID");
  });
  it("propagates probe errors and cancellation before admitting an encoder", async () => {
    const { project } = audioEnvelopeFixture(), plan = buildRenderPlan(project, path => path), controller = new AbortController();
    await expect(buildStreamAudioMixV1(project, plan, { inputOffset: 1, probe: async () => { throw Error("probe unavailable"); } })).rejects.toThrow("probe unavailable");
    controller.abort(Error("owned cancel")); const probe = vi.fn(async () => ({ hasAudio: true }));
    await expect(buildStreamAudioMixV1(project, plan, { inputOffset: 1, signal: controller.signal, probe })).rejects.toThrow("owned cancel");
    expect(probe).not.toHaveBeenCalled();
  });
});
