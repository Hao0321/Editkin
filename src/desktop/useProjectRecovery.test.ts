import { describe, expect, it, vi } from "vitest";
import { preventDirtyProjectUnload, RECOVERY_AUTOSAVE_DELAY_MS, recoveryFailureMessage } from "./useProjectRecovery";

describe("dirty project unload guard", () => {
  it("preserves Tauri string rejections and normal Error details", () => {
    expect(recoveryFailureMessage("assets[1].width received null", "Autosave 失敗")).toBe("Autosave 失敗：assets[1].width received null");
    expect(recoveryFailureMessage(new Error("disk full"), "Autosave 失敗")).toBe("Autosave 失敗：disk full");
    expect(recoveryFailureMessage(undefined, "Autosave 失敗")).toBe("Autosave 失敗；請立即手動儲存");
  });
  it("keeps recovery latency below the delivered Timeline durability window", () => {
    expect(RECOVERY_AUTOSAVE_DELAY_MS).toBeLessThanOrEqual(500);
  });

  it("blocks leaving only while the project has unsaved changes", () => {
    const dirtyEvent = { preventDefault: vi.fn(), returnValue: undefined as unknown };
    expect(preventDirtyProjectUnload(dirtyEvent as Pick<BeforeUnloadEvent, "preventDefault" | "returnValue">, true)).toBe(true);
    expect(dirtyEvent.preventDefault).toHaveBeenCalledOnce();
    expect(dirtyEvent.returnValue).toBe("");

    const cleanEvent = { preventDefault: vi.fn(), returnValue: undefined as unknown };
    expect(preventDirtyProjectUnload(cleanEvent as Pick<BeforeUnloadEvent, "preventDefault" | "returnValue">, false)).toBe(false);
    expect(cleanEvent.preventDefault).not.toHaveBeenCalled();
  });
});
