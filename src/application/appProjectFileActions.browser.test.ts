import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemoProject } from "../domain/demo";
import { dispatchCommand } from "../domain/history";
import type { OpenProjectResult } from "../desktop/types";
import { createAppProjectFileActions } from "./appProjectFileActions";
import { createProjectSession } from "./projectSession";
import { decodeProjectBytes, encodeProjectBytes } from "./projectCodec";

function fixture() {
  const session = createProjectSession(createDemoProject());
  const confirm = vi.fn(() => true);
  vi.stubGlobal("window", { confirm });
  const download = vi.fn(() => ({ status: "download_requested" as const, filename: "actual-graph.editkin.json", bytes: 100 }));
  const open = vi.fn(async (): Promise<OpenProjectResult> => ({ canceled: true }));
  const load = vi.fn((opened: OpenProjectResult) => { if (opened.project) session.replaceProject(opened.project); });
  const status = vi.fn(), playing = vi.fn(), rate = vi.fn();
  const actions = createAppProjectFileActions({ session, loadOpenedProject: load, browserFiles: { open, download },
    setStatus: status, setRuntimeUrls: vi.fn(), setSelectedClipId: vi.fn(), setSelectedCaptionId: vi.fn(), setPlayhead: vi.fn(),
    setPlaying: playing, setPlaybackRate: rate, setTrackingMode: vi.fn(), setTrackingSelection: vi.fn() });
  const edit = (name: string) => session.setHistory(current => dispatchCommand(current, { type: "rename_project", name }));
  return { session, confirm, download, open, load, status, playing, rate, actions, edit };
}
afterEach(() => vi.unstubAllGlobals());

describe("browser file actions with real project session and explicit delivery providers", () => {
  it("downloads the live snapshot without changing dirty/history/revision/path or claiming an atomic save", async () => {
    const f = fixture();
    f.edit("Actual current edits");
    const before = f.session.getSnapshot();
    await f.actions.saveProject(true);
    expect(f.download).toHaveBeenCalledWith(before.history.present);
    expect(f.session.getSnapshot()).toEqual(before);
    expect(f.session.getSnapshot().dirty).toBe(true);
    expect(f.status).toHaveBeenLastCalledWith(expect.stringContaining("不會標記已儲存"));
    expect(f.status.mock.calls[0][0]).not.toContain("專案已儲存");
  });
  it("keeps edits intact and reports a failed download dispatch", async () => {
    const f = fixture();
    f.edit("Retained");
    const before = f.session.getSnapshot();
    f.download.mockImplementation(() => { throw new Error("blocked real download dispatch"); });
    await f.actions.saveProject();
    expect(f.session.getSnapshot()).toEqual(before);
    expect(f.status).toHaveBeenLastCalledWith("blocked real download dispatch");
  });
  it("opens a graph from the actual codec without inventing a writable native path or retained blob media", async () => {
    const f = fixture();
    const opened = decodeProjectBytes(encodeProjectBytes({ ...createDemoProject(), revision: 8, name: "Real reopened graph" }));
    f.open.mockResolvedValue({ canceled: false, project: opened, runtimeUrls: {} });
    await f.actions.openProject();
    expect(f.load).toHaveBeenCalledWith({ canceled: false, project: opened, runtimeUrls: {} });
    expect(f.session.getSnapshot()).toMatchObject({ projectPath: undefined, diskRevision: 8, dirty: false });
    expect(f.session.getSnapshot().history.present.tracks[0].clips[0].id).toBe("clip-demo");
    expect(f.status).toHaveBeenLastCalledWith(expect.stringContaining("缺失素材請逐一重新連結"));
    expect(f.playing).toHaveBeenCalledWith(false);
  });
  it("canceled/corrupt open leaves the live graph intact", async () => {
    const f = fixture();
    f.edit("Keep");
    const before = f.session.getSnapshot();
    await f.actions.openProject();
    expect(f.load).not.toHaveBeenCalled();
    expect(f.session.getSnapshot()).toEqual(before);
    f.open.mockRejectedValue(new Error("invalid selected JSON"));
    await f.actions.openProject();
    expect(f.session.getSnapshot()).toEqual(before);
    expect(f.status).toHaveBeenLastCalledWith("invalid selected JSON");
  });
  it("retains edits made during the chooser when the second discard confirmation is rejected", async () => {
    const f = fixture();
    let resolve!: (opened: OpenProjectResult) => void;
    f.open.mockImplementation(() => new Promise(yes => { resolve = yes; }));
    f.edit("Before");
    const pending = f.actions.openProject();
    f.edit("During chooser");
    f.confirm.mockReturnValueOnce(false);
    resolve({ canceled: false, project: createDemoProject() });
    await pending;
    expect(f.load).not.toHaveBeenCalled();
    expect(f.session.getSnapshot().history.present.name).toBe("During chooser");
  });
  it("new project stops playing and resets reverse/fast-forward direction to normal without a save claim", () => {
    const f = fixture();
    f.edit("Before New");
    f.actions.newProject();
    expect(f.playing).toHaveBeenLastCalledWith(false);
    expect(f.rate).toHaveBeenLastCalledWith(1);
    expect(f.session.getSnapshot().history.present.assets).toEqual([]);
    expect(f.session.getSnapshot().history.present.tracks.flatMap(track => track.clips)).toEqual([]);
  });
});
