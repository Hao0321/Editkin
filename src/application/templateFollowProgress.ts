/**
 * While a clip edit lays a title template out again (one to three seconds of real fonts and the compiler), the status
 * line says so in plain words. It never flashes for a fast edit: the hint appears only once the work has run for
 * TEMPLATE_FOLLOW_HINT_DELAY_MS, and it goes away as soon as every such edit has finished, applied or not — or, for an
 * edit whose project is no longer the one on screen (an Undo, another edit), at once: that work is cancelled.
 *
 * `episode` counts each stretch of waiting, so a status surface can tell a newer message from the one that was showing
 * when the wait began, and stop showing the hint at once.
 */
export const TEMPLATE_FOLLOW_HINT = "標題跟著調整中…";
export const TEMPLATE_FOLLOW_HINT_DELAY_MS = 300;

export interface TemplateFollowProgress {
  /** Increases each time waiting starts. */
  readonly episode: number;
  /** A template is being laid out again right now. */
  readonly pending: boolean;
  /** It has taken long enough to say so (and the project it works on is still the one on screen). */
  readonly visible: boolean;
}

export interface TemplateFollowTracking {
  /** False once the project the work was planned on is gone (an Undo, another edit): its hint goes away at once. */
  stillCurrent?: () => boolean;
  /** Called once when stillCurrent turns false, to cancel the work. */
  onStale?: () => void;
}

interface Tracker extends TemplateFollowTracking { stale: boolean }

let snapshot: TemplateFollowProgress = Object.freeze({ episode: 0, pending: false, visible: false });
const trackers = new Set<Tracker>();
let timer: ReturnType<typeof setTimeout> | undefined;
/** When the hint is due (Date.now(), so fake timers move it too). */
let dueAt = 0;
const listeners = new Set<() => void>();

function publish(next: TemplateFollowProgress): void {
  snapshot = Object.freeze({ ...next });
  for (const listener of [...listeners]) listener();
}

export function templateFollowProgress(): TemplateFollowProgress {
  return snapshot;
}

export function subscribeTemplateFollowProgress(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Drop work whose project is gone (cancelling it), and show the hint once live work has run long enough. */
function refresh(): void {
  for (const tracker of trackers) {
    if (tracker.stale || !tracker.stillCurrent || tracker.stillCurrent()) continue;
    tracker.stale = true;
    tracker.onStale?.();
  }
  const visible = [...trackers].some(tracker => !tracker.stale) && Date.now() >= dueAt;
  if (visible !== snapshot.visible) publish({ ...snapshot, visible });
}

/**
 * Laying a template out again is long synchronous work (glyph layout and hashing). Awaiting this between its steps lets
 * the browser paint and take input; it costs a task turn, not a delay. The hint is shown (or dropped) here, because a
 * timer can wait behind these turns. A message-channel task, so it works the same under fake timers.
 */
export function yieldToBrowser(): Promise<void> {
  refresh();
  return new Promise(resolve => {
    if (typeof MessageChannel !== "function") { setTimeout(resolve, 0); return; }
    const channel = new MessageChannel();
    channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); };
    channel.port2.postMessage(undefined);
  });
}

/** Show the hint while `work` runs (after the delay), and clear it when the last such work settles, whatever the result. */
export function trackTemplateFollow<T>(work: Promise<T>, tracking: TemplateFollowTracking = {}): Promise<T> {
  const tracker: Tracker = { ...tracking, stale: false };
  trackers.add(tracker);
  if (trackers.size === 1) {
    dueAt = Date.now() + TEMPLATE_FOLLOW_HINT_DELAY_MS;
    publish({ episode: snapshot.episode + 1, pending: true, visible: false });
    timer = setTimeout(() => { timer = undefined; refresh(); }, TEMPLATE_FOLLOW_HINT_DELAY_MS);
  }
  return work.finally(() => {
    trackers.delete(tracker);
    if (trackers.size) { refresh(); return; }
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    publish({ episode: snapshot.episode, pending: false, visible: false });
  });
}
