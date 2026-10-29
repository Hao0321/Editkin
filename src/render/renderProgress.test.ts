import { describe, expect, it } from "vitest";
import { runProcess } from "./mediaProcess";
import { withRenderLifetime } from "./renderLifetime";
import { currentRenderProgress, renderProgressTimeReporter, reportRenderPart, reportRenderStage, withRenderProgress, type RenderProgressSnapshot } from "./renderProgress";

const node = process.execPath;

describe("export progress measured by the renderer", () => {
  it("is silent outside a desktop export job", async () => {
    expect(renderProgressTimeReporter()).toBeUndefined();
    reportRenderStage("encode", 10); // no context: nothing to report, nothing thrown
    expect(currentRenderProgress()).toBeUndefined();
    expect(await withRenderProgress(undefined, async () => 42)).toBe(42);
  });

  it("reports stages, and a fraction only for a stage with a measured length", async () => {
    const seen: RenderProgressSnapshot[] = [];
    let clock = 1_000;
    await withRenderProgress(snapshot => seen.push(snapshot), async () => {
      reportRenderStage("audio");
      expect(renderProgressTimeReporter()).toBeDefined();
      renderProgressTimeReporter()!(5); // the audio stage has no known length: no number
      clock = 2_000;
      reportRenderStage("encode", 20);
      const report = renderProgressTimeReporter()!;
      report(5); report(4); report(10); report(10); report(99);
      reportRenderStage("encode", 20); // the same stage again keeps its measurement
      reportRenderStage("verify");
    }, () => clock);
    expect(seen[0]).toMatchObject({ schema: "editkin.render-progress/v1", stage: "prepare", sequence: 1, startedAtMs: 1_000 });
    const audio = seen.filter(item => item.stage === "audio");
    expect(audio.every(item => item.fraction === undefined)).toBe(true);
    const encode = seen.filter(item => item.stage === "encode");
    expect(encode.map(item => item.fraction)).toEqual([undefined, .25, .5, 1]);
    expect(encode[1].stageStartedAtMs).toBe(2_000);
    expect(seen.at(-1)).toMatchObject({ stage: "verify" });
    expect(seen.at(-1)).not.toHaveProperty("fraction");
    expect(seen.map(item => item.sequence)).toEqual(seen.map((_, index) => index + 1));
  });

  it("starts each pre-rendered part's measurement from zero, even with the same length", async () => {
    const seen: RenderProgressSnapshot[] = [];
    await withRenderProgress(snapshot => seen.push(snapshot), async () => {
      reportRenderPart(1, 2);
      reportRenderStage("precompose", 8);
      renderProgressTimeReporter()!(8);
      reportRenderPart(2, 2);
      reportRenderStage("precompose", 8);
      renderProgressTimeReporter()!(2);
      reportRenderPart();
    });
    const second = seen.filter(item => item.part === 2);
    expect(second[0]).not.toHaveProperty("fraction");
    expect(second.at(-1)).toMatchObject({ fraction: .25, parts: 2 });
    expect(seen.at(-1)).not.toHaveProperty("part");
  });

  it("turns a real process's FFmpeg -progress output into the encode fraction", async () => {
    const seen: RenderProgressSnapshot[] = [];
    const script = "for (const us of [1000000, 2500000, 5000000]) console.log('out_time_us=' + us); console.log('progress=end');";
    await withRenderProgress(snapshot => seen.push(snapshot), () => withRenderLifetime({ workSeconds: 5 }, async () => {
      reportRenderStage("encode", 5);
      await runProcess(node, ["-e", script], 10_000, undefined, { ffmpegProgress: true });
    }));
    const fractions = seen.filter(item => item.stage === "encode" && item.fraction !== undefined).map(item => item.fraction);
    expect(fractions).toEqual([.2, .5, 1]);
  });
});
