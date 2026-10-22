import { afterEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({ values: [] as unknown[], index: 0, effects: [] as Array<() => unknown> }));
vi.mock("react", () => ({
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => unknown) => { hooks.effects.push(effect); },
  useRef: (initial: unknown) => {
    const index = hooks.index++;
    hooks.values[index] ??= { current: initial };
    return hooks.values[index];
  },
  useState: (initial: unknown) => {
    const index = hooks.index++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return [hooks.values[index], (next: unknown) => { hooks.values[index] = next; }];
  },
}));
import { useWindowCloseGuard, type WindowCloseGuardOptions } from "./useWindowCloseGuard";
import { resetRenderJobForTest } from "./renderJobStore";

function mount(patch: Partial<WindowCloseGuardOptions> = {}) {
  hooks.values = []; hooks.effects = [];
  let request: (() => void) | undefined;
  const api = {
    setCloseGuard: vi.fn(async () => undefined), acknowledgeCloseRequest: vi.fn(async () => undefined),
    closeWindowConfirmed: vi.fn(async () => undefined), cancelRenderJob: vi.fn(),
    clearRecovery: vi.fn(async () => undefined), keepRecoveryAside: vi.fn(async () => ({ kept: true })),
    onCloseRequested: vi.fn((handler: () => void) => { request = handler; return () => { request = undefined; }; }),
  };
  let dirty = true;
  const save = vi.fn(async () => { dirty = false; });
  const options: WindowCloseGuardOptions = { api, dirty: true, exporting: false, save, isDirty: () => dirty, ...patch };
  const render = () => { hooks.index = 0; hooks.effects = []; const guard = useWindowCloseGuard(options); return guard; };
  render();
  for (const effect of hooks.effects) effect();
  return { api, save, render, request: () => request?.(), setDirty: (value: boolean) => { dirty = value; } };
}

afterEach(() => resetRenderJobForTest());

describe("asking before the window closes", () => {
  it("arms the native guard only while something would be lost", () => {
    const dirty = mount();
    expect(dirty.api.setCloseGuard).toHaveBeenCalledWith(true);
    const clean = mount({ dirty: false });
    expect(clean.api.setCloseGuard).toHaveBeenCalledWith(false);
    const exporting = mount({ dirty: false, exporting: true });
    expect(exporting.api.setCloseGuard).toHaveBeenCalledWith(true);
  });

  it("shows the question when the host asks, and acknowledges it", () => {
    const mounted = mount();
    expect(mounted.render().asking).toBe(false);
    mounted.request();
    expect(mounted.api.acknowledgeCloseRequest).toHaveBeenCalledOnce();
    expect(mounted.render().asking).toBe(true);
  });

  it("closes after a successful save, and keeps the window when the save was canceled", async () => {
    const saved = mount();
    saved.request();
    await saved.render().saveAndClose();
    expect(saved.save).toHaveBeenCalledOnce();
    // The saved project's crash copy is obsolete; it must not reappear as unsaved work next time.
    expect(saved.api.clearRecovery).toHaveBeenCalledOnce();
    expect(saved.api.keepRecoveryAside).not.toHaveBeenCalled();
    expect(saved.api.closeWindowConfirmed).toHaveBeenCalledOnce();

    const canceled = mount();
    canceled.save.mockImplementation(async () => undefined); // still dirty: the dialog was closed
    canceled.request();
    await canceled.render().saveAndClose();
    expect(canceled.api.closeWindowConfirmed).not.toHaveBeenCalled();
    expect(canceled.render().asking).toBe(false);
    expect(canceled.api.setCloseGuard).toHaveBeenLastCalledWith(true);
  });

  it("closes without saving only when chosen, and cancel re-arms the native question", async () => {
    const mounted = mount();
    mounted.request();
    mounted.render().cancel();
    expect(mounted.render().asking).toBe(false);
    expect(mounted.api.closeWindowConfirmed).not.toHaveBeenCalled();
    expect(mounted.api.setCloseGuard).toHaveBeenLastCalledWith(true);
    await mounted.render().closeWithoutSaving();
    expect(mounted.save).not.toHaveBeenCalled();
    // 「不存檔」 keeps the crash copy aside instead of deleting it, so it is not offered again as a surprise.
    expect(mounted.api.keepRecoveryAside).toHaveBeenCalledOnce();
    expect(mounted.api.clearRecovery).not.toHaveBeenCalled();
    expect(mounted.api.closeWindowConfirmed).toHaveBeenCalledOnce();
  });
});
