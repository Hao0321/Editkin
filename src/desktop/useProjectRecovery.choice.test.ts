import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemoProject } from "../domain/demo";
import { createProjectSession } from "../application/projectSession";
import type { HaoDesktopApi, OpenProjectResult } from "./types";
import type { RecoveryReadResult } from "../application/recoveryFiles";

// Stable hook slots; only the startup effect (the first one) is run, explicitly. This exercises the production
// startup decision with the real ProjectSession, not React scheduling or the native dialogs.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], index: 0, effects: [] as Array<() => unknown> }));
vi.mock("react", () => ({
  useCallback: (callback: unknown) => callback,
  useMemo: (factory: () => unknown) => factory(),
  useEffect: (effect: () => unknown) => { hooks.effects.push(effect); },
  useRef: (initial: unknown) => {
    const index = hooks.index++;
    hooks.values[index] ??= { current: initial };
    return hooks.values[index];
  },
  useState: (initial: unknown) => {
    const index = hooks.index++;
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [hooks.values[index], (next: unknown) => {
      hooks.values[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(hooks.values[index]) : next;
    }];
  },
}));
import { useProjectRecovery, type RecoveryChoiceRequest } from "./useProjectRecovery";

const settle = async () => { for (let index = 0; index < 20; index += 1) await Promise.resolve(); };

function mount(result: RecoveryReadResult, apiPatch: Partial<HaoDesktopApi> = {}) {
  hooks.values = []; hooks.effects = [];
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn(), confirm: vi.fn(() => { throw new Error("no window.confirm any more"); }) });
  vi.stubGlobal("document", { title: "" });
  const session = createProjectSession(createDemoProject());
  const api = {
    loadRecovery: vi.fn(async () => result),
    clearRecovery: vi.fn(async () => undefined),
    keepRecoveryAside: vi.fn(async () => ({ kept: true, path: "C:/data/recovery/kept/session-1.json" })),
    previewUrls: vi.fn(async () => ({})),
    inspectProjectFile: vi.fn(async () => ({ exists: true })),
    openProjectPath: vi.fn(async (path: string): Promise<OpenProjectResult> => ({ canceled: false, path, project: { ...createDemoProject(), name: "Saved" } })),
    ...apiPatch,
  } as unknown as HaoDesktopApi;
  const onRestore = vi.fn();
  const onOpenSaved = vi.fn();
  const onStatus = vi.fn();
  const snapshot = session.getSnapshot();
  const render = () => {
    hooks.index = 0; hooks.effects = [];
    return useProjectRecovery({ api, project: snapshot.history.present, projectPath: snapshot.projectPath, cleanUpdatedAt: snapshot.cleanUpdatedAt,
      dirty: snapshot.dirty, recoveryOwner: snapshot.recoveryOwner, isRecoveryOwnerCurrent: session.isRecoveryOwnerCurrent, onRestore, onOpenSaved, onStatus });
  };
  render();
  hooks.effects[0]();
  return { api, onRestore, onOpenSaved, onStatus, render };
}

const found = (projectPath?: string): RecoveryReadResult => ({ found: true, source: "primary", snapshot: {
  schemaVersion: 1, savedAt: "2026-10-10T05:00:00.000Z", cleanUpdatedAt: "2026-10-10T04:00:00.000Z",
  ...(projectPath ? { projectPath } : {}), project: { ...createDemoProject(), name: "旅行 vlog" } } });

async function pending(mounted: ReturnType<typeof mount>): Promise<RecoveryChoiceRequest> {
  await settle();
  const choice = mounted.render().pendingChoice;
  expect(choice).toBeDefined();
  return choice!;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("crash recovery asks three ways and never deletes on a wrong click", () => {
  it("waits for the creator: nothing is restored or deleted while the question is open", async () => {
    const mounted = mount(found("D:/p/trip.editkin.json"));
    const choice = await pending(mounted);
    expect(choice).toMatchObject({ projectName: "旅行 vlog", projectPath: "D:/p/trip.editkin.json", savedFileAvailable: true });
    expect(mounted.api.clearRecovery).not.toHaveBeenCalled();
    expect(mounted.api.keepRecoveryAside).not.toHaveBeenCalled();
    expect(mounted.onRestore).not.toHaveBeenCalled();
    expect(mounted.render().ready).toBe(false);
  });

  it("「打開找回的版本」 restores the recovered work and keeps the backup", async () => {
    const mounted = mount(found());
    const choice = await pending(mounted);
    expect(choice.savedFileAvailable).toBe(false);
    choice.choose("restore");
    await settle();
    expect(mounted.onRestore).toHaveBeenCalledOnce();
    expect(mounted.api.clearRecovery).not.toHaveBeenCalled();
    expect(mounted.render().ready).toBe(true);
  });

  it("「打開上次存的檔案」 opens the saved file and keeps the recovered copy aside (not deleted)", async () => {
    const mounted = mount(found("D:/p/trip.editkin.json"));
    (await pending(mounted)).choose("open-saved");
    await settle();
    expect(mounted.api.openProjectPath).toHaveBeenCalledWith("D:/p/trip.editkin.json");
    expect(mounted.api.keepRecoveryAside).toHaveBeenCalledOnce();
    expect(mounted.api.clearRecovery).not.toHaveBeenCalled();
    expect(mounted.onOpenSaved).toHaveBeenCalledWith(expect.objectContaining({ path: "D:/p/trip.editkin.json" }));
    expect(mounted.onRestore).not.toHaveBeenCalled();
  });

  it("a saved file that will not open asks again with the reason, and the backup stays", async () => {
    const mounted = mount(found("D:/p/trip.editkin.json"), { openProjectPath: vi.fn(async () => { throw new Error("ENOENT: no such file"); }) } as Partial<HaoDesktopApi>);
    (await pending(mounted)).choose("open-saved");
    const again = await pending(mounted);
    expect(again.failure).toBe("ENOENT: no such file");
    expect(mounted.api.keepRecoveryAside).not.toHaveBeenCalled();
    expect(mounted.api.clearRecovery).not.toHaveBeenCalled();
    again.choose("restore");
    await settle();
    expect(mounted.onRestore).toHaveBeenCalledOnce();
  });

  it("only the confirmed 「不要了」 clears the recovery data", async () => {
    const mounted = mount(found("D:/p/trip.editkin.json"));
    (await pending(mounted)).choose("discard");
    await settle();
    expect(mounted.api.clearRecovery).toHaveBeenCalledOnce();
    expect(mounted.onRestore).not.toHaveBeenCalled();
    expect(mounted.onStatus).toHaveBeenCalledWith("已丟掉找回的版本。");
  });

  it("damaged or old recovery data is moved aside instead of deleted", async () => {
    const mounted = mount({ found: false, reason: "corrupt" });
    await settle();
    expect(mounted.api.keepRecoveryAside).toHaveBeenCalledOnce();
    expect(mounted.api.clearRecovery).not.toHaveBeenCalled();
    expect(mounted.onStatus).toHaveBeenCalledWith("偵測到損壞的當機復原資料，已移到復原資料夾保存。正常專案檔不受影響。");
  });
});
