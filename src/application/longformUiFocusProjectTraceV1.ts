export interface LongformUiFocusProjectTraceConfigV1 {
  sourceTimeBase: { numerator: number; denominator: number };
  projectTimeBase: { numerator: number; denominator: number };
  timelineStartFrame: number; sourceStart: number; sourceOrigin: number; duration: number;
  width: number; height: number; videoStreamIndex: number;
}
export interface LongformUiFocusProjectTraceFrameV1 {
  frame: number; projectFrame: number; sourcePts: number; sourceTime: number; checksum: string;
}
type Input = { pts: number; frame: number; checksum: string };
type Written = { input: Input; rawOutputPts: number };
const integer = (value: string) => { const n = Number(value); if (!Number.isSafeInteger(n)) throw Error("UI_FOCUS_PROJECT_TRACE_INTEGER"); return n; };
/** Parse the actual named fps read/drop/write stream. No resampling formula
 * guesses which source frame won a timestamp collision. Identical pixels still
 * retain separate source PTS identities. State is bounded while a long prefix
 * streams through the decoder. */
export class LongformUiFocusProjectTraceV1 {
  private sourceBase = false; private outputBase = false; private offset?: number; private original?: number;
  private unread?: Input; private readonly slots = new Map<number, Input[]>(); private readonly writes: Written[] = [];
  private lastInputPts = -Infinity; private lastWrittenPts = -Infinity; private lastSourceSlot = -Infinity;
  private firstWrittenPts?: number; private readonly durationTicks: number;
  inputFrames = 0; outputFrames = 0; droppedSourceFrames = 0; duplicatedSourceFrames = 0;
  private previousWrittenInput?: number;
  constructor(readonly config: LongformUiFocusProjectTraceConfigV1, private readonly output: (row: LongformUiFocusProjectTraceFrameV1) => void) {
    const c = config;
    if (![c.sourceTimeBase.numerator, c.sourceTimeBase.denominator, c.projectTimeBase.numerator, c.projectTimeBase.denominator,
      c.width, c.height].every(n => Number.isSafeInteger(n) && n > 0) || !Number.isSafeInteger(c.timelineStartFrame) || c.timelineStartFrame < 0
      || !Number.isSafeInteger(c.videoStreamIndex) || c.videoStreamIndex < 0
      || ![c.sourceStart, c.sourceOrigin, c.duration].every(Number.isFinite) || c.sourceStart < 0 || c.duration <= 0)
      throw Error("UI_FOCUS_PROJECT_TRACE_CONFIG");
    // FFmpeg trim.c rescales its microsecond duration with av_rescale_q
    // (nearest, halfway away from zero), relative to its first actual fps PTS.
    // This bounds trim only; source correspondence still uses actual events.
    const micros = Math.round(c.duration * 1e6);
    if (!Number.isSafeInteger(micros) || micros < 1) throw Error("UI_FOCUS_PROJECT_TRACE_CONFIG");
    const divisor = 1000000n * BigInt(c.projectTimeBase.numerator);
    this.durationTicks = Number((BigInt(micros) * BigInt(c.projectTimeBase.denominator) + divisor / 2n) / divisor);
    if (!Number.isSafeInteger(this.durationTicks) || this.durationTicks < 1) throw Error("UI_FOCUS_PROJECT_TRACE_CONFIG");
  }
  line(line: string) {
    if (line.length > 65536) throw Error("UI_FOCUS_PROJECT_TRACE_LINE_BUDGET");
    const c = this.config, stream = `ist_index:0:${c.videoStreamIndex} type:video `;
    if (line.includes(stream) && line.includes("demuxer ->")) {
      const pts = /\bpkt_pts:(-?\d+)\b/.exec(line); if (!pts || this.original !== undefined) throw Error("UI_FOCUS_PROJECT_DEMUX_PAIR");
      this.original = integer(pts[1]); return;
    }
    if (line.includes(stream) && line.includes("demuxer+ffmpeg ->")) {
      const pts = /\bpkt_pts:(-?\d+)\b/.exec(line); if (!pts || this.original === undefined) throw Error("UI_FOCUS_PROJECT_DEMUX_PAIR");
      const offset = this.original - integer(pts[1]); this.original = undefined;
      if (this.offset !== undefined && offset !== this.offset) throw Error("UI_FOCUS_PROJECT_TIMESTAMP_OFFSET_CHANGED");
      const tick = c.sourceTimeBase.numerator / c.sourceTimeBase.denominator;
      if (Math.abs(offset * tick - c.sourceStart - c.sourceOrigin) > tick / 2 + 1e-7) throw Error("UI_FOCUS_PROJECT_SEEK_BINDING");
      this.offset = offset; return;
    }
    const named = /^\[(showinfo@clock_input|showinfo@clock_output|fps@clock_rate) @ [^\]]+\]\s+(.*)$/.exec(line);
    if (!named) return;
    const [, tag, text] = named;
    const base = /^config in time_base:\s*(\d+)\/(\d+)/.exec(text);
    if (base) {
      const expected = tag === "showinfo@clock_input" ? c.sourceTimeBase : c.projectTimeBase;
      if (tag === "fps@clock_rate" || (tag === "showinfo@clock_input" ? this.sourceBase : this.outputBase)
        || integer(base[1]) !== expected.numerator || integer(base[2]) !== expected.denominator) throw Error("UI_FOCUS_PROJECT_TRACE_TIME_BASE");
      if (tag === "showinfo@clock_input") this.sourceBase = true; else this.outputBase = true; return;
    }
    const image = /^n:\s*(\d+)\s+pts:\s*(-?\d+)\s+pts_time:\S+\s+duration:\s*\d+\s+duration_time:\S+\s+fmt:gray\b.*?\bs:(\d+)x(\d+)\b.*?\bchecksum:([A-F0-9]{8})\b/.exec(text);
    if (image) {
      const frame = integer(image[1]), pts = integer(image[2]), checksum = image[5];
      if (integer(image[3]) !== c.width || integer(image[4]) !== c.height) throw Error("UI_FOCUS_PROJECT_TRACE_GEOMETRY");
      if (tag === "showinfo@clock_input") {
        if (!this.sourceBase || this.unread || frame !== this.inputFrames || pts <= this.lastInputPts || this.inputFrames >= 65536)
          throw Error("UI_FOCUS_PROJECT_TRACE_SOURCE_ORDER");
        this.inputFrames++; this.lastInputPts = pts; this.unread = { frame, pts, checksum }; return;
      }
      const written = this.writes.shift();
      if (tag !== "showinfo@clock_output" || !this.outputBase || !written || this.offset === undefined || frame !== this.outputFrames
        || pts !== c.timelineStartFrame + frame || checksum !== written.input.checksum || this.outputFrames >= 65536
        || written.rawOutputPts - this.firstWrittenPts! >= this.durationTicks)
        throw Error("UI_FOCUS_PROJECT_TRACE_OUTPUT_BINDING");
      const sourcePts = written.input.pts + this.offset;
      this.outputFrames++; this.output({ frame, projectFrame: pts, sourcePts,
        sourceTime: sourcePts * c.sourceTimeBase.numerator / c.sourceTimeBase.denominator - c.sourceOrigin, checksum }); return;
    }
    if (tag !== "fps@clock_rate") {
      if (/^(?:n:|config in time_base:)/.test(text)) throw Error("UI_FOCUS_PROJECT_TRACE_UNSUPPORTED_LOG"); return;
    }
    let match = /^Read frame with in pts (-?\d+), out pts (-?\d+)$/.exec(text);
    if (match) {
      const pts = integer(match[1]), slot = integer(match[2]);
      if (!this.unread || this.unread.pts !== pts) throw Error("UI_FOCUS_PROJECT_FPS_READ_BINDING");
      const rows = this.slots.get(slot) ?? []; rows.push(this.unread); this.slots.set(slot, rows); this.unread = undefined;
      if ([...this.slots.values()].reduce((n, value) => n + value.length, 0) > 8) throw Error("UI_FOCUS_PROJECT_FPS_STATE_BUDGET"); return;
    }
    match = /^Dropping frame with pts (-?\d+)$/.exec(text);
    if (match) {
      const slot = integer(match[1]), rows = this.slots.get(slot);
      if (!rows?.length) throw Error("UI_FOCUS_PROJECT_FPS_DROP_BINDING");
      rows.shift(); if (!rows.length) this.slots.delete(slot); this.droppedSourceFrames++; return;
    }
    match = /^Writing frame with pts (-?\d+) to pts (-?\d+)$/.exec(text);
    if (match) {
      const slot = integer(match[1]), rawOutputPts = integer(match[2]), rows = this.slots.get(slot);
      if (rows?.length !== 1 || slot < this.lastSourceSlot || (this.lastWrittenPts !== -Infinity && rawOutputPts !== this.lastWrittenPts + 1))
        throw Error("UI_FOCUS_PROJECT_FPS_WRITE_BINDING");
      const input = rows[0]; if (this.previousWrittenInput === input.frame) this.duplicatedSourceFrames++;
      this.firstWrittenPts ??= rawOutputPts;
      this.previousWrittenInput = input.frame; this.lastSourceSlot = slot; this.lastWrittenPts = rawOutputPts;
      for (const key of this.slots.keys()) if (key < slot) this.slots.delete(key);
      this.writes.push({ input, rawOutputPts }); if (this.writes.length > 32) throw Error("UI_FOCUS_PROJECT_FPS_PENDING_BUDGET"); return;
    }
    if (/^(?:Read frame|Dropping frame|Writing frame)/.test(text)) throw Error("UI_FOCUS_PROJECT_TRACE_UNSUPPORTED_LOG");
  }
  finish() {
    if (!this.sourceBase || !this.outputBase || this.offset === undefined || !this.inputFrames || !this.outputFrames || this.original !== undefined)
      throw Error("UI_FOCUS_PROJECT_TRACE_INCOMPLETE");
    // trim can consume fps events at/after its actual integer half-open end.
    if (this.writes.some(row => row.rawOutputPts - this.firstWrittenPts! < this.durationTicks))
      throw Error("UI_FOCUS_PROJECT_TRACE_MISSING_OUTPUT");
    return { sourceTimestampOffsetPts: this.offset, inputFramesObserved: this.inputFrames, outputFramesObserved: this.outputFrames,
      droppedSourceFrames: this.droppedSourceFrames, duplicatedSourceFrames: this.duplicatedSourceFrames };
  }
}
