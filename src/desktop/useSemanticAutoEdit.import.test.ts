import { expect, it, vi } from "vitest";
import { createDemoProject } from "../domain/demo";
import { dispatchCommand } from "../domain/history";
import { createProjectSession } from "../application/projectSession";
import type { HaoDesktopApi } from "./types";
import { useSemanticAutoEdit } from "./useSemanticAutoEdit";

const moduleGate = vi.hoisted(() => {
  let started!: () => void;
  let release!: () => void;
  return { entered: new Promise<void>(resolve => { started = resolve; }), wait: new Promise<void>(resolve => { release = resolve; }), started: () => started(), release: () => release() };
});
vi.mock("react", () => ({ useState: (initial: unknown) => [initial, () => {}], useRef: (initial: unknown) => ({ current: initial }) }));
vi.mock("../application/nativeAutopilot", async importOriginal => {
  moduleGate.started();
  await moduleGate.wait;
  return await importOriginal();
});

it("rechecks content ownership after the actual lazy native-autopilot module resolves", async () => {
  const project = createDemoProject();
  const projectSession = createProjectSession(project);
  const onCommand = vi.fn();
  const onRuntimeUrls = vi.fn();
  const onStatus = vi.fn();
  const library = vi.fn(async () => ({ assets: [] }));
  const hook = useSemanticAutoEdit({ project, projectSession, selectedClip: project.tracks[0].clips[0], onCommand, onRuntimeUrls, onStatus,
    api: { automaticCaptionMedia: async () => ({ cues: [{ start: 0, end: 3, text: "Deferred module fixture" }] }), detectScenes: async () => ({ cuts: [] }), listCreativeLibrary: library } as unknown as HaoDesktopApi,
  });
  const work = hook.run();
  await moduleGate.entered;
  projectSession.setHistory(current => dispatchCommand(current, { type: "rename_project", name: "KEEP EDIT WHILE MODULE LOADS" }));
  const before = projectSession.getSnapshot().history;
  moduleGate.release();
  await work;
  expect(library).not.toHaveBeenCalled();
  expect(onCommand).not.toHaveBeenCalled();
  expect(onRuntimeUrls).not.toHaveBeenCalled();
  expect(projectSession.getSnapshot().history).toBe(before);
  expect(onStatus).toHaveBeenLastCalledWith(expect.stringContaining("重新執行"));
});
