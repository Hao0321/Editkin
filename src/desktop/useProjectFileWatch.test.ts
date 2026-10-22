import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemoProject } from "../domain/demo";
import { createProjectSession } from "../application/projectSession";
import type { ProjectFileInspection } from "./apiTypes";

const hooks = vi.hoisted(() => ({ values: [] as unknown[], index: 0, effects: [] as (() => void)[] }));
vi.mock("react", () => ({
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => (() => void) | void, dependencies: unknown[]) => {
    const index = hooks.index++;
    const previous = hooks.values[index] as { dependencies: unknown[]; cleanup?: () => void } | undefined;
    if (previous && previous.dependencies.length === dependencies.length && previous.dependencies.every((value, i) => Object.is(value, dependencies[i]))) return;
    hooks.effects.push(() => {
      previous?.cleanup?.();
      hooks.values[index] = { dependencies: [...dependencies], cleanup: effect() };
    });
  },
  useRef: (initial: unknown) => {
    const index = hooks.index++;
    hooks.values[index] ??= { current: initial };
    return hooks.values[index];
  },
  useState: (initial: unknown) => {
    const index = hooks.index++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return [hooks.values[index], (next: unknown) => {
      hooks.values[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(hooks.values[index]) : next;
    }];
  },
}));
import { useProjectFileWatch } from "./useProjectFileWatch";

function mount(path = "D:/p/trip.editkin.json") {
  hooks.values = [];
  const project = { ...createDemoProject(), revision: 4 };
  const identity = (revision: number, bytes: number) => ({ schema: "editkin.project-file-identity/v1" as const,
    projectId: project.id, revision, updatedAt: project.updatedAt, projectSha256: String(revision).padStart(64, "0"), bytes });
  const session = createProjectSession(project, path);
  session.replaceProject(project, path, { fileIdentity: identity(4, 10) });
  let file: ProjectFileInspection = { exists: true, modifiedMs: 100, bytes: 10, revision: 4, readable: true, fileIdentity: identity(4, 10) };
  const inspectProjectFile = vi.fn(async (_path: string) => file);
  const api = { inspectProjectFile };
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn(), setInterval, clearInterval });
  vi.stubGlobal("document", { visibilityState: "visible" });
  const render = () => {
    hooks.index = 0;
    const result = useProjectFileWatch(api, session, true);
    const effects = hooks.effects.splice(0);
    effects.forEach(effect => effect());
    return result;
  };
  return { session, inspectProjectFile, render, inspection: () => file, setFile: (next: ProjectFileInspection) => {
    file = next.readable && typeof next.revision === "number" && next.bytes !== undefined && !next.fileIdentity
      ? { ...next, fileIdentity: identity(next.revision, next.bytes) } : next;
  } };
}

afterEach(() => {
  for (const value of hooks.values) (value as { cleanup?: () => void } | undefined)?.cleanup?.();
  hooks.values = []; hooks.effects = [];
  vi.unstubAllGlobals();
});

describe("noticing that another program changed the open project file", () => {
  it("stays quiet for Editkin's own file and an unchanged file", async () => {
    const mounted = mount();
    await mounted.render().check();
    expect(mounted.render().change).toBeUndefined();
    await mounted.render().check();
    expect(mounted.inspectProjectFile).toHaveBeenLastCalledWith("D:/p/trip.editkin.json");
    expect(mounted.render().change).toBeUndefined();
  });

  it("announces a new revision written by someone else, once", async () => {
    const mounted = mount();
    await mounted.render().check();
    mounted.setFile({ exists: true, modifiedMs: 200, bytes: 12, revision: 5, readable: true });
    await mounted.render().check();
    expect(mounted.render().change).toEqual({ kind: "changed", path: "D:/p/trip.editkin.json", revision: 5, fileIdentity: mounted.inspection().fileIdentity });
    mounted.render().dismiss();
    expect(mounted.render().change).toBeUndefined();
    await mounted.render().check();
    expect(mounted.render().change).toBeUndefined(); // the same revision is not announced again
    mounted.setFile({ exists: true, modifiedMs: 300, bytes: 13, revision: 6, readable: true });
    await mounted.render().check();
    expect(mounted.render().change).toMatchObject({ revision: 6 });
  });

  it("waits for a half-written file and never prompts during Editkin's own save", async () => {
    const mounted = mount();
    await mounted.render().check();
    mounted.setFile({ exists: true, modifiedMs: 250, bytes: 3, readable: false });
    await mounted.render().check();
    expect(mounted.render().change).toBeUndefined();
    const request = mounted.session.beginSave();
    mounted.setFile({ exists: true, modifiedMs: 260, bytes: 20, revision: 9, readable: true });
    const calls = mounted.inspectProjectFile.mock.calls.length;
    await mounted.render().check();
    expect(mounted.inspectProjectFile.mock.calls.length).toBe(calls);
    mounted.session.finishSave(request!);
  });

  it("says when the project file is gone", async () => {
    const mounted = mount();
    await mounted.render().check();
    mounted.setFile({ exists: false });
    await mounted.render().check();
    expect(mounted.render().change).toEqual({ kind: "missing", path: "D:/p/trip.editkin.json" });
  });
});
