import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemoProject } from "../domain/demo";
import { downloadEditGraph, PROJECT_DOWNLOAD_URL_LIFETIME_MS } from "./exportGraph";
import { createAppRenderActions } from "./appRenderActions";
import { decodeProjectBytes, parseProject } from "./projectCodec";

function environment(clickError = false) {
  const listeners = new Map<string, () => void>();
  let attached = false;
  const link = { href: "", download: "", hidden: false, remove: vi.fn(() => { attached = false; }),
    click: vi.fn(() => { expect(attached).toBe(true); if (clickError) throw new Error("download dispatch failed"); }) };
  const create = vi.fn((_blob: Blob) => "blob:owned-project");
  const revoke = vi.fn();
  vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: revoke });
  vi.stubGlobal("document", { createElement: () => link, body: { appendChild: vi.fn(() => { attached = true; }) } });
  vi.stubGlobal("window", { addEventListener: (name: string, listener: () => void) => listeners.set(name, listener), removeEventListener: (name: string) => listeners.delete(name) });
  vi.useFakeTimers();
  return { link, create, revoke, listeners };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("attached project download ownership (DOM dispatch doubles, not actual disk delivery)", () => {
  it("attaches before click, retains its URL for a finite window, and emits reopenable exact graph bytes", async () => {
    const f = environment();
    const project = createDemoProject();
    project.name = "原創 / 保存";
    const requested = downloadEditGraph(project);
    expect(requested.status).toBe("download_requested");
    expect(requested.filename).toBe("原創 - 保存.editkin.json");
    expect(f.revoke).not.toHaveBeenCalled();
    const blob = f.create.mock.calls[0][0];
    const reopened = decodeProjectBytes(new Uint8Array(await blob.arrayBuffer()));
    expect(reopened.id).toBe(project.id);
    expect(reopened.tracks[0].clips[0]).toEqual(parseProject(project).tracks[0].clips[0]);
    vi.advanceTimersByTime(PROJECT_DOWNLOAD_URL_LIFETIME_MS - 1);
    expect(f.revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(f.revoke).toHaveBeenCalledTimes(1);
    expect(f.revoke).toHaveBeenCalledWith("blob:owned-project");
    expect(f.link.remove).toHaveBeenCalledTimes(1);
  });
  it("cleans on pagehide exactly once and does not revoke another download's URL", () => {
    const f = environment();
    downloadEditGraph(createDemoProject());
    f.listeners.get("pagehide")!();
    vi.advanceTimersByTime(PROJECT_DOWNLOAD_URL_LIFETIME_MS * 2);
    expect(f.revoke).toHaveBeenCalledTimes(1);
    expect(f.revoke).toHaveBeenCalledWith("blob:owned-project");
    expect(f.listeners.size).toBe(0);
  });
  it("preserves dispatch errors and releases the owned anchor/URL immediately", () => {
    const f = environment(true);
    expect(() => downloadEditGraph(createDemoProject())).toThrow("dispatch failed");
    expect(f.revoke).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(PROJECT_DOWNLOAD_URL_LIFETIME_MS);
    expect(f.revoke).toHaveBeenCalledTimes(1);
  });
  it("browser render fallback reports download requested rather than completed save/video", async () => {
    environment();
    const status = vi.fn();
    await createAppRenderActions({ project: createDemoProject(), setStatus: status }).renderVideo();
    expect(status).toHaveBeenLastCalledWith(expect.stringContaining("已送出專案下載"));
    expect(status.mock.calls[0][0]).not.toMatch(/已匯出|影片輸出完成|專案已儲存/);
  });
});
