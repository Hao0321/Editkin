/** Fixed source resource limits, not a measured production latency guarantee. */
export const ASS_MOTION_LIMITS = Object.freeze({
  sampleEvaluations: 100_000,
  events: 200_000,
  utf8Bytes: 64 * 1024 * 1024,
});

export interface AssMotionCost {
  sampleEvaluations?: number;
  events?: number;
  utf8Bytes?: number;
}
export interface AssMotionLimits { sampleEvaluations: number; events: number; utf8Bytes: number; }

/** Count UTF-8 without allocating another encoded copy of a contour string.
 * Unpaired UTF-16 surrogates encode as U+FFFD, as TextEncoder/Node do. */
export function assUtf8Bytes(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length
      && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4; index++;
    } else bytes += 3;
  }
  return bytes;
}

function checkedSum(current: number, addition: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(addition) || addition < 0 || addition > maximum - current) {
    throw new Error(`ASS ${label} resource budget exceeded (${maximum})`);
  }
  return current + addition;
}

/** Each v2 frame must be an admitted integer before any expansion loop. */
export function assMotionFrameRange(timelineStart: number, duration: number, fps: number) {
  if (!Number.isFinite(timelineStart) || timelineStart < 0 || !Number.isFinite(duration) || duration <= 0
    || !Number.isFinite(fps) || fps <= 0 || fps > 100) throw new Error("ASS sample resource budget: invalid frame duration/fps");
  const startFrame = Math.round(timelineStart * fps), durationFrames = Math.max(1, Math.round(duration * fps));
  if (!Number.isSafeInteger(startFrame) || !Number.isSafeInteger(durationFrames)
    || !Number.isSafeInteger(startFrame + durationFrames)) throw new Error("ASS sample resource budget: unsafe frame range");
  for (const frame of [startFrame, startFrame + durationFrames]) {
    const centiseconds = Math.floor(frame * 100 / fps + 1e-7);
    if (!Number.isSafeInteger(centiseconds) || centiseconds < 0) throw new Error("ASS sample resource budget: unsafe derived centiseconds timestamp");
  }
  return { startFrame, durationFrames };
}

/** Admission estimates and actual output counters are separate. Known physical
 * contour copies admit before frame expansion. Dynamic vector path bytes are
 * bounded by addLine, not claimed to have an exact preflight upper bound. */
export class AssMotionBudget {
  private readonly lines: string[] = [];
  private estimate = { sampleEvaluations: 0, events: 0, utf8Bytes: 0 };
  private actualLedger = { state: { sampleEvaluations: 0, events: 0, utf8Bytes: 0 } };
  private readonly limits: Readonly<AssMotionLimits>;
  constructor(limits: Readonly<AssMotionLimits> = ASS_MOTION_LIMITS) {
    for (const key of ["sampleEvaluations", "events", "utf8Bytes"] as const) {
      if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > ASS_MOTION_LIMITS[key]) throw new Error("ASS resource limits invalid");
    }
    this.limits = Object.freeze({ ...limits });
  }
  /** Each ASS script has its own lines, estimates and newline boundaries.
   * Forks for one resolved foreground/background output share actual work.
   * An independent writer without a provider has a single-script cap; this
   * provider does not aggregate nested/recursive render jobs. */
  fork(): AssMotionBudget {
    const child = new AssMotionBudget(this.limits);
    child.actualLedger = this.actualLedger;
    return child;
  }
  admit(cost: AssMotionCost): void {
    const next = {
      sampleEvaluations: checkedSum(this.estimate.sampleEvaluations, cost.sampleEvaluations ?? 0, this.limits.sampleEvaluations, "sample"),
      events: checkedSum(this.estimate.events, cost.events ?? 0, this.limits.events, "event"),
      utf8Bytes: checkedSum(this.estimate.utf8Bytes, cost.utf8Bytes ?? 0, this.limits.utf8Bytes, "UTF-8"),
    };
    this.estimate = next;
  }
  takeSample(): void {
    const actual = this.actualLedger.state;
    actual.sampleEvaluations = checkedSum(actual.sampleEvaluations, 1, this.limits.sampleEvaluations, "sample");
  }
  addLine(line: string): void {
    // Account even an embedded event newline in an authored identifier. The
    // event count is about actual ASS records, not just calls to this method.
    let events = line.startsWith("Dialogue: ") ? 1 : 0, offset = -1;
    while ((offset = line.indexOf("\nDialogue: ", offset + 1)) !== -1) events++;
    if (line.length > this.limits.utf8Bytes) throw new Error(`ASS UTF-8 resource budget exceeded (${this.limits.utf8Bytes})`);
    const actual = this.actualLedger.state;
    const nextEvents = checkedSum(actual.events, events, this.limits.events, "event");
    const nextBytes = checkedSum(actual.utf8Bytes, assUtf8Bytes(line) + (this.lines.length ? 1 : 0), this.limits.utf8Bytes, "UTF-8");
    // Never retain the line or mutate a counter before both checks succeed.
    this.lines.push(line);
    actual.events = nextEvents;
    actual.utf8Bytes = nextBytes;
  }
  snapshot() {
    return Object.freeze({ estimate: Object.freeze({ ...this.estimate }), actual: Object.freeze({ ...this.actualLedger.state }), lines: this.lines.length });
  }
  finish(): string { return this.lines.join("\n"); }
}
