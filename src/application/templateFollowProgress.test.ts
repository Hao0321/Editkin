import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { subscribeTemplateFollowProgress, TEMPLATE_FOLLOW_HINT_DELAY_MS, templateFollowProgress, trackTemplateFollow, yieldToBrowser } from "./templateFollowProgress";

/** A promise settled from outside, like a template being laid out again. */
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = () => new Promise<void>(done => queueMicrotask(done)).then(() => undefined);

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("the 「標題跟著調整中…」 hint while a template follows a clip edit", () => {
  it("never shows for a fast edit, shows after about 300 ms for a slow one, and clears when it is applied", async () => {
    const fast = deferred<boolean>(), episode = templateFollowProgress().episode;
    const tracked = trackTemplateFollow(fast.promise);
    expect(templateFollowProgress()).toMatchObject({ episode: episode + 1, pending: true, visible: false });
    vi.advanceTimersByTime(120);
    fast.resolve(true);
    await expect(tracked).resolves.toBe(true);
    expect(templateFollowProgress()).toMatchObject({ pending: false, visible: false });
    vi.advanceTimersByTime(TEMPLATE_FOLLOW_HINT_DELAY_MS);
    expect(templateFollowProgress().visible).toBe(false);

    const slow = deferred<boolean>(), seen: boolean[] = [];
    const stop = subscribeTemplateFollowProgress(() => seen.push(templateFollowProgress().visible));
    const waiting = trackTemplateFollow(slow.promise);
    vi.advanceTimersByTime(TEMPLATE_FOLLOW_HINT_DELAY_MS - 1);
    expect(templateFollowProgress().visible).toBe(false);
    vi.advanceTimersByTime(1);
    expect(templateFollowProgress()).toMatchObject({ pending: true, visible: true });
    slow.resolve(true);
    await waiting;
    stop();
    expect(templateFollowProgress()).toMatchObject({ pending: false, visible: false });
    expect(seen).toEqual([false, true, false]);
  });

  it("shows the hint at the work's own pause points once it is due, even if the timer waits behind the work", async () => {
    const work = deferred<boolean>(), tracked = trackTemplateFollow(work.promise);
    const pause = yieldToBrowser();
    expect(templateFollowProgress().visible).toBe(false);
    await pause;
    // The clock moves past the delay while the work runs; no timer has had a turn yet.
    vi.setSystemTime(Date.now() + TEMPLATE_FOLLOW_HINT_DELAY_MS);
    const next = yieldToBrowser();
    expect(templateFollowProgress()).toMatchObject({ pending: true, visible: true });
    await next;
    work.resolve(true);
    await tracked;
    expect(templateFollowProgress()).toMatchObject({ pending: false, visible: false });
  });

  it("drops the hint and cancels the work at its next pause point once its project is gone (an Undo)", async () => {
    let current = true;
    const onStale = vi.fn(), work = deferred<boolean>();
    const tracked = trackTemplateFollow(work.promise, { stillCurrent: () => current, onStale });
    vi.advanceTimersByTime(TEMPLATE_FOLLOW_HINT_DELAY_MS);
    expect(templateFollowProgress().visible).toBe(true);
    current = false;
    const pause = yieldToBrowser();
    expect(templateFollowProgress()).toMatchObject({ pending: true, visible: false });
    expect(onStale).toHaveBeenCalledOnce();
    await pause;
    await yieldToBrowser();
    expect(onStale).toHaveBeenCalledOnce();
    work.resolve(false);
    await tracked;
    expect(templateFollowProgress()).toMatchObject({ pending: false, visible: false });
  });

  it("clears when the edit fails, and stays up while another follow is still running", async () => {
    const first = deferred<boolean>(), second = deferred<boolean>();
    const a = trackTemplateFollow(first.promise), b = trackTemplateFollow(second.promise);
    vi.advanceTimersByTime(TEMPLATE_FOLLOW_HINT_DELAY_MS);
    expect(templateFollowProgress().visible).toBe(true);
    first.reject(new Error("片段太短"));
    await expect(a).rejects.toThrow("片段太短");
    expect(templateFollowProgress()).toMatchObject({ pending: true, visible: true });
    second.resolve(false);
    await b;
    await settle();
    expect(templateFollowProgress()).toMatchObject({ pending: false, visible: false });
  });
});
