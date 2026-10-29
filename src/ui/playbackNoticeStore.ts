export type PlaybackNoticeKind = "play" | "audio" | "audio-source" | "audio-fallback" | "gpu";
/** A playback stop or fallback the user must see, with at most one recovery action.
 * The UI shows a fixed plain line per kind and step; `detail` is the raw technical
 * cause and is only shown folded under 查看原因 (or in a tooltip). */
export interface PlaybackNotice {
  kind: PlaybackNoticeKind;
  detail: string;
  /** Media names of the audio sources that cannot play. */
  names?: readonly string[];
  /** Which recovery is offered: play → "play" | "reload" | "rebuild";
   * gpu → "fallback" (picture moved to 相容預覽) | "playback" (GPU still shows it). */
  step?: string;
  /** The one recovery action. A returned promise keeps the button busy until it settles. */
  retry?: () => void | Promise<unknown>;
}
export interface PublishedPlaybackNotice extends PlaybackNotice {
  key: string;
  /** Recoveries already tried for this same problem; above 0 means it is still failing. */
  attempts: number;
  /** A recovery is running. */
  busy: boolean;
}

// The window has one preview. Playback owners (the audio and GPU preview hooks)
// publish what stopped by key; the transport shows it beside the button the
// user just pressed, instead of only in a tooltip or a hidden data attribute.
const entries = new Map<string, PlaybackNotice>();
const attempts = new Map<string, number>();
const busy = new Map<string, object>();
// A retry often clears its notice before the outcome is known (a GPU re-admission,
// play again). The same problem coming back shortly after keeps its count, so the
// line can say it is still failing instead of repeating the first advice.
const recent = new Map<string, { identity: string; attempts: number; at: number }>();
const REAPPEAR_MS = 20_000;
const listeners = new Set<() => void>();
let snapshot: readonly PublishedPlaybackNotice[] = [];
const identity = (notice: PlaybackNotice) => `${notice.kind}\n${notice.step ?? ""}`;

function emit(): void {
  snapshot = [...entries].map(([key, value]) => ({ ...value, key, attempts: attempts.get(key) ?? 0, busy: busy.has(key) }));
  for (const listener of listeners) listener();
}
export function publishPlaybackNotice(key: string, notice?: PlaybackNotice): void {
  const previous = entries.get(key);
  if (!notice) {
    if (!previous) return;
    const tried = attempts.get(key) ?? 0;
    entries.delete(key); attempts.delete(key); busy.delete(key);
    if (tried > 0) recent.set(key, { identity: identity(previous), attempts: tried, at: Date.now() });
    emit();
    return;
  }
  if (!previous || identity(previous) !== identity(notice)) {
    const earlier = recent.get(key);
    attempts.set(key, !previous && earlier?.identity === identity(notice) && Date.now() - earlier.at <= REAPPEAR_MS ? earlier.attempts : 0);
  }
  recent.delete(key);
  entries.set(key, notice);
  emit();
}
/** Runs the notice's recovery once at a time and counts it, so a repeat failure reads differently. */
export function retryPlaybackNotice(key: string): void {
  const notice = entries.get(key);
  if (!notice?.retry || busy.has(key)) return;
  const token = {};
  attempts.set(key, (attempts.get(key) ?? 0) + 1);
  busy.set(key, token);
  emit();
  let outcome: unknown;
  try { outcome = notice.retry(); } catch (error) { outcome = Promise.reject(error); }
  void Promise.resolve(outcome).catch(() => undefined).then(() => {
    if (busy.get(key) !== token) return;
    busy.delete(key);
    emit();
  });
}
/** Closes a notice that does not block playback; its owner shows it again on a new failure. */
export function dismissPlaybackNotice(key: string): void {
  if (!entries.delete(key)) return;
  attempts.delete(key); busy.delete(key); recent.delete(key);
  emit();
}
/** Drops every notice and remembered attempt (a new window, or a test). */
export function resetPlaybackNotices(): void {
  entries.clear(); attempts.clear(); busy.clear(); recent.clear();
  emit();
}
export const currentPlaybackNotices = (): readonly PublishedPlaybackNotice[] => snapshot;
export function subscribePlaybackNotices(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
