import type { LongformUiFocusProjectTraceConfigV1 } from "./longformUiFocusProjectTraceV1";
/** Hand-authored protocol control based on the observed half-frame fps trace;
 * it is not an FFmpeg/OCR/pixel acceptance fixture. */
export function uiFocusProjectTraceFixtureV1(identical = false) {
  const config: LongformUiFocusProjectTraceConfigV1 = { sourceTimeBase: { numerator: 1, denominator: 1000 },
    projectTimeBase: { numerator: 1, denominator: 30 }, timelineStartFrame: 2, sourceStart: .05, sourceOrigin: 0,
    duration: .3, width: 16, height: 16, videoStreamIndex: 0 };
  const named = (tag: string, text: string) => `[${tag} @ 0000] ${text}`;
  const input = (frame: number, pts: number, checksum: string) => named("showinfo@clock_input", `n: ${frame} pts: ${pts} pts_time:0 duration:33 duration_time:0.033 fmt:gray s:16x16 checksum:${checksum}`);
  const output = (frame: number, pts: number, checksum: string) => named("showinfo@clock_output", `n: ${frame} pts: ${pts} pts_time:0 duration:1 duration_time:0.033 fmt:gray s:16x16 checksum:${checksum}`);
  const fps = (text: string) => named("fps@clock_rate", text);
  const a = "AA000001", b = identical ? a : "AA000002", c = identical ? a : "AA000003", d = identical ? a : "AA000004";
  const lines = ["[vist] demuxer -> ist_index:0:0 type:video pkt_pts:67 pkt_dts:67",
    "[vist] demuxer+tsfixup -> ist_index:0:0 type:video pkt_pts:17 pkt_dts:17",
    "[vist] demuxer+ffmpeg -> ist_index:0:0 type:video pkt_pts:17 pkt_dts:17 off:-50000",
    named("showinfo@clock_input", "config in time_base: 1/1000, frame_rate:30/1"),
    named("showinfo@clock_output", "config in time_base: 1/30, frame_rate:30/1"),
    input(0,17,a), fps("Read frame with in pts 17, out pts 1"),
    input(1,50,b), fps("Read frame with in pts 50, out pts 2"),
    fps("Writing frame with pts 1 to pts 1"), output(0,2,a),
    input(2,83,c), fps("Read frame with in pts 83, out pts 2"), fps("Dropping frame with pts 2"),
    input(3,117,d), fps("Read frame with in pts 117, out pts 4"),
    fps("Writing frame with pts 2 to pts 2"), output(1,3,c),
    fps("Writing frame with pts 2 to pts 3"), output(2,4,c),
    fps("Writing frame with pts 4 to pts 4"), output(3,5,d) ];
  return { config, lines, pixels: Buffer.from(Array.from({length:1024}, (_, i) => i % 256)) };
}
