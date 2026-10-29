import { describe, expect, it, vi } from "vitest";
import { rotoProjectFixture, rotoBakeFixture } from "./__fixtures__/rotoCutoutProject.fixture";
import { createProjectSession } from "./projectSession";
import { dispatchCommand } from "../domain/history";
import { ROTO_V2_DEFAULT_SETTINGS } from "./autoRotoV2Contract";
import { mapRotoCorrectionClockV1, runRotoCutoutActionV1, type RotoCutoutActionOptionsV1 } from "./runRotoCutoutActionV1";
function harness() {
  const project = rotoProjectFixture(), projectSession = createProjectSession(project);
  const onCommand = vi.fn((command: Parameters<RotoCutoutActionOptionsV1["onCommand"]>[0]) => projectSession.setHistory(h => dispatchCommand(h, command)));
  const options: RotoCutoutActionOptionsV1 = { project, projectSession, clipId: "selected", maskId: "roi", playhead: 2.5,
    settings: { ...ROTO_V2_DEFAULT_SETTINGS }, maxDimension: 64, ids: { assetId: "baked", clipId: "foreground", trackId: "fg-track", linkGroupId: "fg-link", assetName: "Subject", trackName: "Subject" },
    execute: vi.fn(async () => rotoBakeFixture()), busy: { current: false }, onBusy: vi.fn(), onPlaying: vi.fn(), onCommand };
  return options;
}
describe("generation-safe asynchronous cutout action", () => {
  it("dispatches the verified bake as one command and retains pending subject confirmation", async () => {
    const o = harness(), result = await runRotoCutoutActionV1(o);
    expect(result).toMatchObject({ status: "applied", result: { subjectConfirmation: "required", benchmarkAccepted: false } });
    expect(o.onCommand).toHaveBeenCalledTimes(1); expect(o.projectSession.getSnapshot().history.past).toHaveLength(1);
    expect(o.onBusy).toHaveBeenLastCalledWith(false); expect(o.busy.current).toBe(false);
  });
  it("rejects a same-tick second invocation and does not apply after an intervening edit", async () => {
    const o = harness(); let release!: (value: ReturnType<typeof rotoBakeFixture>) => void;
    o.execute = vi.fn(() => new Promise<ReturnType<typeof rotoBakeFixture>>(yes => { release = yes; }));
    const pending = runRotoCutoutActionV1(o); expect(o.busy.current).toBe(true);
    expect(await runRotoCutoutActionV1(o)).toEqual({ status: "busy" });
    o.projectSession.setHistory(h => dispatchCommand(h, { type: "move_clip", clipId: "selected", timelineStart: 3 }));
    release(rotoBakeFixture()); expect(await pending).toEqual({ status: "stale" }); expect(o.onCommand).not.toHaveBeenCalled(); expect(o.busy.current).toBe(false);
  });
  it("cancel, unavailable runtime and locked source cannot apply a command", async () => {
    const cancelled = harness(), abort = new AbortController(); abort.abort(); cancelled.signal = abort.signal;
    expect(await runRotoCutoutActionV1(cancelled)).toEqual({ status: "cancelled" }); expect(cancelled.execute).not.toHaveBeenCalled();
    const unavailable = harness(); unavailable.execute = undefined; expect(await runRotoCutoutActionV1(unavailable)).toEqual({ status: "unavailable" });
    const locked = harness(); locked.project.tracks[0].locked = true; expect(await runRotoCutoutActionV1(locked)).toMatchObject({ status: "failed" }); expect(locked.execute).not.toHaveBeenCalled();
  });
  it("requires an explicit current seed for tracked mask geometry and an explicit old correction clock", async () => {
    const tracked = harness(); tracked.project.tracks[0].clips[0].masks![0].trackId = "tracked";
    expect(await runRotoCutoutActionV1(tracked)).toMatchObject({ status: "failed", error: { message: "ROTO_CUTOUT_EXPLICIT_CURRENT_SEED_REQUIRED" } });
    const brush = harness(); brush.project.tracks[0].clips[0].masks![0].rotoCorrections = [{ id: "brush", frame: 1, mode: "foreground", radius: .1, points: [{ x: .5, y: .5 }] }];
    expect(await runRotoCutoutActionV1(brush)).toMatchObject({ status: "failed", error: { message: "ROTO_CUTOUT_CORRECTION_CLOCK_REQUIRED" } });
  });
  it("maps v1 analysis frames to the new grid without mutating corrections or accepting out-of-range time", () => {
    const strokes = [{ id: "brush", frame: 6, mode: "foreground" as const, radius: .1, points: [{ x: .5, y: .5 }] }];
    expect(mapRotoCorrectionClockV1(strokes, 12, 30, 1)).toMatchObject([{ frame: 15 }]); expect(strokes[0].frame).toBe(6);
    expect(() => mapRotoCorrectionClockV1(strokes, undefined, 30, 1)).toThrow("CLOCK");
    expect(() => mapRotoCorrectionClockV1(strokes, 12, 30, .5)).toThrow("TIME_OUTSIDE");
  });
});
