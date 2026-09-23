import { afterEach, describe, expect, it, vi } from "vitest";
import { startAutomaticUpdateChecks } from "./automaticUpdates";

afterEach(() => vi.useRealTimers());

describe("automatic update scheduler", () => {
  it("checks after startup and at a bounded interval", async () => {
    vi.useFakeTimers();
    const check = vi.fn(async () => ({ status: "current", message: "ok" }));
    const onResult = vi.fn();
    const stop = startAutomaticUpdateChecks({ check, onResult, initialDelayMs: 50, intervalMs: 1_000 });
    expect(check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(50);
    expect(check).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith({ status: "current", message: "ok" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(check).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("never overlaps a slow check", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const check = vi.fn(async () => { await pending; return { status: "current", message: "ok" }; });
    const stop = startAutomaticUpdateChecks({ check, onResult: () => undefined, initialDelayMs: 0, intervalMs: 1_000 });
    await vi.advanceTimersByTimeAsync(2_500);
    expect(check).toHaveBeenCalledTimes(1);
    release();
    await pending;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(check).toHaveBeenCalledTimes(2);
    stop();
  });
});
