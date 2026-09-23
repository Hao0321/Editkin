import { describe, expect, it } from "vitest";
import { parseSceneDetectLog } from "./sceneDetection";

describe("scene detection", () => {
  it("parses, clusters and frame-aligns FFmpeg scdet observations", () => {
    const log = "lavfi.scd.score: 12.5, lavfi.scd.time: 2\nlavfi.scd.score: 18, lavfi.scd.time: 2.1\nlavfi.scd.score: 20, lavfi.scd.time: 4";
    expect(parseSceneDetectLog(log, 6, 30, 0.5)).toEqual([
      { time: 2.1, score: 18, frame: 63 },
      { time: 4, score: 20, frame: 120 },
    ]);
  });

  it("drops cuts that would create tiny edge scenes", () => {
    const log = "lavfi.scd.score: 20, lavfi.scd.time: 0.1\nlavfi.scd.score: 20, lavfi.scd.time: 5.9";
    expect(parseSceneDetectLog(log, 6, 30, 0.5)).toEqual([]);
  });
});
