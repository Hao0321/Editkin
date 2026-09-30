import { describe, expect, it, vi } from "vitest";
import { createDemoProject } from "../domain/demo";
import { createBrowserProjectApi, type BrowserProjectStore } from "./browserProjectApi";
import { RECOVERY_MAX_AGE_MS } from "../application/recoverySnapshot";
import type { EditProject } from "../domain/types";

function setup(picked: File[] = []) {
  let stored: unknown;
  const store: BrowserProjectStore = {
    get: async () => stored, put: async (value) => { stored = value; }, clear: async () => { stored = undefined; },
  };
  const download = vi.fn<(project: EditProject) => void>();
  const pickFiles = vi.fn(async (_accept: string) => picked);
  const api = createBrowserProjectApi({ store, pickFiles, download });
  return { api, store, download, pickFiles, setStored: (value: unknown) => { stored = value; }, getStored: () => stored };
}

function browserProject(): EditProject {
  const project = createDemoProject();
  project.assets = [
    { id: "a1", name: "我的 影片.mp4", kind: "video", uri: `local://${encodeURIComponent("我的 影片.mp4")}`, duration: 5 },
    { id: "a2", name: "voice.wav", kind: "audio", uri: "local://voice.wav", duration: 5 },
  ];
  project.tracks.forEach((track) => { track.clips = []; });
  return project;
}

const projectFile = (project: unknown, name = "demo.editkin.json") => new File([JSON.stringify(project)], name, { type: "application/json" });

describe("browser project file API", () => {
  it("saves a validated project with a higher revision and downloads exactly that version", async () => {
    const { api, download } = setup();
    const project = browserProject();
    const result = await api.saveProject(project);
    expect(result.project!.revision).toBe(project.revision + 1);
    expect(result.path).toMatch(/\.editkin\.json$/);
    expect(download).toHaveBeenCalledWith(result.project);
  });

  it("opens a saved project and links picked media by decoded file name", async () => {
    const project = browserProject();
    const saved = await setup().api.saveProject(project);
    const video = new File(["v"], "我的 影片.mp4", { type: "video/mp4" });
    const opened = await setup([projectFile(saved.project), video]).api.openProject();
    expect(opened.project!.id).toBe(project.id);
    expect(opened.path).toBe("demo.editkin.json");
    expect(Object.keys(opened.runtimeUrls!)).toEqual(["a1"]);
    expect(opened.unlinkedAssetNames).toEqual(["voice.wav"]);
  });

  it("reports cancel without touching anything and rejects ambiguous or invalid picks", async () => {
    expect(await setup([]).api.openProject()).toEqual({ canceled: true });
    await expect(setup([projectFile({}, "a.json"), projectFile({}, "b.json")]).api.openProject()).rejects.toThrow(/一個/);
    await expect(setup([new File(["v"], "clip.mp4")]).api.openProject()).rejects.toThrow(/一個/);
    await expect(setup([projectFile({ not: "a project" })]).api.openProject()).rejects.toThrow(/不是有效的 Editkin 專案檔/);
    await expect(setup([new File(["{broken"], "x.json")]).api.openProject()).rejects.toThrow(/不是有效的 Editkin 專案檔/);
  });

  it("re-links only matching media and returns undefined when the picker is cancelled", async () => {
    const project = browserProject();
    const relinked = await setup([new File(["a"], "voice.wav")]).api.relinkMedia(project.assets);
    expect(Object.keys(relinked!.runtimeUrls)).toEqual(["a2"]);
    expect(relinked!.unlinkedAssetNames).toEqual(["我的 影片.mp4"]);
    expect(await setup([]).api.relinkMedia(project.assets)).toBeUndefined();
  });

  it("round-trips autosave through the store and clears it", async () => {
    const t = setup();
    const project = browserProject();
    expect(await t.api.loadRecovery()).toEqual({ found: false, reason: "missing" });
    await t.api.saveRecovery(project, "demo.editkin.json", project.updatedAt);
    const loaded = await t.api.loadRecovery();
    expect(loaded).toMatchObject({ found: true, source: "primary", snapshot: { projectPath: "demo.editkin.json", project: { id: project.id } } });
    await t.api.clearRecovery();
    expect(await t.api.loadRecovery()).toEqual({ found: false, reason: "missing" });
  });

  it("classifies stale and corrupt autosave data instead of throwing", async () => {
    const t = setup();
    const project = browserProject();
    await t.api.saveRecovery(project, undefined, project.updatedAt);
    t.setStored({ ...(t.getStored() as object), savedAt: new Date(Date.now() - RECOVERY_MAX_AGE_MS - 60_000).toISOString() });
    expect(await t.api.loadRecovery()).toEqual({ found: false, reason: "stale" });
    t.setStored({ schemaVersion: 1, savedAt: "garbage" });
    expect(await t.api.loadRecovery()).toEqual({ found: false, reason: "corrupt" });
  });
});
