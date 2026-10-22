import { describe, expect, it } from "vitest";
import { LongformUiFocusProjectTraceV1, type LongformUiFocusProjectTraceFrameV1 } from "./longformUiFocusProjectTraceV1";
import { uiFocusProjectTraceFixtureV1 } from "./longformUiFocusProjectTraceV1.fixture";
const execute = (lines: string[], config = uiFocusProjectTraceFixtureV1().config) => {
  const rows: LongformUiFocusProjectTraceFrameV1[] = [], trace = new LongformUiFocusProjectTraceV1(config, row => rows.push(row));
  lines.forEach(line => trace.line(line)); return { rows, summary: trace.finish() };
};
describe("actual source/project fps trace protocol", () => {
  it("retains the observed collision winner, duplication and separately rebased project clock", () => {
    const f = uiFocusProjectTraceFixtureV1(), r = execute(f.lines);
    expect(r.rows.map(row => [row.projectFrame,row.sourcePts])).toEqual([[2,67],[3,133],[4,133],[5,167]]);
    expect(r.summary).toEqual({ sourceTimestampOffsetPts:50,inputFramesObserved:4,outputFramesObserved:4,droppedSourceFrames:1,duplicatedSourceFrames:1 });
  });
  it("keeps distinct source timestamps even when every frame checksum is identical", () => {
    const f = uiFocusProjectTraceFixtureV1(true); expect(execute(f.lines).rows.map(row => row.sourcePts)).toEqual([67,133,133,167]);
  });
  it("refuses missing collision-drop evidence instead of guessing a latest frame", () => {
    const f = uiFocusProjectTraceFixtureV1(); expect(() => execute(f.lines.filter(line => !line.includes("Dropping frame")))).toThrow("FPS_WRITE_BINDING");
  });
  it("rejects changed seek offset and unpaired demux timestamps", () => {
    const f = uiFocusProjectTraceFixtureV1();
    expect(() => execute([...f.lines,"[vist] demuxer -> ist_index:0:0 type:video pkt_pts:200", "[vist] demuxer+ffmpeg -> ist_index:0:0 type:video pkt_pts:149"])).toThrow("OFFSET_CHANGED");
    expect(() => execute(f.lines.slice(1))).toThrow("DEMUX_PAIR");
  });
  it("rejects mismatched timebase, source order, geometry and output pixels", () => {
    const f = uiFocusProjectTraceFixtureV1();
    for (const [from,to,message] of [["1/1000,","1/15360,","TIME_BASE"],["n: 2 pts: 83","n: 2 pts: 50","SOURCE_ORDER"],
      ["s:16x16","s:16x15","GEOMETRY"],["n: 0 pts: 2 pts_time:0 duration:1 duration_time:0.033 fmt:gray s:16x16 checksum:AA000001",
      "n: 0 pts: 2 pts_time:0 duration:1 duration_time:0.033 fmt:gray s:16x16 checksum:AA000009","OUTPUT_BINDING"]]) {
      expect(() => execute(f.lines.map(line => line.replace(from,to)))).toThrow(message);
    }
  });
  it("requires every non-trimmed fps write to have an output and refuses changed log grammar", () => {
    const f = uiFocusProjectTraceFixtureV1(); expect(() => execute(f.lines.slice(0,-1))).toThrow("MISSING_OUTPUT");
    expect(() => execute(f.lines.map(line => line.replace("Writing frame with pts 2 to pts 3","Writing frame into output 3")))).toThrow("UNSUPPORTED_LOG");
  });
  it("anchors the trim end to the first actual fps PTS, including a nonzero seek phase", () => {
    const f = uiFocusProjectTraceFixtureV1(), config = { ...f.config, duration: .133333 };
    expect(execute(f.lines, config).rows).toHaveLength(4);
    // raw PTS 4 is still before first PTS 1 + duration 4 ticks.
    expect(() => execute(f.lines.slice(0,-1), config)).toThrow("MISSING_OUTPUT");
  });
  it("accepts the observed 24 fps integer trim boundary but rejects an earlier missing output", () => {
    const f = uiFocusProjectTraceFixtureV1();
    const named = (tag: string, text: string) => `[${tag} @ 0000] ${text}`;
    const lines = f.lines.slice(0,3).concat([
      named("showinfo@clock_input","config in time_base: 1/1000, frame_rate:30/1"),
      named("showinfo@clock_output","config in time_base: 1/24, frame_rate:24/1")]);
    // Protocol control transcribed from the retained actual 24 fps failure.
    const pts = [17,50,83,117,150,183,217,250,283], slots = [0,1,2,3,4,4,5,6,7];
    const checksum = (i: number) => `AA00000${i+1}`;
    let output = 0;
    for (let i = 0; i < pts.length; i++) {
      lines.push(named("showinfo@clock_input",`n: ${i} pts: ${pts[i]} pts_time:0 duration:33 duration_time:0.033 fmt:gray s:16x16 checksum:${checksum(i)}`),
        named("fps@clock_rate",`Read frame with in pts ${pts[i]}, out pts ${slots[i]}`));
      if (i === 0) continue;
      if (i === 5) { lines.push(named("fps@clock_rate","Dropping frame with pts 4")); continue; }
      const source = i - 1;
      lines.push(named("fps@clock_rate",`Writing frame with pts ${slots[source]} to pts ${output}`),
        named("showinfo@clock_output",`n: ${output} pts: ${output+2} pts_time:0 duration:1 duration_time:0 fmt:gray s:16x16 checksum:${checksum(source)}`));
      output++;
    }
    lines.push(named("fps@clock_rate","Writing frame with pts 7 to pts 7"));
    const config = { ...f.config, projectTimeBase: { numerator:1,denominator:24 } };
    expect(execute(lines,config).rows).toHaveLength(7);
    const lastOutput = lines.findLastIndex(line => /clock_output.*n: 6 /.test(line));
    expect(() => execute(lines.filter((_,i) => i !== lastOutput),config)).toThrow("MISSING_OUTPUT");
    expect(() => execute([...lines,named("showinfo@clock_output",`n: 7 pts: 9 pts_time:0 duration:1 duration_time:0 fmt:gray s:16x16 checksum:${checksum(8)}`)],config)).toThrow("OUTPUT_BINDING");
  });
});
